import { createCache } from "cache-manager";
import { CacheService } from "./cache.service";
import { ConfigService } from "@nestjs/config";

const config = { get: (_key: string, fallback: unknown) => fallback } as ConfigService;
const results = [{ chatId: "123", messageId: 7, peer: { kind: "channel", id: "123", accessHash: "-987654321012345678" } }];

describe("Cached source results", () => {
  afterEach(() => jest.restoreAllMocks());

  it("expires empty searches after a minute while retaining positive searches and folders", async () => {
    let now = Date.now();
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const cache = new CacheService(createCache(), config);
    await cache.setSearchResults("a", "empty", []);
    await cache.setSearchResults("a", "found", results);
    await cache.setUserFolders("a", [{ id: 1 }]);
    now += 60001;
    expect(await cache.getSearchResults("a", "empty")).toBeNull();
    expect(await cache.getSearchResults("a", "found")).toEqual(results);
    expect(await cache.getUserFolders("a")).toEqual([{ id: 1 }]);
    now += 240000;
    expect(await cache.getUserFolders("a")).toBeNull();
    now += 1500000;
    expect(await cache.getSearchResults("a", "found")).toBeNull();
  });

  it("bounds the actual store across metadata, tags, folders and source results", async () => {
    const store = createCache();
    const cache = new CacheService(store, new ConfigService({ cache: { maxEntries: 3 } }));
    await cache.set("tag", "sent");
    await cache.setUserFolders("a", []);
    await cache.setSearchResults("a", "found", results);
    await cache.remember("metadata", 3600, async () => ({ title: "Movie" }));
    expect(await store.get("tag")).toBeUndefined();
    expect(await cache.getSearchResults("a", "found")).toEqual(results);
    await cache.clearAll();
    expect(await cache.get("metadata")).toBeUndefined();
  });

  it("coalesces metadata requests, isolates mutable results and retries failures", async () => {
    const cache = new CacheService(createCache(), config);
    const loader = jest.fn(async () => ({ titles: ["Original"] }));
    const values = await Promise.all(Array.from({ length: 10 }, () => cache.remember("metadata", 60, loader)));
    expect(loader).toHaveBeenCalledTimes(1);
    values[0].titles[0] = "Mutated";
    expect(values[1].titles[0]).toBe("Original");
    expect(await cache.remember("metadata", 60, loader)).toEqual({ titles: ["Original"] });
    const failed = jest.fn().mockRejectedValueOnce(new Error("upstream")).mockResolvedValueOnce(null).mockResolvedValueOnce("ok");
    await expect(cache.remember("failed", 60, failed)).rejects.toThrow("upstream");
    expect(await cache.remember("failed", 60, failed)).toBeNull();
    expect(await cache.remember("failed", 60, failed)).toBe("ok");
    expect(failed).toHaveBeenCalledTimes(3);
  });

  it("does not repopulate a cleared cache from an older pending lookup", async () => {
    const cache = new CacheService(createCache(), config);
    let finish!: (value: string) => void;
    const loader = jest.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const pending = cache.remember("metadata", 60, loader);
    while (!finish) await Promise.resolve();
    await cache.clearAll();
    finish("old");
    expect(await pending).toBe("old");
    expect(await cache.get("metadata")).toBeUndefined();
  });

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
