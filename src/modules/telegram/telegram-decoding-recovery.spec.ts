import { ConfigService } from "@nestjs/config";
import { Api, TelegramClient } from "teleproto";
import { TypeNotFoundError } from "teleproto/errors";
import { BinaryReader } from "teleproto/extensions/BinaryReader";
import bigInt from "big-integer";
import { TelegramClientManager } from "./telegram-client.manager";
import { TelegramNestService } from "./telegram.service";
import { CacheService } from "../cache/cache.service";
import { createCache } from "cache-manager";

jest.mock("../../logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

describe("Telegram RPC decoding recovery", () => {
  const configuration = { get: (key: string, fallback: unknown) =>
    key === "telegram.apiId" ? 12345 : key === "telegram.apiHash" ? "test" : fallback } as ConfigService;
  const peer = new Api.InputPeerChannel({ channelId: bigInt(123), accessHash: bigInt(456) });
  const message = { id: 7 };
  let manager: TelegramClientManager;
  let service: TelegramNestService;
  let cache: CacheService;
  let initialize: jest.SpyInstance;

  function makeClient(fail: boolean) {
    const invoke = jest.fn(async () => {
      if (fail) {
        const body = Buffer.alloc(4);
        body.writeUInt32LE(2533211113);
        // Exercise the real decoder with the constructor from the server log.
        new BinaryReader(body).tgReadObject();
      }
      return [message];
    });
    const client = {
      connected: true,
      invoke,
      getInputEntity: jest.fn(async () => peer),
      getMessages: jest.fn(function (this: TelegramClient, channel: Api.InputPeerChannel, options: { ids: number }) {
        return this.invoke(new Api.channels.GetMessages({ channel, id: [new Api.InputMessageID({ id: options.ids })] }));
      }),
      disconnect: jest.fn(async () => undefined),
      destroy: jest.fn(async () => undefined),
    } as unknown as TelegramClient;
    (manager as unknown as { observeRpcFailures(client: TelegramClient): void }).observeRpcFailures(client);
    return client;
  }

  beforeEach(async () => {
    manager = new TelegramClientManager(configuration);
    initialize = jest.spyOn(manager as unknown as { initializeClient(session: string): Promise<TelegramClient> }, "initializeClient");
    cache = new CacheService(createCache(), configuration);
    await cache.setMessageDetails("123", 7, {});
    service = new TelegramNestService(cache, configuration, manager);
  });
  afterEach(async () => {
    await manager.onApplicationShutdown();
    jest.restoreAllMocks();
  });
  const prepare = () => service.preparePlayback("account", "session", "123", 7, new AbortController().signal);

  it("replaces a client after a direct RPC decode failure without onError, retaining the peer", async () => {
    const old = makeClient(true), replacement = makeClient(false);
    (replacement.getInputEntity as jest.Mock).mockRejectedValue(new Error("Empty entity cache"));
    initialize.mockResolvedValueOnce(old).mockResolvedValueOnce(replacement);
    expect(await prepare()).toEqual({ client: replacement, message });
    expect(old.destroy).toHaveBeenCalledTimes(1);
    expect(replacement.getInputEntity).not.toHaveBeenCalled();
    expect(manager.getClient("account")).toBe(replacement);
  });

  it("shares one replacement across simultaneous failures and ignores late failures from the old client", async () => {
    const old = makeClient(true), replacement = makeClient(false);
    initialize.mockResolvedValueOnce(old).mockResolvedValueOnce(replacement);
    await manager.getOrInitializeClient("account", "session");
    const results = await Promise.all(Array.from({ length: 10 }, () => prepare()));
    expect(results.every(result => result.client === replacement)).toBe(true);
    expect(initialize).toHaveBeenCalledTimes(2);
    await expect(old.invoke(new Api.help.GetConfig())).rejects.toThrow("client failed");
    expect(manager.getClient("account")).toBe(replacement);
    expect(replacement.destroy).not.toHaveBeenCalled();
  });

  it("bounds repeated decoding failures, cools down, and allows subsequent recovery", async () => {
    let now = 100000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const old = makeClient(true), replacement = makeClient(true), healthy = makeClient(false);
    initialize.mockResolvedValueOnce(old).mockResolvedValueOnce(replacement).mockResolvedValueOnce(healthy);
    await expect(prepare()).rejects.toBeInstanceOf(TypeNotFoundError);
    expect(manager.getClient("account")).toBeNull();
    for (let i = 0; i < 5; i++) await expect(prepare()).rejects.toThrow("cooling down");
    expect(initialize).toHaveBeenCalledTimes(2);
    now += 31000;
    expect((await prepare()).client).toBe(healthy);
  });

  it("does not replace clients or retry ordinary RPC errors", async () => {
    const client = makeClient(false);
    (client.getMessages as jest.Mock).mockRejectedValue(new Error("CHANNEL_PRIVATE"));
    initialize.mockResolvedValue(client);
    await expect(prepare()).rejects.toThrow("CHANNEL_PRIVATE");
    expect(client.destroy).not.toHaveBeenCalled();
    expect(client.getMessages).toHaveBeenCalledTimes(1);
  });

  it("stops preparation before acquiring a client when the player disconnects", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(service.preparePlayback("account", "session", "123", 7, controller.signal)).rejects.toThrow("cancelled");
    expect(initialize).not.toHaveBeenCalled();
  });

  it("plays cached sources on new clients without re-resolving their channel, including after decoding recovery", async () => {
    await cache.setSearchResults("account", "episode", [{ chatId: "123", messageId: 7 }, { chatId: "321", messageId: 7 }], {
      session: "session", peers: [
        { chatId: "123", kind: "channel", id: "123", accessHash: "456" },
        { chatId: "321", kind: "channel", id: "321", accessHash: "654" },
      ],
    });
    const old = makeClient(true), replacement = makeClient(false);
    for (const client of [old, replacement]) {
      (client.getInputEntity as jest.Mock).mockRejectedValue(new Error("Could not find the input entity"));
    }
    initialize.mockResolvedValueOnce(old).mockResolvedValueOnce(replacement);
    expect((await prepare()).client).toBe(replacement);
    expect((await prepare()).client).toBe(replacement);
    await cache.setMessageDetails("321", 7, {});
    await service.preparePlayback("account", "session", "321", 7, new AbortController().signal);
    expect(replacement.getMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ channelId: bigInt(321), accessHash: bigInt(654) }), { ids: 7 },
    );
    expect(replacement.getInputEntity).not.toHaveBeenCalled();
    expect(await cache.getSearchResults("account", "episode")).not.toBeNull();
  });

  it("evicts the failed source list so returning to it performs a fresh lookup", async () => {
    await cache.setSearchResults("account", "episode", [{ chatId: "123", messageId: 7 }]);
    await cache.setSearchResults("other", "episode", [{ chatId: "123", messageId: 7 }]);
    const client = makeClient(false);
    (client.getInputEntity as jest.Mock).mockRejectedValue(new Error("Could not find the input entity for PeerUser"));
    initialize.mockResolvedValue(client);
    await expect(prepare()).rejects.toThrow("refresh the source list");
    expect(await cache.getSearchResults("account", "episode")).toBeNull();
    expect(await cache.getSearchResults("other", "episode")).not.toBeNull();
    expect(client.destroy).not.toHaveBeenCalled();
    (client.getInputEntity as jest.Mock).mockResolvedValue(peer);
    await cache.setSearchResults("account", "episode", [{ chatId: "123", messageId: 7 }],
      await service.getPlaybackContextForUser("account", "session", [{ chatId: "123", messageId: 7, fileName: null, fileSize: 1, mimeType: null }]));
    (client.getInputEntity as jest.Mock).mockRejectedValue(new Error("Could not find the input entity"));
    expect((await prepare()).message).toBe(message);
  });
});
