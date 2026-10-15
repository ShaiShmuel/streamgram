import { ConfigService } from "@nestjs/config";
import { Api, TelegramClient } from "teleproto";
import { TypeNotFoundError } from "teleproto/errors";
import bigInt from "big-integer";
import { TelegramClientManager } from "./telegram-client.manager";
import { InstanceConfigService } from "../user/instance-config.service";

type ClientInitializer = { initializeClient(session: string): Promise<TelegramClient> };

describe("Managed client lifecycle", () => {
  let manager: TelegramClientManager;
  const configuration = {
    get: (key: string, fallback: unknown) => key === "telegram.apiId" ? 12345 : key === "telegram.apiHash" ? "api-hash" : fallback,
  } as ConfigService;
  const client = () =>
    ({
      connected: true,
      disconnect: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn().mockResolvedValue(undefined),
    }) as unknown as TelegramClient;
  beforeEach(() => {
    manager = new TelegramClientManager(configuration);
  });
  afterEach(async () => {
    await manager.onApplicationShutdown();
    jest.restoreAllMocks();
  });
  it("keeps concurrent operations alive and starts idle time after the final release", async () => {
    let now = Date.now();
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const managed = client();
    jest.spyOn(manager as unknown as ClientInitializer, "initializeClient").mockResolvedValue(managed);
    await manager.getOrInitializeClient("a", "session");
    const cleanup = () => (manager as unknown as { cleanupIdleClients(): Promise<void> }).cleanupIdleClients();
    const first = manager.retainClient(managed);
    const second = manager.retainClient(managed);
    now += 2 * 60 * 60 * 1000;
    await cleanup();
    first(); first(); // Releases must be idempotent.
    await cleanup();
    expect(managed.destroy).not.toHaveBeenCalled();
    second();
    now += 14 * 60 * 1000;
    await cleanup();
    expect(managed.destroy).not.toHaveBeenCalled();
    now += 60 * 1000;
    await cleanup();
    expect(managed.destroy).toHaveBeenCalledTimes(1);
  });

  it("rechecks activity after awaiting another client's disposal", async () => {
    let now = Date.now();
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const a = client(), b = client();
    let finish!: () => void;
    (a.disconnect as jest.Mock).mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    jest.spyOn(manager as unknown as ClientInitializer, "initializeClient").mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    await manager.getOrInitializeClient("a", "session");
    await manager.getOrInitializeClient("b", "session");
    now += 16 * 60 * 1000;
    const cleanup = (manager as unknown as { cleanupIdleClients(): Promise<void> }).cleanupIdleClients();
    const release = manager.retainClient(b);
    finish();
    await cleanup;
    expect(b.destroy).not.toHaveBeenCalled();
    release();
  });

  it("still forcibly removes a client with active operations", async () => {
    const managed = client();
    jest.spyOn(manager as unknown as ClientInitializer, "initializeClient").mockResolvedValue(managed);
    await manager.getOrInitializeClient("a", "session");
    const release = manager.retainClient(managed);
    await manager.removeClient("a");
    expect(managed.destroy).toHaveBeenCalledTimes(1);
    release();
  });

  it("protects an in-flight RPC and releases activity when it rejects", async () => {
    let now = Date.now();
    jest.spyOn(Date, "now").mockImplementation(() => now);
    let reject!: (error: Error) => void;
    const managed = Object.assign(client(), { invoke: jest.fn(() => new Promise((_, fail) => { reject = fail; })) });
    (manager as unknown as { observeRpcFailures(client: TelegramClient): void }).observeRpcFailures(managed);
    jest.spyOn(manager as unknown as ClientInitializer, "initializeClient").mockResolvedValue(managed);
    await manager.getOrInitializeClient("a", "session");
    const request = managed.invoke(new Api.help.GetConfig());
    const failure = expect(request).rejects.toThrow("RPC failed");
    now += 16 * 60 * 1000;
    const cleanup = () => (manager as unknown as { cleanupIdleClients(): Promise<void> }).cleanupIdleClients();
    await cleanup();
    expect(managed.destroy).not.toHaveBeenCalled();
    reject(new Error("RPC failed"));
    await failure;
    now += 15 * 60 * 1000;
    await cleanup();
    expect(managed.destroy).toHaveBeenCalledTimes(1);
  });

  it("cancels an initialization that finishes after deletion", async () => {
    let resolve!: (client: TelegramClient) => void;
    jest
      .spyOn(
        manager as unknown as {
          initializeClient(session: string): Promise<TelegramClient>;
        },
        "initializeClient",
      )
      .mockReturnValue(
        new Promise((r) => {
          resolve = r;
        }),
      );
    const pending = manager.getOrInitializeClient("account", "session");
    const rejected = expect(pending).rejects.toThrow("cancelled");
    const removal = manager.removeClient("account");
    const temporary = client();
    resolve(temporary);
    await Promise.all([rejected, removal]);
    expect(manager.getActiveClientCount()).toBe(0);
    expect(temporary.disconnect).toHaveBeenCalled();
    expect(temporary.destroy).toHaveBeenCalled();
  });
  it("replaces only one account's session", async () => {
    const a = client(),
      b = client(),
      replacement = client();
    const init = jest
      .spyOn(
        manager as unknown as {
          initializeClient(session: string): Promise<TelegramClient>;
        },
        "initializeClient",
      )
      .mockResolvedValueOnce(a)
      .mockResolvedValueOnce(b)
      .mockResolvedValueOnce(replacement);
    await manager.getOrInitializeClient("a", "old");
    await manager.getOrInitializeClient("b", "other");
    expect(await manager.getOrInitializeClient("a", "new")).toBe(replacement);
    expect(a.disconnect).toHaveBeenCalled();
    expect(b.disconnect).not.toHaveBeenCalled();
    expect(manager.getClient("b")).toBe(b);
    expect(init).toHaveBeenCalledTimes(3);
  });
  it("shares initialization for concurrent requests", async () => {
    const connected = client();
    const init = jest
      .spyOn(
        manager as unknown as {
          initializeClient(session: string): Promise<TelegramClient>;
        },
        "initializeClient",
      )
      .mockResolvedValue(connected);
    const results = await Promise.all([
      manager.getOrInitializeClient("a", "session"),
      manager.getOrInitializeClient("a", "session"),
    ]);
    expect(results).toEqual([connected, connected]);
    expect(init).toHaveBeenCalledTimes(1);
  });
  it("destroys a disconnected client before concurrent requests replace it", async () => {
    const old = client();
    const replacement = client();
    const init = jest.spyOn(manager as unknown as ClientInitializer, "initializeClient")
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(replacement);
    await manager.getOrInitializeClient("a", "session");
    Object.defineProperty(old, "connected", { value: false });
    const results = await Promise.all([
      manager.getOrInitializeClient("a", "session"),
      manager.getOrInitializeClient("a", "session"),
    ]);
    expect(results).toEqual([replacement, replacement]);
    expect(old.destroy).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledTimes(2);
    expect((old.destroy as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan(init.mock.invocationCallOrder[1]);
  });
  it("stops schema-error storms through Teleproto's actual error callback", async () => {
    jest.spyOn(TelegramClient.prototype, "connect").mockResolvedValue(true);
    jest.spyOn(TelegramClient.prototype, "getMe").mockResolvedValue(new Api.User({ id: bigInt(1) }));
    const destroy = jest.spyOn(TelegramClient.prototype, "destroy").mockResolvedValue(undefined);
    jest.spyOn(TelegramClient.prototype, "disconnect").mockResolvedValue(undefined);
    const managed = await (manager as unknown as ClientInitializer).initializeClient("") as TelegramClient;
    // A failing client may still report connected while shutdown is pending.
    Object.defineProperty(managed, "connected", { value: true });
    const init = jest.spyOn(manager as unknown as ClientInitializer, "initializeClient").mockResolvedValueOnce(managed);
    await manager.getOrInitializeClient("a", "session");
    const error = new TypeNotFoundError(3758725303, Buffer.alloc(0));
    for (let i = 0; i < 10; i++) await managed._errorHandler?.(error);
    expect(destroy).toHaveBeenCalledTimes(1);
    const replacement = client();
    init.mockResolvedValueOnce(replacement);
    expect(await manager.getOrInitializeClient("a", "session")).toBe(replacement);
    expect(manager.getActiveClientCount()).toBe(1);
  });
  it("rejects stale request profiles after deletion or reconnect", async () => {
    await manager.onApplicationShutdown();
    const config = {
      getConfig: () => ({ telegram: { apiId: 12345, apiHash: "hash" } }),
      getUserByToken: jest.fn().mockReturnValue(null),
    };
    manager = new TelegramClientManager(
      configuration,
      config as unknown as InstanceConfigService,
    );
    await expect(
      manager.getOrInitializeClient("deleted", "old"),
    ).rejects.toThrow("deleted");
    config.getUserByToken.mockReturnValue({ sessionString: "new" });
    await expect(
      manager.getOrInitializeClient("reconnected", "old"),
    ).rejects.toThrow("replaced");
  });
});
