# Phase 3 Step 2: internal Bot posting adapter

## Scope and deployment boundary

Implemented against Step 1 commit `27b3368dc5a60cf2e6e4dd6c9e658106eaf172d2`.
The public Worker does **not** import `forum-posts.mjs`. No posting endpoint,
diagnostic posting endpoint, frontend change, production deployment, real Discord
request, Secret update, migration, or Step 3 durable posting state is included.
Existing local Wrangler configuration and its backup are excluded from the commit.

## Modules and integration contract

- `forum-input.mjs`: bounded UTF-8 JSON reader, strict duplicate/depth/schema
  validation, normalized and immutable posting input.
- `forum-tags.mjs`: shared eight-name mapping, fixed forum/tag validation, and
  conservative effective `MANAGE_THREADS` permission verification for moderated tags.
- `discord-client.mjs`: fixed Discord v10 targets, manual redirect handling,
  bounded/timed response parsing, safe errors and rate-limit metadata. Existing
  read-only forum and webhook checks retain their response/error-stage interface.
- `forum-posts.mjs`: `prepareForumPost` validates and preflights; a private one-use
  context is consumed by `sendPreparedForumPost`. Contexts expire after 15 seconds.
  Tokens and posting content are absent from returned context/result objects.
- `request-boundary.mjs`: HTTPS and exact deployed Worker host check, before
  existing Origin/auth checks. Forwarded headers cannot expand the allowlist.

Step 3 must durably persist the sending state and reserve shared quota **before**
calling `sendPreparedForumPost`. The in-memory context is neither durable
idempotency nor an exactly-once guarantee. Receipt persistence failure after a
write must remain unknown; an adapter success alone is not durable completion.
Do not connect the public router until Step 3's safety boundary is complete.

## Input and sending rules

Require `apiVersion: 1`, `threadName`, `content`; `tagIds` defaults to `[]`.
Reject extra fields, invalid types, duplicate decoded JSON keys, nesting beyond
three levels, malformed UTF-8, unpaired surrogates and forbidden controls.
JSON is limited to 16,384 received UTF-8 bytes, regardless of Content-Length.
Accept only uncompressed application/json with optional UTF-8 charset; body read
timeout is five seconds. Normalize CR/CRLF to LF without Unicode normalization.
Trim title; require 1–100 UTF-16 code units. Require non-whitespace content of
1–2,000 UTF-16 code units; content permits LF/tab but rejects other C0 and DEL.
At most five distinct nonzero decimal uint64 tag IDs, belonging to the fixed
forum and unambiguous supported eight-name mapping. Required/moderated tags are
checked against forum flags and server-fetched permissions, not client claims.

Only `POST https://discord.com/api/v10/channels/{fixedForumId}/threads` is used
for writes, with `name`, `message.content`, `applied_tags`, and
`message.allowed_mentions: {parse: [], replied_user: false}`. Content URLs are
text only, never transport destinations. Timeout covers fetch and response body
(10 seconds); response parsing is bounded to 64 KiB. No automatic retry occurs.
Successful receipts must contain validated thread/message IDs and matching
forum/guild/channel relationships before fixed-origin Discord links are returned.

## Error outcomes

`not_sent` means validation/config/preflight failed before a write.
`rejected` covers explicit Discord 400/401/403/404 and 429 responses.
`unknown` covers post-start network failures, timeout, 3xx, 5xx, malformed JSON,
oversized response, or invalid receipt. Unknown always has `safeToRetry: false`.
Errors expose fixed codes/status/field names, never upstream bodies, exception
text, Authorization, Bot token, or posting content. No adapter logs are emitted.
429 includes sanitized Retry-After information; fallback is 60 seconds when
metadata is unusable. Retry metadata is informational and does not cause sends.
Step 3 must distinguish Discord 429 from the application's global quota.

## Verification

- `npm test`: PASS, legacy v0.1.0 checks plus 68 Node tests, including 32 new
  adapter/input/security tests. Discord requests are mocked; real fetch is disabled
  for the new suite. Entrypoint bundling proves the posting adapter is unreachable.
- `npm run test:worker-runtime`: PASS with local workerd, SQLite AuthState,
  emulated production PBKDF2 cap, existing 600k hash, signed session and logout replay.
- `npm run test:browser`: PASS, 14 browser acceptance cases.
- `npm run test:phase2-browser`: PASS, auth/tag mapping/forum mismatch/logout and
  unchanged legacy posting behavior, all external requests mocked.
- `git diff --check`: PASS.

Miniflare rewrites incoming Host to its loopback transport address. The runtime
test-only entry reconstructs Host from the dispatch URL; it does not weaken the
production boundary. Node tests separately reject incorrect Host/Origin values.
The host allowlist currently covers only the existing workers.dev endpoint;
custom domains and direct localhost requests require a separately reviewed change.
Real Bot posting permission and production behavior remain unverified by design.
No production CPU timing or exactly-once guarantee is claimed.

## Official references

- [Start Thread in Forum or Media Channel](https://docs.discord.com/developers/resources/channel#start-thread-in-forum-or-media-channel)
- [Allowed Mentions](https://docs.discord.com/developers/resources/message#allowed-mentions-object)
- [Permissions and overwrites](https://docs.discord.com/developers/topics/permissions)
- [Rate limits](https://docs.discord.com/developers/topics/rate-limits)

The application's explicit UTF-16 counting and stricter JSON/control restrictions
are its own contract, not a claim that Discord documents every Unicode edge case.
