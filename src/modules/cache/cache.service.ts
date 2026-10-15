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
  private readonly messageTtl: number;
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
    this.messageTtl = this.configService.get<number>("cache.messageTtl", 7200);
    this.folderTtl = this.configService.get<number>("cache.folderTtl", 3600);
    this.channelVideosTtl = this.configService.get<number>(
      "cache.channelVideosTtl",
      1800,
    );
  }

  // Coordinate result writes, eviction, deletion and clearing.
  private writeResults<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.resultWrites.catch(() => undefined).then(operation);
    this.resultWrites = pending;
    return pending;
  }

  private pruneResultKeys(): void {
    for (const [key, expiresAt] of this.resultKeys) {
      if (expiresAt <= Date.now()) this.resultKeys.delete(key);
    }
  }

  private async setResults(key: string, streams: CacheValue, ttlMs: number): Promise<void> {
    await this.writeResults(async () => {
      await this.cacheManager.set(key, streams, ttlMs);
      this.pruneResultKeys();
      this.resultKeys.delete(key);
      this.resultKeys.set(key, Date.now() + ttlMs);
      if (this.resultKeys.size > 1000) {
        const oldest = this.resultKeys.keys().next().value;
        if (oldest !== undefined) {
          await this.cacheManager.del(oldest);
          this.resultKeys.delete(oldest);
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

  private messageKey(chatId: string, messageId: number): string {
    return `stream:${chatId}+${messageId}`;
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
    const ttlMs = ttl ? ttl * 1000 : this.defaultTtl * 1000;
    await this.cacheManager.set(key, value, ttlMs);
  }

  async del(key: string | string[]): Promise<void> {
    await this.writeResults(async () => {
      for (const item of Array.isArray(key) ? key : [key]) {
        await this.cacheManager.del(item);
        this.resultKeys.delete(item);
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
        this.searchTtl * 1000,
      );
      return true;
    } catch {
      return false;
    }
  }

  async deleteSearchResults(userToken: string, cacheKey: string): Promise<void> {
    await this.del(this.searchKey(userToken, cacheKey));
  }

  async getMessageDetails<T>(
    chatId: string,
    messageId: number,
  ): Promise<T | null> {
    const value = await this.cacheManager.get<T>(
      this.messageKey(chatId, messageId),
    );
    return value !== undefined ? value : null;
  }

  async setMessageDetails(
    chatId: string,
    messageId: number,
    value: CacheValue,
  ): Promise<boolean> {
    try {
      await this.cacheManager.set(
        this.messageKey(chatId, messageId),
        value,
        this.messageTtl * 1000,
      );
      return true;
    } catch {
      return false;
    }
  }

  async cleanup(): Promise<void> {
    // Cache-manager expires entries automatically.
  }

  async clearAll(): Promise<boolean> {
    return this.writeResults(async () => {
      const cleared = await this.cacheManager.clear();
      this.resultKeys.clear();
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
      await this.cacheManager.set(
        this.folderKey(userToken),
        value,
        this.folderTtl * 1000,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Invalidate cached user folders
   */
  async invalidateUserFolders(userToken: string): Promise<void> {
    await this.cacheManager.del(this.folderKey(userToken));
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
