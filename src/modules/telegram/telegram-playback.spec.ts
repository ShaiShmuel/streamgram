import { TelegramClient } from "teleproto";
import { TypeNotFoundError } from "teleproto/errors";
import { TelegramNestService } from "./telegram.service";

jest.mock("../../logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

describe("Playback metadata recovery", () => {
  const old = {} as TelegramClient;
  const replacement = {} as TelegramClient;
  let releases: jest.Mock[];
  let manager: {
    getOrInitializeClient: jest.Mock;
    retainClient: jest.Mock;
    isDecodeError: jest.Mock;
    recoverClient: jest.Mock;
  };
  let service: TelegramNestService;
  let lookup: jest.SpyInstance;
  const decodeError = () => new TypeNotFoundError(3758725303, Buffer.alloc(0));

  beforeEach(() => {
    releases = [];
    manager = {
      getOrInitializeClient: jest.fn().mockResolvedValue(old),
      retainClient: jest.fn(() => { const release = jest.fn(); releases.push(release); return release; }),
      isDecodeError: jest.fn((error) => error instanceof TypeNotFoundError),
      recoverClient: jest.fn().mockResolvedValue(replacement),
    };
    service = Reflect.construct(TelegramNestService, [{}, { get: () => ({}) }, manager]);
    lookup = jest.spyOn(service, "getMessageWithCache");
  });

  it("retries with the recovered client and retains it until response completion", async () => {
    const message = {};
    lookup.mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { cause: decodeError() }))
      .mockResolvedValueOnce(message);
    const playback = await service.preparePlayback("a", "session", "1", 2, new AbortController().signal);
    expect(manager.recoverClient).toHaveBeenCalledWith("a", old);
    expect(lookup.mock.calls.map((args) => args[0])).toEqual([old, replacement]);
    expect(playback.client).toBe(replacement);
    expect(playback.message).toBe(message);
    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(releases[1]).not.toHaveBeenCalled();
    playback.release();
    expect(releases[1]).toHaveBeenCalledTimes(1);
  });

  it("does not retry ordinary lookup failures", async () => {
    lookup.mockRejectedValue(new Error("CHANNEL_PRIVATE"));
    await expect(service.preparePlayback("a", "session", "1", 2, new AbortController().signal))
      .rejects.toThrow("CHANNEL_PRIVATE");
    expect(manager.recoverClient).not.toHaveBeenCalled();
    expect(releases[0]).toHaveBeenCalledTimes(1);
  });

  it("retries an entity lookup that wrapped a background decoding failure", async () => {
    manager.isDecodeError.mockImplementation((_error, client) => client === old);
    lookup.mockRejectedValueOnce(new Error("Could not find the input entity"))
      .mockResolvedValueOnce({});
    const playback = await service.preparePlayback("a", "session", "1", 2, new AbortController().signal);
    expect(manager.isDecodeError).toHaveBeenCalledWith(expect.any(Error), old);
    expect(playback.client).toBe(replacement);
    playback.release();
  });

  it("retries only once when decoding keeps failing", async () => {
    lookup.mockRejectedValue(decodeError());
    await expect(service.preparePlayback("a", "session", "1", 2, new AbortController().signal))
      .rejects.toBeInstanceOf(TypeNotFoundError);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(manager.recoverClient).toHaveBeenCalledTimes(2);
    expect(manager.recoverClient).toHaveBeenLastCalledWith("a", replacement);
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it("does not reconnect after the player disconnects during lookup", async () => {
    const controller = new AbortController();
    lookup.mockImplementation(async () => { controller.abort(); throw decodeError(); });
    await expect(service.preparePlayback("a", "session", "1", 2, controller.signal)).rejects.toThrow();
    expect(manager.recoverClient).not.toHaveBeenCalled();
    expect(releases[0]).toHaveBeenCalledTimes(1);
  });
});
