import { ConfigService } from "@nestjs/config";
import { Request, Response } from "express";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { InstanceConfigService } from "../user/instance-config.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ManagementService } from "./management.service";
import { PasswordResetService } from "./password-reset.service";

const request = (ip = "192.0.2.1", cookie?: string) => ({ ip, socket: {}, headers: { cookie },
  secure: true, get: () => undefined }) as unknown as Request;
const response = () => ({ cookie: jest.fn() }) as unknown as Response;
const settings = { enabled: false, events: [], botToken: "123:secret", passwordRecoveryEnabled: true, chatId: "-10012345" };

describe("Admin password reset", () => {
  let directory: string, config: InstanceConfigService, management: ManagementService, service: PasswordResetService;
  let send: jest.Mock;
  let now: number;
  let message: string;
  let deliveryValid: () => boolean;
  const token = () => /reset-password=([A-Za-z0-9_-]{43})/.exec(message)?.[1] ?? "missing-token";
  const makeService = () => new PasswordResetService(config, { sendRecovery: send } as unknown as NotificationsService, management);
  beforeEach(async () => {
    now = 1_700_000_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    directory = mkdtempSync(join(tmpdir(), "streamgram-reset-"));
    config = new InstanceConfigService({ get: (key: string, fallback: unknown) => key === "storage.dataDir" ? directory : fallback } as ConfigService);
    await config.initialize({ adminPassword: "old-password", publicUrl: "https://stream.example" });
    config.updateNotificationSettings(settings);
    management = new ManagementService(config);
    send = jest.fn(async (text: string, _expires: number, valid: () => boolean) => { message = text; deliveryValid = valid; return true; });
    service = makeService();
  });
  afterEach(() => { jest.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });
  it("uses the saved URL and disabled-alert recovery, stores only a hash, and does not replace a pending link", () => {
    expect(service.request(request())).toEqual({ success: true });
    const original = token();
    expect(message).toContain("https://stream.example/#reset-password=");
    expect(send.mock.calls[0][1]).toBe(now + 600_000);
    expect(JSON.stringify(service)).not.toContain(original);
    service.request(request("192.0.2.2"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(token()).toBe(original);
  });
  it("accepts immediately before expiry, invalidates old sessions and admin attempts, clears lockouts and signs in", async () => {
    const oldResponse = response();
    const id = management.issueSession(request(), oldResponse);
    const oldRequest = request("192.0.2.1", `streamgram_admin=${id}`);
    for (let i = 0; i < 5; i++) try { management.verifyAdminPassword(request(), "wrong"); } catch { /* lockout */ }
    service.request(request());
    now += 599_999;
    const result = response();
    await service.complete(token(), "new-password", request(), result);
    expect(config.verifyAdminPassword("new-password")).toBe(true);
    expect(config.verifyAdminPassword("old-password")).toBe(false);
    expect(management.isAuthenticated(oldRequest)).toBe(false);
    expect(() => management.validateOwner({ kind: "admin", id })).toThrow("expired");
    expect(management.verifyAdminPassword(request(), "new-password")).toBe(true);
    expect(result.cookie).toHaveBeenCalledWith("streamgram_admin", expect.any(String), expect.objectContaining({ httpOnly: true, secure: true, sameSite: "strict", maxAge: 28_800_000 }));
    const newId = (result.cookie as jest.Mock).mock.calls[0][1];
    expect(management.isAuthenticated(request("192.0.2.1", `streamgram_admin=${newId}`))).toBe(true);
    await expect(service.complete(token(), "other-password", request(), response())).rejects.toThrow("invalid or expired");
  });
  it("rejects at exactly ten minutes and rejects invalid tokens without changing the password", async () => {
    service.request(request());
    await expect(service.complete("bad", "new-password", request(), response())).rejects.toThrow("invalid or expired");
    now += 600_000;
    await expect(service.complete(token(), "new-password", request(), response())).rejects.toThrow("invalid or expired");
    expect(config.verifyAdminPassword("old-password")).toBe(true);
  });
  it("allows only one concurrent completion", async () => {
    service.request(request());
    const results = await Promise.allSettled([service.complete(token(), "new-password", request(), response()), service.complete(token(), "other-password", request(), response())]);
    expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected"]);
  });
  it("allows retry after a failed config write and preserves the existing password", async () => {
    service.request(request());
    const write = jest.spyOn(config as unknown as { writePersistedConfig(): void }, "writePersistedConfig").mockImplementationOnce(() => { throw new Error("disk full"); });
    await expect(service.complete(token(), "new-password", request(), response())).rejects.toThrow("disk full");
    expect(config.verifyAdminPassword("old-password")).toBe(true);
    write.mockRestore();
    await expect(service.complete(token(), "new-password", request(), response())).resolves.toEqual({ success: true });
  });
  it.each(["password", "protection", "settings", "restore", "restart", "public URL"])("invalidates on %s", async change => {
    service.request(request());
    const oldToken = token();
    if (change === "password") await config.update({ adminPassword: "changed-password" });
    if (change === "protection") await config.update({ adminProtection: false });
    if (change === "settings") config.updateNotificationSettings(settings);
    if (change === "restore") await config.importRaw(JSON.parse(config.exportRaw()));
    if (change === "restart") service = makeService();
    if (change === "public URL") await config.update({ publicUrl: "https://new.example" });
    await expect(service.complete(oldToken, "new-password", request(), response())).rejects.toThrow("invalid or expired");
    if (change !== "restart") expect(deliveryValid()).toBe(false);
  });
  it.each([false, "throw"])("invalidates failed delivery: %s", async failure => {
    send.mockImplementationOnce(async (text: string) => { message = text; if (failure === "throw") throw new Error("delivery failed"); return false; });
    service.request(request());
    await Promise.resolve(); await Promise.resolve();
    await expect(service.complete(token(), "new-password", request(), response())).rejects.toThrow("invalid or expired");
  });
  it("bounds requests per connection IP and delivery attempts globally without leaking configuration", async () => {
    send.mockResolvedValue(false);
    for (let i = 0; i < 5; i++) {
      service.request(request());
      await Promise.resolve(); await Promise.resolve();
      now += 60_000;
    }
    expect(send).toHaveBeenCalledTimes(5);
    expect(service.request(request())).toEqual({ success: true });
    expect(send).toHaveBeenCalledTimes(5);
    service.request(request("192.0.2.2"));
    expect(send).toHaveBeenCalledTimes(6);
    now += 15 * 60_000;
    service.request(request());
    expect(send).toHaveBeenCalledTimes(7);
    config.updateNotificationSettings({ ...settings, passwordRecoveryEnabled: false });
    expect(service.request(request("192.0.2.3"))).toEqual({ success: true });
    expect(send).toHaveBeenCalledTimes(7);
  });
  it("leaves personal account credentials usable", async () => {
    const user = config.completeAuthentication({ kind: "admin", id: "admin" }, "+11111", "1", "private-session");
    service.request(request());
    await service.complete(token(), "new-password", request(), response());
    const req = { get: () => `Bearer ${user.token}` } as unknown as Request;
    expect(management.personalToken(req)).toBe(user.token);
    expect(config.getUserByToken(user.token)?.sessionString).toBe("private-session");
  });
});
