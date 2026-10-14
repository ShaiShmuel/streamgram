import { ConfigService } from "@nestjs/config";
import { TelegramClient } from "teleproto";
import { TelegramClientManager } from "./telegram-client.manager";
import { InstanceConfigService } from "../user/instance-config.service";
import { TypeNotFoundError } from "teleproto/errors";

describe("Managed client lifecycle", () => {
  let manager: TelegramClientManager;
  const configuration = {
    get: (key: string) => (key === "telegram.apiId" ? 12345 : "api-hash"),
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

  const stubInitialization = (manager: TelegramClientManager) => jest.spyOn(
    manager as unknown as { initializeClient(session: string): Promise<TelegramClient> },
    "initializeClient",
  );

  it("destroys a disconnected client before replacing it", async () => {
    const old = client(), replacement = client();
    stubInitialization(manager).mockResolvedValueOnce(old).mockResolvedValueOnce(replacement);
    await manager.getOrInitializeClient("a", "session");
    Object.defineProperty(old, "connected", { value: false });
    expect(await manager.getOrInitializeClient("a", "session")).toBe(replacement);
    expect(old.destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys the old client even if disconnect fails", async () => {
    const old = client();
    stubInitialization(manager).mockResolvedValue(old);
    await manager.getOrInitializeClient("a", "session");
    (old.disconnect as jest.Mock).mockRejectedValue(new Error("socket failure"));
    await manager.removeClient("a");
    expect(old.destroy).toHaveBeenCalledTimes(1);
  });

  it("shares decoding recovery and does not disturb another account", async () => {
    const old = client(), other = client(), replacement = client();
    const init = stubInitialization(manager)
      .mockResolvedValueOnce(old).mockResolvedValueOnce(other).mockResolvedValueOnce(replacement);
    await manager.getOrInitializeClient("a", "session");
    await manager.getOrInitializeClient("b", "other");
    const results = await Promise.all([
      manager.recoverClient("a", old), manager.recoverClient("a", old),
    ]);
    expect(results).toEqual([replacement, replacement]);
    expect(init).toHaveBeenCalledTimes(3);
    expect(old.destroy).toHaveBeenCalledTimes(1);
    expect(other.disconnect).not.toHaveBeenCalled();
    expect(await manager.recoverClient("a", old)).toBe(replacement);
    expect(replacement.destroy).not.toHaveBeenCalled();
  });

  it("uses onError to recover a background decoding failure", async () => {
    const old = client(), replacement = client();
    stubInitialization(manager).mockResolvedValueOnce(old).mockResolvedValueOnce(replacement);
    await manager.getOrInitializeClient("a", "session");
    await (old as unknown as { onError: (error: Error) => Promise<void> }).onError(
      new TypeNotFoundError(3758725303, Buffer.alloc(0)),
    );
    expect(manager.isDecodeError(new Error("Could not find the input entity"), old)).toBe(true);
    expect(await manager.recoverClient("a", old)).toBe(replacement);
    expect(old.destroy).toHaveBeenCalledTimes(1);
  });

  it("stops a repeated decoding failure until the recovery cooldown expires", async () => {
    const old = client(), replacement = client(), next = client();
    const init = stubInitialization(manager)
      .mockResolvedValueOnce(old).mockResolvedValueOnce(replacement).mockResolvedValueOnce(next);
    const now = jest.spyOn(Date, "now").mockReturnValue(100_000);
    await manager.getOrInitializeClient("a", "session");
    await manager.recoverClient("a", old);
    await expect(manager.recoverClient("a", replacement)).rejects.toThrow("cooling down");
    expect(replacement.destroy).toHaveBeenCalledTimes(1);
    await expect(manager.getOrInitializeClient("a", "session")).rejects.toThrow("cooling down");
    expect(init).toHaveBeenCalledTimes(2);
    now.mockReturnValue(160_001);
    expect(await manager.getOrInitializeClient("a", "session")).toBe(next);
  });

  it("does not resurrect an account removed during recovery", async () => {
    const old = client();
    const init = stubInitialization(manager).mockResolvedValue(old);
    await manager.getOrInitializeClient("a", "session");
    const recovery = manager.recoverClient("a", old);
    const rejection = expect(recovery).rejects.toThrow("cancelled");
    await manager.removeClient("a");
    await rejection;
    expect(init).toHaveBeenCalledTimes(1);
    expect(manager.getActiveClientCount()).toBe(0);
  });

  it("does not reconnect after shutdown begins during recovery", async () => {
    const old = client();
    const init = stubInitialization(manager).mockResolvedValue(old);
    await manager.getOrInitializeClient("a", "session");
    const recovery = manager.recoverClient("a", old);
    const rejection = expect(recovery).rejects.toThrow("cancelled");
    await manager.onApplicationShutdown();
    await rejection;
    expect(init).toHaveBeenCalledTimes(1);
    await expect(manager.getOrInitializeClient("a", "session")).rejects.toThrow("shutting down");
  });

  it("keeps active playback alive past the idle cutoff and releases it idempotently", async () => {
    const active = client();
    stubInitialization(manager).mockResolvedValue(active);
    await manager.getOrInitializeClient("a", "session");
    const release = manager.retainClient(active);
    const internals = manager as unknown as {
      clients: Map<string, { lastUsed: Date }>;
      cleanupIdleClients(): Promise<void>;
    };
    const session = internals.clients.get("a");
    if (!session) throw new Error("Expected managed client");
    session.lastUsed = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await internals.cleanupIdleClients();
    expect(active.destroy).not.toHaveBeenCalled();
    release();
    release();
    await internals.cleanupIdleClients();
    expect(active.destroy).not.toHaveBeenCalled();
    session.lastUsed = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await internals.cleanupIdleClients();
    expect(active.destroy).toHaveBeenCalledTimes(1);
  });
});
