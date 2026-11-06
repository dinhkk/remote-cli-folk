# CloudCLI Remote relay (Cloudflare Worker + Durable Object)

A dumb pipe: forwards opaque, end-to-end encrypted **binary** frames between one Host and one Controller per room. It never sees keys, plaintext, or the route allow-list. Protocol, close codes and error registry live in `plans/261104-1155-cloudcli-remote-work/contracts.md` (sections 4, 5, 9); this directory implements them and the tests are the executable spec.

**Status: not deployed.** Deployment (worker name, secret, domain) is done by the user with their own Cloudflare account; nothing in this repository needs or stores Cloudflare credentials. The numbered deploy runbook, the Controller/Host setup and the phone test checklist are in [docs/deployment-guide.md](../../../../docs/deployment-guide.md); the trust model is in [docs/system-architecture.md](../../../../docs/system-architecture.md).

## Before you deploy (checklist)
- **Random worker name.** `wrangler.jsonc` carries the placeholder `cloudcli-remote-relay-dev`; never deploy it. Set `name` to an unguessable value (16+ random characters) or pass `npx wrangler deploy --name <random>`. A random name is obscurity, not protection.
- **`RELAY_SECRET`** (>= 32 random characters) as a Worker secret: `npx wrangler secret put RELAY_SECRET`. Never in git, `wrangler.jsonc` or chat. The relay answers 503 on every request until it exists. `/healthz` = 200 means it is set and long enough.
- **Separate scoped Cloudflare API token** for deploys (or `wrangler login` on your own machine). Never paste it into a chat or commit it.
- **Rate limiting needs a zone.** Cloudflare rate-limiting rules cannot be attached to a `*.workers.dev` URL. For one you need a custom domain on a Cloudflare zone (`workers_dev: false` + a route). See Operational notes below for what that means for the Free quota.
- Do **not** put Cloudflare Access in front of the Controller (not this relay): the sandboxed tab has origin `null` and sends no Access cookie.

## Layout
```
src/index.ts   Worker: /healthz, /ws -> gate -> Room stub (no static files, no CORS)
src/gate.ts    HMAC-SHA256 gate (WebCrypto), parameter + Origin checks
src/room.ts    Room Durable Object: hibernation API, state in SQLite, one alarm
src/types.ts   close codes, limits, frame/attachment types
test/          vitest (workerd) + node tests; test/conformance/scenarios.ts = shared protocol scenarios
scripts/       sync-vectors.mjs (copy phase-03 vectors), smoke.mjs (manual check of any running relay)
wrangler.jsonc workers_dev, SQLite-backed Room, observability off
```

## Protocol in 10 lines
`wss://<relay>/ws?kind=<link|pair>&room=<32 hex>&role=<host|controller>&gate=<64 hex>`; `gate = HMAC-SHA256(RELAY_SECRET, kind + ":" + room)`.
First frame (<= 512 chars, within 5 s): `{"t":"auth","token":"<b64url>","ctl":"<sha256 hex of controllerToken>"?}`. The relay stores only SHA-256 hashes; the role comes from which hash the token matches (constant-time compare), `role=` is only a hint. Then: relay -> client `{"t":"ready"}`, `{"t":"peer","up":bool}`; client -> relay only `{"t":"destroy"}` (hostToken only, link rooms); data = binary <= 2 MiB, forwarded verbatim. Close codes: 4400 bad frame, 4401 unauthenticated (unknown token and role mismatch look identical: same code, same reason text), 4404 no room yet, 4409 replaced, 4410 revoked/expired, 4429 locked, 1009 too big. 8 wrong tokens / 10 min -> 15 min lock (pair room: 5 wrong, 5 min TTL, checked again at authentication time). A room with no activity for 30 days (live or revoked tombstone) is wiped; a room nobody registered stores nothing. Full detail incl. the phase-04 clarifications: contracts.md section 4.

## Commands (run from this directory, Node 22)
```
npm ci --ignore-scripts           # exact versions from the lockfile (generated with npm 11); wrangler is pinned
npm run typecheck                 # tsc over src + test + scripts
npm test                          # workerd in-pool (gate, room-*, pair, hibernation, conformance) + node guards
npm run test:wrangler             # same conformance scenarios against a REAL `wrangler dev` over ws (starts it for you)
npm run dev -- --var RELAY_SECRET:<your-generated-secret>    # local relay on http://127.0.0.1:8787
node scripts/smoke.mjs http://127.0.0.1:8787 <your-generated-secret>   # PASS/FAIL walk-through of a room
npm run sync-vectors              # refresh test/vectors/derivation.json after phase-03 vectors change
```
From the fork root: `npm run typecheck:relay`, `npm run test:relay`.

### RELAY_SECRET
Generate it, do not invent it (32 random bytes, 43 characters):
```
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```
The relay refuses to run with a secret shorter than **32 characters**: every `/ws` request and `/healthz` answer `503 relay not configured` (the body never says whether the secret is missing or too short). So `/healthz` = 200 means the relay can actually serve `/ws`. A short secret would let anyone who sees one gate URL brute-force the secret offline and open every room.

Locally: `--var RELAY_SECRET:...` or a git-ignored `relay/.dev.vars` (`RELAY_SECRET=...`). In production it is a Worker secret (`wrangler secret put RELAY_SECRET`), never in git or `wrangler.jsonc`. The same value goes into the Host/Controller relay settings.

## Reusing the conformance scenarios (phases 05/06)
`test/conformance/scenarios.ts` exports `scenarios` and `runConformance(harness)`. A harness implements `RelayHarness` from `test/support/relay-harness.ts` (`connect`, `http`, `gate`, `origin`, optional `advanceClock`). `test/support/node-ws-harness.ts` already gives one for any relay reachable at a URL (that is what a ws-based fake relay needs); scenarios with `needs: 'clock'` are skipped when `advanceClock` is absent.

## Operational notes
- Free plan: Room is a SQLite-backed class; sockets use the hibernation API; the platform answers ping/pong without waking the object; there are no timers, a single alarm covers the auth deadline and the pair TTL.
- Every Worker invocation counts as a request even when the gate rejects it (also `/healthz`, 404s and 401s). **Rate limiting is not available on a `*.workers.dev` URL**: Cloudflare WAF/rate-limiting rules belong to a zone, so they need a custom domain on a Cloudflare zone (`workers_dev: false` + a route). On `workers.dev` the Free quota (100k Worker requests/day) is exposed to anyone who knows the URL: once exhausted the relay answers Cloudflare error 1027 until 00:00 UTC. A random worker name is obscurity, not protection. Decision (custom domain vs accepting this risk) is pending with the user (phase 13).
- Storage: a room that never got a Host registration creates no tables and no alarm. A registered room, and the tombstone of a revoked or expired one, is wiped after 30 days without activity (activity = successful authentication or relayed data; a connected authenticated socket counts as active). One alarm covers the auth deadline, the pair TTL and this wipe. Because tombstones go too, the single-use guarantee of a pair code lasts 30 days (its TTL is 5 minutes, so that is ample).
- The relay never logs (a static test forbids `console.*` in `src/`); `observability` is disabled in `wrangler.jsonc`.
- Local-only quirk: with `wrangler dev`, a close started by the alarm (auth timeout, pair TTL) is delivered on time but the client's `close` event arrives ~10 s later. See `plans/.../reports/relay-tooling.md`.

## Limits
- Frames: binary only, <= 2 MiB each (larger = close 1009); first frame <= 512 characters within 5 s; at most 16 unauthenticated sockets per room.
- Lockout: 8 wrong tokens in 10 minutes locks a link room for 15 minutes (pair room: 5 wrong in 5 minutes); a pair room lives 5 minutes.
- One Host and one Controller per room; a new connection for a role replaces the old one (close 4409).
- Cloudflare Free plan: 100k Worker requests per day (every invocation counts, including rejected ones) and Durable Object WebSocket messages are billed at 20 incoming messages per request. Measured traffic per interaction: `plans/261104-1155-cloudcli-remote-work/reports/latency-measurements.md`.
- A room with no activity for 30 days is wiped; a Host that returns later registers it again as a new room.

## What the relay can and cannot see
- **Can see:** that a room exists, its random id, connection and disconnection times, frame sizes and rhythm, client IP addresses (Cloudflare sees them), the SHA-256 hashes of the room tokens, and, in a `pair` room during pairing, the public ceremony values and the Controller's chosen device name.
- **Cannot see:** the pairing key, any plaintext, chat content, file content, URLs or headers of proxied requests, the route allow-list, or the account password. Everything after pairing is AES-256-GCM ciphertext keyed by secrets the relay never has.
- **Cannot forge:** frames. A hostile relay can only drop, delay or disconnect traffic (availability), which the clients detect (counter check, PING/PONG) and recover from by handshaking again.
- The `RELAY_SECRET` gate only stops strangers from using your relay; it is not what protects the traffic.
