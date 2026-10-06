# cams-admin: migration phase 2 (commands and tokens) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cams-admin sends signed, versioned, idempotent commands to the proxies it is connected to, records their signed results, and uses the first command, `tokens.apply`, to issue, rotate and revoke cams↔proxy client and admin tokens that it stores **only as hashes** and shows **once**.

**Architecture:** The contract (`contract/v1`, additive: `command`, `result`, `event`, per-command args/result schemas, heartbeat fields, fixtures, vectors) comes first and is shared with cam-proxy. On the server, a `Commands` service (queue, one in flight per proxy, retries with the same `cmdId`, expiry) signs commands over JCS with cams-admin's existing Ed25519 key and verifies results with the proxy's enrolled key; a `Tokens` service owns `proxy_tokens` and builds declarative `tokens.apply` sets. Both write the database only on meaningful changes (the S3 cost rule). The protocol test client gains an independent proxy-side implementation of the command check, so the contract has two implementations in this repo's tests and a third (cam-proxy's) in the cross-check.

**Tech Stack:** TypeScript, Express 5, `node:sqlite`, `ws`, ajv (run time, lenient; strict in tests), vitest, Svelte 5, Playwright (existing). Node ≥ 26. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-06-cams-admin-migration-design.md` (cited **M §n**): §3 (M1, M2, M5), §5 (`commands`, `proxy_tokens`, `proxy_token_state`, audit actions), §7, §10.1–§10.2, §13.1, §13.3, §14, §15 (P2a, P2b); on `docs/superpowers/specs/2026-10-06-cams-admin-phase1-design.md` (**P1 §n**; §8.4 "Signed commands", §11.4 audit, §15.3 local stack). The companion plan is cam-proxy `docs/superpowers/plans/2026-10-06-migration-p2-cam-proxy.md`; the section "The P2 contract" is **identical** in both plans.

## Klaus's decisions (2026-10-06, recorded as decisions, not defaults)

Klaus pre-approved spec, plan, implementation and deployment, and answered M §16 with the spec's recommendations ("I follow the recommendations"):

1. **Held trust changes (M §9.7, Q1):** cams holds changed connection data (proxy URL, CA pins, TLS names, camera host) until an account admin confirms. *(P4; nothing in this plan.)*
2. **Stale cache (M §9.4, Q2):** cams uses its cached configuration however old it is. *(P4; nothing in this plan.)*
3. **Disruptive remote actions (M §8.6, Q3):** camera reboot, power-cycle, proxy restart and FTP/NTP/cert setup may be allowed for remote use **per proxy, off by default**. *(P3 implements them; this plan's contract lists their allow entries so the proxies can report them, and cams-admin sends none in P2.)*

## Rulings made in this plan (where the spec is silent or unclear)

The cam-proxy plan's rulings R2-1 … R2-9 apply (allow-list outside `overrides.json`; `tokens.apply.admin` is an allow entry, not a wire command; widening is local-only on the proxy; `exp` on the challenge clock; fail-closed env switch; local block list; managed tokens outlive the channel; nacks not journaled; `refused-*` fixtures). This side adds:

- **R2-10 Rotation in P2 is two person steps.** The holder is `manual` (a token typed into cams's `cameras.json` / the `cams-cameras` Secret by a person), so "Rotate" = **Issue** a new token (shown once), the person switches cams to it, then **Retire** the old one (`retiring` for 24 h by default, 1 h–7 d; the proxy itself stops accepting it at `retireAt`, even with cams-admin down) or **Revoke** it at once. The automatic rotation of M §10.1 needs a cams holder (P4).
- **R2-11 A restored cams-admin catches up with the proxy's revision.** When a proxy answers `tokens.apply` with `stale: true` and a revision ≥ cams-admin's, cams-admin raises its revision to the proxy's + 1 and re-sends the current set once (actor `system`, at most once per proxy per 10 min). Without this, a restore from an older backup would leave every later token change refused as stale.
- **R2-12 The evidence is the whole signed envelope.** `commands.result` stores the proxy's final signed `result`/`event` envelope verbatim (JSON), `result_sig` its signature, so the outcome can be re-verified later against the proxy key (`proxy_keys` keeps revoked keys).
- **R2-13 States map from the result:** `done` = `status: ok`; `refused` = `status: refused` (the nack code in `outcome_code`); `failed` = `status: failed` or `conflict` (the code says which); `expired` = never sent within 15 min; `unknown` = sent, no final result within 15 min. A late final result still finalises an `unknown` row (audited).
- **R2-14 No generic "send a command" API in P2.** The only command producer is the Tokens service (and its "Re-apply" button). P3 adds the config commands with their own routes.
- **R2-15 Pre-checks are UX, the proxy decides.** cams-admin refuses to queue (409) when the proxy's last heartbeat says it lacks the `commands` capability, doesn't allow the needed entries, or is paused/off; the proxy re-checks everything anyway.

## Global Constraints

- **Never stored, logged, audited or returned twice:** a token's plaintext. It exists in the `POST …/tokens` answer only (`Cache-Control: no-store`), never in the database, a log line, an audit detail, a command's `args`, the SSE stream or an error message. Hashes appear in audit details and API answers only as an 8-hex prefix (`sha256:1a2b3c4d`). The P1 secret-marker guard (P1 §9.3) is extended to commands, results, token routes and the dashboard.
- **Tokens:** 32 random bytes (`crypto.randomBytes`), base64url without padding (43 characters); `hash = "sha256:" + hex(SHA-256(UTF-8(token)))`; at most 64 non-revoked tokens per proxy.
- **Commands:** `args` JCS ≤ 16 KiB; `exp = ts + 60 s`; one command in flight per proxy; re-sent with the **same `cmdId`** and a fresh envelope after 10 s without `received`, and on the next connection when `received` came without `done`; `expired`/`unknown` after 15 min (R2-13). 60 commands per minute per proxy (refused 429), plus the P1 per-session write limit.
- **Results:** accepted only when the signature verifies with the connection's own proxy key and `proxyId`/`connId` are the connection's; anything else is dropped and audited (`command-result`, outcome `refused`, throttled per proxy and reason); more than 20 dropped results on one connection closes it (4400).
- **Database writes only on meaningful changes** (a command's state change, a token row change, a confirmed revision). Heartbeat fields (`commands`, `tokens`, `configRevision`) live in memory and in the 10-minute status snapshot. `test/write-budget.test.ts` stays green and gains a P2 case.
- **Rate limits never key on the client address.**
- **Public repository:** fixtures and docs use RFC 5737 / 2606 values; no real token, id or address.
- **Contract first:** a change to the wire goes into `contract/build.ts`/`make.ts`, `npm run contract:make`, commit; cam-proxy vendors it the same day (its drift check fails on its PRs until then).
- **Commands are off by default on every proxy** (the proxy's empty allow-list); cams-admin never assumes otherwise and shows what the proxy reports.

## Review Focus

1. **cams-admin restored from an older backup** (`restore-detected`): its token revision is lower than the proxies'. The next token change must still reach the proxy (R2-11), and no revoked token may come back. Task 6.
2. **The proxy disconnects between `received` and `done`** (or cams-admin restarts in between): the row must end `done` (from the event after reconnect, or the duplicate answer to the re-sent `cmdId`), never run twice, and never sit in `sent` forever. Task 5.
3. **Two sysadmins issue tokens for the same proxy at once:** both tokens end up in one consistent set (revisions strictly increase, the later `tokens.apply` carries both), and neither command overwrites the other's token. Task 6.
4. **A result signed with a revoked or another proxy's key, or carrying another proxy's `cmdId`:** refused, audited, the command unchanged. Task 5.
5. **The token shown once is lost** (the browser closes the dialog): there is no way to see it again; the UI says so and offers Revoke + Issue. Task 9.

---

## The P2 contract (identical in both plans; binding)

The envelope stays **v1**; the subprotocol stays `cams-admin.v1` (M §7.1). All additions are in cams-admin `contract/v1/` (lenient and strict schemas, fixtures, `vectors.json`), generated by `contract/build.ts` / `contract/make.ts` / `scripts/contract/make-vectors.ts`.

**Canonical JSON (RFC 8785, JCS)** — the same function in both repos (`server/crypto/jcs.ts`, `src/fleet/jcs.ts`):

```ts
// RFC 8785 for what the protocol carries: null, booleans, finite numbers,
// strings, arrays, plain objects. Keys sorted by UTF-16 code units (the
// default sort), strings and numbers as JSON.stringify writes them (ES2019+,
// which RFC 8785 adopts). Anything else (undefined, NaN, Infinity, functions,
// class instances, holes, depth > 32) throws.
export function jcs(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('jcs: nested too deep');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('jcs: not a finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${Array.from(value, (v) => jcs(v, depth + 1)).join(',')}]`;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error('jcs: not a plain object');
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${jcs(o[k], depth + 1)}`).join(',')}}`;
  }
  throw new Error(`jcs: cannot canonicalise ${typeof value}`);
}
```

**Signatures:** `sig = base64(Ed25519(UTF-8(jcs(envelope without sig))))`. cams-admin's key signs `command`; the proxy's key signs `result` and `event`. The receiver canonicalises **the parsed message as received** (unknown fields included) minus `sig`.

**`command`** (server → proxy; `sig` required; no `re`). Body:

| field | rule |
|---|---|
| `proxyId` | `^prx_[0-9A-HJKMNP-TV-Z]{20}$` |
| `connId` | `^con_[0-9A-HJKMNP-TV-Z]{20}$` |
| `cmdId` | `^cmd_[0-9A-HJKMNP-TV-Z]{20}$`, the idempotency key |
| `exp` | integer ms, `1 ≤ exp − ts ≤ 60000` |
| `actor` | string ≤ 200 (a sysadmin email, or `system`) |
| `command` | lenient `^[a-z][a-z.]{0,31}$`; strict enum `tokens.apply`, `config.get`, `config.set`, `config.unset`, `config.rollback`, `camera.action`, `camera.name.set`, `proxy.restart` |
| `args` | object with integer `v`; `jcs(args)` ≤ 16384 bytes |

**`result`** (proxy → server; `sig` required; `re` required = the command envelope's `id`). Body `{proxyId, connId, cmdId, phase, status?, code?, retryAfterS?, duplicate?, result?}`: `phase` `received` | `done`; `status` (required when `done`) `ok` | `failed` | `conflict` | `refused`; `code` string ≤ 64; `retryAfterS` integer ≥ 0; `duplicate` boolean; `result` object, `jcs(result)` ≤ 65536 bytes.

**`event`** (proxy → server; `sig` required; no `re`). Body `{proxyId, connId, kind: "command.done", cmdId, phase: "done", status, code?, duplicate?, result?}`: a `done` that could not be sent on its own connection, sent after the next `welcome` (`connId` = the new connection's).

**Nack codes** (`phase: done, status: refused`): `bad_signature`, `wrong_target`, `expired`, `replayed`, `not_allowed`, `paused`, `rate_limited` (with `retryAfterS`), `invalid_args`, `unsupported_version`, `busy`. A command whose body has no readable `cmdId` gets `error {code: "bad_message"}` with `re`, never a result.

**Check order on the proxy** (normative; each step's refusal wins over later ones):

1. `body.cmdId` matches the pattern, else `error bad_message`.
2. `sig` verifies against one of the pinned server keys, else `bad_signature` (a missing `sig` too).
3. `body.proxyId` is this proxy's and `body.connId` this connection's, else `wrong_target`.
4. The envelope `id` was not seen on this connection (then it is recorded), else `replayed`.
5. `exp` is an integer, `1 ≤ exp − ts ≤ 60000`, and `exp + 120000 ≥ serverNow`, where `serverNow = Date.now() + offset` (R2-4), else `expired`.
6. The journal has `cmdId`: answer its stored `done` with `duplicate: true` (or `received` with `duplicate: true` while it runs). Nothing runs.
7. Env kill switch off, or paused → `paused`.
8. `command` is implemented by this version and in the allow-list → else `not_allowed`.
9. Rate limits → `rate_limited` + `retryAfterS`.
10. `args.v` is 1 → else `unsupported_version`; `args` passes the command's strict validator → else `invalid_args`.
11. Allow entries the args need (`tokens.apply.admin` for a set with an `admin` entry) → else `not_allowed`.
12. Another command is running → `busy`.

Then `result {phase: received}` (within 2 s), the handler, the journal write, `result {phase: done}`.

**`hello.capabilities`:** a P2 proxy sends `["status", "commands"]`. cams-admin never sends a command to a proxy without `commands`.

**Heartbeat `proxy` block, three optional fields** (optional in lenient **and** strict, so P1 heartbeats stay valid):

```json
"commands": { "enabled": true, "paused": false, "pauseReason": null, "allow": ["tokens.apply"], "seenWindow": 1000 },
"tokens": { "revision": 7, "client": 1, "admin": 1, "blocked": [] },
"configRevision": "sha256:<64 hex>"
```

`commands.enabled` is false when the env switch is off; `allow` lists the allow entries this version implements **and** that are allowed (≤ 32 entries of ≤ 64 chars), whether paused or not; `pauseReason` ≤ 200 or null; `tokens` counts the managed tokens accepted now, `blocked` the locally blocked ids (≤ 64).

**Allow-list entries** (`camsAdmin.allowCommands`): `tokens.apply`, `tokens.apply.admin`, `config.get`, `config.set`, `config.unset`, `config.rollback`, `camera.name.set`, `proxy.restart`, and `camera.action:<a>` for `a` in `camera-test`, `onvif-resubscribe`, `camera-ftp-test`, `poe-switch-read`, `inventory`, `inventory-cancel`, `retention-run`, `restart`, `camera-reboot`, `camera-powercycle`, `camera-ftp-setup`, `camera-ftp-off`, `camera-ntp-set`, `camera-cert-push`. Anything else is a load error. P2 implements `tokens.apply` (and the `tokens.apply.admin` entry).

**`tokens.apply` args v1:**

```json
{ "v": 1, "revision": 8,
  "tokens": [ { "id": "tok_…", "kind": "client", "hash": "sha256:<64 lower hex>", "label": "cams cluster", "retireAt": null } ] }
```

`revision` integer ≥ 1; `tokens` ≤ 64 entries; `id` `^tok_[0-9A-HJKMNP-TV-Z]{20}$`, unique; `kind` `client` | `admin`; `hash` `^sha256:[0-9a-f]{64}$`, unique; `label` 1–64 characters without control characters; `retireAt` integer ms or null. Declarative: the full managed set. **Result:** `{revision, applied, stale, client, admin, blocked}` (the proxy's revision after the command; whether it applied; whether it was stale; the counts accepted now; the ids it dropped as locally blocked). `failed` codes: `shadows_local_token` (a hash equals the digest of the local admin, a local client, or the audit token), `store_error`.

**Tokens:** 32 random bytes, base64url without padding (43 characters). `hash = "sha256:" + hex(SHA-256(UTF-8(token)))`. The proxy hashes the presented bearer and compares to every managed hash with `timingSafeEqual`.

**Fixtures** (`contract/v1/fixtures/`, made by `make.ts`; `$context` = `{now, proxyId, connId, serverKeys, allow, paused, seen}`):

| fixture | strict | runtime (receiver) |
|---|---|---|
| `valid-command-tokens-apply`, `valid-result-received`, `valid-result-done-ok`, `valid-result-refused-paused`, `valid-event-command-done`, `valid-heartbeat-p2` | valid | accepted |
| `refused-command-bad-signature` (signed by the `other` key) | valid | `bad_signature` (proxy) |
| `refused-command-wrong-proxy`, `refused-command-wrong-conn` | valid | `wrong_target` (proxy) |
| `refused-command-replayed` (`$context.seen` holds its id) | valid | `replayed` (proxy) |
| `refused-command-expired` (`exp + 120000 < now`), `refused-command-exp-too-far` (`exp − ts = 60001`) | valid | `expired` (proxy) |
| `refused-command-paused` (`$context.paused: true`) | valid | `paused` (proxy) |
| `refused-command-not-allowed` (`config.get`, allow `["tokens.apply"]`) | valid | `not_allowed` (proxy) |
| `refused-command-args-v2` | valid | `unsupported_version` (proxy) |
| `refused-tokens-apply-bad-hash` (upper-case hex) | valid* | `invalid_args` (proxy) |
| `refused-tokens-apply-admin-not-allowed` (an `admin` entry, allow `["tokens.apply"]`) | valid | `not_allowed` (proxy) |
| `invalid-command-unsigned` | invalid | `bad_signature` (proxy) |
| `invalid-command-unknown-name` (`frobnicate`, signed) | invalid | `not_allowed` (proxy) |
| `invalid-type-command` (changed: schema `command`, body `{}`) | invalid | `unsupported_type` (server: a proxy sent a command) |
| `drift-result-new-field` | invalid | accepted (server) |

\* the `command` schema checks only that `args` is an object; the args are checked by `commands/tokens.apply.args.schema.json` (strict refuses the fixture's args).

`vectors.json` gains `jcs` (input → canonical text, including key order by UTF-16 units, `-0`, `1e21`, escapes, nested arrays) and `envelopes` (`{kind, key, envelope, text, sig}` for one command, one result, one event). Ed25519 is deterministic: each side reproduces the other's signatures byte for byte.

---

## File map

| file | responsibility |
|---|---|
| `server/crypto/jcs.ts` (new) | `jcs()` as in the contract |
| `server/crypto/ed25519.ts` | + `signEnvelope`, `verifyEnvelope`, `unsigned` |
| `contract/build.ts`, `contract/make.ts`, `scripts/contract/make-vectors.ts`, `contract/v1/**`, `contract/README.md` | the P2 contract |
| `server/contract.ts` | `result`/`event` validation (lenient), per-command args (strict, for what cams-admin sends) |
| `test-client/commands.ts` (new) | an independent proxy-side command check and `tokens.apply` (reference implementation) |
| `test-client/client.ts` | answers commands when told to (`commands` option) |
| `server/db/migrations.ts` | migration 3 |
| `server/ids.ts` | `cmd`, `tok` prefixes |
| `server/audit.ts` | new actions |
| `server/commands/service.ts` (new) | `Commands`: create, dispatch, retry, expire, results, listing |
| `server/commands/envelope.ts` (new) | builds and signs a command envelope on a connection |
| `server/channel/connection.ts`, `server/channel/hub.ts` | capabilities, `sendSigned`, `result`/`event` routing, `live(proxyId)` |
| `server/tokens/service.ts` (new) | `Tokens`: issue, retire, revoke, re-apply, list, apply results, tick |
| `server/status/store.ts`, `server/status/derive.ts` | heartbeat `commands`/`tokens`/`configRevision`, hello capabilities in `Reported` |
| `server/api/router.ts` | command and token routes; dashboard fields |
| `server/server.ts` | wiring, ticks |
| `web/src/lib/commands.ts`, `web/src/components/ProxyCommands.svelte`, `web/src/components/ProxyTokens.svelte`, `web/src/components/ShownOnce.svelte`, `web/src/pages/Proxy.svelte`, `web/src/pages/Dashboard.svelte` | UI |
| `scripts/contract/cam-proxy-commands.ts` (new), `scripts/contract/cam-proxy-check.sh` | the cross-check against cam-proxy `main`'s real command check |
| `scripts/localstack/start.sh`, `scripts/localstack/setup.ts`, `scripts/localstack/p2-check.ts` (new), `docs/localstack.md` | real cam-proxies enrolled with `admin-enroll`; the two-proxy P2 check |
| `docs/kube-setup-request-p2.md` (new), `README.md`, `CHANGELOG.md`, `CLAUDE.md` | docs |

---

### Task 1: JCS and signed envelopes

**Files:**
- Create: `server/crypto/jcs.ts`, `test/jcs.test.ts`
- Modify: `server/crypto/ed25519.ts`, `scripts/contract/make-vectors.ts`, `contract/v1/vectors.json` (regenerated), `test/ed25519.test.ts`

**Interfaces:**
- Produces: `jcs(value: unknown): string`; `unsigned(m: Record<string, unknown>): Record<string, unknown>`; `signEnvelope(priv: KeyObject, m: Record<string, unknown>): string`; `verifyEnvelope(pub: KeyObject, m: Record<string, unknown>): boolean`. `vectors.json` gains `jcs: {name: string; input: unknown; text: string}[]` and `envelopes: {kind: 'command' | 'result' | 'event'; key: 'proxy' | 'server' | 'other'; envelope: object; text: string; sig: string}[]`; the existing `keys` and `signatures` stay byte-identical.

- [ ] **Step 1: Failing tests** (`test/jcs.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { jcs } from '../server/crypto/jcs';
import { keyFromSeed, privateFromB64, publicFromB64, signEnvelope, unsigned, verifyEnvelope } from '../server/crypto/ed25519';
import vectors from '../contract/v1/vectors.json';

describe('JCS (RFC 8785)', () => {
  it('RFC 8785 §3.2.3: keys sorted by UTF-16 code units', () => {
    const input = { '\u20ac': 'Euro', '\r': 'CR', '\ufb33': 'Hebrew', '1': 'One', '\ud83d\ude00': 'Smiley', '\u0080': 'Control', '\u00f6': 'Latin' };
    expect(jcs(input)).toBe('{"\\r":"CR","1":"One","\u0080":"Control","\u00f6":"Latin","\u20ac":"Euro","\ud83d\ude00":"Smiley","\ufb33":"Hebrew"}');
  });
  it('numbers and escapes as ES writes them', () => {
    expect(jcs([-0, 1e21, 1e-7, 0.1, 100, 'a"\\\n\u2028'])).toBe('[0,1e+21,1e-7,0.1,100,"a\\"\\\\\\n\u2028"]');
  });
  it('refuses what JSON cannot say', () => {
    for (const bad of [undefined, NaN, -Infinity, () => 1, new Date(0), { a: undefined }, [1, , 2], new Map()]) expect(() => jcs(bad)).toThrow();
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = { d: deep };
    expect(() => jcs(deep)).toThrow(/too deep/);
  });
  it('the committed vectors: every jcs case, every envelope signature', () => {
    for (const v of vectors.jcs) expect(jcs(v.input), v.name).toBe(v.text);
    for (const e of vectors.envelopes) {
      const k = (vectors.keys as Record<string, { seedHex: string; publicKey: string }>)[e.key];
      expect(jcs(e.envelope)).toBe(e.text);
      expect(signEnvelope(privateFromB64(keyFromSeed(k.seedHex).privateKeyPkcs8B64), e.envelope as Record<string, unknown>)).toBe(e.sig);
      expect(verifyEnvelope(publicFromB64(k.publicKey), { ...e.envelope, sig: e.sig })).toBe(true);
      expect(verifyEnvelope(publicFromB64(vectors.keys.other.publicKey), { ...e.envelope, sig: e.sig })).toBe(false);
      expect(verifyEnvelope(publicFromB64(k.publicKey), { ...e.envelope, sig: e.sig, extra: 1 })).toBe(false);
      expect(unsigned({ ...e.envelope, sig: e.sig })).toEqual(e.envelope);
    }
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/jcs.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement.** `server/crypto/jcs.ts` = the contract's `jcs` verbatim. In `server/crypto/ed25519.ts`:

```ts
import { jcs } from './jcs';
export function unsigned(m: Record<string, unknown>): Record<string, unknown> {
  const { sig: _sig, ...rest } = m;
  return rest;
}
// Contract P2: Ed25519 over jcs(envelope without sig), the message as received.
export const signEnvelope = (priv: KeyObject, m: Record<string, unknown>): string => sign(priv, jcs(unsigned(m)));
export function verifyEnvelope(pub: KeyObject, m: Record<string, unknown>): boolean {
  let text: string;
  try {
    text = jcs(unsigned(m));
  } catch {
    return false;
  }
  return verify(pub, text, m.sig);
}
```

`scripts/contract/make-vectors.ts`: keep `keys` and `signatures` as they are; add

```ts
const jcsCases = [
  { name: 'rfc8785-sorting', input: { '\u20ac': 'Euro', '\r': 'CR', '\ufb33': 'Hebrew', '1': 'One', '\ud83d\ude00': 'Smiley', '\u0080': 'Control', '\u00f6': 'Latin' } },
  { name: 'numbers', input: [0, -0, 1, -1, 0.1, 1e21, 1e-7, 9007199254740991, 1791273600000] },
  { name: 'escapes', input: { s: 'a"\\\b\f\n\r\t\u0001\u001f\u007f\u2028/<>&é😀' } },
  { name: 'nesting', input: { b: [true, false, null, { z: [], a: {} }], a: '' } },
].map((c) => ({ ...c, text: jcs(c.input) }));
const env = (type: string, seq: number, body: object, extra: object = {}) => ({ v: 1, type, id: '01K6' + String(seq).padStart(22, '0'), seq, ts: 1791273600000 + seq, ...extra, body });
const CON = 'con_0123456789ABCDEFGHJK', PRX = 'prx_0123456789ABCDEFGHJK', CMD = 'cmd_0123456789ABCDEFGHJK';
const tokensArgs = { v: 1, revision: 1, tokens: [{ id: 'tok_0123456789ABCDEFGHJK', kind: 'client', hash: 'sha256:' + '0'.repeat(63) + '1', label: 'cams example', retireAt: null }] };
const envelopeCases = [
  { kind: 'command', key: 'server', envelope: env('command', 3, { proxyId: PRX, connId: CON, cmdId: CMD, exp: 1791273600003 + 60000, actor: 'admin@example.org', command: 'tokens.apply', args: tokensArgs }) },
  { kind: 'result', key: 'proxy', envelope: env('result', 4, { proxyId: PRX, connId: CON, cmdId: CMD, phase: 'done', status: 'ok', result: { revision: 1, applied: true, stale: false, client: 1, admin: 0, blocked: [] } }, { re: '01K6' + '3'.padStart(22, '0') }) },
  { kind: 'event', key: 'proxy', envelope: env('event', 2, { proxyId: PRX, connId: CON, kind: 'command.done', cmdId: CMD, phase: 'done', status: 'ok', result: { revision: 1, applied: true, stale: false, client: 1, admin: 0, blocked: [] } }) },
].map((c) => ({ ...c, text: jcs(c.envelope), sig: signEnvelope(privateFromB64(keys[c.key].privateKey), c.envelope) }));
```

and write `{ $comment, keys, signatures, jcs: jcsCases, envelopes: envelopeCases }`. Run `npx tsx scripts/contract/make-vectors.ts`; `git diff contract/v1/vectors.json` must show only the two added arrays.

- [ ] **Step 4: Run** `npx vitest run test/jcs.test.ts test/ed25519.test.ts test/contract.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server/crypto/jcs.ts server/crypto/ed25519.ts scripts/contract/make-vectors.ts contract/v1/vectors.json test/jcs.test.ts
git commit -m "feat(contract): JCS and signed envelopes, with vectors"
```

---

### Task 2: The P2 contract (schemas, fixtures, run-time validation)

**Files:**
- Modify: `contract/build.ts`, `contract/make.ts`, `contract/README.md`, `contract/v1/**` (regenerated), `server/contract.ts`, `test/contract.test.ts`, `test/validate.test.ts` (if it lists message types)
- Test: `test/contract.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - Schemas (lenient + strict): `command`, `result`, `event`, `commands/tokens.apply.args`, `commands/tokens.apply.result`; `hello` (capabilities unchanged shape), `heartbeat` (proxy block gains optional `commands`, `tokens`, `configRevision`).
  - `MESSAGE_TYPES` (build.ts) = `['challenge', 'hello', 'welcome', 'heartbeat', 'ack', 'error', 'bye', 'command', 'result', 'event']`; `RESERVED_TYPES = ['key.rotate']`.
  - `server/contract.ts`: `INBOUND_TYPES = ['hello', 'heartbeat', 'error', 'bye', 'result', 'event']` (what a proxy may send); `validateMessage` answers `unsupported_type` for `command`, `challenge`, `welcome`, `ack` from a proxy and for unknown types; `validateCommandArgs(command: string, args: unknown): {ok: true} | {ok: false; detail: string}` (strict, for what cams-admin itself sends); `validateResultPayload(command: string, result: unknown): boolean` (lenient).
  - Fixture fields: `$expect.receiver: 'proxy' | 'server'` (default `server`), `$context` for proxy fixtures.
  - `ALLOW_ENTRIES` exported from `contract/build.ts` (the contract's list) for the UI.

- [ ] **Step 1: Failing tests** in `test/contract.test.ts` (keep the existing ones; the class rule changes to accept `refused-*`):

```ts
it('fixture classes: valid-* and refused-* pass strict; invalid-* and drift-* fail strict', () => {
  for (const f of allFixtures()) {
    const ok = strictValidator(f.schema)(f.message);
    if (f.name.startsWith('valid-') || f.name.startsWith('refused-')) expect(ok, f.name).toBe(true);
    else expect(ok, f.name).toBe(false);
  }
});
it('every proxy-receiver fixture has a $context and a runtime code from the nack list', () => {
  const NACKS = ['bad_signature', 'wrong_target', 'expired', 'replayed', 'not_allowed', 'paused', 'rate_limited', 'invalid_args', 'unsupported_version', 'busy'];
  for (const f of allFixtures().filter((x) => x.$expect?.receiver === 'proxy')) {
    expect(f.$context, f.name).toMatchObject({ now: expect.any(Number), proxyId: expect.stringMatching(/^prx_/), connId: expect.stringMatching(/^con_/), serverKeys: [vectors.keys.server.publicKey] });
    expect(NACKS, f.name).toContain(f.$expect.runtime);
  }
});
it('the signed fixtures verify (or fail) as their name says', () => {
  const cmd = fixture('valid-command-tokens-apply');
  expect(verifyEnvelope(publicFromB64(vectors.keys.server.publicKey), cmd.message)).toBe(true);
  expect(verifyEnvelope(publicFromB64(vectors.keys.server.publicKey), fixture('refused-command-bad-signature').message)).toBe(false);
  for (const n of ['valid-result-received', 'valid-result-done-ok', 'valid-result-refused-paused', 'valid-event-command-done']) expect(verifyEnvelope(publicFromB64(vectors.keys.proxy.publicKey), fixture(n).message), n).toBe(true);
});
it('a P1 heartbeat stays valid in strict (the new proxy fields are optional)', () => {
  expect(strictValidator('heartbeat')(fixture('valid-heartbeat-1cam-pi').message)).toBe(true);
  expect(strictValidator('heartbeat')(fixture('valid-heartbeat-p2').message)).toBe(true);
});
it('run time: a proxy may send result and event; command from a proxy is unsupported_type', () => {
  expect(validateMessage(fixture('valid-result-done-ok').message)).toMatchObject({ ok: true });
  expect(validateMessage(fixture('valid-event-command-done').message)).toMatchObject({ ok: true });
  expect(validateMessage(fixture('invalid-type-command').message)).toMatchObject({ ok: false, code: 'unsupported_type' });
  expect(validateMessage(fixture('drift-result-new-field').message)).toMatchObject({ ok: true });
});
it('what cams-admin sends: tokens.apply args pass the strict args schema', () => {
  expect(validateCommandArgs('tokens.apply', fixture('valid-command-tokens-apply').message.body.args)).toEqual({ ok: true });
  expect(validateCommandArgs('tokens.apply', fixture('refused-tokens-apply-bad-hash').message.body.args)).toMatchObject({ ok: false });
});
```

- [ ] **Step 2: Run** `npx vitest run test/contract.test.ts` → FAIL.

- [ ] **Step 3: Implement** in `contract/build.ts` (inside `buildSchemas`, using its helpers `obj`, `str`, `int`, `id`, `b64`, `arr`, `en`, `nullable`, `message`):

```ts
  const ALLOW = [...ALLOW_ENTRIES];
  const cmdId = id('cmd');
  const tokId = id('tok');
  const hash: S = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' };
  const label: S = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[^\\u0000-\\u001f\\u007f]+$' };
  const NACKS = ['bad_signature', 'wrong_target', 'expired', 'replayed', 'not_allowed', 'paused', 'rate_limited', 'invalid_args', 'unsupported_version', 'busy'];
  const commandBody = obj({
    proxyId: id('prx'), connId: id('con'), cmdId, exp: int(), actor: str(),
    command: strict ? { type: 'string', enum: WIRE_COMMANDS } : { type: 'string', pattern: '^[a-z][a-z.]{0,31}$' },
    args: { type: 'object', properties: { v: int(1) }, required: ['v'] },
  }, ['proxyId', 'connId', 'cmdId', 'exp', 'actor', 'command', 'args']);
  const resultCore = {
    proxyId: id('prx'), connId: id('con'), cmdId, phase: en(['received', 'done']),
    status: en(['ok', 'failed', 'conflict', 'refused']), code: str(64), retryAfterS: int(0), duplicate: bool, result: { type: 'object' },
  };
  const resultOptional = ['status', 'code', 'retryAfterS', 'duplicate', 'result'];
  const resultBody: S = {
    ...obj(resultCore, ['proxyId', 'connId', 'cmdId', 'phase'], resultOptional),
    // done needs a status (both modes: a result without one is unusable).
    if: { properties: { phase: { const: 'done' } }, required: ['phase'] }, then: { required: ['status'] },
  };
  const eventBody: S = {
    ...obj({ ...resultCore, kind: en(['command.done']), phase: { const: 'done' } }, ['proxyId', 'connId', 'kind', 'cmdId', 'phase', 'status'], ['code', 'retryAfterS', 'duplicate', 'result']),
  };
  const tokensArgs = obj({
    v: { const: 1 }, revision: int(1),
    tokens: arr(obj({ id: tokId, kind: en(['client', 'admin']), hash, label, retireAt: nullable(int()) }, ['id', 'kind', 'hash', 'label', 'retireAt']), 64),
  }, ['v', 'revision', 'tokens']);
  const tokensResult = obj({ revision: int(), applied: bool, stale: bool, client: int(), admin: int(), blocked: arr(tokId, 64) }, ['revision', 'applied', 'stale']);
  const commandsInfo = obj({ enabled: bool, paused: bool, pauseReason: nullable(str()), allow: arr(strict ? { type: 'string', enum: ALLOW } : str(64), 32), seenWindow: int() }, ['enabled', 'paused', 'allow']);
  const tokensInfo = obj({ revision: int(), client: int(), admin: int(), blocked: arr(tokId, 64) }, ['revision']);
```

- Add to `proxyInfo`'s properties: `commands: commandsInfo, tokens: tokensInfo, configRevision: nullable({ type: 'string', pattern: '^sha256:[0-9a-f]{64}$' })`, and list all three in `obj(...)`'s `optional` argument (strict keeps them optional).
- Add schemas: `command: message('command', commandBody, { sig: true, re: 'none' })`, `result: message('result', resultBody, { sig: true, re: 'required' })`, `event: message('event', eventBody, { sig: true, re: 'none' })`, `'commands/tokens.apply.args': { $id: BASE + 'commands/tokens.apply.args.schema.json', title: 'tokens.apply args v1', ...tokensArgs }`, `'commands/tokens.apply.result'` likewise. Unique ids/hashes inside `tokens` can't be said in JSON Schema: `make.ts`'s README note says so, and `validateCommandArgs` adds the uniqueness check in code.
- Export `WIRE_COMMANDS = ['tokens.apply', 'config.get', 'config.set', 'config.unset', 'config.rollback', 'camera.action', 'camera.name.set', 'proxy.restart']` and `ALLOW_ENTRIES` (the contract's list, with `REMOTE_ACTIONS` → `camera.action:<a>`).
- `make.ts`: write schemas whose name contains `/` into subfolders (`mkdirSync(dirname(...), {recursive: true})`); add the fixtures of the contract table. Helpers:

```ts
const SERVER = privateFromB64(serverKey.privateKeyPkcs8B64);
const PROXY = privateFromB64(proxyKey.privateKeyPkcs8B64);
const OTHER = privateFromB64(keyFromSeed(vectors.keys.other.seedHex).privateKeyPkcs8B64);
const CMD = 'cmd_0123456789ABCDEFGHJK';
const TOK = (n: number) => `tok_${String(n).padStart(20, '0')}`;
const HASH = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
const ctx = (o: Partial<{ allow: string[]; paused: boolean; seen: string[]; connId: string; now: number }> = {}) => ({ now: NOW + 10, proxyId: PRX, connId: CON, serverKeys: [serverKey.publicKeySpkiB64], allow: ['tokens.apply'], paused: false, seen: [], ...o });
const signed = (m: Record<string, unknown>, key = SERVER) => ({ ...m, sig: signEnvelope(key, m) });
const command = (seq: number, command: string, args: object, o: Partial<{ proxyId: string; connId: string; exp: number; key: KeyObject }> = {}) =>
  signed(env('command', seq, { proxyId: o.proxyId ?? PRX, connId: o.connId ?? CON, cmdId: CMD, exp: o.exp ?? NOW + seq + 60_000, actor: 'admin@example.org', command, args }), o.key);
const tokensArgs = (tokens: object[]) => ({ v: 1, revision: 1, tokens });
const clientTok = { id: TOK(1), kind: 'client', hash: HASH(1), label: 'cams example', retireAt: null };
const refused = (schema: string, code: string, message: unknown, context: object, note: string) => ({ $note: note, schema, $context: context, $expect: { runtime: code, strict: 'valid', receiver: 'proxy' }, message });
```

and e.g. `'refused-command-replayed': refused('command', 'replayed', command(3, 'tokens.apply', tokensArgs([clientTok])), ctx({ seen: [ID(3)] }), 'its envelope id was seen on this connection')`, `'refused-command-expired': refused('command', 'expired', command(3, 'tokens.apply', tokensArgs([clientTok]), { exp: NOW + 4 }), ctx({ now: NOW + 4 + 120_001 }), 'exp + 120 s is past cams-admin time')`, `'refused-command-exp-too-far': … { exp: NOW + 3 + 60_001 } …`, `'refused-command-bad-signature': … { key: OTHER } …`, `'refused-tokens-apply-bad-hash': … tokensArgs([{ ...clientTok, hash: HASH(1).toUpperCase().replace('SHA256', 'sha256') }]) …`, `'refused-tokens-apply-admin-not-allowed': … tokensArgs([{ ...clientTok, id: TOK(2), kind: 'admin', hash: HASH(2) }]) …, ctx({ allow: ['tokens.apply'] })`, `'refused-command-args-v2': … { v: 2, revision: 1, tokens: [] } …`, `'refused-command-not-allowed': … command(3, 'config.get', { v: 1 }) …`, `'refused-command-paused': … ctx({ paused: true })`, `'refused-command-wrong-proxy': … { proxyId: 'prx_ZZZZZZZZZZZZZZZZZZZZ' }`, `'refused-command-wrong-conn': … { connId: 'con_ZZZZZZZZZZZZZZZZZZZZ' }`; `invalid-command-unsigned` = the valid command without `sig` (runtime `bad_signature`, receiver proxy, `$context: ctx()`); `invalid-command-unknown-name` = `command(3, 'frobnicate', { v: 1 })` (runtime `not_allowed`, receiver proxy); `invalid-type-command` = `env('command', 1, {})`, schema `command`, runtime `unsupported_type` (receiver server); results signed with `PROXY` (`valid-result-received`: `{phase: 'received'}`, `re: ID(3)`; `valid-result-done-ok`: `status: 'ok'`, `result` = a `tokens.apply.result`; `valid-result-refused-paused`: `status: 'refused', code: 'paused'`); `valid-event-command-done`; `drift-result-new-field` (a done result with `body.newThing: 1`, signed); `valid-heartbeat-p2` = `hb(pi, false, { ...makeProxyInfo({ now: NOW }), commands: { enabled: true, paused: false, pauseReason: null, allow: ['tokens.apply'], seenWindow: 1000 }, tokens: { revision: 7, client: 1, admin: 1, blocked: [] }, configRevision: 'sha256:' + 'a'.repeat(64) })`.
- `server/contract.ts`: compile `result.schema.json` and `event.schema.json` (lenient); `INBOUND_TYPES` as above; strict args validator compiled from `contract/v1/strict/commands/tokens.apply.args.schema.json` plus the uniqueness check:

```ts
export function validateCommandArgs(command: string, args: unknown): { ok: true } | { ok: false; detail: string } {
  if (command !== 'tokens.apply') return { ok: false, detail: `no args schema for ${command}` };
  if (!vTokensArgs(args)) return { ok: false, detail: errText(vTokensArgs) };
  const t = (args as { tokens: { id: string; hash: string }[] }).tokens;
  if (new Set(t.map((x) => x.id)).size !== t.length || new Set(t.map((x) => x.hash)).size !== t.length) return { ok: false, detail: 'duplicate id or hash' };
  if (Buffer.byteLength(jcs(args)) > 16384) return { ok: false, detail: 'args over 16 KiB' };
  return { ok: true };
}
```

- `contract/README.md`: the fixture classes (`refused-*`, `$context`, `$expect.receiver`), the signed envelopes, the check order (link to the plan section), "uniqueness inside `tokens` is checked in code on both sides".
- `npm run contract:make`.

- [ ] **Step 4: Run** `npx vitest run test/contract.test.ts test/conformance.test.ts test/channel.test.ts` → PASS (the P1 conformance test skips fixtures with `receiver: 'proxy'` when sending them over the wire; add that filter where it iterates fixtures).
- [ ] **Step 5: Commit**

```bash
git add contract server/contract.ts test/contract.test.ts test/conformance.test.ts
git commit -m "feat(contract): command, result, event; tokens.apply; heartbeat command and token fields; fixtures"
```

---

### Task 3: A reference proxy-side command check (test client) and the cam-proxy cross-check

**Files:**
- Create: `test-client/commands.ts`, `test/contract-commands.test.ts`, `scripts/contract/cam-proxy-commands.ts`
- Modify: `test-client/client.ts`, `scripts/contract/cam-proxy-check.sh`, `.github/workflows/production-checks.yml` (step name only)

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `refCheck(m: Record<string, any>, ctx: { now: number; proxyId: string; connId: string; serverKeys: string[]; allow: string[]; paused: boolean; seen: Set<string>; journal?: Map<string, object> }): { kind: 'run' } | { kind: 'duplicate' } | { kind: 'bad_message' } | { kind: 'nack'; code: string }` — written from the contract text only (it must not import cam-proxy code or `server/` code other than crypto).
  - `ProxyClient` option `commands?: { allow: string[]; paused?: boolean }`: the client answers commands per `refCheck`, applies `tokens.apply` to an in-memory set, keeps a journal, signs `result`s with its key, reports `commands`/`tokens` in its heartbeat `proxy` block, and announces `capabilities: ['status', 'commands']`. Without the option it behaves exactly as today (P1 proxy).
  - `scripts/contract/cam-proxy-commands.ts <cam-proxy dir>`: imports `<dir>/src/fleet/command-check.ts` and `<dir>/src/fleet/jcs.ts` when present; runs every `receiver: 'proxy'` fixture and every `vectors.jcs` case through cam-proxy's real code; exits non-zero on any difference; prints a notice and exits 0 when cam-proxy has no `command-check.ts` yet (before cam-proxy PR B is on `main`).

- [ ] **Step 1: Failing test** (`test/contract-commands.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { refCheck } from '../test-client/commands';

const DIR = join(__dirname, '../contract/v1/fixtures');
const all = readdirSync(DIR).map((f) => ({ name: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(join(DIR, f), 'utf8')) }));

describe('the reference proxy check agrees with every proxy fixture', () => {
  for (const f of all.filter((x) => x.$expect?.receiver === 'proxy' || (x.schema === 'command' && x.name.startsWith('valid-')))) {
    it(f.name, () => {
      const c = f.$context;
      const d = refCheck(f.message, { ...c, seen: new Set(c.seen) });
      if (f.name.startsWith('valid-')) expect(d.kind).toBe('run');
      else expect(d.kind === 'nack' ? d.code : d.kind).toBe(f.$expect.runtime);
    });
  }
  it('a journaled cmdId is answered as a duplicate before the pause check', () => {
    const f = all.find((x) => x.name === 'valid-command-tokens-apply')!;
    expect(refCheck(f.message, { ...f.$context, paused: true, seen: new Set(), journal: new Map([[f.message.body.cmdId, {}]]) }).kind).toBe('duplicate');
  });
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `test-client/commands.ts` following the contract's check order 1–11 (signature via `verifyEnvelope` from `server/crypto/ed25519`, args checks hand-written from the contract table, its own small rate counter is not needed for the fixtures and is omitted — the reference covers steps 1–8, 10, 11; step 9 is cam-proxy's). In `test-client/client.ts`, on `case 'command'` when `this.o.commands` is set: run `refCheck` with `serverNow = Date.now() + (serverTime − localAtChallenge)`, send a signed `received` and `done` (or the nack) with `signEnvelope(privateFromB64(key.privateKey), …)`; otherwise keep answering `unsupported_type`. `cam-proxy-check.sh`: after the heartbeat check, `npx tsx scripts/contract/cam-proxy-commands.ts "$DIR/cam-proxy"`.
- [ ] **Step 4: Run** `npx vitest run test/contract-commands.test.ts test/test-client.test.ts` → PASS; `scripts/contract/cam-proxy-check.sh` → passes (commands part prints the "no command check on cam-proxy main yet" notice until cam-proxy PR B lands).
- [ ] **Step 5: Commit**

```bash
git add test-client/commands.ts test-client/client.ts test/contract-commands.test.ts scripts/contract/cam-proxy-commands.ts scripts/contract/cam-proxy-check.sh .github/workflows/production-checks.yml
git commit -m "test(contract): reference proxy-side command check; cross-check cam-proxy's real one"
```

**→ PR A ends here** ("contract: commands and tokens"). Merge, then cam-proxy plan Task 1 (vendor) the same day.

---

### Task 4: Migration 3, ids, audit actions

**Files:**
- Modify: `server/db/migrations.ts`, `server/ids.ts`, `server/audit.ts`, `test/db.test.ts`, `test/ids.test.ts`, `test/audit.test.ts`, `server/backup/snapshot.ts` (if it lists tables), `scripts/backup/restore-check.ts` (if it lists tables)

**Interfaces:**
- Produces: tables `commands`, `proxy_tokens`, `proxy_token_state`; `IdPrefix` gains `'cmd' | 'tok'`; audit actions `command-create`, `command-result`, `command-expired`, `token-issue`, `token-retire`, `token-revoke`.

- [ ] **Step 1: Failing tests:** `test/db.test.ts`: a fresh database has `user_version` 3 and the three tables; a version-2 database file (made by running migrations 1–2 only) migrates to 3 with its rows intact; `proxy_tokens.hash` must match `sha256:` + 64 characters (CHECK) and is unique; deleting a proxy deletes its tokens and token state and sets `commands.proxy_id` to NULL (history kept); `commands.state` refuses an unknown value. `test/ids.test.ts`: `newId('cmd')` / `newId('tok')` match the contract patterns. `test/audit.test.ts`: the six actions are accepted.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** migration 3:

```ts
  // 3: phase 2, commands and managed tokens (migration spec §5). Never a token, only its hash.
  (db) => db.exec(`
CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  proxy_id TEXT REFERENCES proxies(id) ON DELETE SET NULL,
  actor TEXT NOT NULL,
  command TEXT NOT NULL,
  args TEXT NOT NULL CHECK (length(args) <= 16384),
  dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0,1)),
  state TEXT NOT NULL CHECK (state IN ('queued','sent','received','done','refused','failed','expired','unknown')),
  outcome_code TEXT,
  result TEXT CHECK (result IS NULL OR length(result) <= 98304),
  result_sig TEXT,
  created_at INTEGER NOT NULL, sent_at INTEGER, finished_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX commands_proxy_created ON commands(proxy_id, created_at);
CREATE INDEX commands_open ON commands(state, created_at) WHERE state IN ('queued','sent','received');

CREATE TABLE proxy_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  proxy_id TEXT NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('client','admin')),
  holder TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  hash TEXT NOT NULL UNIQUE CHECK (hash GLOB 'sha256:*' AND length(hash) = 71),
  state TEXT NOT NULL CHECK (state IN ('pending','active','retiring','revoked','external')),
  issued_revision INTEGER NOT NULL,
  applied_revision INTEGER,
  retire_at INTEGER, revoked_at INTEGER,
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
  FOREIGN KEY (account_id, proxy_id) REFERENCES proxies(account_id, id)
) STRICT;
CREATE INDEX proxy_tokens_proxy ON proxy_tokens(proxy_id, state);

CREATE TABLE proxy_token_state (
  proxy_id TEXT PRIMARY KEY REFERENCES proxies(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  applied_revision INTEGER NOT NULL DEFAULT 0
) STRICT;
`),
```

(`issued_revision` = the revision whose set first carried the token, used to confirm it from a heartbeat's `tokens.revision`; an addition to M §5's columns.) Audit prune (400 days) also prunes `commands` older than 400 days: add `DELETE FROM commands WHERE created_at < ? AND state NOT IN ('queued','sent','received')` to `Audit.prune()`'s transaction (or a `Commands.prune()` called by the same daily job — pick the job the server already runs `audit.prune()` from).
- [ ] **Step 4: Run** `npx vitest run test/db.test.ts test/ids.test.ts test/audit.test.ts test/backup.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server/db/migrations.ts server/ids.ts server/audit.ts test/db.test.ts test/ids.test.ts test/audit.test.ts
git commit -m "feat(db): migration 3 (commands, proxy_tokens, proxy_token_state) and the P2 audit actions"
```

---

### Task 5: The Commands service and the channel

**Files:**
- Create: `server/commands/service.ts`, `server/commands/envelope.ts`, `test/commands.test.ts`
- Modify: `server/channel/connection.ts`, `server/channel/hub.ts`, `server/status/store.ts` (hello capabilities), `server/server.ts`, `test/helpers/channel.ts`, `test/helpers/server.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4.
- Produces:
  - `interface CommandRow { id: string; accountId: string; proxyId: string | null; actor: string; command: string; args: Record<string, unknown>; state: 'queued' | 'sent' | 'received' | 'done' | 'refused' | 'failed' | 'expired' | 'unknown'; outcomeCode: string | null; result: Record<string, unknown> | null; createdAt: number; sentAt: number | null; finishedAt: number | null; attempts: number }` (the stored envelope is reduced to its `body.result` in the API view; `resultEnvelope` only in `get()` for evidence).
  - `class Commands { constructor(d: { db: Db; clock: Clock; audit: Audit; registry: Registry; status: StatusStore; live: LiveHub; log: Logger; hub: () => Hub; perProxyPerMin?: number }); create(actor: string, accountId: string, proxyId: string, command: 'tokens.apply', args: Record<string, unknown>, meta?: { reason?: string }): CommandRow; tick(): void; onLive(c: Connection): void; onMessage(c: Connection, m: Envelope): void; list(accountId, proxyId, o: { limit?: number; cursor?: string }): { items: CommandRow[]; nextCursor: string | null }; get(accountId, proxyId, cmdId): CommandRow & { resultEnvelope: unknown }; onFinal(fn: (row: CommandRow) => void): void }`
  - `Connection` gains `capabilities: string[]`, `proxyKey: KeyObject | null` (the verified hello key), `sendSigned(type: 'command', build: (now: number, connId: string) => Record<string, unknown>): string | null` (the envelope id), and routes `result`/`event` to `deps.commands?.onMessage(this, m)`; calls `deps.commands?.onLive(this)` after `welcome`.
  - `Hub.live(proxyId): Connection | null`; `HubDeps.commands?: Commands`.
  - `StatusStore.hello(proxyId, version, ts, capabilities: string[])` → `Reported.capabilities`.
  - Constants: `RESEND_AFTER_MS = 10_000`, `GIVE_UP_AFTER_MS = 15 * 60_000`, `EXP_MS = 60_000`.

- [ ] **Step 1: Failing tests** (`test/commands.test.ts`), using `startServer` (`test/helpers/server.ts`) with `TICK_MS=50` and a `ProxyClient` with `commands: { allow: ['tokens.apply'] }` (Task 3), a fake clock where noted:

```ts
it('create → sent → received → done; the stored evidence verifies with the proxy key', async () => {
  const row = s.commands.create('admin@example.com', acc, prx, 'tokens.apply', ARGS(1));
  expect(row.state).toBe('queued');
  const done = await until(() => s.commands.get(acc, prx, row.id).state === 'done' && s.commands.get(acc, prx, row.id));
  expect(done).toMatchObject({ attempts: 1, outcomeCode: null, result: { revision: 1, applied: true } });
  expect(verifyEnvelope(publicFromB64(client.key.publicKey), done.resultEnvelope as never)).toBe(true);
  expect(auditActions()).toEqual(expect.arrayContaining(['command-create', 'command-result']));
});
it('the command on the wire validates against the strict command schema and carries the connection binding', async () => {
  const m = client.receivedCommands[0];
  expect(strict('command')(m)).toBe(true);
  expect(m.body).toMatchObject({ proxyId: prx, connId: client.connId, cmdId: expect.stringMatching(/^cmd_/), actor: 'admin@example.com' });
  expect(m.body.exp - m.ts).toBe(60_000);
});
it('no received within 10 s → re-sent with the same cmdId and a new envelope id', async () => {
  client.dropCommands = 1; // the test client ignores the first command it gets
  const row = s.commands.create(ACTOR, acc, prx, 'tokens.apply', ARGS(2));
  await until(() => s.commands.get(acc, prx, row.id).state === 'done', 15_000);
  const sends = client.receivedCommands.filter((m) => m.body.cmdId === row.id);
  expect(sends).toHaveLength(2);
  expect(sends[0].id).not.toBe(sends[1].id);
  expect(s.commands.get(acc, prx, row.id).attempts).toBe(2);
});
it('received, then the socket drops: re-sent on the next connection, answered as a duplicate, done once', async () => {});
it('one in flight per proxy: a second command waits until the first is final', async () => {});
it('a proxy without the commands capability: create() refuses 409 unsupported_by_proxy', () => {});
it('the proxy reports tokens.apply not allowed (or paused): create() refuses 409 not_allowed_on_proxy / paused_on_proxy', () => {});
it('a refused result: state refused with the nack code; never re-sent', async () => { client.commands.paused = true; /* … */ });
it('offline for 15 min: queued → expired; sent without a final → unknown; a late done still finalises', () => { /* fake clock + tick */ });
it('results that must be dropped: bad signature, another proxy\'s cmdId, wrong connId, a key from another proxy', async () => {
  // a raw socket authenticated as proxy B sends a correctly signed result for proxy A's cmdId → dropped, A's row unchanged, command-result refused audited once
});
it('more than 20 dropped results on one connection close it (4400)', async () => {});
it('60 commands per minute per proxy, then 429 rate_limited', () => {});
it('the secret marker never appears in commands.args/result, the audit log, or the logs', () => {});
it('write budget: one command end to end costs at most 4 write transactions (create, sent, received, done)', () => {});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**

`server/commands/envelope.ts`:

```ts
import type { Connection } from '../channel/connection';
export const EXP_MS = 60_000;
// Sends one signed command on this live connection; null when it can't.
export function sendCommand(c: Connection, row: { id: string; actor: string; command: string; args: Record<string, unknown>; proxyId: string }): string | null {
  return c.sendSigned('command', (now, connId) => ({ proxyId: row.proxyId, connId, cmdId: row.id, exp: now + EXP_MS, actor: row.actor.slice(0, 200), command: row.command, args: row.args }));
}
```

`Connection.sendSigned`:

```ts
  sendSigned(type: 'command', build: (now: number, connId: string) => Record<string, unknown>): string | null {
    if (this.state !== 'live' || this.ws.readyState !== this.ws.OPEN) return null;
    const now = this.host.deps.clock.now();
    this.seqOut++;
    const m: Record<string, unknown> = { v: 1, type, id: ulid(now), seq: this.seqOut, ts: now, body: build(now, this.connId) };
    m.sig = signEnvelope(this.host.deps.signingKey, m);
    this.ws.send(JSON.stringify(m));
    return m.id as string;
  }
```

In `onHello`, keep `this.proxyKey = publicFromB64(key.public_key)` and `this.capabilities = Array.isArray(b.capabilities) ? b.capabilities.filter((x) => typeof x === 'string').slice(0, 16) : []`; pass capabilities to `status.hello`. In `onMessage`'s switch: `case 'result': case 'event': return d.commands ? d.commands.onMessage(this, v.msg) : this.send('error', { code: 'unsupported_type', message: … }, { re: v.msg.id });`. After `welcome`: `d.commands?.onLive(this)`.

`server/commands/service.ts` — the core:

```ts
export class Commands {
  private inflightConn = new Map<string, string>(); // cmdId → connId it was last sent on (memory; a restart re-sends once)
  private dropped = new WeakMap<Connection, number>();
  private budget: Buckets;
  private finals: ((r: CommandRow) => void)[] = [];
  constructor(private d: CommandsDeps) { this.budget = new Buckets({ capacity: d.perProxyPerMin ?? 60, windowMs: 60_000 }); }

  create(actor: string, accountId: string, proxyId: string, command: 'tokens.apply', args: Record<string, unknown>): CommandRow {
    const px = this.d.registry.getProxy(accountId, proxyId); // 404 for another account's proxy
    if (px.state !== 'enrolled') throw new ApiError(409, 'not_enrolled');
    const rep = this.d.status.row(proxyId)?.reported;
    if (!rep?.capabilities?.includes('commands') || !rep.commands) throw new ApiError(409, 'unsupported_by_proxy');
    if (!rep.commands.enabled || rep.commands.paused) throw new ApiError(409, 'paused_on_proxy');
    for (const need of requiredEntries(command, args)) if (!rep.commands.allow.includes(need)) throw new ApiError(409, 'not_allowed_on_proxy');
    const v = validateCommandArgs(command, args);
    if (!v.ok) throw new ApiError(400, 'invalid_args');
    if (!this.budget.take(proxyId, this.d.clock.now()).ok) throw new ApiError(429, 'rate_limited');
    const id = newId('cmd');
    const now = this.d.clock.now();
    tx(this.d.db, () => {
      this.d.db.prepare(`INSERT INTO commands (id, account_id, proxy_id, actor, command, args, state, created_at) VALUES (?,?,?,?,?,?,'queued',?)`).run(id, accountId, proxyId, actor, command, JSON.stringify(args), now);
      this.d.audit.write({ actorType: actor === 'system' ? 'system' : 'sysadmin', actor, action: 'command-create', accountId, targetType: 'proxy', targetId: proxyId, targetLabel: px.name, outcome: 'ok', detail: { cmdId: id, command, ...summarise(command, args) } });
    });
    queueMicrotask(() => this.dispatch(proxyId));
    return this.get(accountId, proxyId, id);
  }
```

`requiredEntries('tokens.apply', args)` = `['tokens.apply', ...(args.tokens.some(admin) ? ['tokens.apply.admin'] : [])]`. `summarise('tokens.apply', args)` = `{revision, tokens: [{id, kind, label, hashPrefix: hash.slice(0, 15)}]}` — never the full hash.

`dispatch(proxyId)` (also called from `tick()` for every proxy with open rows and from `onLive`):

```ts
  private dispatch(proxyId: string): void {
    const now = this.d.clock.now();
    const open = this.d.db.prepare(`SELECT * FROM commands WHERE proxy_id = ? AND state IN ('queued','sent','received') ORDER BY created_at, id`).all(proxyId).map(toRow);
    for (const r of open) {
      if (now - r.createdAt >= GIVE_UP_AFTER_MS) this.giveUp(r, now);
    }
    const head = open.find((r) => now - r.createdAt < GIVE_UP_AFTER_MS);
    if (!head) return;
    const c = this.d.hub().live(proxyId);
    if (!c || !c.capabilities.includes('commands')) return;
    const due = head.state === 'queued'
      || (head.state === 'sent' && now - (head.sentAt ?? 0) >= RESEND_AFTER_MS)
      || (head.state === 'received' && this.inflightConn.get(head.id) !== c.connId);
    if (!due) return;
    if (!sendCommand(c, { ...head, proxyId })) return;
    this.inflightConn.set(head.id, c.connId);
    const state = head.state === 'received' ? 'received' : 'sent';
    this.d.db.prepare(`UPDATE commands SET state = ?, sent_at = ?, attempts = attempts + 1 WHERE id = ?`).run(state, now, head.id);
  }
```

(One write per send; a resend while `received` keeps the state.) `giveUp`: `queued` with `attempts = 0` → `expired`, otherwise `unknown`; `finished_at`; audit `command-expired` (`detail: {cmdId, state}`); `finals` listeners.

`onMessage(c, m)` — results and events:

```ts
  onMessage(c: Connection, m: Envelope): void {
    const b = m.body as Record<string, unknown>;
    const drop = (reason: string) => {
      this.d.audit.throttled(`cmdres:${c.proxyId}:${reason}`, { actorType: 'proxy', actor: c.proxyId!, action: 'command-result', outcome: 'refused', targetType: 'proxy', targetId: c.proxyId, detail: { reason, cmdId: typeof b.cmdId === 'string' ? b.cmdId.slice(0, 40) : null } });
      const n = (this.dropped.get(c) ?? 0) + 1;
      this.dropped.set(c, n);
      if (n > 20) c.close(CLOSE.bad_message, 'bad_message');
    };
    if (!c.proxyKey || !verifyEnvelope(c.proxyKey, m as never)) return drop('bad_signature');
    if (b.proxyId !== c.proxyId || b.connId !== c.connId) return drop('wrong_target');
    const row = this.d.db.prepare('SELECT * FROM commands WHERE id = ? AND proxy_id = ?').get(String(b.cmdId), c.proxyId!) as Row | undefined;
    if (!row) return drop('unknown_command');
    const r = toRow(row);
    if (b.phase === 'received') {
      if (r.state === 'sent') this.d.db.prepare(`UPDATE commands SET state = 'received' WHERE id = ? AND state = 'sent'`).run(r.id);
      return;
    }
    if (['done', 'refused', 'failed'].includes(r.state)) return; // already final (a duplicate answer)
    const state = b.status === 'ok' ? 'done' : b.status === 'refused' ? 'refused' : 'failed';
    const text = JSON.stringify(m);
    tx(this.d.db, () => {
      this.d.db.prepare(`UPDATE commands SET state = ?, outcome_code = ?, result = ?, result_sig = ?, finished_at = ? WHERE id = ?`)
        .run(state, typeof b.code === 'string' ? b.code.slice(0, 64) : null, text.length <= 98304 ? text : null, m.sig ?? null, this.d.clock.now(), r.id);
      this.d.audit.write({ actorType: 'proxy', actor: c.proxyId!, action: 'command-result', accountId: r.accountId, targetType: 'proxy', targetId: c.proxyId, outcome: state === 'done' ? 'ok' : state === 'refused' ? 'refused' : 'failed', detail: { cmdId: r.id, command: r.command, status: b.status, code: b.code ?? null, duplicate: b.duplicate === true, late: r.state === 'unknown' } });
    });
    this.inflightConn.delete(r.id);
    const fin = this.getById(r.id);
    for (const f of this.finals) f(fin);
    this.d.live.publishRegistry('proxy', c.proxyId!);
    queueMicrotask(() => this.dispatch(c.proxyId!));
  }
```

(The `result` payload is validated leniently by `validateMessage` already; `sanitize()` clamps it for display in `toRow`.) `CommandsDeps` also takes `live: LiveHub`. `server.ts`: construct `Commands` after `hub`, set `hub.deps.commands = commands`, call `commands.tick()` from the existing tick loop.

- [ ] **Step 4: Run** `npx vitest run test/commands.test.ts test/channel.test.ts test/conformance.test.ts test/write-budget.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server/commands server/channel/connection.ts server/channel/hub.ts server/status/store.ts server/server.ts test/commands.test.ts test/helpers/channel.ts test/helpers/server.ts
git commit -m "feat(commands): signed commands with retries by cmdId, verified results, expiry"
```

---

### Task 6: The Tokens service

**Files:**
- Create: `server/tokens/service.ts`, `test/tokens.test.ts`
- Modify: `server/server.ts`, `server/status/store.ts` (heartbeat → `Tokens.onHeartbeat`)

**Interfaces:**
- Consumes: `Commands.create/onFinal` (Task 5).
- Produces:
  - `interface ProxyTokenView { id: string; proxyId: string; kind: 'client' | 'admin'; holder: string; label: string; hashPrefix: string; state: 'pending' | 'active' | 'retiring' | 'revoked' | 'external'; retireAt: number | null; revokedAt: number | null; createdAt: number; createdBy: string; issuedRevision: number; lastCommand: { id: string; state: string; outcomeCode: string | null } | null }`
  - `class Tokens { constructor(d: { db; clock; audit; registry; commands: Commands; status: StatusStore; live: LiveHub }); issue(actor, accountId, proxyId, input: unknown): { token: string; tokenId: string; commandId: string }; retire(actor, accountId, proxyId, tokenId, hours: unknown): ProxyTokenView; revoke(actor, accountId, proxyId, tokenId): ProxyTokenView; reapply(actor, accountId, proxyId): { commandId: string }; list(accountId, proxyId): { revision: number; appliedRevision: number; items: ProxyTokenView[] }; onHeartbeat(proxyId: string, tokens: { revision: number } | null): void; tick(): void }`
  - `generateToken(): { token: string; hash: string }` (exported for tests).

- [ ] **Step 1: Failing tests** (`test/tokens.test.ts`), with the server + test client (`commands: { allow: ['tokens.apply', 'tokens.apply.admin'] }`):

```ts
it('issue: 43-character token, only its hash stored, shown once; pending → active when the proxy confirms', async () => {
  const r = s.tokens.issue(ACTOR, acc, prx, { kind: 'client', label: 'cams cluster' });
  expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const row = s.db.prepare('SELECT * FROM proxy_tokens WHERE id = ?').get(r.tokenId) as Record<string, unknown>;
  expect(row.hash).toBe(`sha256:${createHash('sha256').update(r.token).digest('hex')}`);
  expect(JSON.stringify(s.db.prepare('SELECT * FROM proxy_tokens').all())).not.toContain(r.token);
  expect(JSON.stringify(s.db.prepare('SELECT * FROM audit_log').all())).not.toContain(r.token);
  expect(JSON.stringify(s.db.prepare('SELECT args FROM commands').all())).not.toContain(r.token);
  await until(() => s.tokens.list(acc, prx).items.find((t) => t.id === r.tokenId)?.state === 'active');
  expect(client.tokens.has(row.hash)).toBe(true); // the test client applied it
});
it('every tokens.apply carries the full non-revoked set with a strictly higher revision', async () => {});
it('two issues at once: both tokens in the final set, revisions 1 then 2', async () => {
  const [a, b] = [s.tokens.issue(ACTOR, acc, prx, { kind: 'client', label: 'a' }), s.tokens.issue(ACTOR2, acc, prx, { kind: 'client', label: 'b' })];
  await until(() => s.tokens.list(acc, prx).items.filter((t) => t.state === 'active').length === 2);
  expect(lastAppliedArgs().tokens.map((t) => t.id).sort()).toEqual([a.tokenId, b.tokenId].sort());
});
it('admin kind needs tokens.apply.admin on the proxy: 409 not_allowed_on_proxy otherwise', () => {});
it('retire: retiring with retireAt in the set; hours outside 1–168 → 400; at retireAt → revoked and a cleanup tokens.apply', async () => {});
it('revoke: revoked at once, the next set no longer has it', async () => {});
it('a refused tokens.apply leaves the token pending with the reason shown; re-apply sends the set again', async () => {});
it('restore (R2-11): the proxy reports a higher revision → cams-admin jumps above it and re-sends once', async () => {
  client.tokensRevision = 50; // the proxy has seen revision 50 (from before the restore)
  const r = s.tokens.issue(ACTOR, acc, prx, { kind: 'client', label: 'after restore' });
  await until(() => s.tokens.list(acc, prx).items.find((t) => t.id === r.tokenId)?.state === 'active');
  expect(s.tokens.list(acc, prx).revision).toBe(51);
  expect(auditDetails('command-create').filter((d) => d.reason === 'stale-revision')).toHaveLength(1);
});
it('a heartbeat tokens.revision covering a pending token confirms it (a lost done)', () => {});
it('64 non-revoked tokens per proxy, then 409 too_many_tokens', () => {});
it('another account\'s proxy: 404', () => {});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `server/tokens/service.ts`:

```ts
export function generateToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}` };
}

export class Tokens {
  private bumpedAt = new Map<string, number>();
  constructor(private d: TokensDeps) {
    d.commands.onFinal((r) => { if (r.command === 'tokens.apply' && r.proxyId) this.onApplied(r); });
  }

  // The full managed set as the proxy should have it, with the next revision. In the caller's transaction.
  private nextApply(actor: string, accountId: string, proxyId: string, reason?: string, atLeast = 0): string {
    const st = this.state(proxyId);
    const revision = Math.max(st.revision + 1, atLeast);
    this.d.db.prepare(`INSERT INTO proxy_token_state (proxy_id, revision) VALUES (?, ?) ON CONFLICT(proxy_id) DO UPDATE SET revision = excluded.revision`).run(proxyId, revision);
    const rows = this.d.db.prepare(`SELECT id, kind, hash, label, retire_at FROM proxy_tokens WHERE proxy_id = ? AND state IN ('pending','active','retiring') ORDER BY created_at, id`).all(proxyId) as { id: string; kind: 'client' | 'admin'; hash: string; label: string; retire_at: number | null }[];
    const args = { v: 1, revision, tokens: rows.map((t) => ({ id: t.id, kind: t.kind, hash: t.hash, label: t.label, retireAt: t.retire_at })) };
    return this.d.commands.create(actor, accountId, proxyId, 'tokens.apply', args, reason ? { reason } : undefined).id;
  }

  issue(actor: string, accountId: string, proxyId: string, input: unknown) {
    const { kind, label } = parseIssue(input); // 400 field errors: kind client|admin, label 1–64 printable
    this.d.registry.getProxy(accountId, proxyId);
    const live = (this.d.db.prepare(`SELECT count(*) n FROM proxy_tokens WHERE proxy_id = ? AND state IN ('pending','active','retiring')`).get(proxyId) as { n: number }).n;
    if (live >= 64) throw new ApiError(409, 'too_many_tokens');
    const { token, hash } = generateToken();
    const tokenId = newId('tok');
    let commandId = '';
    tx(this.d.db, () => {
      const rev = this.state(proxyId).revision + 1;
      this.d.db.prepare(`INSERT INTO proxy_tokens (id, account_id, proxy_id, kind, holder, label, hash, state, issued_revision, created_at, created_by) VALUES (?,?,?,?, 'manual', ?,?, 'pending', ?,?,?)`).run(tokenId, accountId, proxyId, kind, label, hash, rev, this.d.clock.now(), actor);
      this.d.audit.write({ actorType: 'sysadmin', actor, action: 'token-issue', accountId, targetType: 'proxy', targetId: proxyId, outcome: 'ok', detail: { tokenId, kind, label, hashPrefix: hash.slice(0, 15) } });
      commandId = this.nextApply(actor, accountId, proxyId);
    });
    this.d.live.publishRegistry('proxy', proxyId);
    return { token, tokenId, commandId };
  }
```

`Commands.create` gains an optional 6th parameter `meta?: { reason?: string }` copied into the `command-create` audit detail; a `create` that throws (409 pre-checks) rolls back the token insert because it runs inside the same `tx` (the `tx` helper joins the outer transaction). `retire`: `hours` integer 1–168 (default 24), state must be `active` (409 `not_active` otherwise), set `retiring`, `retire_at = now + hours·3600_000`, audit `token-retire`, `nextApply`. `revoke`: any non-revoked state → `revoked`, `revoked_at`, audit `token-revoke`, `nextApply`. `reapply`: `nextApply(actor, …, 'reapply')`, audit via `command-create` only. `tick()`: rows `retiring` with `retire_at <= now` → `revoked` (actor `system`, audit `token-revoke` with `detail.reason: 'retired'`), one `nextApply('system', …)` per affected proxy (skipped with a log line when `create` refuses, e.g. the proxy paused: the proxy itself already stopped accepting the token at `retireAt`).

`onApplied(r)`:

```ts
  private onApplied(r: CommandRow): void {
    const res = r.result as { revision?: number; applied?: boolean; stale?: boolean } | null;
    if (r.state !== 'done' || !res || typeof res.revision !== 'number') return; // refused/failed: tokens stay pending; the UI shows r's outcome
    const st = this.state(r.proxyId!);
    if (res.stale && res.revision >= st.revision) {
      // R2-11: the proxy is ahead (cams-admin was restored). Jump above it, once per 10 min per proxy.
      const last = this.bumpedAt.get(r.proxyId!) ?? 0;
      if (this.d.clock.now() - last < 600_000) return;
      this.bumpedAt.set(r.proxyId!, this.d.clock.now());
      tx(this.d.db, () => this.nextApply('system', r.accountId, r.proxyId!, 'stale-revision', res.revision! + 1));
      return;
    }
    this.confirm(r.proxyId!, res.revision);
  }

  // Everything issued up to `revision` is on the proxy.
  private confirm(proxyId: string, revision: number): void {
    const st = this.state(proxyId);
    if (revision > st.revision || revision <= st.appliedRevision) return;
    tx(this.d.db, () => {
      this.d.db.prepare(`UPDATE proxy_tokens SET state = 'active', applied_revision = ? WHERE proxy_id = ? AND state = 'pending' AND issued_revision <= ?`).run(revision, proxyId, revision);
      this.d.db.prepare(`UPDATE proxy_token_state SET applied_revision = ? WHERE proxy_id = ?`).run(revision, proxyId);
    });
    this.d.live.publishRegistry('proxy', proxyId);
  }

  onHeartbeat(proxyId: string, t: { revision: number } | null): void {
    if (t && Number.isSafeInteger(t.revision)) this.confirm(proxyId, t.revision); // writes only when it confirms something new
  }
```

(Revoked rows stay revoked; a stale answer never re-activates anything because `confirm` only touches `pending` rows with `issued_revision ≤ revision ≤ our revision`.)

`server.ts`: construct `Tokens` after `Commands`; `tokens.tick()` in the tick loop; `StatusStore` heartbeat calls an injected `onTokens?.(proxyId, info.tokens)` hook.

- [ ] **Step 4: Run** `npx vitest run test/tokens.test.ts test/commands.test.ts test/write-budget.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server/tokens server/server.ts server/status/store.ts server/commands/service.ts test/tokens.test.ts
git commit -m "feat(tokens): issue, retire, revoke managed proxy tokens (hashes only) via tokens.apply"
```

---

### Task 7: Status — the proxy's command and token report

**Files:**
- Modify: `server/status/store.ts`, `server/status/derive.ts`, `server/api/router.ts` (`dashboard`, `proxyDetail`), `test/status.test.ts`, `test/write-budget.test.ts`

**Interfaces:**
- Produces: `Reported` gains `capabilities?: string[]`, `commands?: { enabled: boolean; paused: boolean; pauseReason: string | null; allow: string[]; seenWindow: number } | null`, `tokens?: { revision: number; client: number; admin: number; blocked: string[] } | null`, `configRevision?: string | null`; `ProxyView.commands: 'unsupported' | 'off' | 'paused' | 'none-allowed' | 'allowed'` (derived), `ProxyView.allow: string[]`; dashboard proxy rows carry `commands` and `allow`.

- [ ] **Step 1: Failing tests:** a P1 heartbeat → `commands: 'unsupported'`; P2 with `allow: []` → `'none-allowed'`; paused → `'paused'`; `enabled: false` → `'off'`; with entries → `'allowed'`; malformed fields (strings too long, 100 allow entries, `pauseReason` 10 KiB) are clamped by `sanitize` and never break the heartbeat; `write-budget`: 20 P2 proxies heartbeating for a simulated hour with **changing** `commands.paused` every 5 minutes still stay within the existing budget (the change publishes live, writes nothing by itself).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (parse in `heartbeat()` next to `tls`; `deriveCommands(rep)` in `derive.ts`; the change of `reported.commands` is compared and, when different, calls `live.publishStatus(proxyId)` without marking the row meaningful). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

```bash
git add server/status server/api/router.ts test/status.test.ts test/write-budget.test.ts
git commit -m "feat(status): show each proxy's command policy and token revision"
```

---

### Task 8: API routes

**Files:**
- Modify: `server/api/router.ts`, `test/api.test.ts`, `test/api-audit-completeness.test.ts`
- Create: `test/api-tokens.test.ts`

**Interfaces:**
- Produces (all under the sysadmin session, CSRF header, write limiter):
  - `GET  /accounts/:accountId/proxies/:proxyId/commands?limit&cursor` → `{items: CommandRow[], nextCursor}`
  - `GET  /accounts/:accountId/proxies/:proxyId/commands/:cmdId` → `CommandRow & { resultEnvelope }`
  - `GET  /accounts/:accountId/proxies/:proxyId/tokens` → `{revision, appliedRevision, items: ProxyTokenView[]}`
  - `POST /accounts/:accountId/proxies/:proxyId/tokens` `{kind, label}` → **201** `{token, tokenId, commandId, shownOnce: true}` with `Cache-Control: no-store`
  - `POST /accounts/:accountId/proxies/:proxyId/tokens/:tokenId/retire` `{hours}` → 200
  - `POST /accounts/:accountId/proxies/:proxyId/tokens/:tokenId/revoke` → 200
  - `POST /accounts/:accountId/proxies/:proxyId/tokens/apply` → 202 `{commandId}`
  - Errors: 400 `invalid` (field), 404, 409 `not_enrolled` / `unsupported_by_proxy` / `not_allowed_on_proxy` / `paused_on_proxy` / `too_many_tokens` / `not_active`, 429.

- [ ] **Step 1: Failing tests** (`test/api-tokens.test.ts`): every route's happy path and error codes; the issue answer has `Cache-Control: no-store` and the token appears in that body only — a following `GET …/tokens`, `GET …/commands`, `GET /dashboard`, `GET /audit` and the SSE stream (`/live`, read for 1 s) never contain it nor a full hash (regex `sha256:[0-9a-f]{16}` must not match); the completeness table gains the four write routes, with `action` allowed to be a list (`['token-issue', 'command-create']`, `['token-retire', 'command-create']`, `['token-revoke', 'command-create']`, `['command-create']`) — change the table type `action: string | string[]` and the count check to `action.length`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** in `apiRouter` next to the proxy routes:

```ts
  const tokenBase = `${proxyBase}/tokens`;
  r.get(`${proxyBase}/commands`, h((req) => d.commands.list(p(req, 'accountId'), p(req, 'proxyId'), { limit: limit(req), cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined })));
  r.get(`${proxyBase}/commands/:cmdId`, h((req) => d.commands.get(p(req, 'accountId'), p(req, 'proxyId'), p(req, 'cmdId'))));
  r.get(tokenBase, h((req) => d.tokens.list(p(req, 'accountId'), p(req, 'proxyId'))));
  r.post(tokenBase, h((req, res) => {
    created(res);
    res.set('Cache-Control', 'no-store');
    const out = d.tokens.issue(actor(res), p(req, 'accountId'), p(req, 'proxyId'), req.body);
    reg('proxy', p(req, 'proxyId'));
    return { ...out, shownOnce: true };
  }));
  r.post(`${tokenBase}/apply`, h((req, res) => { res.status(202); return d.tokens.reapply(actor(res), p(req, 'accountId'), p(req, 'proxyId')); }));
  r.post(`${tokenBase}/:tokenId/retire`, h((req, res) => d.tokens.retire(actor(res), p(req, 'accountId'), p(req, 'proxyId'), p(req, 'tokenId'), req.body?.hours)));
  r.post(`${tokenBase}/:tokenId/revoke`, h((req, res) => d.tokens.revoke(actor(res), p(req, 'accountId'), p(req, 'proxyId'), p(req, 'tokenId'))));
```

(`h()` already honours a status set before returning; check that `res.status(202)` survives its `res.status(... ? 201 : 200)` — if not, extend `h` with `res.locals.status`.) `ApiDeps` gains `commands`, `tokens`.
- [ ] **Step 4: Run** `npx vitest run test/api-tokens.test.ts test/api.test.ts test/api-audit-completeness.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add server/api/router.ts server/server.ts test/api-tokens.test.ts test/api.test.ts test/api-audit-completeness.test.ts
git commit -m "feat(api): proxy command history and managed token routes (token shown once)"
```

---

### Task 9: Web UI

**Files:**
- Create: `web/src/lib/commands.ts`, `web/src/lib/commands.test.ts`, `web/src/components/ProxyCommands.svelte`, `web/src/components/ProxyTokens.svelte`, `web/src/components/ShownOnce.svelte`, `e2e/tokens.spec.ts`
- Modify: `web/src/pages/Proxy.svelte`, `web/src/pages/Dashboard.svelte`, `web/src/lib/api.ts` (types), `e2e/server.ts` (a test-client proxy with `commands` for the e2e)

**Interfaces:**
- Consumes: Task 7/8 routes.
- Produces:
  - `commandsText(v: ProxyView['commands']): string` — `unsupported` "this proxy version takes no commands", `off` "commands are off on the proxy (environment)", `paused` "paused on the proxy", `none-allowed` "no command allowed on the proxy", `allowed` "allowed: <entries>".
  - `stateText(state)`/`stateClass(state)` for command rows (`queued`, `sent`, `received`, `done`, `refused <code>`, `failed <code>`, `expired`, `unknown` — "unknown: check the proxy's audit log").
  - Proxy page: **Commands** card (policy line, the last 20 commands: time, actor, command, state, code; "more" pages with `cursor`), **Tokens** card (table: id, kind, label, state, issued, retires/revoked, last command outcome; buttons **Issue client token**, **Issue admin token** (disabled with the reason when the proxy doesn't allow `tokens.apply.admin`), **Retire** (hours field, 24 default), **Revoke** (Confirm dialog), **Re-apply**).
  - `ShownOnce.svelte`: shows the token in a read-only monospace field with **Copy**, the sentence "This is the only time cams-admin shows this token. Put it in cams's `cameras-config.json` as this proxy's `token` (cluster: the `cams-cameras` Secret, through kube-setup). If you lose it, revoke it and issue a new one.", and a checkbox "I have stored it" that enables **Close**; the token is held only in the component's state and cleared on close; never put in the URL, `localStorage` or the router state.
  - Dashboard proxy rows: a small chip with `commandsText`.

- [ ] **Step 1: Failing tests:** `web/src/lib/commands.test.ts` for the text/class functions; `e2e/tokens.spec.ts` (Playwright, the e2e lock): sign in (fake Google), open a proxy whose test-client allows `tokens.apply`, **Issue client token** → the dialog shows a 43-character token, Close stays disabled until the box is ticked; after Close, the token is nowhere in the page (`page.content()` doesn't contain it) and the row turns `active`; **Retire** with 1 h → `retiring`; **Revoke** → `revoked`; a proxy without `commands` shows "this proxy version takes no commands" and no Issue buttons.
- [ ] **Step 2: Run** `npx vitest run web/src/lib/commands.test.ts && npm run test:e2e -- e2e/tokens.spec.ts` → FAIL.
- [ ] **Step 3: Implement** the components (Svelte 5 runes, the existing `Confirm.svelte`, `StateChip.svelte`, `Ago.svelte`; live refresh on the existing registry/status SSE events for this proxy).
- [ ] **Step 4: Run** → PASS; `npm run check && npm run check:svelte`.
- [ ] **Step 5: Commit**

```bash
git add web/src e2e/tokens.spec.ts e2e/server.ts
git commit -m "feat(ui): proxy commands and managed tokens (shown once)"
```

**→ PR B ends here** ("commands and managed tokens"). Release cams-admin.

---

### Task 10: The local stack with real cam-proxies, and the two-proxy P2 check

Runs after cam-proxy PR B is on cam-proxy `main` (rollout step 4).

**Files:**
- Modify: `scripts/localstack/start.sh`, `scripts/localstack/setup.ts`, `docs/localstack.md`
- Create: `scripts/localstack/p2-check.ts`

**Interfaces:**
- Consumes: cams-admin API (session cookie from `npm run dev:session`), cam-proxy's `admin-enroll` CLI and control API (`/control/admin/commands*`, its local admin token from the run's secrets folder), cam-proxy's client API.
- Produces: `scripts/localstack/start.sh` enrolls each proxy with the real `admin-enroll` (code on stdin) when the cam-proxy worktree has `src/fleet/commands.ts`; `LOCALSTACK_BRIDGE=1` keeps the P1 bridge. `npx tsx scripts/localstack/p2-check.ts` prints one line per check and exits non-zero on the first failure.

- [ ] **Step 1: Write `p2-check.ts`** against the running stack (`alpha-1` on 29100 and `beta-2` on 29300 — two proxies in two accounts; `beta-2` is the three-camera proxy):

```ts
// The P2 two-proxy check (plan Task 10). Never anything but 127.0.0.1.
const checks: [string, () => Promise<void>][] = [
  ['both proxies report commands, nothing allowed', async () => {
    for (const px of [A, B]) expect((await dash()).proxy(px.id).commands, px.name).toBe('none-allowed');
  }],
  ['issuing on a proxy that allows nothing: 409 not_allowed_on_proxy', async () => {
    expect((await api('POST', tokensUrl(A), { kind: 'client', label: 'p2-check' })).status).toBe(409);
  }],
  ['allow tokens.apply on alpha-1 with its LOCAL admin token; beta-2 stays closed', async () => {
    expect((await proxyApi(A, 'PUT', '/control/admin/commands', { allow: ['tokens.apply'] }, A.adminToken)).status).toBe(200);
    await waitFor(async () => (await dash()).proxy(A.id).commands === 'allowed');
  }],
  ['issue a client token: active, works on alpha-1 only, audited on both sides with the same cmdId', async () => {
    const r = await (await api('POST', tokensUrl(A), { kind: 'client', label: 'p2-check' })).json();
    await waitFor(async () => (await tokens(A)).find((t) => t.id === r.tokenId)?.state === 'active');
    expect((await proxyGet(A, '/api/cameras', r.token)).status).toBe(200);
    expect((await proxyGet(B, '/api/cameras', r.token)).status).toBe(401);
    const proxyAudit = await proxyAuditFor(A, 'admin-command');
    expect(proxyAudit.some((x) => x.details.cmdId === r.commandId)).toBe(true);
    expect((await adminAudit('command-result')).some((x) => x.detail.cmdId === r.commandId)).toBe(true);
    state.t1 = r;
  }],
  ['rotation without downtime: 0 failed requests while T2 is issued, cams switches, T1 is revoked', async () => {
    let current = state.t1.token;
    let failures = 0;
    const loop = setInterval(async () => { if ((await proxyGet(A, '/api/cameras', current)).status !== 200) failures++; }, 50);
    const t2 = await (await api('POST', tokensUrl(A), { kind: 'client', label: 'p2-check 2' })).json();
    await waitFor(async () => (await tokens(A)).find((t) => t.id === t2.tokenId)?.state === 'active');
    current = t2.token;
    await sleep(500);
    await api('POST', `${tokensUrl(A)}/${state.t1.tokenId}/revoke`, {});
    await waitFor(async () => (await proxyGet(A, '/api/cameras', state.t1.token)).status === 401);
    clearInterval(loop);
    expect(failures).toBe(0);
  }],
  ['pause on beta-2 (local), allow tokens.apply there: refused paused; cams-admin cannot resume it', async () => {
    await proxyApi(B, 'PUT', '/control/admin/commands', { allow: ['tokens.apply'] }, B.adminToken);
    await proxyApi(B, 'POST', '/control/admin/commands/pause', { reason: 'p2-check' }, B.adminToken);
    await waitFor(async () => (await dash()).proxy(B.id).commands === 'paused');
    expect((await api('POST', tokensUrl(B), { kind: 'client', label: 'x' })).status).toBe(409); // paused_on_proxy
    await proxyApi(B, 'POST', '/control/admin/commands/resume', {}, B.adminToken);
  }],
  ['env kill switch: restart beta-2 with CAMPROXY_ADMIN_COMMANDS=off → off; back on after restart without it', async () => {
    await restartProxy(B, { CAMPROXY_ADMIN_COMMANDS: 'off' });
    await waitFor(async () => (await dash()).proxy(B.id).commands === 'off');
    await restartProxy(B, {});
    await waitFor(async () => (await dash()).proxy(B.id).commands === 'allowed');
  }],
  ['CAMPROXY_TOKENS still works on both proxies throughout', async () => {
    for (const px of [A, B]) expect((await proxyGet(px, '/api/cameras', px.clientToken)).status).toBe(200);
  }],
];
```

`restartProxy` stops only the PID `start.sh` recorded for that proxy (never by name) and starts it again with the same command line plus the given env; `A/B.adminToken` and `clientToken` are read from the run's secrets folder (mode 600) into memory and never printed.
- [ ] **Step 2:** `scripts/localstack/start.sh && npx tsx scripts/localstack/p2-check.ts`. Expected: every line `ok`. (If cam-proxy `main` lacks P2, `start.sh` prints "cam-proxy main has no commands yet: P2 check skipped" and `p2-check.ts` exits 2.)
- [ ] **Step 3:** `docs/localstack.md`: replace "The bridge" paragraph (real `admin-enroll` now; `LOCALSTACK_BRIDGE=1`), add "The P2 check" with what it proves and its runtime (~2 min).
- [ ] **Step 4: Commit**

```bash
git add scripts/localstack/start.sh scripts/localstack/setup.ts scripts/localstack/p2-check.ts docs/localstack.md
git commit -m "test(localstack): real cam-proxy enrollment and the two-proxy commands/tokens check"
```

---

### Task 11: Docs and the kube-setup note

**Files:**
- Create: `docs/kube-setup-request-p2.md`
- Modify: `README.md`, `CHANGELOG.md` (`## [Unreleased]`), `CLAUDE.md`, `contract/README.md` (if not done in Task 2)

- [ ] **Step 1:** `docs/kube-setup-request-p2.md`:
  - **No manifest change:** commands and results use the existing proxy channel (`/proxy/v1/connect`); the cluster proxy already reaches cams-admin in the cluster (P1 NetworkPolicy). No new host, port, egress, Secret or env variable for cams-admin or cam-proxy.
  - **One data change at cut-over step 1 (M §11.4):** after cams-admin issues the managed client and admin tokens for the cluster proxy, the `cams-cameras` Secret's `cameras.json` gets them in place of the old `proxy.token`/`proxy.adminToken` for that proxy (Klaus hands the values over directly, never through a repo, an issue or a chat log). Rollback: the previous Secret data (the old tokens never stopped working).
  - **Nothing for P2 on the Pi** that touches the cluster.
- [ ] **Step 2:** `README.md`: "Commands and managed tokens" section (what cams-admin can do to a proxy in P2: `tokens.apply` only; allow-lists live on each proxy; tokens shown once, stored as hashes). `CLAUDE.md`: "Tokens are shown once and stored only as SHA-256 hashes; never log, store or test with a real token" and "commands: the contract's check order is normative; a change goes into contract/ first". `CHANGELOG.md`: the user-visible changes.
- [ ] **Step 3:** Full checks: `npm run lint:types && npm test && npm run build && npm run check && npm run check:svelte && scripts/contract/cam-proxy-check.sh && npm run test:e2e && npm audit --audit-level=high && scripts/backup/restore-test.sh`. Expected: green.
- [ ] **Step 4: Commit**

```bash
git add docs/kube-setup-request-p2.md README.md CHANGELOG.md CLAUDE.md contract/README.md
git commit -m "docs: commands and managed tokens; kube-setup note for P2"
```

---

## Release and rollout order (both repos)

Each step is its own PR to `main` (checks must pass; merge only then), and every step leaves the Pi and the cluster proxy working.

1. **cams-admin PR A — contract** (Tasks 1–3). Merge to `main`. cam-proxy's `contract-drift` check now fails on cam-proxy PRs until step 2: do step 2 the same day.
2. **cam-proxy PR A — vendor** (cam-proxy plan Task 1). No behaviour change; no release.
3. **cams-admin PR B — commands and tokens** (Tasks 4–9, 11). Release cams-admin (`main` → `production`). Safe: P1 proxies don't announce `commands`; the UI says "this proxy version takes no commands"; migration 3 only adds tables.
4. **cam-proxy PR B** (cam-proxy plan Tasks 2–11). Release cam-proxy. The cluster proxy updates through its release workflow; the Pi is updated by the release owner. Both report "no command allowed" → **P2a done**. `scripts/contract/cam-proxy-check.sh` now cross-checks cam-proxy's real command check on every cams-admin PR.
5. **cams-admin PR C — local stack** (Task 10), run on the Mac against cam-proxy `main`.
6. **Cut-over steps 1–2** (M §11.4), with Klaus: on the cluster proxy's card, with its local admin token, allow `tokens.apply` and `tokens.apply.admin`; issue a client and an admin token for the cluster cams; Klaus / kube-setup put them into `cams-cameras` (`docs/kube-setup-request-p2.md`); check cams (live, recordings, sign-in link, rename) and the proxy audit shows the token labels; then the Pi's proxy, with tokens for both cams instances. Rollback: the old tokens in cams again (never stopped working), or pause on the card. **P2b done** after one proven rollback.

## kube-setup

No manifest, NetworkPolicy, Secret-shape or env change for P2. One Secret **data** update (`cams-cameras`) at cut-over step 1, written up in `docs/kube-setup-request-p2.md`.

## Self-review

- **Spec coverage:** M §5 tables and audit actions (Task 4; `cams_*`, `proxy_config`, `config_revision` are P3/P4); §7.1 contract and capability (Tasks 2, 5, 7); §7.2 signing and binding (Tasks 1, 5); §7.3 retries with the same `cmdId`, `unknown` after 15 min (Task 5); §7.4 signed results stored with signature (Task 5, R2-12); §7.8 server limit 60/min/proxy (Task 5); §7.9 cams-admin audit (Tasks 5, 6); §10.1 lifecycle, manual holder, shown once (Tasks 6, 8, 9, R2-10); §10.2 declarative set with revision (Task 6, R2-11); §13.1 forged/replayed/hostile proxy/flood/lost command (Tasks 3, 5); §13.3 logging and secret guard (Tasks 5, 6, 8); §14.1–§14.3 tests (Tasks 2–10); §15 P2a/P2b done criteria (rollout). Interfaces P3 consumes: `Commands.create` for any wire command (P3 widens its `command` type and `validateCommandArgs`), `WIRE_COMMANDS`, `ALLOW_ENTRIES`, `Reported.configRevision`, the Commands card.
- **Placeholder scan:** none; Task 10 depends on cam-proxy `main` by design and says what happens before.
- **Type consistency:** `Commands.create/onFinal/onMessage/onLive/tick/list/get`, `Tokens.issue/retire/revoke/reapply/list/onHeartbeat/tick`, `Connection.sendSigned/capabilities/proxyKey`, `Hub.live` are used with the same signatures in Tasks 5–10.
