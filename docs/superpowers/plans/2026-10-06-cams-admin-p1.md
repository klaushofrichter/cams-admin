# cams-admin phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build cams-admin phase 1: the fleet registry, proxy enrollment, the
outbound proxy channel with heartbeats, the live dashboard, the audit log and
the S3 backup, with the repository standards of the other cluster apps.

**Architecture:** One Node 26 process (Express 5 + `ws` in `noServer` mode +
`node:sqlite`), a Svelte 5 single-page UI served from the same process, and a
Litestream sidecar in production. The wire protocol is written once as JSON
Schema in `contract/v1/` and validated at run time with Ajv; a second,
independent implementation of the protocol (`test-client/`) drives the
integration tests, the e2e, the load test, the local stack and the release
WebSocket check.

**Tech Stack:** TypeScript 7, Node 26 (`node:sqlite`, `crypto` Ed25519),
Express 5, ws 8, Ajv 8, pino, google-auth-library, @aws-sdk/client-s3, Svelte 5
+ Vite 8, vitest 5, Playwright, Litestream 0.5.17, MinIO (tests only).

**Spec:** `docs/superpowers/specs/2026-10-06-cams-admin-phase1-design.md`
(approved 2026-10-06). Section numbers below (§n) refer to it.

## Global Constraints

- Node **26** everywhere: `engines`, Dockerfile `node:26-alpine`, CI `node-version: 26`, `@types/node` ^26.
- CommonJS TypeScript like cams: `server/` → `dist/server`, `tsconfig.check.json` covers `server test e2e scripts test-client contract`.
- Ids: type prefix + `_` + 20 Crockford base32 characters (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`); `aud_` ids start with 10 time characters (sortable). Times are integer ms UTC.
- Every editable row has `version`; PATCH carries it; mismatch → 409 `conflict`.
- **No rate limit or throttle is ever keyed on the client IP or `X-Forwarded-For`** (§7, kube-setup 2026-10-06); IPs are never logged or audited.
- Never log codes, keys, cookies, tokens. Audit `detail` ≤ 4 KiB, field names only for secrets.
- CSRF: writes under `/api/` need `Content-Type: application/json`, `X-Cams-Admin: 1`, and `Origin` (when present) == `PUBLIC_URL` origin.
- Session cookie `__Host-cams_admin`, 12 h absolute; `Secure` unless the `PUBLIC_URL` is loopback http (dev/e2e).
- Channel: path `/proxy/v1/connect`, subprotocol `cams-admin.v1`, frame cap 256 KiB, heartbeat 30 s, offline after 90 s, server ping 25 s (all overridable by env for tests: `HEARTBEAT_S`, `OFFLINE_AFTER_S`, `PING_S`).
- `GET /health` and `HEAD /health` answer 200 `{status, version, backup:{lastReplicationAt,lastSnapshotAt}}`.
- Public repo: RFC 2606/5737 names and addresses in fixtures, no secrets, no AWS account id, no media.
- Every element the e2e touches has a `data-testid`. UI renders proxy-supplied text only as text (no `{@html}`).
- Commits end with the two trailer lines given by the coordinator (Co-Authored-By, Claude-Session).
- Rulings are written in commit bodies / the PR as "Ruling: … — why — cost if wrong".

## Review Focus

1. **A proxy that reconnects in a loop** (two proxies with one key, or a flapping link): the dashboard must not flicker offline/online on every reconnect, and `status_events` must not grow per reconnect beyond `connected`/`disconnected`. Test in Task 9 (liveness) and Task 14 (two-proxy-same-key fault).
2. **cams-admin restarted with proxies connected:** stored status shows stale, then live again without page reload; SSE clients reconnect (EventSource auto-retry). Test in Task 14 (restart fault) and Task 17 (e2e reload-free recovery).
3. **Deleting an account or proxy while its proxy is connected:** the socket closes 4403 and nothing writes a `proxy_status` row for a deleted proxy afterwards (FK errors must not crash the process). Test in Task 9 and Task 11.
4. **Hostile summary content** (huge strings, deep nesting, HTML): the server refuses or clamps; the UI shows text. Test in Task 6 (validator) and Task 17 (e2e no injected element).
5. **Clock jumps on the server side** (fake clock going backwards in tests): liveness never shows "online" for a proxy whose last heartbeat is in the future relative to now; ages clamp at 0. Test in Task 9.

---

## File structure

```
server/
  config.ts            env → Config (all knobs, test overrides)
  clock.ts             Clock interface + systemClock
  log.ts               pino logger (redaction)
  ids.ts               crockford, newId(prefix), auditId(now), ulid(now)
  validate.ts          column rules (§4), normalisers
  db/open.ts           openDb(file): DatabaseSync with pragmas + migrate
  db/migrations.ts     numbered migrations, user_version
  db/epoch.ts          write_epoch bump + epoch file (restore-detected)
  audit.ts             AUDIT_ACTIONS, writeAudit(), throttle, listAudit()
  registry/accounts.ts registry/users.ts registry/proxies.ts registry/cameras.ts
  registry/memberships.ts
  crypto/ed25519.ts    keys, sign/verify, fingerprints, signed strings
  contract.ts          Ajv validators compiled from contract/v1
  enroll/codes.ts      create/cancel/redeem codes
  enroll/route.ts      POST /proxy/v1/enroll
  channel/limits.ts    token buckets keyed by identity
  channel/connection.ts per-socket state machine (challenge→hello→live)
  channel/hub.ts       upgrade handler, connection map, replace/close
  status/store.ts      heartbeat → proxy_status, status_events, transitions
  status/derive.ts     proxy/camera state, reconciliation, pin check
  status/ticker.ts     liveness tick (offline transitions)
  live.ts              SSE hub
  auth/google.ts auth/session.ts auth/allowlist.ts auth/csrf.ts auth/routes.ts
  api/router.ts api/accounts.ts api/proxies.ts api/cameras.ts api/audit.ts api/dashboard.ts
  backup/store.ts      ObjectStore (S3 / memory)
  backup/snapshot.ts   VACUUM INTO, integrity, gzip, put, prune, jobs
  backup/litestream.ts metrics poller → lastReplicationAt
  backup/scheduler.ts  daily at BACKUP_SNAPSHOT_AT in TZ
  app.ts               express app assembly
  server.ts            main: http server, upgrade, ticker, shutdown
contract/v1/*.schema.json, contract/v1/strict/*.schema.json, contract/v1/fixtures/*, contract/v1/vectors.json, contract/README.md
contract/make-strict.ts  generates strict/ from the lenient schemas
test-client/
  client.ts            ProxyClient (enroll, connect, heartbeat, backoff)
  keyfile.ts           key file read/write (mode 600)
  summaries.ts         realistic summary generator (N cameras, faults)
  cli.ts               enroll | run | bridge | ws-hold
  load.ts              load test runner + report
web/                   Svelte app (index.html, src/…)
scripts/dev-session.ts scripts/gen-signing-key.ts scripts/create-secrets.sh
scripts/backup/restore-test.sh scripts/backup/restore-drill.sh
scripts/localstack/{lib.sh,start.sh,stop.sh,bind-local.cjs,sim-local.cjs}
scripts/contract/cam-proxy-heartbeat.ts   (CI cross-check)
test/…  e2e/…
deploy/litestream.yml  docs/restore.md docs/repo-setup.md docs/localstack.md
```

---

### Task 0: Repository standards and skeleton

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.check.json`, `vitest.config.mts`, `server/version.ts`, `server/app.ts` (health only), `server/server.ts`, `test/health.test.ts`, `.github/workflows/production-checks.yml`, `.github/workflows/build-push.yml`, `.github/workflows/deploy-production.yml`, `.github/dependabot.yml`, `.github/codeql-accepted.tsv`, `Dockerfile`, `.dockerignore`, `CHANGELOG.md`, `CLAUDE.md`, `.env.example`, `docs/repo-setup.md`; Modify: `README.md`, `.gitignore`.

**Interfaces:** Produces `createApp(deps: AppDeps): express.Express` (grows in later tasks) and `version(): string` (`APP_VERSION` or `dev`).

- [ ] Write `test/health.test.ts`: `GET /health` → 200 JSON `{status:'ok', version:'dev', backup:{lastReplicationAt:null,lastSnapshotAt:null}}`; `HEAD /health` → 200, empty body; `Cache-Control: no-store`.
- [ ] Run `npx vitest run test/health.test.ts` → fails (no app).
- [ ] Implement `server/app.ts` with the route; `server/server.ts` listens on `PORT` (8080).
- [ ] Tests pass. CI: `production-checks.yml` jobs `test` (lint:types, vitest, build, check:svelte, `npm audit --audit-level=high`, restore test, contract cross-check, short load test), `e2e` (Playwright, desktop+phone), `codeql` (copied from cams with the accepted-tsv gate). `build-push.yml` tags `:main` only. `deploy-production.yml`: version, multi-arch build (`:<sha>`, `:v<ver>`, `:latest`), deploy job on `[self-hosted, k3s]` that sets the image on `deployment/cams-admin` (`kubectl set image` / patch), **polls** `.status.observedGeneration >= .metadata.generation` and `updatedReplicas == availableReplicas == 1` (no `rollout status`), polls `/health` for the version, runs `ws-hold` if `/etc/cams-admin-canary/key.json` exists (warning otherwise), cuts the release from `## [Unreleased]` and resets it on `main`. Dependabot copied from cams. `docs/repo-setup.md`: the `gh api` commands for Dependabot alerts/updates, labels, `delete_branch_on_merge`, and `production` protection (required `test`, `e2e`, `codeql`, strict, `enforce_admins:false`, no force push/deletion) to run when `production` is created.
- [ ] README badge row (release, PR checks, build `?branch=main`, deploy `?branch=production`, Dependabot static), status "phase 1 in progress".
- [ ] Commit `chore: repository standards, CI workflows, /health`.

### Task 1: Ids, codes and column validation

**Files:** Create `server/ids.ts`, `server/validate.ts`, `server/clock.ts`; Test `test/ids.test.ts`, `test/validate.test.ts`.

**Interfaces (Produces):**
```ts
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newId(prefix: 'acc'|'usr'|'prx'|'cam'|'key'|'enr'|'con'): string; // prefix_ + 20 chars
export function auditId(now: number): string;  // 'aud_' + 10 time chars + 10 random
export function ulid(now: number): string;      // 26 chars, envelope ids
export function newEnrollmentCode(): string;     // 'CAE1-XXXX-XXXX-XXXX-XXXX-XXXX'
export function normaliseCode(input: string): string | null; // canonical dashed form or null
export function codeHash(canonical: string): string;  // sha256 hex
// validate.ts
export class FieldError extends Error { constructor(public field: string, msg?: string) }
export function normaliseEmail(s: unknown): string;                  // throws FieldError('email')
export function normaliseFingerprint(s: unknown, field?: string): string; // 'SHA256:' + 64 upper hex
export function accountInput(b: unknown, partial: boolean): Partial<AccountFields>;
export function userInput(...), proxyInput(...), cameraInput(...), simInput(...);
export interface Clock { now(): number }
```

- [ ] Tests: ids match `^acc_[0-9A-HJKMNP-TV-Z]{20}$`; 1000 ids unique; `auditId` sorts by time; code format; `normaliseCode(' cae1 7q2m-k9xd 4hpa w3zt rn6b ')` → canonical; `o`→`0`, `i`/`l`→`1`; wrong tag, 19/21 chars, `U` → null. Emails: trim+lowercase, ≤254, exactly one `@`, refuse whitespace `,;"\`. Fingerprint: `sha256:aa:bb…` and plain 64 hex normalise; 63 hex refused. Each column rule of §4 (account name regex `^[a-z0-9][a-z0-9-]{1,31}$`, proxy name `{0,31}`, url `^https?://` without credentials/query/hash, `runs_on`/`host_kind`/`kind`/`role`/`protocol` enums, lengths 80/2000/120, `ca_fingerprints` 0–2 entries) has a pass and a fail case with the named field.
- [ ] Fail → implement → pass → commit `feat: ids, enrollment codes and column validation`.

### Task 2: Database, migrations, write epoch

**Files:** Create `server/db/open.ts`, `server/db/migrations.ts`, `server/db/epoch.ts`; Test `test/db.test.ts`.

**Interfaces:** `openDb(file: string): Db` where `Db = DatabaseSync`; `migrate(db)`; `MIGRATIONS: ((db)=>void)[]`; `tx<T>(db, fn: () => T): T` (BEGIN IMMEDIATE … COMMIT, bumps `meta.write_epoch`); `checkEpoch(db, epochFile): 'fresh'|'same'|'restored'` and `writeEpochFile(db, epochFile)`.

- [ ] Tests: fresh file → `user_version` = latest, every §4.1 table exists and is STRICT (`pragma table_list` `strict=1`); `journal_mode=wal`, `foreign_keys=1`; a database with a higher `user_version` throws `db_newer_than_code`; `UNIQUE(account_id,email)`; composite FK camera→proxy of another account fails at the database; deleting a proxy sets cameras' `proxy_id` NULL (`ON DELETE SET NULL (proxy_id)`); the partial unique index allows only one active key per proxy; the `sims` trigger refuses a non-sim camera; `tx` bumps `write_epoch`; epoch file lower than db → `same`, higher → `restored`, missing → `fresh`.
- [ ] Fail → implement migration 1 with every table, index and trigger of §4.1 → pass → commit `feat(db): schema, migrations and the write epoch`.

### Task 3: Audit log

**Files:** Create `server/audit.ts`; Test `test/audit.test.ts`.

**Interfaces:** `AUDIT_ACTIONS` (closed list §11.4) ; `writeAudit(db, clock, e: {actorType:'sysadmin'|'proxy'|'system', actor:string, action:AuditAction, accountId?:string|null, targetType?:string, targetId?:string, targetLabel?:string, outcome:'ok'|'refused'|'failed', detail?:object}): void`; `throttledAudit(db, clock, key: string, e)` (one record per key per 10 min, later ones counted into `detail.count` of a following `audit-throttled` record); `listAudit(db, f:{account?,actorType?,action?,from?,to?,limit?,cursor?}): {items, nextCursor}`; `pruneAudit(db, now)` (400 days).

- [ ] Tests: unknown action throws; detail over 4 KiB is truncated to `{truncated:true}`; filters and cursor paging newest first; throttle: 5 refusals for one key in 10 min → 1 record + one `audit-throttled` with count 4 when the window closes; prune.
- [ ] Fail → implement → pass → commit `feat: the audit log`.

### Task 4: Registry

**Files:** Create `server/registry/{accounts,users,proxies,cameras,memberships}.ts`; Test `test/registry.test.ts`.

**Interfaces:** each module exports `create(db, clock, actor, input)`, `get(db, accountId, id)`, `list(db, accountId)`, `update(db, clock, actor, accountId, id, patch & {version})`, `remove(db, clock, actor, accountId, id)`; every write runs in `tx` and writes exactly one audit record. `memberships(db, email): {accountId, accountName, displayName, role}[]`. Errors: `NotFound`, `Conflict` (`conflict` | `duplicate_email` | `duplicate_name` | `duplicate_cams_id`), `FieldError`. Proxies: `block()`, `revokeKey()`, `activeKey()`. Account delete needs `confirmName`.

- [ ] Tests: CRUD per entity; version conflict → `conflict`; duplicate email in one account refused, in another allowed; `memberships()` excludes disabled users and is ordered by account name; proxy delete keeps cameras (proxy_id null); account delete cascades; camera with `proxy_id` needs `proxy_camera_id`; sim details only on kind `sim`; each write produced exactly one audit row with the right action.
- [ ] Fail → implement → pass → commit `feat: registry of accounts, users, proxies, cameras and sims`.

### Task 5: Ed25519 and the signature vectors

**Files:** Create `server/crypto/ed25519.ts`, `contract/v1/vectors.json`, `scripts/contract/make-vectors.ts`; Test `test/ed25519.test.ts`.

**Interfaces:**
```ts
export function generateKeyPair(): { privateKeyPkcs8B64: string; publicKeySpkiB64: string };
export function publicFromB64(spkiB64: string): KeyObject;   // throws on non-Ed25519 / wrong length (44 bytes DER)
export function sign(priv: KeyObject, text: string): string;   // base64 signature
export function verify(pub: KeyObject, text: string, sigB64: string): boolean;
export function fingerprint(spkiB64: string): string;          // 'SHA256:' + upper hex of sha256(DER)
export const signedText = {
  enroll: (code: string, publicKey: string) => `cams-admin enroll v1\n${code}\n${publicKey}`,
  challenge: (connId: string, nonce: string, serverTime: number) => `cams-admin/v1 challenge\n${connId}\n${nonce}\n${serverTime}`,
  hello: (connId: string, nonce: string, proxyId: string, keyId: string, ts: number) => `cams-admin/v1 hello\n${connId}\n${nonce}\n${proxyId}\n${keyId}\n${ts}`,
};
```
`code` in the enroll proof is the **canonical** dashed upper-case form; `nonce` is base64url of 32 bytes.

- [ ] Tests: round trip; wrong key/text fails; non-Ed25519 SPKI refused; `vectors.json` (fixed PKCS#8 keys, made once by `make-vectors.ts`, committed) reproduces every listed signature byte for byte (Ed25519 is deterministic).
- [ ] Fail → implement → pass → commit `feat(crypto): Ed25519 helpers and contract vectors`.

### Task 6: The contract (schemas, fixtures, validators)

**Files:** Create `contract/v1/{envelope,challenge,hello,welcome,heartbeat,ack,error,bye,enroll-request,enroll-response,health-summary}.schema.json`, `contract/make-strict.ts`, `contract/v1/strict/*.schema.json` (generated), `contract/v1/fixtures/*.json`, `contract/README.md`, `server/contract.ts`; Test `test/contract.test.ts`.

**Interfaces:** `validateMessage(msg: unknown): {ok:true, msg: Envelope} | {ok:false, code:'bad_message'|'unsupported_version'|'unsupported_type', detail:string}`; `validateBody(type, body)`; `validateSummary(s: unknown): {ok:true} | {ok:false, unreadable:boolean, reason:string}`; `validateEnroll(body)`. Ajv 2020 with `allErrors:false`, `strict:true`. The lenient schemas allow extra properties; `make-strict.ts` writes copies with `additionalProperties:false` on every object that has `properties`.

The health summary schema mirrors cam-proxy `HealthSummary` (schema 1): every field with its type; strings `maxLength: 200`; `items` and `cameras` `maxItems: 64`; per-camera `items` `maxItems: 64`; enums for `onvif`, `source`, `cameraUpload`, `reboot`, item `id`; `cert` with `mode`, `servername`, `fingerprint`, `notAfter`, `lastPush`, `problem`.

- [ ] Tests: every `fixtures/valid-*.json` validates (lenient and strict); every `fixtures/invalid-*.json` fails with the code named in its `"$expect"` field; committed strict files equal freshly generated ones; a summary with `schema: 2` → `unreadable:true`; a 201-char label, 65 items, a nested depth bomb are refused; property test: 500 random mutations of `valid-heartbeat-4cam.json` (drop a required field, change a type, lengthen a string past 200) are refused by the strict validator and by `validateSummary` alike.
- [ ] Fail → implement → pass → commit `feat(contract): v1 JSON schemas, fixtures and run-time validators`.

### Task 7: Enrollment

**Files:** Create `server/enroll/codes.ts`, `server/enroll/route.ts`, `server/channel/limits.ts`; Test `test/enroll.test.ts`, `test/limits.test.ts`.

**Interfaces:** `createCode(db, clock, actor, accountId, proxyId, lifetimeH: 1|24|168): {id, code, expiresAt}` (cancels a live code); `cancelCode(...)`; `redeem(db, clock, req: EnrollRequest, cfg): {status:201, body: EnrollResponse} | {status:400|401|413|429, body:{error, retryAfterS?}}`. `class Buckets { take(key: string, now: number): {ok:true}|{ok:false, retryAfterS:number} }` constructed with `{capacity, windowMs}` — keys are identities (`code:<hash>`, `global`, `proxy:<id>`, `conn:<id>`, `session:<hash>`), never addresses.

- [ ] Tests: valid → 201 with `proxyId`, `keyId`, `account` (name), `connectUrl` (`PROXY_CONNECT_URL` or `PUBLIC_URL` with `ws(s)://…/proxy/v1/connect`), `serverKeys`, `heartbeatS`; proxy now `enrolled`, audit `proxy-enrolled` with fingerprint; used/expired (at exactly `expires_at`)/cancelled/unknown → 401 `invalid_code` with identical bodies; proxy `revoked` → 401; bad proof → 400 `bad_proof`; proof for another key → 400; `v:2` → 400 `unsupported_version`; body > 8 KiB → 413; two concurrent redeems → exactly one 201; re-enrolment revokes the old key (`re-enrolled`) and calls `onKeyRevoked(keyId)`; 6th attempt per code hash in 15 min → 429 with `retryAfterS`; 101st in total → 429; **rotating `X-Forwarded-For` does not change any budget**; refusals audited as `enroll-refused` (throttled).
- [ ] Fail → implement → pass → commit `feat(enroll): one-time codes and POST /proxy/v1/enroll`.

### Task 8: The channel (handshake, envelope, limits)

**Files:** Create `server/channel/connection.ts`, `server/channel/hub.ts`; Test `test/channel.test.ts` (with a raw `ws` client, not the test client, so the server is tested against hand-made frames).

**Interfaces:**
```ts
export interface HubDeps { db: Db; clock: Clock; cfg: Config; signingKey: KeyObject; serverKeyB64: string; status: StatusStore; log: Logger }
export class Hub {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  closeProxy(proxyId: string, code: 4401|4403, reason: string): void;   // revoke, block, delete
  closeKey(keyId: string, code: 4401|4403): void;
  connected(proxyId: string): boolean;
  shutdown(): Promise<void>;   // bye server-shutdown + 1001 to all
  stats(): { open: number; pending: number };
}
```
Close codes and reasons exactly as §8.3. Server `seq` starts at 1 (the challenge). Messages after `welcome`: `heartbeat` → `status.heartbeat()` then `ack {nextInS}`; `bye` → `status.bye()`; reserved types and unknown types → `error unsupported_type`. Pings every `PING_S`; a missed pong terminates.

- [ ] Tests: no/unknown subprotocol → 426 JSON with `supported`; `cams-admin.v2, cams-admin.v1` → `v1`; `Origin` header → 403; challenge signature verifies with the server key; valid hello → welcome with `heartbeatS`, `offlineAfterS`, `maxMessageBytes:262144`, `serverTime`; no hello in 10 s (test: `HELLO_TIMEOUT_MS=200`) → 4408; wrong signature / revoked key / other proxy's key / nonce of another connection / stale nonce → 4401 with an audit `proxy-auth-refused` reason; `seq` 0, gap, repeat → 4400; invalid JSON, binary frame → 4400; frame > 256 KiB → 4413; > `MSG_PER_MIN` → 4429 preceded by `error` with `retryAfterS`; heartbeat faster than `HEARTBEAT_MIN_GAP_MS` dropped, third drop in a minute → 4429; second authenticated connection for a proxy closes the first with 4409 only after its own hello succeeds; an unauthenticated second socket does not disturb the first; 51 pending sockets → the 51st gets 503; 7 hellos for one `proxyId` in a minute → 4429; 301 failed handshakes in 10 min → upgrade 429 for 60 s; `closeKey` → 4401; `closeProxy` → 4403; `shutdown()` sends `bye server-shutdown` then 1001.
- [ ] Fail → implement → pass → commit `feat(channel): WebSocket handshake, envelope and limits`.

### Task 9: Status store, liveness, reconciliation, SSE

**Files:** Create `server/status/store.ts`, `server/status/derive.ts`, `server/status/ticker.ts`, `server/live.ts`; Test `test/status.test.ts`, `test/derive.test.ts`, `test/live.test.ts`.

**Interfaces:**
```ts
export type ProxyState = 'pending'|'never-connected'|'online'|'offline'|'stopped'|'rejected'|'revoked';
export function deriveProxyState(p: ProxyRow, s: StatusRow|null, hasActiveKey: boolean, now: number, offlineAfterMs: number): ProxyState;
export function cameraStates(s: StatusRow|null, state: ProxyState): {ref: string; online: boolean|null}[]; // null = unknown
export function reconcile(cameras: CameraRow[], s: StatusRow|null): {reportedNotRegistered: {ref, proposedCamsId}[]; registeredNotReported: string[]; pin: 'match'|'mismatch'|'hint'|'none'};
export class StatusStore {
  hello(proxyId, connId, version, skewMs): void;  // connected=1, events connected/online
  heartbeat(proxyId, body: HeartbeatBody, ts: number): void; // stores summary/reported/ok/problems/skew, transition events
  disconnected(proxyId, reason: string): void;  // connected=0, event disconnected
  bye(proxyId, reason): void;                    // stopped for shutdown|restart
  tick(): void;                                  // online→offline transitions
}
export class LiveHub { subscribe(sessionId, res): boolean /* ≤5 per session */; publishStatus(s: LiveStatus): void; publishRegistry(type, id): void }
```
Rules from §8.6: online while `now - last_heartbeat_at < offlineAfterMs` (offline at exactly offlineAfterMs); `stopped` after `bye shutdown|restart` until next hello; a heartbeat with `ts` in the future still counts at **server** time; ages clamp at 0; offline → cameras `null` (unknown). Pin: mismatch iff registered and reported both non-empty and `reported[0]` ∉ registered; hint iff reported non-empty and registered empty. Proposed cams id = proxy camera id if free in the account, else `<proxy name>-<id>`. Events: `connected`, `disconnected`, `online`, `offline`, `stopped`, `problems-changed`, `camera-online`, `camera-offline`, `version-changed`, `pin-mismatch`, `pin-match`, only on change. Summary over 192 KiB or unreadable schema → stored as `{unreadable: "schema N"}` with `ok=0`, problem count 1. Skew over 60 s → a problem on the dashboard (derived, not stored in summary).

- [ ] Tests (fake clock): every state of `deriveProxyState` incl. offline at exactly 90 000 ms and online at 89 999; reconnect inside the window writes `connected` but no `offline`; disconnect without bye stays online until age 90 s; bye restart → stopped; transition events written once; reconciliation cases; pin cases; a heartbeat for a proxy deleted meanwhile is ignored without throwing; SSE: publish reaches subscribers, sixth stream per session refused, 25 s comment heartbeat (fake timers); `tick()` publishes an SSE status for each offline transition; clock going backwards → state not `online` for a future heartbeat beyond window? (rule: age = max(0, now − last)).
- [ ] Fail → implement → pass → commit `feat(status): heartbeat store, liveness, reconciliation and SSE`.

### Task 10: Sign-in, sessions, CSRF, headers

**Files:** Create `server/auth/{google,session,allowlist,csrf,routes}.ts`, `scripts/dev-session.ts`, `test/fakeGoogle.ts`; Test `test/auth.test.ts`.

**Interfaces:** `sysadminAllowed(email, env)` (re-read each call); `createSession(db, clock, email): string /*cookie value*/`; `sessionFrom(req): {id, email, expiresAt} | null` (deletes expired; re-checks the allowlist); `requireSysadmin` middleware; `requireCsrf` middleware; `authRoutes(deps)` (`/auth/google/login`, `/auth/google/callback`, `POST /auth/logout` → 200 page with a Sign-in link, never a redirect to Google). `GOOGLE_AUTH_URL`/`GOOGLE_TOKEN_URL`/`GOOGLE_CERTS_URL` overridable (fakeGoogle in tests and e2e only, refused unless `NODE_ENV!=='production'`).

- [ ] Tests: allowlisted email → session cookie `__Host-cams_admin`, httpOnly, SameSite=Lax, Max-Age 43200, audit `signin`; not allowlisted → 403 page and audit `signin-refused` whose detail has only `emailHash` (12 hex chars of sha256), never the email; `email_verified:false` refused; state mismatch refused; 61st callback in 15 min → 429 **regardless of X-Forwarded-For**; session after 12 h → 401; removing the email from `SYSADMIN_EMAILS` → next request 401; logout deletes the row; writes without `X-Cams-Admin` / with form content type / with a foreign `Origin` → 403; 121st write per minute per session → 429, another session unaffected; CSP, `frame-ancestors 'none'`, `Referrer-Policy: same-origin`, HSTS present; `dev-session.ts` refuses unless `NODE_ENV=development`, loopback `PUBLIC_URL`, email allowlisted.
- [ ] Fail → implement → pass → commit `feat(auth): Google sign-in, sessions and CSRF`.

### Task 11: The JSON API

**Files:** Create `server/api/{router,accounts,proxies,cameras,audit,dashboard}.ts`; Test `test/api.test.ts`, `test/api-audit-completeness.test.ts`.

**Interfaces:** all routes of §11.1–§11.2 under `/api/v1`, errors `{"error":code,"field"?}`; `POST …/enrollment-codes` → 201 `{id, code, expiresAt, command}` where `command` is `docker compose exec cam-proxy node dist/src/cli.js admin-enroll --url <PUBLIC_URL>`; revoke/block/delete call `hub.closeKey/closeProxy`; every registry write publishes `registry` SSE; `GET /api/v1/dashboard` → `{accounts:[{id,name,displayName,proxies:[{id,name,state,lastHeartbeatAt,ok,problemCount,version,pin,skewMs,cameras:[{ref,online}],reconcile}],cameras:[…]}], backup:{lastSnapshotAt,lastSnapshotOk,lastReplicationAt,alerts:[]}, refusedProxyIds:[]}`.

- [ ] Tests: the full CRUD per route with validation errors naming the field; account delete requires matching `confirmName`, closes live connections; `GET /users?email=`; adopt creates a camera with the proposed cams id; audit filters; **audit completeness**: a table of every write route (method, path, body) — each call adds exactly one audit row with the expected action, and a route missing from the table fails the test (the test enumerates the router's stack).
- [ ] Fail → implement → pass → commit `feat(api): registry, enrollment and status API`.

### Task 12: Backup

**Files:** Create `server/backup/{store,snapshot,litestream,scheduler}.ts`, `deploy/litestream.yml`, `scripts/backup/restore-test.sh`, `scripts/backup/restore-drill.sh`, `docs/restore.md`; Test `test/backup.test.ts`.

**Interfaces:** `interface ObjectStore { put(key, body: Buffer, sha256B64: string): Promise<void>; list(prefix): Promise<{key, lastModified:number}[]>; delete(keys: string[]): Promise<void> }`; `s3Store(cfg)` (AWS SDK v3, `S3_ENDPOINT` + path style for MinIO); `memoryStore()`; `runSnapshot(deps): Promise<{ok, key?, error?}>` (VACUUM INTO under `<dataDir>/snap/`, read-only integrity check, gzip, put with `ChecksumSHA256`, delete local, prune by `BACKUP_SNAPSHOT_RETENTION_DAYS` keeping the newest, `jobs` row + audit `backup-snapshot`); `LitestreamWatch` polls `LITESTREAM_METRICS_URL`: `lastReplicationAt` = poll time when `litestream_sync_count` increased and `litestream_sync_error_count` did not (Litestream 0.5.17 metric names, measured 2026-10-06); `nextRunAt(now, 'HH:MM', tz)`.

- [ ] Tests: snapshot object key `cams-admin/<env>/snapshots/YYYY/MM/DD/cams-admin-YYYYMMDDTHHMMSSZ.sqlite.gz`; gunzipped content opens and has the rows; integrity failure → `ok:false`, nothing uploaded, audit `failed`; prune deletes only older than retention and never the newest; metrics parsing with a fake endpoint (advance, error, endpoint down → unchanged); `/health` shows both times; dashboard alerts: no snapshot in 26 h, replication lag > 5 min; `nextRunAt` across DST.
- [ ] `restore-test.sh`: MinIO (docker locally; CI service container) + pinned Litestream 0.5.17 (download + sha256 check) → start built app + `litestream replicate` → create data via API (dev session) and enroll a test-client proxy → trigger snapshot (`POST /api/v1/backup/snapshot`) → record per-table counts + content hash → kill both → restore (a) `litestream restore` (b) the snapshot → compare, integrity check → start the app on each copy → the test client's `hello` succeeds.
- [ ] Fail → implement → pass → commit `feat(backup): daily snapshot, retention, Litestream watch, restore test`.

### Task 13: Protocol test client

**Files:** Create `test-client/{client,keyfile,summaries,cli}.ts`; Test `test/test-client.test.ts`.

**Interfaces:**
```ts
export interface ClientOptions { url: string; keyFile?: string; key?: KeyFile; summary: () => object; proxyInfo?: () => object; heartbeatS?: number; backoffCapMs?: number; random?: () => number; clock?: Clock; WebSocketImpl?: typeof WebSocket; log?: (e: string, d?: object) => void }
export async function enroll(url: string, code: string, info?: {version: string; cameraIds: string[]}): Promise<KeyFile>;
export class ProxyClient extends EventEmitter { // events: state, welcome, ack, error, close
  state: 'idle'|'connecting'|'connected'|'rejected'|'incompatible'|'backoff';
  start(): void; stop(reason?: 'shutdown'|'restart'|'unenrolled'): Promise<void>;
  heartbeatNow(): void;  // early heartbeat (10 s floor)
  stats: { sent: number; acked: number; reconnects: number; ackLatencyMs: number[] };
}
export function backoffDelay(attempt: number, capMs: number, random: () => number): number; // full jitter
export function makeSummary(o: { cameras: number; version?: string; offline?: string[]; problems?: number; now: number }): object; // validates against the strict schema
```
The client verifies the challenge signature against the pinned `serverKeys`, sends `hello`, heartbeats every `heartbeatS` (using `max(ack.nextInS, 10)` unless overridden), closes and reconnects after 3 un-acked heartbeats, and maps close codes to §8.8 reactions. CLI: `enroll --url U` (code from stdin), `run --key F [--cameras N]`, `bridge --key F --health http://127.0.0.1:P/api/local/health` (forwards a real cam-proxy's summary), `ws-hold --key F --minutes 5`.

- [ ] Tests: `backoffDelay` bounds (0 ≤ d ≤ min(cap, 1000·2^n)); reset after 60 s up; a fake challenge with a bad signature → state `rejected` (`admin_server_untrusted`) without sending hello; close 4409 → waits 30 s; 4429 → `retryAfterS`; 4401/4403 → `rejected` (15 min); 426 → `incompatible` (6 h); `makeSummary({cameras:4})` validates strict.
- [ ] Fail → implement → pass → commit `feat(test-client): an independent protocol client for tests, load and the local stack`.

### Task 14: Conformance, end-to-end metrics and fault injection

**Files:** Create `test/conformance.test.ts`, `test/metrics-e2e.test.ts`, `test/faults.test.ts`, `test/helpers/{server,tcpProxy}.ts`.

**Interfaces:** `startServer(env?): Promise<{url, wsUrl, db, stop(), restart(), session: string, api(method, path, body?)}>` (real `server.ts` entry on a random port with a temp data dir); `tcpProxy(target): {port, blackhole(on), latency(ms, bytesPerS), close()}`.

- [ ] Conformance: every case of §15.4 "Protocol conformance" against the real server via the test client or raw frames (some overlap with Task 8 is fine; this file is organised by the spec's list and is the one the PR cites).
- [ ] Metrics end to end: walk the strict health-summary schema's leaves; for each leaf send a heartbeat whose value there is distinctive; assert it is in `proxy_status.summary`, in `GET …/status`, and in the UI's summary tree data (`summaryLeaves()` of `web/src/lib/summaryTree.ts`, the same function the page renders); a leaf without an assertion fails. Derived values, ageing out (2.9 s online / 3.0 s offline with `OFFLINE_AFTER_S=3`), cameras unknown when offline, SSE `status` on each change, restart keeps stored status (stale) then live.
- [ ] Faults: server down then up (proxies back within the 5 s test backoff cap); `1001` mid-heartbeat; blackhole (client reconnects after 3 un-acked heartbeats; server marks offline by age; ping reaps the half-open socket); slow link (2 s latency, 32 KiB/s: no heartbeat lost); malformed frames and hostile summaries; revoked key while connected; blocked proxy; account deleted with live proxies; two clients with one key for 2 min (test time-scaled) — bounded flaps and replacement audit trail.
- [ ] Commit `test: protocol conformance, end-to-end metrics and fault injection`.

### Task 15: Load test

**Files:** Create `test-client/load.ts`, `scripts/load.sh`; Modify `package.json` (`"load": "tsx test-client/load.ts"`).

**Interfaces:** `npm run load -- --proxies 50 --cameras 4 --duration 60m [--url U] [--report file.json]`. It creates an account per 10 proxies and the proxies via the API (dev session), enrolls each with a code, runs the clients (heartbeat 30 s, jitter, 1 % state changes), opens two SSE streams, samples server RSS (`/proc` not available on macOS: `ps -o rss= -p <pid>` of the server it started) and event-loop lag (server exposes it only in `NODE_ENV=development` under `/api/v1/dev/metrics`, removed from production builds by the env check), and prints pass/fail against §15.4's criteria.
- [ ] Run `--duration 2m` in CI (`test` job) with 20 proxies; the full hour locally, numbers in the PR.
- [ ] Commit `test: the load test`.

### Task 16: The UI

**Files:** Create `web/index.html`, `web/vite.config.mts`, `web/tsconfig.json`, `web/src/{main.ts,App.svelte}`, `web/src/lib/{api.ts,live.ts,format.ts,summaryTree.ts,router.ts}`, `web/src/styles/theme.css` (cams tokens), `web/src/pages/{SignIn,Dashboard,Accounts,Account,Proxy,Audit}.svelte`, `web/src/components/*`; Test `web/src/lib/*.test.ts`.

Pages as §16. `summaryTree.ts` exports `summaryLeaves(summary): {path: string; text: string}[]` (every leaf, depth-first, values as text); the proxy page renders the items like cam-proxy's Health card, per-camera blocks, and a "All fields" tree with `data-testid="sum-<path>"`. Live via `EventSource('/api/v1/live')`, reloading the affected rows on `registry` events. A ticking "x s ago". Confirm dialogs for delete account (typed name), delete proxy, revoke key, block proxy. The enrollment code is shown once in a copy box with the command.

- [ ] Unit tests for `summaryTree`, `format` (ages), `api` (CSRF header, error mapping).
- [ ] Commit `feat(web): dashboard, registry pages, proxy detail and audit log`.

### Task 17: e2e (Playwright)

**Files:** Create `playwright.config.ts`, `e2e/{env.ts,global-setup.ts,session.ts}`, `e2e/{signin,registry,enroll-live,reconcile,revoke-delete,audit,hostile}.spec.ts`.

Desktop 1440×900 and phone 390×844. The built server with `HEARTBEAT_S=1 OFFLINE_AFTER_S=3`, fakeGoogle on its own port, sessions inserted by `dev-session`. Flows of §15.1 e2e, plus: the dashboard recovers after a server restart without a reload; a hostile summary renders as text (no injected element); every summary field of the 4-camera fixture shows on the proxy page.
- [ ] Commit `test(e2e): sign-in, registry, live enrollment, reconciliation, revoke, audit`.

### Task 18: Local stack

**Files:** Create `scripts/localstack/{lib.sh,start.sh,stop.sh,bind-local.cjs,sim-local.cjs}`, `docs/localstack.md`.

Ports 29xxx on 127.0.0.1: cams-admin 29000; MinIO 29010/29011 (docker, optional `--no-minio`); account `alpha`: proxy `alpha-1` (29100) with 2 cam-sims; `beta`: `beta-1` (29200) with 1 sim, `beta-2` (29300) with 3 sims; `gamma`: `gamma-1` (29400) enrolled then stopped. cam-sims 29500 + 10·n (+0 http, +2 control, +3 rtsp, +4 onvif, +5 baichuan). cam-proxies from a detached worktree of cam-proxy `origin/main` (built once per commit). **Ruling:** cam-proxy has no cams-admin client yet, so each proxy is enrolled by a test-client **bridge** that forwards that proxy's real `GET /api/local/health` summary; when cam-proxy's client is released, `--native` switches to `admin-enroll`. Work dir `${TMPDIR}/cams-admin-localstack` (refused inside the repo); secrets mode 600, never printed; `stop.sh` kills only PIDs it recorded.
- [ ] Run it; the dashboard shows 3 accounts, 4 proxies (3 online, 1 offline), 6 cameras online. Commit `feat: local stack on the Mac`.

### Task 19: Release scaffolding and secrets

**Files:** Create `scripts/gen-signing-key.ts`, `scripts/create-secrets.sh` (reads `.env` with `env_get`, never prints, `kubectl create secret … --dry-run=client -o yaml | kubectl apply -f -`), `scripts/release/ws-hold.ts` (wraps `test-client ws-hold`), update `docs/kube-setup-request.md` cross-references.
- [ ] Test `gen-signing-key` writes PKCS#8 PEM mode 600 and the server loads it; server refuses a key file readable by group/others.
- [ ] Commit `chore(release): signing key, secrets script, WebSocket hold check`.

### Task 20: Contract cross-check with cam-proxy (CI)

**Files:** Create `scripts/contract/cam-proxy-heartbeat.ts`, a `contract` step in `production-checks.yml` `test` job.
The step clones cam-proxy `main` (shallow), runs `npm ci` there, and with `tsx` imports its `buildHealth` and its multi-camera test fixture input to build a summary, wraps it in a heartbeat body and validates against `contract/v1/strict/heartbeat.schema.json`. A network failure fails the step (no silent skip).
- [ ] Commit `ci: contract cross-check against cam-proxy main`.

### Task 21: Docs and final review

- [ ] README (what it is, how to run, local stack, testing incl. load numbers, badges), CLAUDE.md (rules: public repo, never print `.env`, ports, e2e lock, merge rules), CHANGELOG `## [Unreleased]` entries, `.env.example` names only.
- [ ] Final self-review against the spec (no subagent): every §15.4 bullet has a test; rulings collected for the PR.
- [ ] Commit `docs: README, CLAUDE.md, CHANGELOG`.
