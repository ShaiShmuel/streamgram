import { Test } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Cache } from "cache-manager";
import { CacheModule } from "./cache.module";

it("configures the underlying cache TTL in milliseconds", async () => {
  let now = Date.now();
  jest.spyOn(Date, "now").mockImplementation(() => now);
  const module = await Test.createTestingModule({ imports: [
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ cache: { defaultTtl: 3600 } })] }),
    CacheModule,
  ] }).compile();
  try {
    const store = module.get<Cache>(CACHE_MANAGER);
    await store.set("default-ttl", "value");
    now += 4000;
    expect(await store.get("default-ttl")).toBe("value");
    now += 3600000;
    expect(await store.get("default-ttl")).toBeUndefined();
  } finally {
    await module.close();
    jest.restoreAllMocks();
  }
});
