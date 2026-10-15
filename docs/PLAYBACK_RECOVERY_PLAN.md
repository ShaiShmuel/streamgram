# Playback URLs and Telegram recovery

## Current design

This supersedes the peer-cache design introduced in `86b32fc`. The error callback
fix from `4196802` and client recovery safeguards remain necessary: an access hash
resolves a peer but does not repair Telegram schema/decoding failures.

Playback routes are:

- `/:userToken/watch/channel/:chatId/:accessHash/:messageId`
- `/:userToken/watch/user/:chatId/:accessHash/:messageId`
- `/:userToken/watch/chat/:chatId/:messageId`

There is no query parameter or legacy-route fallback. The account guard runs as
before. DTO validation rejects malformed IDs/hashes before allocating a Telegram
client. IDs are positive decimal strings (peer: signed 64-bit maximum; message:
signed 32-bit maximum). Hashes are nonzero signed 64-bit decimal strings and are
converted directly to big-integer values, never JavaScript numbers.

All routes delegate to one streaming handler. Preparation constructs a typed
InputPeer directly and fetches the message with that peer. The message supplies
the current document access hash and fileReference needed for download. The
redundant message-metadata cache has been removed.

## Source generation and caching

Each MediaSearchResult has a discriminated peer reference: `{kind, id}` for basic
groups and `{kind, id, accessHash}` for channels/users. Search, series fallback,
tagged videos and channel/folder listings preserve it before caching results.
Tags use the original video's peer. Incomplete, min-only and zero-hash peers are
excluded. Message deduplication includes peer kind to distinguish colliding IDs.

The formatter produces the URL directly from the reference. There is no separate
peer store, session-scoped peer lookup, post-search resolution pass, playback
invalidation scan or generation counter. Ordinary search/channel caches retain
the complete source payload, existing TTLs, a combined 1,000-list bound and
coordinated writes/deletions. Cache eviction does not invalidate saved URLs.

## Recovery retained

- The manager owns persistent clients and observes background and direct RPC errors.
- TypeNotFoundError marks the client unusable; disconnect/destroy happens once.
- Concurrent requests wait for retirement and share replacement initialization.
- Idle cleanup runs every minute and closes unused clients after 15 minutes.
- RPCs, complete searches and HTTP streams retain their exact client until completion; idle cleanup skips retained clients. Explicit removal and recovery still work.
- Repeated decode failures trigger the existing cooldown.
- Read-only playback preparation retries once with the same supplied peer.
- Failed clients cannot publish source results to the cache.
- Decode failures remain typed and raw Telegram response bytes are not logged.
- Temporary pre-header failures return 503 with Retry-After.
- A stream that has already sent headers fails/terminates rather than replaying bytes.
- Cancellation, backpressure, HEAD and byte-range behavior remain unchanged.
- Source-list responses keep Cache-Control: private, no-store.

## Compatibility and limits

Upgrade requires refreshing old Stremio sources; old URLs are unsupported.
Restarting with the same Telegram login needs no cache warmup or new search.
The URL is not a guarantee against deleted messages, lost access, revoked sessions
or a new login. Telegram access hashes are account/login specific:
https://core.telegram.org/api/peers

## Verification

Automated coverage includes all path shapes, large/negative hashes, invalid IDs,
old paths, typed peer reconstruction with empty caches, decoding recovery,
concurrency, cooldown, source generation, incomplete peers, deduplication,
account cache isolation, TTL, eviction, HTTP ranges, HEAD and cancellation.

For live verification, save a generated URL, stop the test process, start a fresh
process with the same login and empty caches, then request HEAD and byte ranges
at the beginning and a nonzero offset without searching again. Do not log private
URLs, session strings or access hashes.
