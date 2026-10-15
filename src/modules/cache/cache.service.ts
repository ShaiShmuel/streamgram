import { Injectable, Inject } from "@nestjs/common";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Cache } from "cache-manager";
import { ConfigService } from "@nestjs/config";

type CacheValue =
  | Record<string, unknown>
  | Array<unknown>
  | string
  | number
  | boolean
  | null;

@Injectable()
export class CacheService {
  private readonly defaultTtl: number;
  private readonly searchTtl: number;
  private readonly emptySearchTtl: number;
  private readonly maxEntries: number;
  private readonly entryKeys = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private clearGeneration = 0;
  private readonly folderTtl: number;
  private readonly channelVideosTtl: number;
  // Bound result entries without retaining a separate copy of their payload.
  private readonly resultKeys = new Map<string, number>();
  private resultWrites: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private configService: ConfigService,
  ) {
    this.defaultTtl = this.configService.get<number>("cache.defaultTtl", 3600);
    this.searchTtl = this.configService.get<number>("cache.searchTtl", 1800);
    this.emptySearchTtl = this.configService.get<number>("cache.emptySearchTtl", 60);
    this.maxEntries = this.configService.get<number>("cache.maxEntries", 10000);
    this.folderTtl = this.configService.get<number>("cache.folderTtl", 300);
    this.channelVideosTtl = this.configService.get<number>(
      "cache.channelVideosTtl",
      60,
    );
  }

  // Coordinate result writes, eviction, deletion and clearing.
  private writeResults<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.resultWrites.catch(() => undefined).then(operation);
    this.resultWrites = pending;
    return pending;
  }

  // Called only inside writeResults: enforce a real bound on the underlying store.
  private async setEntry<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const now = Date.now();
    for (const [expiredKey, expiresAt] of this.entryKeys) {
      if (expiresAt <= now) await this.deleteEntry(expiredKey);
    }
    if (!this.entryKeys.has(key) && this.entryKeys.size >= this.maxEntries) {
      const oldest = this.entryKeys.keys().next().value;
      if (oldest !== undefined) await this.deleteEntry(oldest);
    }
    await this.cacheManager.set(key, value, ttlMs);
    this.entryKeys.delete(key);
    this.entryKeys.set(key, ttlMs === 0 ? Infinity : now + ttlMs);
  }

  private async deleteEntry(key: string): Promise<void> {
    await this.cacheManager.del(key);
    this.entryKeys.delete(key);
    this.resultKeys.delete(key);
  }

  private async setResults(key: string, streams: CacheValue, ttlMs: number): Promise<void> {
    await this.writeResults(async () => {
      await this.setEntry(key, streams, ttlMs);
      this.resultKeys.delete(key);
      this.resultKeys.set(key, Date.now() + ttlMs);
      if (this.resultKeys.size > 1000) {
        const oldest = this.resultKeys.keys().next().value;
        if (oldest !== undefined) {
          await this.deleteEntry(oldest);
        }
      }
    });
  }

  private async getResults<T>(key: string): Promise<T | null> {
    return (await this.cacheManager.get<T>(key)) ?? null;
  }

  private searchKey(userToken: string, key: string): string {
    return `u:${userToken}:search:${key}`;
  }

  private folderKey(userToken: string): string {
    return `u:${userToken}:folders`;
  }

  private channelVideosKey(userToken: string, channelId: string, offsetId: number): string {
    return `u:${userToken}:channel_videos:${channelId}:${offsetId}`;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return await this.cacheManager.get<T>(key);
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const ttlMs = (ttl ?? this.defaultTtl) * 1000;
    await this.writeResults(() => this.setEntry(key, value, ttlMs));
  }

  async del(key: string | string[]): Promise<void> {
    await this.writeResults(async () => {
      for (const item of Array.isArray(key) ? key : [key]) {
        await this.deleteEntry(item);
      }
    });
  }

  async flushAll(): Promise<void> {
    await this.clearAll();
  }

  async getStats() {
    // The process-local cache does not expose hit/miss counters.
    return {
      keys: 0,
      hits: 0,
      misses: 0,
      ksize: 0,
      vsize: 0,
    };
  }

  async getSearchResults<T>(userToken: string, cacheKey: string): Promise<T | null> {
    return this.getResults<T>(this.searchKey(userToken, cacheKey));
  }

  async setSearchResults(
    userToken: string,
    cacheKey: string,
    value: CacheValue,
  ): Promise<boolean> {
    try {
      await this.setResults(
        this.searchKey(userToken, cacheKey),
        value,
        (Array.isArray(value) && value.length === 0 ? this.emptySearchTtl : this.searchTtl) * 1000,
      );
      return true;
    } catch {
      return false;
    }
  }

  async deleteSearchResults(userToken: string, cacheKey: string): Promise<void> {
    await this.del(this.searchKey(userToken, cacheKey));
  }

  /** Coalesce metadata reads; cache successful values and give callers independent copies. */
  async remember<T>(key: string, ttl: number | ((value: T) => number), load: () => Promise<T>): Promise<T> {
    const generation = this.clearGeneration;
    const cached = await this.get<T>(key);
    if (cached !== undefined) return structuredClone(cached);
    let pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = (async () => {
        const value = await load();
        if (value !== null && value !== undefined) {
          await this.writeResults(async () => {
            if (generation === this.clearGeneration) {
              await this.setEntry(key, structuredClone(value), (typeof ttl === "function" ? ttl(value) : ttl) * 1000);
            }
          });
        }
        return value;
      })();
      // Bound bookkeeping even during a burst of distinct requests.
      if (this.inFlight.size < this.maxEntries) this.inFlight.set(key, pending);
    }
    try {
      return structuredClone(await pending);
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  }

  async cleanup(): Promise<void> {
    // Cache-manager expires entries automatically.
  }

  async clearAll(): Promise<boolean> {
    return this.writeResults(async () => {
      this.clearGeneration++;
      this.inFlight.clear();
      const cleared = await this.cacheManager.clear();
      this.resultKeys.clear();
      this.entryKeys.clear();
      return cleared;
    });
  }

  /**
   * Get cached user folders
   */
  async getUserFolders<T>(userToken: string): Promise<T | null> {
    const value = await this.cacheManager.get<T>(this.folderKey(userToken));
    return value !== undefined ? value : null;
  }

  /**
   * Set cached user folders
   */
  async setUserFolders(userToken: string, value: CacheValue): Promise<boolean> {
    try {
      await this.set(this.folderKey(userToken), value, this.folderTtl);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Invalidate cached user folders
   */
  async invalidateUserFolders(userToken: string): Promise<void> {
    await this.del(this.folderKey(userToken));
  }

  /**
   * Get cached channel videos
   */
  async getChannelVideos<T>(
    userToken: string,
    channelId: string,
    offsetId: number = 0,
  ): Promise<T | null> {
    return this.getResults<T>(
      this.channelVideosKey(userToken, channelId, offsetId),
    );
  }

  /**
   * Set cached channel videos
   */
  async setChannelVideos(
    userToken: string,
    channelId: string,
    offsetId: number = 0,
    value: CacheValue,
  ): Promise<boolean> {
    try {
      await this.setResults(
        this.channelVideosKey(userToken, channelId, offsetId),
        value,
        this.channelVideosTtl * 1000,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Invalidate cached channel videos
   */
  async invalidateChannelVideos(userToken: string, channelId: string): Promise<void> {
    // Clear all offset variations - in production might need pattern matching
    const offsets = [0, 50, 100, 150]; // Common offsets
    await Promise.all(
      offsets.map((offset) =>
        this.del(this.channelVideosKey(userToken, channelId, offset)),
      ),
    );
  }
}
