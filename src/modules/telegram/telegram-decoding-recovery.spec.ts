import { ConfigService } from "@nestjs/config";
import { Api, TelegramClient } from "teleproto";
import { TypeNotFoundError } from "teleproto/errors";
import { BinaryReader } from "teleproto/extensions/BinaryReader";
import bigInt from "big-integer";
import { TelegramClientManager } from "./telegram-client.manager";
import { TelegramNestService } from "./telegram.service";
import { PlaybackPeer } from "./types";
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
  const prepare = () => service.preparePlayback("account", "session", { kind: "channel", id: "123", accessHash: "456" }, 7, new AbortController().signal);

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
    await expect(service.preparePlayback("account", "session", { kind: "channel", id: "123", accessHash: "456" }, 7, controller.signal)).rejects.toThrow("cancelled");
    expect(initialize).not.toHaveBeenCalled();
  });

  it.each<PlaybackPeer>([
    { kind: "chat", id: "123" },
    { kind: "user", id: "123", accessHash: "9223372036854775807" },
    { kind: "channel", id: "123", accessHash: "-9223372036854775808" },
  ])("constructs the correct input peer for $kind", async (reference) => {
    const client = makeClient(false);
    (client.getMessages as jest.Mock).mockResolvedValue([message]);
    initialize.mockResolvedValue(client);
    await service.preparePlayback("account", "session", reference, 7, new AbortController().signal);
    const input = (client.getMessages as jest.Mock).mock.calls[0][0];
    if (reference.kind === "chat") {
      expect(input).toBeInstanceOf(Api.InputPeerChat);
      expect(input.chatId.toString()).toBe(reference.id);
    } else {
      expect(input).toBeInstanceOf(reference.kind === "user" ? Api.InputPeerUser : Api.InputPeerChannel);
      expect(input.accessHash.toString()).toBe(reference.accessHash);
      expect((input.userId ?? input.channelId).toString()).toBe(reference.id);
    }
    expect(client.getInputEntity).not.toHaveBeenCalled();
  });

  it("plays a saved URL with empty caches and a new client", async () => {
    await cache.clearAll();
    const client = makeClient(false);
    (client.getInputEntity as jest.Mock).mockRejectedValue(new Error("Empty entity cache"));
    initialize.mockResolvedValue(client);
    jest.spyOn(service, "getFileSize").mockReturnValue(1);
    await service.preparePlayback("account", "session",
      { kind: "channel", id: "321", accessHash: "-9223372036854775808" }, 7, new AbortController().signal);
    expect(client.getMessages).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: bigInt(321), accessHash: bigInt("-9223372036854775808") }), { ids: 7 },
    );
    expect(client.getInputEntity).not.toHaveBeenCalled();
  });
});
