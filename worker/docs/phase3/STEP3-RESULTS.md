# Phase 3 Step 3: durable posting execution (internal only)

Baseline: `a27386fbdca8c02137b7576ed6b3c4b1708babfd`.
This implements the existing v1 contract's state/ticket/quota boundary, but follows
the Step 3 instruction's stricter **no public posting API** requirement. Earlier
Step 1 documents' statements about enabling public routes in Step 3 are superseded.
`post-handler.mjs` is not imported by the deployed entrypoint. Public intents,
POST and status GET remain 404. Capability flags are not enabled.

## Durable Object and signing boundary

Reuse `AUTH_STATE`, `AuthState`, `personal-auth-v1`, and the existing `auth-v1`
SQLite namespace. No new Worker, binding, class, migration or Secret is needed.
Existing `sessions` and `attempts` records/600k password hashing are unchanged.
New keys are `posts:operation:{uuid}`, ordered `posts:expiry:{time}:{uuid}`,
`posts:rate`, `posts:rate-initialized`, and `posts:cooldown`. The marker prevents
silently resetting a missing initialized quota to zero. The existing AuthState queue serializes local
storage commands, including login/logout; external Discord calls run in the
separate handler, never inside this queue or a storage transaction.

The DO creates a random UUID v4, server timestamps, 30-day expiry and claims
binding the fixed principal/forum and canonical SHA-256 payload hash. Intents
commit before the handler returns a ticket. The existing SESSION_SIGNING_KEY is
used with HMAC-SHA256 domain `forum-post-operation:v1.`; Bearer signing remains
unchanged. Canonical claims/encoding, exact schema/types, duration, future times,
signature, 1,024-byte header limit and expiry are checked. No key rotation needed.
Changing the expiry/operation/payload/target invalidates the signed ticket.

Tickets are not Bearer credentials. Every internal DO posting command rechecks
the live signed session and logout revocation. Commands also require exact
`https://internal/auth`/POST and an HMAC proof in the distinct
`forum-post-internal:v1.` domain. A client-supplied action/proof is never forwarded
by the public router. Same-owner sessions may recover the same operation after
re-login; sessions are not independent quota/principal namespaces.

## State machine and atomic boundary

1. Verify Host/Origin/Bearer, then ticket, JSON/schema and normalized payload hash.
2. Inspect existing state, returning terminal/pending/cooldown replays without
   new Discord calls; valid tickets with missing records fail 503, never recreate.
3. For eligible operations only, perform Step 2's fixed forum/tag preflight.
4. Atomically reserve `preparing` with a random 15-second lease.
5. Recheck session, claims, expiry, target, lease and quota; atomically commit
   `sending`, attempt ID/count and the global sliding-window slot.
6. Await transaction completion and `storage.sync()` before the single-use
   prepared context can dispatch the Bot POST, outside the DO.
7. Commit validated receipt or classified failure with the matching attempt ID,
   await sync, then return the saved response. No automatic API retry occurs.

`not_started -> preparing -> sending -> succeeded / failed / retryable / unknown`.
Expired preparing leases permit a new lease only; old CAS grants are rejected.
Sending is never released back into a sendable state, even after a crash before
the actual POST. After 120 seconds it becomes unknown on inspection. Only a
validated receipt for that same attempt may resolve unknown to succeeded.
Succeeded cannot be overwritten by stale/failure results. Preparing-context
expiry after beginSend is conservatively unknown and consumes its reserved slot.
Operations with less than 120 seconds until expiry reject new attempts with 409.

If intent/reserve/begin/quota/sync fails, dispatch is zero. If beginSend's reply
is lost, no grant is reacquired and status must be inspected. If receipt saving,
sync, session renewal or logout interrupts result acknowledgement, the caller
receives unknown; durable sending/succeeded may be recovered by authenticated GET.
No promise of external exactly-once is made: Discord and SQLite are not one
transaction, and safe unknown can represent an operation never actually sent.

## Retention and shared quota

Retention is exactly 30 days from intent creation, not last update. Store only
IDs, canonical payload hash, claims/timestamps, status/lease/attempt, safe fixed
error information and validated Discord receipt IDs/derived fixed-origin URLs.
Never store Bot token, Bearer, ticket, posting title/body or upstream response.
Auth records still store their existing random session IDs, not Bearer tokens.

Expired tickets return 410 before record lookup, even after deletion. Alarm and
valid posting-state commands clean expired records in bounded batches of 100.
The next expiry alarm is coordinated with the existing authentication alarm:
login must not overwrite an earlier post expiry. Logical expiry does not rely
on alarm timing; real-time physical deletion during platform outages is not
guaranteed. No Discord thread is deleted by history cleanup.

`posts:rate` is one app-wide window across users, sessions and forum changes.
Count beginSend reservations in `(effectiveNow - 60000, effectiveNow]` with
`effectiveNow=max(serverNow,lastRateNow)` so clock rollback cannot free slots.
Max ten timestamps; the eleventh gets 429 `APP_RATE_LIMITED`, positive rounded
Retry-After, and no new attempt/slot. At exactly 60 seconds the old slot expires.
Intents, GET, same-key replay, preparing duplicates and preflight failures do not
consume quota. Rejection/429/unknown and crash-after-commit retain their slot.

Discord 429 is `DISCORD_RATE_LIMITED`, not application quota. Store the maximum
safe upstream wait plus a fixed 250ms margin; missing/unusable wait uses 60 seconds
and cannot enable retry. A conservative shared Bot cooldown blocks the internal
posting path's preflight and write; bucket/global metadata is retained, not used
to loosen this cooldown. Only explicitly rejected 429 with valid metadata permits
a later same-ticket request, max four write attempts total. The Worker does not
sleep or automatically retry. Unknown, sending, succeeded and failed never resend.
Phase 2's existing public read-only Discord APIs are unchanged; coordinated
cooldown integration across those legacy APIs must be reviewed before public
posting activation. Another app's use of the Bot remains outside this quota.

## Internal HTTP contract

`createPostHandler` supplies the three contract routes solely to tests/future
integration: POST `/api/forum/post-intents`, POST `/api/forum/posts`, and GET
`/api/forum/posts/{operationId}`. Request JSON/ticket and response states match
API-CONTRACT.md, including requestId, operationId, attempt, expiresAt, replay,
safeToRetry, retryAfterSeconds, fixed error/fields and safe receipt links.
GET reports saved states with 200, while expired/invalid/auth failures retain
their contract statuses. POST pending uses 202/Retry-After:2, new success 201,
success replay 200, application/Discord limit 429, unknown 502, storage outage 503.
CORS, exact Host/Origin, Bearer, allowed methods/headers, no queries, no-store,
relative Location and exposed Retry-After/Location are implemented internally.
No browser integration, direct-WebHook removal or fallback change is included.

## Verification and release gate

- `npm test`: legacy parser checks plus 94 Node tests PASS (26 new Step 3 tests).
- `npm run test:post-runtime`: local workerd + real persisted SQLite PASS:
  parallel same-key one write, shared ten-slot quota, full restart with preserved
  session/history/quota, replay without dispatch, logout, unknown and cooldown.
- `npm run test:worker-runtime`: PASS, production PBKDF2 cap emulation with
  existing 600k hash, session, incorrect password, logout replay.
- `npm run test:browser`: 14 acceptance cases PASS.
- `npm run test:phase2-browser`: existing auth/tag/Webhook behavior PASS.
- Production bundle graph excludes both posting adapter and internal handler;
  exports remain AuthState/default/passwordHash; public posting routes return 404.
- No real Discord calls. Test-only runtime entry mocks exact Discord endpoints;
  fault/time/restart tests use test Secrets only. Storage-failure injection and
  30-day virtual-clock evidence are Node mocks; SQLite durability/restart evidence
  is local workerd. Neither proves real Bot permissions or production CPU limits.

No production deploy, Secret edit, Wrangler configuration edit, migration,
frontend edit, real posting or Step 4 implementation was performed. Existing
Wrangler diff and `.bak` remain untouched/uncommitted. Step 4 requires another
user instruction; Step 6 requires explicit deployment/real-post approval.

## Official storage references

- [SQLite storage transactions and sync](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Output gates](https://blog.cloudflare.com/sqlite-in-durable-objects)

All network calls are outside transaction callbacks, which may be retried by
the platform. Durable writes and output gates are not a Discord exactly-once primitive.
