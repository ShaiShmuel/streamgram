import { BadRequestException, Injectable } from "@nestjs/common";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { Request, Response } from "express";
import { InstanceConfigService } from "../user/instance-config.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ManagementService } from "./management.service";

const TTL = 10 * 60_000;
interface Reset {
  hash: string;
  expires: number;
  security: number;
  notifications: number;
  claimed: boolean;
  publicUrl: string;
}
@Injectable()
export class PasswordResetService {
  private pending?: Reset;
  private requests = new Map<string, { count: number; expires: number }>();
  private nextDelivery = 0;
  constructor(private readonly config: InstanceConfigService,
    private readonly notifications: NotificationsService,
    private readonly management: ManagementService) {}

  private valid(reset: Reset) {
    return this.pending === reset && reset.expires > Date.now() &&
      reset.security === this.config.securityRevision &&
      reset.notifications === this.config.notificationsRevision &&
      reset.publicUrl === this.config.getConfig().publicUrl &&
      this.config.isProtected() && this.config.isManagementInitialized();
  }
  request(request: Request) {
    const success = { success: true };
    const now = Date.now();
    for (const [ip, entry] of this.requests) if (entry.expires <= now) this.requests.delete(ip);
    const ip = request.ip || request.socket.remoteAddress || "unknown";
    const previous = this.requests.get(ip);
    if ((!previous && this.requests.size >= 1000) || (previous && previous.count >= 5)) return success;
    this.requests.set(ip, { count: (previous?.count ?? 0) + 1, expires: previous?.expires ?? now + 15 * 60_000 });
    if (this.pending && this.valid(this.pending)) return success;
    this.pending = undefined;
    const settings = this.config.getNotificationSettings();
    if (!settings.passwordRecoveryEnabled || !this.config.isProtected() || !this.config.isManagementInitialized() || now < this.nextDelivery) return success;
    let url: URL;
    try { url = new URL(this.config.getConfig().publicUrl); }
    catch { return success; }
    if (url.protocol !== "https:" || url.username || url.password) return success;
    this.nextDelivery = now + 60_000;
    const token = randomBytes(32).toString("base64url");
    const reset: Reset = { hash: this.hash(token), expires: now + TTL,
      security: this.config.securityRevision, notifications: this.config.notificationsRevision, claimed: false, publicUrl: this.config.getConfig().publicUrl };
    this.pending = reset;
    url = new URL("/", url);
    url.hash = `reset-password=${token}`;
    void this.notifications.sendRecovery(`StreamGram: Reset admin password\n${url.href}\nThis link can be used once and expires in 10 minutes. If you did not request this, ignore it.`,
      reset.expires, () => this.valid(reset)).then(delivered => {
        if (!delivered && this.pending === reset) this.pending = undefined;
      }).catch(() => { if (this.pending === reset) this.pending = undefined; });
    return success;
  }
  async complete(token: string, password: string, request: Request, response: Response) {
    const reset = this.pending;
    if (!reset || reset.claimed || !this.valid(reset) || !timingSafeEqual(Buffer.from(reset.hash, "hex"), Buffer.from(this.hash(token), "hex")))
      throw new BadRequestException("Reset link is invalid or expired. Request a new link.");
    reset.claimed = true;
    try {
      // update commits synchronously before returning its promise; claiming closes the concurrency gap.
      await this.config.update({ adminPassword: password });
    } catch (error) { reset.claimed = false; throw error; }
    this.pending = undefined;
    this.management.clearPasswordFailures();
    this.management.issueSession(request, response);
    return { success: true };
  }
  private hash(token: string) { return createHash("sha256").update(token).digest("hex"); }
}
