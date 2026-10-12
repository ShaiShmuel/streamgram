import { HttpException } from "@nestjs/common";
import { Request } from "express";
import { InstanceConfigService } from "../user/instance-config.service";
import { ManagementService } from "./management.service";

describe("Admin password cooldown", () => {
  const windowMs = 15 * 60 * 1000;
  let now: number;
  let service: ManagementService;
  let verify: jest.Mock;
  const request = (ip = "192.0.2.1", password?: string) => ({
    ip,
    headers: {},
    socket: { remoteAddress: ip },
    get: (header: string) => header === "x-admin-password" ? password : undefined,
    res: { setHeader: jest.fn() },
  }) as unknown as Request;

  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    verify = jest.fn((password: string) => password === "12345678");
    service = new ManagementService({
      verifyAdminPassword: verify,
      publishNotification: jest.fn(),
      isManagementInitialized: () => true,
      isProtected: () => true,
    } as unknown as InstanceConfigService);
  });
  afterEach(() => jest.restoreAllMocks());

  it("shares failures across entry points and blocks verification until cooldown expires", () => {
    const login = request();
    const header = request("192.0.2.1", "wrong");
    for (let i = 0; i < 2; i++) {
      expect(service.verifyAdminPassword(login, "wrong")).toBe(false);
      expect(service.isAuthenticated(header)).toBe(false);
    }
    now += 60_000;
    expect(() => service.isAuthenticated(header)).toThrow(HttpException);
    expect(header.res?.setHeader).toHaveBeenCalledWith("Retry-After", "900");
    expect(verify).toHaveBeenCalledTimes(5);
    now += windowMs - 1;
    expect(() => service.verifyAdminPassword(login, "12345678")).toThrow(HttpException);
    expect(() => service.isAuthenticated(request("192.0.2.1", "12345678"))).toThrow(HttpException);
    expect(verify).toHaveBeenCalledTimes(5);
    expect(login.res?.setHeader).toHaveBeenCalledWith("Retry-After", "1");
    expect(service.verifyAdminPassword(request("192.0.2.2"), "12345678")).toBe(true);
    now += 1;
    expect(service.verifyAdminPassword(login, "12345678")).toBe(true);
  });

  it("bounds failure bookkeeping and rate-limits additional IPs through an overflow bucket", () => {
    for (let i = 0; i < 1000; i++) service.verifyAdminPassword(request(`192.0.${Math.floor(i / 256)}.${i % 256}`), "wrong");
    for (let i = 0; i < 4; i++) expect(service.verifyAdminPassword(request(`198.51.100.${i}`), "wrong")).toBe(false);
    expect(() => service.verifyAdminPassword(request("198.51.100.5"), "wrong")).toThrow(HttpException);
    const before = verify.mock.calls.length;
    expect(() => service.verifyAdminPassword(request("198.51.100.6"), "wrong")).toThrow(HttpException);
    expect(verify).toHaveBeenCalledTimes(before);
    expect((service as unknown as { passwordFailures: Map<string, unknown> }).passwordFailures.size).toBe(1001);
  });
  it("resets failures on success and ignores missing credentials", () => {
    const req = request();
    for (let i = 0; i < 4; i++) expect(service.verifyAdminPassword(req, "wrong")).toBe(false);
    for (let i = 0; i < 6; i++) expect(service.isAuthenticated(req)).toBe(false);
    expect(verify).toHaveBeenCalledTimes(4);
    expect(service.isAuthenticated(request("192.0.2.1", "12345678"))).toBe(true);
    for (let i = 0; i < 4; i++) expect(service.verifyAdminPassword(req, "wrong")).toBe(false);
  });

  it("expires incomplete failure windows", () => {
    const req = request();
    for (let i = 0; i < 4; i++) service.verifyAdminPassword(req, "wrong");
    now += windowMs;
    expect(service.verifyAdminPassword(req, "wrong")).toBe(false);
  });
});

describe("Admin notification events", () => {
  it("publishes failures and one lockout at the threshold, but no events for blocked retries", () => {
    const publishNotification = jest.fn();
    const service = new ManagementService({ verifyAdminPassword: () => false, publishNotification } as unknown as InstanceConfigService);
    const request = { ip: "192.0.2.1", res: { setHeader: jest.fn() } } as unknown as Request;
    for (let i = 0; i < 5; i++) { try { service.verifyAdminPassword(request, "wrong"); } catch { /* fifth fails with 429 */ } }
    expect(() => service.verifyAdminPassword(request, "wrong")).toThrow(HttpException);
    expect(publishNotification.mock.calls.filter(([event]) => event.type === "admin_password_failed")).toHaveLength(5);
    expect(publishNotification.mock.calls.filter(([event]) => event.type === "admin_lockout")).toHaveLength(1);
    expect(JSON.stringify(publishNotification.mock.calls)).not.toContain("wrong");
  });
  it("publishes success only for newly established protected sessions", () => {
    const publishNotification = jest.fn();
    const service = new ManagementService({ isProtected: () => true, securityRevision: 0, publishNotification } as unknown as InstanceConfigService);
    const request = { ip: "192.0.2.1", headers: {}, get: () => undefined } as unknown as Request;
    const response = { cookie: jest.fn() } as unknown as import("express").Response;
    const id = service.issueSession(request, response);
    expect(publishNotification).toHaveBeenCalledWith({ type: "admin_login", ip: "192.0.2.1" });
    request.headers.cookie = `streamgram_admin=${id}`;
    service.issueSession(request, response);
    expect(publishNotification).toHaveBeenCalledTimes(1);
  });
});

describe("Admin session resource limits", () => {
  it("caps active sessions and removes stale sessions when issuing a new cookie", () => {
    const config = { securityRevision: 0, isProtected: () => true, publishNotification: jest.fn() };
    const service = new ManagementService(config as unknown as InstanceConfigService);
    const request = { ip: "192.0.2.1", headers: {}, get: () => undefined } as unknown as Request;
    const response = { cookie: jest.fn() } as unknown as import("express").Response;
    const oldest = service.issueSession(request, response);
    for (let i = 0; i < 1000; i++) service.issueSession(request, response);
    const sessions = (service as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(sessions.size).toBe(1000);
    expect(sessions.has(oldest)).toBe(false);
    config.securityRevision++;
    service.issueSession(request, response);
    expect(sessions.size).toBe(1);
  });
});
