import { BadRequestException, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InstanceConfigService } from "../user/instance-config.service";
import { logger } from "../../logger";
import { NotificationEventType, NotificationSettingsDto, validateNotificationSettings, NotificationSettings } from "./dto/notification-settings.dto";

export interface NotificationEvent {
  type: NotificationEventType;
  at: number;
  name?: string;
  phoneLast4?: string;
  ip?: string;
}
const LABELS: Record<NotificationEventType, string> = {
  account_joined: "Account joined", account_deleted: "Account deleted",
  admin_login: "Successful admin login", admin_password_failed: "Failed admin password", admin_lockout: "Admin password lockout",
};
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private queue: Array<{ text: string; revision: number; resolve?: (success: boolean) => void; chatId?: string; expires?: number; valid?: () => boolean }> = [];
  private cancelWait?: () => void;
  private failedIps = new Map<string, number>();
  private running = false;
  private stopped = false;
  private revision = 0;
  private nextSend = 0;
  private abort?: AbortController;
  private lastDelivery: { at: string; success: boolean; message: string } | null = null;
  constructor(private readonly config: InstanceConfigService) {}
  private readonly onEvent = (event: NotificationEvent) => this.enqueue(event);
  private readonly onSettings = () => {
    this.revision++;
    for (const item of this.queue) item.resolve?.(false);
    this.queue = [];
    this.cancelWait?.();
    this.nextSend = Math.min(this.nextSend, Date.now() + 1000);
    this.failedIps.clear();
    this.abort?.abort();
    this.lastDelivery = null;
  };
  private readonly onSecurity = () => {
    this.abort?.abort();
    for (const item of this.queue.filter(item => item.expires !== undefined)) item.resolve?.(false);
    this.queue = this.queue.filter(item => item.expires === undefined);
    this.cancelWait?.();
  };
  onModuleInit() {
    this.config.events.on("securityChanged", this.onSecurity);
    this.config.events.on("notification", this.onEvent);
    this.config.events.on("notificationsChanged", this.onSettings);
  }
  onModuleDestroy() {
    this.stopped = true;
    this.onSettings();
    this.config.events.off("securityChanged", this.onSecurity);
    this.config.events.off("notification", this.onEvent);
    this.config.events.off("notificationsChanged", this.onSettings);
  }
  settings() {
    const { botToken, enabled, passwordRecoveryEnabled, chatId, events } = this.config.getNotificationSettings();
    return { enabled, events, passwordRecoveryEnabled: passwordRecoveryEnabled ?? false, chatId: chatId ?? "", botTokenConfigured: Boolean(botToken), lastDelivery: this.lastDelivery };
  }
  private enqueue(event: NotificationEvent) {
    const settings = this.config.getNotificationSettings();
    if (this.stopped || !settings.enabled || !settings.events.includes(event.type)) return;
    const now = Date.now();
    for (const [ip, at] of this.failedIps) if (at + 60_000 <= now) this.failedIps.delete(ip);
    if (event.type === "admin_password_failed") {
      const ip = event.ip ?? "unknown";
      if (this.failedIps.has(ip)) return;
      // Bound attacker-controlled bookkeeping as well as the delivery queue.
      if (this.failedIps.size >= 1000) return;
      this.failedIps.set(ip, now);
    }
    if (this.queue.length >= 100) {
      logger.warn("Telegram notification queue full; alert dropped");
      return;
    }
    this.queue.push({ text: this.format(event), revision: this.revision });
    void this.drain();
  }
  private format(event: NotificationEvent) {
    const clean = (s: string) => [...s].map(char => char.charCodeAt(0) < 32 ? " " : char).join("").slice(0, 200);
    return ["StreamGram: " + LABELS[event.type], new Date(event.at).toISOString(),
      this.config.getConfig().publicUrl,
      event.name ? "Account: " + clean(event.name) : undefined,
      event.phoneLast4 ? "Phone: •••• " + event.phoneLast4 : undefined,
      event.ip ? "Connection IP: " + clean(event.ip) : undefined,
    ].filter(Boolean).join("\n");
  }
  private async pause(ms: number) {
    if (ms <= 0) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.cancelWait = undefined; resolve(); };
      const timer = setTimeout(finish, ms);
      timer.unref();
      this.cancelWait = finish;
    });
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped && this.queue.length) {
        const item = this.queue.shift();
        if (!item) break;
        let success = false;
        try {
          success = await this.deliver({ ...this.config.getNotificationSettings(), ...(item.chatId ? { chatId: item.chatId } : {}) }, item.text, item.revision, item.expires, item.valid);
        } catch {
          this.record(false, "Telegram delivery failed; check bot token, chat ID, and bot access");
        } finally { item.resolve?.(success); }
      }
    } finally { this.running = false; }
  }
  private record(success: boolean, message: string) {
    this.lastDelivery = { at: new Date().toISOString(), success, message };
    if (!success) logger.warn({ context: "notifications" }, message);
  }
  private async deliver(settings: NotificationSettings, text: string, revision: number, expires = Infinity, valid: () => boolean = () => true): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.pause(Math.max(0, Math.min(this.nextSend, expires) - Date.now()));
      if (this.stopped || revision !== this.revision || Date.now() >= expires || !valid()) return false;
      this.nextSend = Date.now() + 1000;
      const abort = new AbortController();
      this.abort = abort;
      const timeout = setTimeout(() => abort.abort(), Math.min(10_000, expires - Date.now()));
      let retryMs = (attempt + 1) * 1000;
      let retry = true;
      try {
        if (expires !== Infinity) {
          await this.verifyRecoveryChat(settings, abort.signal);
          if (Date.now() >= expires || !valid() || revision !== this.revision) return false;
        }
        const response = await fetch(`https://api.telegram.org/bot${settings.botToken}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: settings.chatId, text, link_preview_options: { is_disabled: true } }), signal: abort.signal,
        });
        const data = await response.json() as { ok?: boolean; error_code?: number; parameters?: { retry_after?: number } };
        if (revision !== this.revision || this.stopped || Date.now() >= expires || !valid()) return false;
        if (response.ok && data.ok === true) { this.record(true, "Telegram message sent"); return true; }
        const code = data.error_code ?? response.status;
        retry = code === 429 || code >= 500;
        const delay = data.parameters?.retry_after;
        if (typeof delay === "number" && Number.isFinite(delay) && delay > 0) retryMs = Math.min(delay * 1000, 2_147_483_647);
      } catch { /* Never log fetch errors: their URLs contain the bot token. */ }
      finally { clearTimeout(timeout); if (this.abort === abort) this.abort = undefined; }
      if (revision !== this.revision || this.stopped || Date.now() >= expires || !valid()) return false;
      if (!retry || attempt === 2) break;
      this.nextSend = Math.max(this.nextSend, Date.now() + retryMs);
    }
    this.record(false, "Telegram delivery failed; check bot token, chat ID, and bot access");
    return false;
  }
  private requireRecovery(settings: NotificationSettings) {
    let url: URL;
    try { url = new URL(this.config.getConfig().publicUrl); }
    catch { throw new BadRequestException("Password recovery requires a configured HTTPS public URL"); }
    if (url.protocol !== "https:" || url.username || url.password || !settings.botToken || !settings.chatId)
      throw new BadRequestException("Password recovery requires a bot token, notification chat ID, and HTTPS public URL");
  }
  async verifyRecoveryChat(settings: NotificationSettings, signal?: AbortSignal) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${settings.botToken}/getChat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: settings.chatId }),
        signal: signal ?? AbortSignal.timeout(10_000),
      });
      const data = await response.json() as { ok?: boolean; result?: { type?: string } };
      if (response.ok && data.ok && ["private", "group", "supergroup", "channel"].includes(data.result?.type ?? "")) return;
    } catch { /* Fetch errors contain bot credentials; never expose them. */ }
    throw new BadRequestException("Recovery uses the notification chat; check its chat ID and bot access");
  }
  async saveSettings(patch: NotificationSettingsDto) {
    const revision = this.config.notificationsRevision;
    const security = this.config.securityRevision;
    const settings = validateNotificationSettings({ ...patch, botToken: patch.botToken || this.config.getNotificationSettings().botToken });
    if (settings.passwordRecoveryEnabled) {
      this.requireRecovery(settings);
      await this.verifyRecoveryChat(settings);
    }
    if (settings.passwordRecoveryEnabled) this.requireRecovery(settings);
    if (revision !== this.config.notificationsRevision || security !== this.config.securityRevision) throw new BadRequestException("Notification settings changed; try again");
    this.config.updateNotificationSettings(patch);
  }
  async sendRecovery(text: string, expires: number, valid: () => boolean): Promise<boolean> {
    const settings = this.config.getNotificationSettings();
    this.requireRecovery(settings);
    if (this.stopped || this.queue.length >= 100 || !valid()) return false;
    return new Promise<boolean>(resolve => {
      this.queue.unshift({ text, chatId: settings.chatId, expires, valid, revision: this.revision, resolve });
      void this.drain();
    });
  }
  async recoveryTest() {
    const revision = this.config.notificationsRevision;
    const success = await this.sendRecovery("StreamGram: Password recovery test", Date.now() + 60_000, () => revision === this.config.notificationsRevision);
    if (!success) throw new BadRequestException("Telegram recovery test failed; check notification chat and bot access");
    return { success: true };
  }
  async test() {
    const settings = this.config.getNotificationSettings();
    if (!settings.botToken || !settings.chatId) throw new BadRequestException("Save a bot token and chat ID first");
    if (this.stopped || this.queue.length >= 100) throw new BadRequestException("Notification queue is busy; try again later");
    const success = await new Promise<boolean>(resolve => {
      this.queue.unshift({ text: "StreamGram: Test notification\n" + new Date().toISOString(), revision: this.revision, resolve });
      void this.drain();
    });
    if (!success) throw new BadRequestException("Telegram test failed or settings changed; check bot token, chat ID, and bot access");
    return { success: true };
  }
}
