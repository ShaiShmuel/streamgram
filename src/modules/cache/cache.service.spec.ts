import { createCache } from "cache-manager";
import { CacheService } from "./cache.service";
import { ConfigService } from "@nestjs/config";

const config = { get: (_key: string, fallback: unknown) => fallback } as ConfigService;
const results = [{ chatId: "123", messageId: 7, peer: { kind: "channel", id: "123", accessHash: "-987654321012345678" } }];

describe("Cached source results", () => {
  it("stores self-contained sources directly and isolates accounts", async () => {
    const store = createCache();
    const cache = new CacheService(store, config);
    await cache.setSearchResults("a", "title", results);
    expect(await cache.getSearchResults("a", "title")).toEqual(results);
    expect(await store.get("u:a:search:title")).toEqual(results);
    expect(await cache.getSearchResults("b", "title")).toBeNull();
    await cache.deleteSearchResults("a", "title");
    expect(await cache.getSearchResults("a", "title")).toBeNull();
  });

  it("bounds combined result lists to 1000 under concurrent writes", async () => {
    const cache = new CacheService(createCache(), config);
    await cache.setSearchResults("a", "oldest", results);
    await Promise.all(Array.from({ length: 1000 }, (_, i) => cache.setChannelVideos("a", String(i), 0, results)));
    expect(await cache.getSearchResults("a", "oldest")).toBeNull();
    expect(await cache.getChannelVideos("a", "0")).toEqual(results);
    expect(await cache.getChannelVideos("a", "999")).toEqual(results);
    await cache.clearAll();
    expect(await cache.getChannelVideos("a", "999")).toBeNull();
  });

  it("expires channel lists independently of search lists", async () => {
    const shortConfig = { get: (key: string, fallback: unknown) => key === "cache.channelVideosTtl" ? 0.02 : fallback } as ConfigService;
    const cache = new CacheService(createCache(), shortConfig);
    await cache.setChannelVideos("a", "123", 0, results);
    await cache.setSearchResults("a", "title", results);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(await cache.getChannelVideos("a", "123")).toBeNull();
    expect(await cache.getSearchResults("a", "title")).toEqual(results);
  });
});
