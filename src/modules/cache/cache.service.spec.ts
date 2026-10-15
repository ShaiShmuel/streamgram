import { createCache } from "cache-manager";
import { CacheService, PlaybackContext } from "./cache.service";
import { ConfigService } from "@nestjs/config";

const config = { get: (_key: string, fallback: unknown) => fallback } as ConfigService;

const context: PlaybackContext = {
  session: "private-session",
  peers: [{ chatId: "123", kind: "channel", id: "123", accessHash: "9876543210987654321" }],
};
const results = [{ chatId: "123", messageId: 7 }];

describe("Cached playback references", () => {
  it("keeps references server-side, account/session-scoped, and tied to live results", async () => {
    const store = createCache();
    const cache = new CacheService(store, config);
    await cache.setSearchResults("a", "title", results, context);
    expect(await cache.getSearchResults("a", "title")).toEqual(results);
    expect(await store.get("u:a:search:title")).toEqual(expect.objectContaining({ streams: results, peers: context.peers }));
    expect(JSON.stringify(await cache.getSearchResults("a", "title"))).not.toContain("accessHash");
    expect(await cache.getPlaybackPeer("a", context.session, "123")).toEqual(context.peers[0]);
    expect(await cache.getPlaybackPeer("b", context.session, "123")).toBeUndefined();
    expect(await cache.getPlaybackPeer("a", "replacement-session", "123")).toBeUndefined();
    await store.del("u:a:search:title");
    expect(await cache.getPlaybackPeer("a", context.session, "123")).toBeUndefined();
  });

  it("does not invalidate newly refreshed results or other sources after a late failure", async () => {
    const cache = new CacheService(createCache(), config);
    await cache.setSearchResults("a", "title", results, context);
    await cache.setChannelVideos("a", "123", 0, results, context);
    await cache.setSearchResults("a", "other", [{ chatId: "456", messageId: 8 }]);
    const before = cache.getPlaybackGeneration();
    await cache.setSearchResults("a", "title", results, context);
    await cache.invalidatePlaybackResults("a", "123", 7, before);
    expect(await cache.getChannelVideos("a", "123")).toBeNull();
    expect(await cache.getSearchResults("a", "title")).toEqual(results);
    expect(await cache.getSearchResults("a", "other")).not.toBeNull();
    expect(await cache.getPlaybackPeer("a", context.session, "123")).toEqual(context.peers[0]);
  });

  it("expires streams and peers together while another live list can still supply the peer", async () => {
    const shortConfig = { get: (key: string, fallback: unknown) => key === "cache.channelVideosTtl" ? 0.02 : fallback } as ConfigService;
    const store = createCache();
    const cache = new CacheService(store, shortConfig);
    await cache.setChannelVideos("a", "123", 0, results, context);
    await cache.setSearchResults("a", "title", results, context);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(await cache.getChannelVideos("a", "123")).toBeNull();
    expect(await store.get("u:a:channel_videos:123:0")).toBeUndefined();
    expect(await cache.getPlaybackPeer("a", context.session, "123")).toEqual(context.peers[0]);
    await cache.deleteSearchResults("a", "title");
    expect(await cache.getPlaybackPeer("a", context.session, "123")).toBeUndefined();
  });
});
