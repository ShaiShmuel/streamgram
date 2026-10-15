import { StreamHandlerService } from "./stream-handler.service";
import { CacheService } from "../cache/cache.service";
import { createCache } from "cache-manager";
import { ConfigService } from "@nestjs/config";
import { InstanceProfile } from "../user/instance-profile";

jest.mock("../../logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

describe("Channel and folder source caching", () => {
  it.each(["channel", "folder"])("preserves complete peers in %s source lists and cache hits", async (kind) => {
    const source = { chatId: "123", messageId: 7, peer: { kind: "channel", id: "123", accessHash: "-9223372036854775808" } };
    const telegram = {
      getUserFolders: jest.fn(async () => [{ id: 1, channelIds: ["-100123"] }]),
      getChannelMessages: jest.fn(async () => [source]),
    };
    const cache = new CacheService(createCache(), { get: (_key: string, fallback: unknown) => fallback } as ConfigService);
    const handler: StreamHandlerService = Reflect.construct(StreamHandlerService, [{}, telegram, cache, {}]);
    const user = { token: "account", session_string: "session" } as InstanceProfile;
    const retrieve = () => kind === "channel"
      ? handler.getChannelVideos(user, "-100123")
      : handler.getFolderChannelVideos(user, 1, 1);
    expect(await retrieve()).toEqual([source]);
    expect(await retrieve()).toEqual([source]);
    expect(telegram.getChannelMessages).toHaveBeenCalledTimes(1);
  });
});
