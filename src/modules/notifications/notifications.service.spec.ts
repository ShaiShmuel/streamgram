import { ConfigService } from "@nestjs/config";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { InstanceConfigService } from "../user/instance-config.service";
import { NotificationsService } from "./notifications.service";
import { NOTIFICATION_EVENTS, validateNotificationSettings } from "./dto/notification-settings.dto";

const settings = { enabled: true, botToken: "123456:test-secret", chatId: "-10012345", events: [...NOTIFICATION_EVENTS] };
const response = (status = 200, data: unknown = { ok: true }) => ({ status, ok: status === 200, json: async () => data }) as Response;

describe("Telegram notifications", () => {
  let directory: string;
  let config: InstanceConfigService;
  let service: NotificationsService;
  let fetchMock: jest.SpyInstance;
  const load = () => new InstanceConfigService({ get: (key: string, fallback: unknown) => key === "storage.dataDir" ? directory : fallback } as ConfigService);
  const emit = (type: typeof NOTIFICATION_EVENTS[number] = "account_joined", ip = "192.0.2.1") => config.publishNotification({ type, name: "Alice", phoneLast4: "1234", ip });
  beforeEach(() => {
    jest.useFakeTimers();
    directory = mkdtempSync(join(tmpdir(), "streamgram-notifications-"));
    config = load();
    config.updateNotificationSettings(settings);
    service = new NotificationsService(config);
    service.onModuleInit();
    fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(response());
  });
  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });
  it("masks the token, preserves a blank token, and survives restart and restore", async () => {
    expect(service.settings()).toMatchObject({ enabled: true, botTokenConfigured: true, chatId: settings.chatId, lastDelivery: null });
    expect(JSON.stringify(service.settings())).not.toContain(settings.botToken);
    config.updateNotificationSettings({ ...settings, botToken: "" });
    expect(load().getNotificationSettings()).toEqual(settings);
    const backup = JSON.parse(config.exportRaw());
    config.updateNotificationSettings({ ...settings, enabled: false });
    const listener = jest.fn(); config.events.on("notification", listener);
    await config.importRaw(backup);
    expect(load().getNotificationSettings()).toEqual(settings);
    expect(listener).not.toHaveBeenCalled();
  });
  it("defaults to disabled with all event choices and validates persisted settings", () => {
    writeFileSync(join(directory, "config.json"), "{}");
    expect(load().getNotificationSettings()).toMatchObject({ enabled: false, events: [...NOTIFICATION_EVENTS] });
    writeFileSync(join(directory, "config.json"), JSON.stringify({ notifications: { ...settings, events: ["bad"] } }));
    expect(load).toThrow("Unable to read");
  });
  it.each([
    { ...settings, botToken: "" }, { ...settings, chatId: "" }, { ...settings, chatId: "https://bad.example" },
    { ...settings, events: ["bad"] }, { ...settings, events: ["admin_login", "admin_login"] },
    { ...settings, enabled: "true" }, { ...settings, botToken: "123:secret/invalid" }, { ...settings, unknown: true },
  ])("rejects invalid settings without changing saved state: %j", invalid => {
    expect(() => validateNotificationSettings(invalid)).toThrow();
    expect(config.getNotificationSettings()).toEqual(settings);
  });
  it("accepts private, group, and channel destinations and rejects invalid backup settings", async () => {
    for (const chatId of ["12345", "-10012345", "@my_channel"]) expect(validateNotificationSettings({ ...settings, chatId }).chatId).toBe(chatId);
    await expect(config.importRaw({ notifications: { ...settings, events: ["unknown"] } } as never)).rejects.toThrow();
    expect(config.getNotificationSettings()).toEqual(settings);
  });
  it("verifies notification chat before enabling recovery and preserves legacy backup compatibility", async () => {
    await config.update({ publicUrl: "https://stream.example" });
    const recovery = { ...settings, enabled: false, passwordRecoveryEnabled: true };
    fetchMock.mockResolvedValue(response(200, { ok: true, result: { type: "invalid" } }));
    await expect(service.saveSettings(recovery)).rejects.toThrow("notification chat");
    expect(config.getNotificationSettings()).toEqual(settings);
    fetchMock.mockResolvedValue(response(200, { ok: true, result: { type: "private" } }));
    await service.saveSettings(recovery);
    expect(service.settings()).toMatchObject({ passwordRecoveryEnabled: true, botTokenConfigured: true });
    expect(JSON.stringify(service.settings())).not.toContain(settings.botToken);
    expect(load().getNotificationSettings()).toEqual(recovery);
    await config.importRaw(JSON.parse(config.exportRaw()));
    expect(config.getNotificationSettings()).toEqual(recovery);
    for (const chatId of ["0", "https://bad.example"]) {
      expect(() => validateNotificationSettings({ ...recovery, chatId })).toThrow();
    }
    await config.update({ publicUrl: "http://stream.example" });
    await expect(service.saveSettings(recovery)).rejects.toThrow("HTTPS");
  });
  it("does not save verified settings after admin credentials change during verification", async () => {
    await config.update({ publicUrl: "https://stream.example" });
    let finish: (value: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const save = service.saveSettings({ ...settings, passwordRecoveryEnabled: true });
    const assertion = expect(save).rejects.toThrow("settings changed");
    await config.update({ adminPassword: "new-password" });
    finish(response(200, { ok: true, result: { type: "private" } }));
    await assertion;
    expect(config.getNotificationSettings()).toEqual(settings);
  });
  it("does not send a link if it expires while checking the notification chat", async () => {
    await config.update({ publicUrl: "https://stream.example" });
    config.updateNotificationSettings({ ...settings, passwordRecoveryEnabled: true });
    let finish: (value: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const sent = service.sendRecovery("expiring secret", Date.now() + 1000, () => true);
    await jest.advanceTimersByTimeAsync(1000);
    finish(response(200, { ok: true, result: { type: "private" } }));
    expect(await sent).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("sends recovery to its notification destination with alerts disabled and previews disabled", async () => {
    await config.update({ publicUrl: "https://stream.example" });
    config.updateNotificationSettings({ ...settings, enabled: false, passwordRecoveryEnabled: true });
    fetchMock.mockImplementation(async (url: string) => url.endsWith("getChat")
      ? response(200, { ok: true, result: { type: "private" } }) : response());
    const result = service.sendRecovery("secret reset link", Date.now() + 600_000, () => true);
    await jest.advanceTimersByTimeAsync(0);
    expect(await result).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toContain("getChat");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ chat_id: settings.chatId, text: "secret reset link", link_preview_options: { is_disabled: true } });
    expect(JSON.stringify(service.settings())).not.toContain("secret reset link");
    const test = service.recoveryTest();
    await jest.advanceTimersByTimeAsync(1000);
    await expect(test).resolves.toEqual({ success: true });
  });
  it.each(["private", "group", "supergroup", "channel"])("uses the restored notification destination for %s recovery", async type => {
    await config.update({ publicUrl: "https://stream.example" });
    // A legacy separate recovery destination must never override the notification destination.
    config.updateNotificationSettings({ ...settings, passwordRecoveryEnabled: true, recoveryChatId: "12345" });
    await config.importRaw(JSON.parse(config.exportRaw()));
    fetchMock.mockImplementation(async (url: string) => url.endsWith("getChat")
      ? response(200, { ok: true, result: { type } }) : response());
    const result = service.sendRecovery("reset secret", Date.now() + 600_000, () => true);
    await jest.advanceTimersByTimeAsync(0);
    expect(await result).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).chat_id).toBe(settings.chatId);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).chat_id).toBe(settings.chatId);
    expect(service.settings()).not.toHaveProperty("recoveryChatId");
  });
  it("rejects inaccessible destinations without sending a recovery link", async () => {
    await config.update({ publicUrl: "https://stream.example" });
    config.updateNotificationSettings({ ...settings, passwordRecoveryEnabled: true });
    fetchMock.mockResolvedValue(response(400, { ok: false }));
    const result = service.sendRecovery("reset secret", Date.now() + 600_000, () => true);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await result).toBe(false);
    expect(fetchMock.mock.calls.every(([url]) => url.endsWith("getChat"))).toBe(true);
  });
  it("drops expired recovery before delivery, and cancels queued recovery on settings/security changes", async () => {
    await config.update({ publicUrl: "https://stream.example" });
    config.updateNotificationSettings({ ...settings, passwordRecoveryEnabled: true });
    expect(await service.sendRecovery("expired secret", Date.now(), () => true)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    // Hold delivery in the pacing wait to exercise cancellation without external traffic.
    (service as unknown as { nextSend: number }).nextSend = Date.now() + 5000;
    const pending = service.sendRecovery("pending secret", Date.now() + 600_000, () => false);
    config.updateNotificationSettings(settings);
    await jest.advanceTimersByTimeAsync(0);
    expect(await pending).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("only emits new joins, publishes deletion once, and keeps secrets out of payloads", async () => {
    const listener = jest.fn(); config.events.on("notification", listener);
    const owner = { kind: "admin" as const, id: "admin" };
    const entry = config.completeAuthentication(owner, "+15551234", "100", "private-session", "Alice");
    config.completeAuthentication({ kind: "user", id: entry.token }, "+15551234", "100", "reconnected-session");
    config.deleteUser(entry.token); config.deleteUser(entry.token);
    expect(listener.mock.calls.map(([event]) => event.type)).toEqual(["account_joined", "account_deleted"]);
    await jest.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).toMatchObject({ chat_id: settings.chatId });
    expect(payload.text).toContain("Account: Alice");
    expect(payload.text).toContain("Phone: •••• 1234");
    expect(payload.text).not.toContain("15551234");
    expect(payload.text).not.toContain(entry.token);
    expect(payload.text).not.toContain("private-session");
  });
  it("does not publish a join when the persistence commit fails", () => {
    const listener = jest.fn(); config.events.on("notification", listener);
    jest.spyOn(config as unknown as { writePersistedConfig(): void }, "writePersistedConfig").mockImplementation(() => { throw new Error("disk full"); });
    expect(() => config.completeAuthentication({ kind: "admin", id: "admin" }, "+11111", "1", "secret")).toThrow("disk full");
    expect(listener).not.toHaveBeenCalled();
    expect(Object.keys(config.getUsers())).toHaveLength(0);
  });
  it("does not let a subscriber failure break an account operation", () => {
    config.events.on("notification", () => { throw new Error("broken subscriber"); });
    expect(() => config.completeAuthentication({ kind: "admin", id: "admin" }, "+11111", "1", "secret")).not.toThrow();
  });
  it("filters disabled and unselected events, but permits a saved-settings test", async () => {
    config.updateNotificationSettings({ ...settings, events: ["admin_login"] });
    emit(); await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
    config.updateNotificationSettings({ ...settings, enabled: false });
    emit("admin_login");
    const test = service.test();
    await jest.advanceTimersByTimeAsync(0);
    await expect(test).resolves.toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(service.settings().lastDelivery?.success).toBe(true);
  });
  it("deduplicates failed passwords per IP for a minute and sends no faster than once a second", async () => {
    emit("admin_password_failed"); emit("admin_password_failed"); emit("admin_password_failed", "192.0.2.2");
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(999); expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1); expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(59_000);
    emit("admin_password_failed"); await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("bounds pending alerts to 100", async () => {
    for (let i = 0; i < 105; i++) emit();
    await jest.advanceTimersByTimeAsync(105_000);
    expect(fetchMock).toHaveBeenCalledTimes(101); // One active plus 100 pending.
  });
  it("retries transient errors up to three attempts and respects retry_after", async () => {
    fetchMock.mockResolvedValueOnce(response(429, { ok: false, error_code: 429, parameters: { retry_after: 5 } }))
      .mockResolvedValueOnce(response(503, { ok: false })).mockResolvedValueOnce(response());
    emit(); await jest.advanceTimersByTimeAsync(4999); expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1); expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(2000); expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(service.settings().lastDelivery?.success).toBe(true);
  });
  it("limits network failures to three attempts and reports failure without throwing into the publisher", async () => {
    fetchMock.mockRejectedValue(new Error("URL containing secret"));
    expect(emit).not.toThrow();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(service.settings().lastDelivery?.success).toBe(false);
    expect(JSON.stringify(service.settings())).not.toContain("secret");
  });
  it("does not retry permanent bot failures and reports failed tests", async () => {
    fetchMock.mockResolvedValue(response(403, { ok: false, error_code: 403 }));
    const test = expect(service.test()).rejects.toThrow("Telegram test failed");
    await jest.advanceTimersByTimeAsync(0); await test;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(service.settings().lastDelivery?.success).toBe(false);
  });
  it("cancels retry waits and pending alerts when disabled or destination changes", async () => {
    fetchMock.mockResolvedValueOnce(response(429, { ok: false, error_code: 429, parameters: { retry_after: 3600 } }));
    emit(); emit(); await jest.advanceTimersByTimeAsync(0);
    config.updateNotificationSettings({ ...settings, enabled: false });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    config.updateNotificationSettings({ ...settings, chatId: "99999" });
    emit(); await jest.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).chat_id).toBe("99999");
  });
  it("aborts requests after ten seconds and cancels active work on shutdown", async () => {
    fetchMock.mockImplementation((_url: string, options: { signal?: AbortSignal | null }) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    emit(); await jest.advanceTimersByTimeAsync(0);
    const signal = fetchMock.mock.calls[0][1].signal;
    expect(signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(10_000); expect(signal.aborted).toBe(true);
    service.onModuleDestroy(); await jest.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
