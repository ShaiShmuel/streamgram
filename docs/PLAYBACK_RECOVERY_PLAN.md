# Reliable playback after idle cleanup or restart

Date: 2026-10-15
Status: RPC recovery and the bounded in-memory playback-cache iteration are implemented locally. Durable disk persistence remains a future design, not an implemented feature.

## Implementation review

The current implementation stores one internal envelope `{ streams, peers, sessionScope, generation }` per result-cache entry, directly in the existing CacheService. Streams and peer references expire or are deleted together. A bounded index of up to 1,000 keys and expiration times supports lookup from watch URLs; it holds no duplicated streams or peers. Only references for returned sources are captured, scoped to the account/session. Public getters return only streams, never access hashes. Both global search and channel/folder result caches use this envelope. The separate playback-cache implementation was removed; its focused tests now live alongside CacheService.

A missing input entity invalidates the originating list for that account, unless a newer generation replaced it while the request was in flight. Returning to the source list can then perform a fresh search. Stored peer references also let subsequent watch requests use a replacement client without re-searching.

RPC decoding failures invalidate the managed client. Playback preparation retries once using the replacement; parallel recovery shares disposal/initialization, and repeated decoding failures trigger a short cooldown. The existing decoding tests were retained because they exercise different failure modes. Added tests cover cache isolation, expiration, late failures, and returning to a source list.

After completing the local reproduction, the temporary timeout configuration was removed. Clients again expire after one hour idle, checked every thirty minutes. The local server runs without fault injection. Fault-injection code was kept outside the repository.

Limitations: references are not durable across restart; an expired/evicted list needs rediscovery. We cannot force a Stremio client to reload a list already held internally. HTTP stream-list responses use `private, no-store`. General search-request coalescing and durable peer storage from the original design are deferred.

Verification after consolidating the cache: all 427 tests across 19 suites passed, and the TypeScript build passed. Lint reported no errors and 140 existing warnings. Before this structural refactor, a live local search returned six sources without peer metadata and with the expected cache-control header. A 1,024-byte range request returned HTTP 206 before idle cleanup. After cleanup, the same URL and a second source both returned HTTP 206 without another search; the first request also recovered from an injected decoding failure. This verifies playback startup, not full-length playback or production stability.

## Revised next step: invalidate failed results and retain peer references with cached streams

Updated after the local decoding-recovery experiment on 2026-10-15. This section supersedes the delivery order below for the next iteration. The persistent peer store remains a later enhancement; this iteration is a bounded in-memory solution tied to stream-result caches.

### A. Targeted invalidation on unresolved playback peers

- Introduce a typed playback-peer resolution error at the point where entity resolution fails. Do not classify every playback exception as stale search data.
- Track which internal result-cache entries returned each account-scoped `(peer kind, chat ID, message ID)` source. Include global searches and channel/folder video listings; their existing cache key formats differ.
- Store this reverse index with bounded lifetime/size and cache-entry generations. Handle concurrent insertions and expiration; a failure from an old generation must not evict a newly refreshed result.
- If playback cannot resolve its peer, invalidate the corresponding result-cache entries for that account. If the peer itself is unresolved, related cached results from the same peer can be invalidated through the same index.
- Do not clear other accounts, all searches, or results for player cancellation, invalid ranges, ordinary network errors, or a decoding failure that recovers successfully.
- If no reverse mapping remains, return a controlled error and record the missing mapping; do not pretend the stale entry was removed.
- The next stream-list request that reaches StreamGram must perform a fresh Telegram lookup rather than return the invalidated entry. Coalesce simultaneous refreshes.
- This cannot force Stremio to discard a stream list it already holds or to request a new list. Retrying the existing watch URL is not a stream-list refresh. Test these two user flows separately.

### B. Keep usable peer references alongside cached stream results

- Cache an internal envelope containing the returned results and deduplicated peer references for only the sources actually returned to the user.
- References contain explicit peer kind, ID, and a usable account-specific access hash for channels. Capture them from discovered Telegram entities before returning the results, without treating incomplete/min entities as reusable references.
- Use a bounded account-scoped lookup index so a watch request can find the reference by source identity; the watch URL does not contain the originating search key.
- Resolve playback directly with the stored InputPeerChannel/InputPeerChat, independently of the current client's entity cache. New requests and simultaneous player probes must benefit, not only the original retry.
- Make expiration coherent across envelopes and the lookup index. If several result entries refer to the same peer, expiring one must not invalidate references still needed by another live entry. Concurrent cache refreshes must not lose mappings.
- Keep all reference metadata server-side. Existing search APIs must unwrap only their public results; never serialize access hashes in search responses, Stremio JSON, URLs, or logs.
- No disk persistence is included in this iteration. After all relevant cached entries expire or the server restarts, old URLs may still require rediscovery; this limitation is deliberate and does not replace the later durable-store design.

### Acceptance tests for this iteration

1. A cached source whose peer cannot be resolved invalidates its originating result entry; the next server-side stream-list request performs a real search.
2. Unrelated entries and other accounts remain untouched, and a delayed failure cannot remove a newer generation.
3. Cache a stream list, replace the Telegram client, then play both the original source and another returned source without a fresh search.
4. Concurrent playback requests after replacement all resolve through stored peer references.
5. Channel/folder cache entries are handled as well as global-search entries.
6. Expiration and account deletion remove index data; shared references remain while still needed by live entries.
7. API/URL serialization never exposes access hashes.
8. Repeat the injected decoding failure and verify playback through HTTP, including range requests, after replacement. Record preparation success and response completion with safe request IDs so logs distinguish parallel requests.
9. Separately verify a genuine empty search result: invalidation must not manufacture matches or misclassify filtering as a transport failure.

## Objective

The remainder records the original longer-term design, including disk persistence. It is not a description of the currently delivered in-memory implementation.

An existing Stremio playback URL should continue to work after StreamGram disposes of an idle Telegram client or restarts, provided the account still has access to the channel and the message still exists. Users should not need to return to search to make an old stream playable.

Also handle Telegram response-decoding failures during playback preparation with bounded recovery, rather than relying exclusively on background error callbacks.

## Findings and limits of the evidence

The investigation covered commit `4196802` and the supplied October 14–15 server log.

1. The manager removes clients idle for more than one hour, checking every 30 minutes. This destroys their in-memory entity information. Failure is conditional, not inevitable exactly one hour after playback.
2. Existing playback URLs contain a chat ID and message ID, but no durable account-scoped channel reference. `getMessageWithCache` passes the ID to `getInputEntity`. With an empty entity cache, an unmarked positive channel ID can be interpreted as a user ID.
3. A local reproduction confirmed that the same ID resolves to a channel with a populated entity cache and produces the reported `PeerUser` error with an empty cache and a simulated Telegram response.
4. Search results returned from the application cache do not repopulate the new Telegram client's entity cache. A real Telegram search often does, explaining why searching again can restore playback.
5. The message-details cache stores descriptive metadata, not everything needed to fetch the message. `getMessageWithCache` still requests the message from Telegram on a cache hit.
6. Separately, the log contains old message/channel constructor IDs that teleproto 1.229.1 cannot decode. Replaying the logged message bytes locally reproduced the decoding failure. The reason Telegram returned those constructors is not established.
7. The previous fix handles background `onError` notifications. RPC result decoding errors can reject `getMessages` directly without invoking that callback. The log does show the previous fix eventually destroying and replacing the client after a background failure; it does not establish successful playback afterward.
8. Search TTL is configured as 30 minutes, but the log contains an unexpectedly old cache hit. Verify actual TTL behavior and the deployed configuration separately; do not assume synchronized expiration would solve playback.

## 1. Add an account-scoped peer reference store

Create `src/modules/telegram/telegram-peer-store.service.ts`, its tests, and provider registration in `telegram.module.ts`.

Maintain one reference per account and peer, shared by all streams from that peer:

```typescript
interface StoredPeerReference {
  kind: "channel" | "chat";
  id: string;
  accessHash?: string; // Required for a reusable channel reference.
  username?: string;   // Optional public-channel recovery hint.
  updatedAt: string;
}
```

- Key records by account token, peer kind, and canonical ID. A numeric ID alone is not a globally unambiguous peer identity.
- Store Telegram IDs and hashes as decimal strings to preserve 64-bit precision.
- Keep references in application memory independently of individual Telegram clients.
- Persist a versioned representation in `telegram-peers.json` under the configured private data directory. Use atomic replacement, serialized writes, and restrictive permissions consistent with existing configuration storage.
- Persist newly learned or changed usable references before returning newly generated stream results. Batch discoveries from one operation and avoid rewriting unchanged records or writing on every media chunk.
- Record persistence failures clearly; memory-only operation may continue, but must not be reported as restart-safe.
- Do not persist entire Telegram clients, message objects, raw responses, media bytes, or session strings in this file.
- Reject incomplete/minimal channel entities as durable access references; do not overwrite a known usable hash with incomplete data.
- Validate loaded records and account ownership. A corrupt derived store must not damage `config.json`; preserve diagnostic evidence and rebuild references when possible.

No fixed one-hour TTL is needed for these references. They are reusable addressing information and are refreshed on discovery or a relevant resolution failure. Authorization remains enforced by Telegram on every request.

## 2. Capture peer references wherever playable results are discovered

Update `telegram.service.ts` and the relevant channel/catalog discovery flows.

- Capture usable channel entities from global search responses, joined-channel discovery, dialog loading, channel lookups, and channel-video listing.
- Pass explicit account context into these operations. Never infer ownership from the first configured account or reuse another account's hash.
- Capture references before reducing Telegram results to `MediaSearchResult` objects.
- Preserve peer kind internally for new results. Build channel references explicitly rather than relying on positive-ID guessing.
- Keep the current public playback route compatible: `/:userToken/watch/:chatId/:messageId`.
- Do not put access hashes in URLs, Stremio responses, or logs.
- Preserve explicit basic-group handling. Do not globally prepend `-100` to every chat ID.

All streams from one channel use one stored channel reference. There is no need to duplicate it for every message.

## 3. Resolve playback independently of the client's entity cache

Add a peer-resolution helper and update `getMessageWithCache` and its caller in `stream.controller.ts` to include explicit account context.

Resolution order:

1. Interpret marked IDs and known peer kinds correctly, including existing legacy URLs.
2. Read the account-scoped stored reference. Construct `Api.InputPeerChannel` with its channel ID and access hash, or `Api.InputPeerChat` for a known basic group.
3. If the store has no reference, use a usable entity already known to the current managed client and persist it.
4. If still unresolved, try a known public username, verifying that it resolves to the requested channel ID before accepting it.
5. For joined channels/groups, perform a bounded, paginated dialog lookup using the same account. Coalesce concurrent lookup requests and retain discovered references.
6. If resolution remains impossible, return a controlled unavailable-source response. Do not guess a user peer from an ambiguous positive ID or launch an unrestricted global media search.

Add configurable limits for fallback lookup time and pages. Stop promptly when the HTTP request is cancelled. A bare ID for an unknown, unjoined private channel cannot always be recovered; existing legacy links without saved references are best-effort until rediscovery.

On a specific stale-reference error, allow one reference refresh. Distinguish it from access denial, deleted messages, revoked sessions, rate limits, and transport failures; these must not all trigger a dialog scan.

After resolving the peer, fetch the message fresh from Telegram. This obtains current media information and file references. Existing byte-range streaming behavior remains in place.

## 4. Preserve isolation across account lifecycle changes

Integrate reference invalidation with account deletion, logout, session replacement, and backup restore.

- Idle cleanup and ordinary client recovery keep references.
- Account deletion/logout removes its references from memory and disk.
- Session replacement conservatively invalidates the account's references so a replacement Telegram identity cannot inherit them.
- Restore invalidates the derived store before restored accounts are used; this file need not become a required part of the configuration backup format.
- Associate asynchronous discovery/persistence with an account generation and reject stale writes after deletion, replacement, or restore.
- Coalesce work only within the same account and generation.

Locate all lifecycle entry points before implementation; updating just one controller is insufficient. Use a shared invalidation mechanism without introducing a circular dependency between configuration storage and Telegram services.

## 5. Extend bounded decoding recovery to playback RPCs

Update `telegram-client.manager.ts`, playback preparation, and their tests.

- Preserve typed errors or their causes. The current generic error wrapper in `getMessageWithCache` must not hide `TypeNotFoundError` from recovery logic.
- Provide a manager operation that invalidates a specific failed client only if it is still the current client for that account. A late failure must not destroy a newer healthy replacement.
- Coalesce concurrent recovery so simultaneous requests share one replacement initialization.
- When message retrieval fails with a decoding error before response headers/media bytes are sent, destroy the failed client, obtain a new client through `TelegramClientManager`, resolve the peer from the durable store, and retry preparation once.
- Keep the existing background error handler and route it through compatible lifecycle handling.
- Ensure the client used to retrieve the final message is also the client used to download it; never continue streaming with the destroyed client.
- If the retry fails, return a controlled temporary failure. Apply a short, account-scoped cooldown after repeated decoding failure so new player requests cannot create an unbounded reconnect storm. Choose and test the cooldown explicitly during implementation.
- Do not transparently restart an HTTP response after streaming has begun. End a failed response cleanly and let a subsequent range request start normally.
- Do not retry revoked authentication, inaccessible channels, or deleted messages as decoding failures.

This is recovery from a separate protocol failure, not a claim that storing channel references fixes decoding. If failures persist after fresh initialization, investigate teleproto/layer handling with a minimal reproduction rather than repeatedly reconnecting or adding guessed constructor mappings.

## 6. Verify cache expiration and improve diagnostics

- Test the installed cache-manager/Nest integration with short real expirations to verify units and behavior for search and message metadata.
- Inspect all relevant cache registrations and compare the deployed configuration/version with the repository. Correct the observed TTL discrepancy only once reproduced or explained.
- Keep search TTL, metadata TTL, and client idle timeout independent. Neither a cache hit nor cache expiration should determine whether an authorized playback URL is resolvable.
- Log safe fields such as operation, peer kind, chat/message IDs, resolution source, retry number, error class, and constructor ID.
- Avoid raw `TypeNotFoundError` objects because they can contain Telegram response bytes. Check both application logging and the library logging path; avoid duplicate stack traces for one failure where feasible.
- Do not log account tokens, session strings, access hashes, or complete private playback URLs in new diagnostics.

## Expected playback flow after the change

```text
Search discovers a message and its channel
    -> persist account-scoped channel reference
    -> return the usual playback URL

Idle cleanup removes the Telegram client
    -> channel reference remains available

Player opens the previous URL
    -> manager creates a new client for the same account
    -> resolver loads the stored channel reference
    -> fetch the requested message
    -> stream through the same managed client
```

The same process works after a server restart because references reload from disk. No fresh title search is required for a previously recorded channel that remains accessible.

## Verification and acceptance criteria

Add focused regression tests alongside the affected services and controller:

1. Discover a channel, remove its managed client, then play the original URL through a new client with an empty entity cache. No media search is needed.
2. Recreate the peer store from disk and repeat playback successfully.
3. Return a cached search result with an empty client entity cache and verify playback still works.
4. Confirm many messages from one channel reuse one reference; two accounts never share references.
5. Verify positive legacy channel IDs, marked channel IDs, and explicit basic-group IDs without accidental `PeerUser` resolution.
6. Reject incomplete entities and preserve 64-bit ID/hash precision across persistence.
7. Test bounded missing-reference recovery, username-to-ID mismatch, inaccessible peers, and lookup cancellation.
8. Test deletion/session replacement/restore racing with discovery and persistence; old work must not recreate invalidated records.
9. Simulate a direct `getMessages` decoding failure, followed by success: exactly one replacement and retry, using the replacement for download.
10. Simulate simultaneous failures and an error from an old client after replacement; do not create multiple replacements or destroy the new client.
11. Simulate persistent decoding failure: enforce the retry budget/cooldown, avoid reconnect loops, and omit raw buffers from application logs.
12. Preserve HTTP range/seek behavior and do not retry after headers are sent.
13. Verify actual cache expiration with the installed dependencies.

Run targeted tests during development, then `pnpm run build`, `pnpm run lint`, and `pnpm test`. Review any lint changes to avoid unrelated rewrites.

For deployment verification, save a playback URL after discovery, test it after idle cleanup, then restart the server and test the same URL again. Confirm seeking works and no fresh media search is required. Offline tests cannot establish whether Telegram's intermittent decoding failure has disappeared in production.

## Delivery order

1. Implement the peer store, discovery capture, lifecycle invalidation, and playback resolver together with regression tests.
2. Implement bounded RPC decoding recovery and concurrency tests as a separately reviewable change.
3. Resolve the TTL discrepancy and finalize diagnostics based on measured behavior.
4. Deploy and verify idle/restart playback using the original URL.

No dependency upgrade, schema patch, or change to the idle timeout is assumed necessary for the addressing fix. Any dependency change should follow a confirmed protocol reproduction and receive its own validation.

## Reference

Telegram documents that older-layer constructors can sometimes arrive and recommends reconnecting and reinitializing the session: https://core.telegram.org/api/invoking
