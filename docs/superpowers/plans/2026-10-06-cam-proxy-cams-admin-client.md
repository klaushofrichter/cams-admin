# cam-proxy: the cams-admin client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give cam-proxy an optional outbound client to cams-admin: enroll with a
one-time code, keep one WebSocket, send the health summary as a heartbeat. Off
unless configured, and never in the way of anything else the proxy does.

**Architecture:** A leaf module `src/fleet/` (enrollment, key file, client state
machine) wired into `src/proxy.ts` behind `camsAdmin.url`. It speaks the
cams-admin protocol v1 as written in cams-admin's `contract/v1/` (JSON Schema +
fixtures + signature vectors), which cam-proxy vendors and tests against.
Node 26's global `WebSocket` and `crypto` Ed25519: **no new dependency**.

**Tech Stack:** cam-proxy's own (TypeScript, Express 5, vitest, Svelte 5,
Playwright). Dev-only: `ajv` (already transitively present? if not, add as a
devDependency for the contract test only).

**Spec:** cams-admin `docs/superpowers/specs/2026-10-06-cams-admin-phase1-design.md`
§8 (protocol), §9 (cam-proxy changes), §15.2 and §15.4 (tests). The repo is
`klaushofrichter/cams-admin`; read the spec from its `main` branch. The
contract lives in cams-admin `contract/v1/` (see "The contract" below).

## Global Constraints

- **Off unless configured:** no `camsAdmin.url` → no socket, no timer, no `data/admin/` folder, no new health item; `test/pi-compat.test.ts` asserts it.
- Config key `camsAdmin` (not `admin`): `url`, `keyFile` (default `admin/key.json`, relative to `server.dataDir`), `enabled` (default true), `allowCommands` (must be `[]` in P1; non-empty is a load error). Host-wide; applies at once (restarts the client only). `npm run schema`; config schema version bump.
- `url` must be `https://`, or `http://` for loopback and hosts ending in `.svc.cluster.local` (§8.9); anything else is a config error.
- Key file `<dataDir>/admin/key.json`: mode 600, folder 700, atomic write (random temp name + rename), refused when group/world readable or owned by another uid. Never printed, logged, served, or put in a downloadable backup. Add `data/admin/` to CLAUDE.md's never-print list.
- The enrollment code is never a CLI argument (stdin/pipe only), never logged, never audited.
- Heartbeat body ≤ 192 KiB; above it send only `items`, `cameras[].camera`, `cameras[].items` with `truncated: true`.
- Timeouts: connect 10 s, `hello` 10 s. Backoff full jitter `random(0, min(5 min, 1 s·2^attempt))`, reset after 60 s connected. Close-code reactions exactly as spec §8.8.
- Logs at info only once per state change: `admin_connected`, `admin_disconnected`, `admin_rejected`, `admin_incompatible`; everything else debug. `admin_client_error` for caught errors (stack at debug).
- Shutdown: `bye {reason}` if connected, wait ≤ 1 s, close; before the HTTP server in the stop order; inside the existing 15 s budget.
- Never sends: tokens, passwords (camera, FTP, PoE switch), private keys, the Vision key, overrides content, clips, stills, event payloads.

## The contract (what cams-admin expects; binding)

Files in cams-admin `contract/v1/` (vendor them into `test/contract/cams-admin-v1/` with a `SOURCE` file holding the cams-admin commit):
- `envelope.schema.json` and one schema per type: `challenge`, `hello`, `welcome`, `heartbeat`, `ack`, `error`, `bye`; `enroll-request`, `enroll-response`; `health-summary` (schema 1 = `HealthSummary` of `src/health/summary.ts`); `strict/` copies with `additionalProperties:false`; `fixtures/` valid and invalid examples; `vectors.json` with fixed keys and the exact signed strings and signatures.
- **Envelope:** `{v:1, type, id (ULID), seq (per connection & direction, from 1, +1 exactly), ts (ms), re?, body, sig?}`.
- **Enroll:** `POST <url>/proxy/v1/enroll` JSON `{v:1, code, publicKey (base64 SPKI DER, Ed25519), proof, proxy:{version, cameraIds}}`; `proof = sign("cams-admin enroll v1\n" + canonicalCode + "\n" + publicKey)` where `canonicalCode` is upper-case `CAE1-XXXX-XXXX-XXXX-XXXX-XXXX` (input normalised: trim, upper-case, drop spaces/dashes, `O`→`0`, `I`/`L`→`1`, regroup). 201 → `{v, proxyId, keyId, account, connectUrl, serverKeys[], heartbeatS}`. 400 `bad_request`/`unsupported_version`/`bad_proof`, 401 `invalid_code`, 413, 429 `{retryAfterS}`.
- **Connect:** `new WebSocket(connectUrl, ['cams-admin.v1'])` (no `Origin` header: Node sends none). Server sends `challenge` body `{connId, nonce (base64url 32 bytes), serverTime, serverKeyId}` with envelope `sig = sign_server("cams-admin/v1 challenge\n" + connId + "\n" + nonce + "\n" + serverTime)`; verify against every pinned `serverKeys` entry; failure → close, state `rejected`, log `admin_server_untrusted`.
- **Hello** (within 10 s): body `{proxyId, keyId, connId, nonce, ts, version, capabilities:['status']}`, envelope `sig = sign_proxy("cams-admin/v1 hello\n" + connId + "\n" + nonce + "\n" + proxyId + "\n" + keyId + "\n" + ts)`.
- **Welcome** body `{heartbeatS, offlineAfterS, maxMessageBytes, serverTime}`.
- **Heartbeat** body `{summary, proxy:{startedAt, uptimeS, configSchema, tls:{site, caFingerprint[]}|null, publicUrl|null}, truncated}`; right after welcome, then every `heartbeatS` ±2 s jitter, early on a change of `ok`, `problemCount` or any camera `online` (≥ 10 s since the last). **Ack** `re = heartbeat id`, body `{nextInS}`; next interval `max(nextInS, 10)`; 3 heartbeats without ack → close and reconnect.
- **Error** body `{code, message, retryAfterS?}`; **bye** body `{reason}` (`shutdown`, `restart`, `unenrolled`, `server-shutdown`). `command`/`result`/`event`/`key.rotate` and unknown types → answer `error {code:'unsupported_type'}`.
- **Close codes:** 4400 bad_message, 4401 unauthorized, 4403 revoked, 4408 timeout, 4409 replaced, 4413 too_large, 4429 rate_limited, 1001 going_away, 1011, HTTP 426 `unsupported_protocol`.
- **426 with Node's WebSocket:** the global `WebSocket` can't read the upgrade's HTTP status (it only sees a close 1006). After a connect that never opened, `GET <connectUrl as http(s)>` (no upgrade): cams-admin answers `426 {"error":"unsupported_protocol","supported":[...]}`; if none of the offered subprotocols is in `supported`, the state is `incompatible`. Any other answer is a normal backoff.
- **Half-open links:** `ws.close()` on a dead or blackholed link may never fire `close` (no close frame comes back). Treat the socket as closed 2 s after calling `close()` and go on with the reconnect (cams-admin's test client does this; `test-client/client.ts` `closeSocket`).
- **Text and sizes:** every text field ≤ 200 characters (the strict schema refuses longer ones; cams-admin clamps at run time): clamp before sending. A truncated heartbeat (over 192 KiB) keeps the header (`schema`, `generatedAt`, `version`, `ok`, `problemCount`), `items`, and per camera `camera` + `items` (`contract/v1/health-summary-truncated.schema.json`).
- **Reference implementation:** cams-admin `test-client/client.ts` speaks this protocol end to end (enroll, challenge check, hello, heartbeats, acks, backoff, every close code); read it next to the contract.
- **Test server:** `cams-admin` main's `scripts/localstack/start.sh` runs real cam-proxies bridged by the test client; replace the bridge with `admin-enroll` once the client exists (`docs/localstack.md`).

## Review Focus

1. **cams-admin hostile or wedged** (accepts and never reads; garbage; closes every second; 4401 forever): stills, events, FTP and the client API carry on, event-loop lag within budget. Task 6.
2. **Key file permissions on the Pi** (container uid vs host uid, a restored backup with 644): refused with a clear `admin_key_unsafe` state, never used. Task 1.
3. **Config change while connected** (url changed, `enabled:false`, unenroll): the old socket closes with `bye`, no second socket leaks. Task 4.
4. **Enroll while already enrolled** (re-enroll after a lost key file or rotation): the new key replaces the old atomically; a failed redemption leaves the old key file untouched. Task 2.
5. **Clock not synced (Pi without RTC)**: enrollment and hello work with a clock years off; only the skew shows on cams-admin. Task 3.

---

### Task 1: Key file

**Files:** Create `src/fleet/keyfile.ts`; Test `test/fleet-keyfile.test.ts`.
**Produces:** `interface AdminKeyFile { v:1; url; connectUrl; proxyId; keyId; privateKey; publicKey; serverKeys: string[]; account; enrolledAt }`; `readKeyFile(path): AdminKeyFile` (throws `KeyFileUnsafe` / `KeyFileInvalid`); `writeKeyFile(path, k)` (folder 700, file 600, random temp + rename); `deleteKeyFile(path)`.
- [ ] Tests: round trip; 0644 file → `KeyFileUnsafe`; 0755 folder tightened on write; other owner → unsafe (mock `statSync`); partial JSON → invalid; the write never leaves a temp file behind on error.
- [ ] Implement, pass, commit `feat(fleet): the cams-admin key file`.

### Task 2: Enrollment (shared by CLI and UI)

**Files:** Create `src/fleet/enroll.ts`, `src/fleet/protocol.ts` (signed strings, code normalisation, envelope build/parse), `test/helpers/fake-admin.ts` (a fake cams-admin: enroll + channel, scriptable), `test/contract/cams-admin-v1/**` (vendored), Test `test/fleet-enroll.test.ts`, `test/fleet-contract.test.ts`.
**Produces:** `enrollWithCode(o: {url; code; dataDir; keyFile; version; cameraIds; fetchImpl?}): Promise<AdminKeyFile>`; `normaliseCode(s): string|null`; `signedText` (same three functions as cams-admin's).
- [ ] Tests: `vectors.json` reproduced byte for byte (enroll proof, hello signature, challenge verification); the enroll request validates against the strict `enroll-request` schema; 401/400/413/429 map to clear errors (`invalid_code`, `bad_proof`, …) without the code in the message; a failed redemption leaves an existing key file unchanged; success writes the key file and returns proxyId/account/fingerprint.
- [ ] Commit `feat(fleet): enrollment with a one-time code`.

### Task 3: The client

**Files:** Create `src/fleet/client.ts`, `src/fleet/heartbeat.ts`; Test `test/fleet-client.test.ts`, `test/fleet-heartbeat.test.ts`.
**Produces:** `class AdminClient { constructor(d: {keyFile: AdminKeyFile; health: () => Promise<HealthSummary>; proxyInfo: () => HeartbeatProxyInfo; log; clock?; random?; WebSocketImpl?}); start(); stop(reason): Promise<void>; reconnect(); view(): {state, url, account, proxyId, fingerprint, lastHeartbeatAt, lastError} }`; states `off | not-enrolled | connecting | connected | backoff | rejected | incompatible | key-unsafe`. `buildHeartbeat(summary, info, maxBytes=192*1024): {body, truncated}`.
- [ ] Tests (fake clock, fake-admin): full handshake; bad challenge sig → `rejected`, no hello sent; every close code's reaction (§8.8: 4409 waits 30 s; 4429 waits retryAfterS; 4401/4403 → rejected, retry 15 min, logged once; 426 → incompatible, retry 6 h); backoff bounds and reset after 60 s; early heartbeat on a change with the 10 s floor; `nextInS` honoured with the 10 s floor; 3 un-acked heartbeats → reconnect; unknown/command types → `error unsupported_type`; `stop('shutdown')` sends bye and closes within 1 s; a throwing `health()` → `admin_client_error`, reconnect, never an unhandled rejection; clock 3 years off still connects; heartbeat bodies validate against the strict `heartbeat` schema for the four-camera fixture (`test/helpers/multi.ts`), the one-camera Pi fixture and the truncated case; **secret marker guard**: every secret env var set to a marker, a fully configured multi-camera proxy, no marker in the serialized heartbeat.
- [ ] Commit `feat(fleet): the cams-admin client`.

### Task 4: Config and wiring

**Files:** Modify `src/config/schema.ts` (`camsAdmin` node), `config.schema.json` (regenerated), `src/proxy.ts` (create/restart/stop the client; stop order before the HTTP server), `test/pi-compat.test.ts`; Test `test/fleet-config.test.ts`.
- [ ] Tests: no url → no client, no timer, no `data/admin/` (pi-compat); `allowCommands` non-empty → load error; plain `http://` to a non-loopback, non-`.svc.cluster.local` host → load error; changing `url`/`enabled` restarts only the client (no second socket: count connections on the fake-admin); stop order and the 15 s budget unchanged.
- [ ] Commit `feat(fleet): camsAdmin config, off unless configured`.

### Task 5: CLI, control API, Status card, audit

**Files:** Modify `src/cli.ts` (`admin-enroll --url U`, code from stdin; `admin-unenroll`), `src/api/control-api.ts` (`GET /control/admin`, `POST /control/admin/enroll|reconnect|unenroll`, admin session + `x-camproxy-ui: 1`, `can(principal,'admin')`), `src/audit/actions.ts` (`admin-enroll`, `admin-unenroll`), `web/src/components/CamsAdminCard.svelte`, `web/src/pages/Status.svelte`, `CLAUDE.md`; Test `test/fleet-cli.test.ts`, `test/fleet-control.test.ts`, `e2e/cams-admin-card.spec.ts`.
- [ ] Tests: the CLI refuses a code passed as an argument; reads it from a pipe; writes the key file and the `camsAdmin.url` override; prints proxy id, account, fingerprint (never the code); `admin-unenroll` sends `bye unenrolled`, deletes the key file, clears the override; control routes need the admin session and the CSRF header; `GET /control/admin` has no key material; audit records carry the outcome and never the code; e2e: enroll from the card against fake-admin, see `connected`, unenroll.
- [ ] Commit `feat(fleet): admin-enroll CLI, control API and the Status card`.

### Task 6: Isolation and the contract drift check

**Files:** Create `test/fleet-isolation.test.ts`, `.github/workflows/production-checks.yml` step `contract-drift`.
- [ ] Isolation: the existing stills, events and FTP integration tests run with the client attached to each hostile fake-admin variant (never reads; garbage; closes every second; 4401) and pass unchanged; event-loop lag within the existing budget.
- [ ] Drift: CI fetches cams-admin `main:contract/v1/` and fails when it differs from `test/contract/cams-admin-v1/` (excluding `SOURCE`), printing the diff. Vendoring a new contract = copy + update `SOURCE` in the same PR.
- [ ] Commit `test(fleet): isolation from a hostile cams-admin, contract drift check`.

## Where the contract test lives

- **Source of truth:** cams-admin `contract/v1/` (schemas, strict copies, fixtures, `vectors.json`).
- **cams-admin side:** `test/contract.test.ts` (validators vs fixtures, strict copies up to date, property test) and a CI step that builds a heartbeat with cam-proxy `main`'s real `buildHealth` (its `test/helpers/health-input.ts` and `test/helpers/multi.ts` inputs) and validates it against the strict heartbeat schema.
- **cam-proxy side:** `test/fleet-contract.test.ts` + `test/fleet-heartbeat.test.ts` against the vendored copy, and the `contract-drift` CI step.
- A new summary field in cam-proxy therefore fails cam-proxy's strict-schema test until cams-admin's contract gains it (and cams-admin's "every field is shown" test makes cams-admin show it).
