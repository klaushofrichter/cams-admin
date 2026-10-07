# The cams-admin proxy protocol, v1: the contract

This folder is the single written source of the wire format between
cam-proxy and cams-admin (spec
`docs/superpowers/specs/2026-10-06-cams-admin-phase1-design.md` §8, §15.4).
Both repositories test against it, so neither can change the payload alone.

| file | what |
|---|---|
| `v1/*.schema.json` | JSON Schema (draft 2020-12), **lenient**: what cams-admin accepts at run time. Unknown fields are ignored; health-summary enums are plain strings |
| `v1/strict/*.schema.json` | the same, **strict**: closed objects, every field required, enums enforced. For tests |
| `v1/commands/*.schema.json` | per-command `args` and `result` schemas (P2: `tokens.apply`; P3: the seven remote-configuration commands), lenient and in `v1/strict/commands/` |
| `v1/remote-settable.json` | P3: the upper bound of the settings any proxy may let cams-admin set (`remote`), the one-way paths (`narrow`) and what is never remote (`denied`) |
| `v1/fixtures/*.json` | `valid-*` (both accept), `invalid-*` (strict refuses; `$expect.runtime` is the receiver's answer), `drift-*` (the receiver accepts, strict refuses: the cases that catch drift), `refused-*` (strict accepts, the receiving proxy refuses with the nack code in `$expect.runtime`) |
| `v1/vectors.json` | fixed Ed25519 test keys, the exact signed strings with their signatures, canonical JSON (`jcs`) cases and signed envelopes (`envelopes`) |
| `build.ts`, `make.ts` | the source of the schemas and fixtures; `npm run contract:make` rewrites `v1/` |

## Rules

- Change `build.ts`, run `npm run contract:make`, commit the result. A test
  fails while the committed files differ from a fresh build.
- A new health-summary field in cam-proxy: add it here first (cams-admin PR),
  then vendor the new `v1/` into cam-proxy `test/contract/cams-admin-v1/`
  (with `SOURCE` = the cams-admin commit). cam-proxy's heartbeat test runs the
  strict schema, so the field can't ship unannounced; cams-admin's
  "every field is shown" test makes the dashboard show it.
- Text fields are at most 200 characters. The server clamps longer ones;
  the proxy must clamp before sending (strict refuses them).
- `seq` starts at 1 per connection and direction and increases by exactly 1.

## Signed strings (see `vectors.json`)

```
enroll:    "cams-admin enroll v1\n" + canonicalCode + "\n" + publicKey
challenge: "cams-admin/v1 challenge\n" + connId + "\n" + nonce + "\n" + serverTime
hello:     "cams-admin/v1 hello\n" + connId + "\n" + nonce + "\n" + proxyId + "\n" + keyId + "\n" + ts
```

`canonicalCode` is `CAE1-XXXX-XXXX-XXXX-XXXX-XXXX` (upper case; input
normalised: spaces and dashes dropped, `O`→`0`, `I`/`L`→`1`). Keys are
Ed25519: public as base64 SPKI DER (44 bytes), private as base64 PKCS#8 DER.
Signatures are base64 (64 bytes), in the envelope's `sig` for `challenge`
and `hello`.

## Commands (P2)

`command` (server → proxy), `result` and `event` (proxy → server) are signed
envelopes:

```
sig = base64(Ed25519(UTF-8(jcs(envelope without sig))))
```

`jcs` is RFC 8785 canonical JSON for what the protocol carries (the same
function is `server/crypto/jcs.ts` here and `src/fleet/jcs.ts` in cam-proxy;
`vectors.json` has the cases both must reproduce). The receiver canonicalises
the parsed message as received, unknown fields included, minus `sig`.
cams-admin's key signs commands; the proxy's enrolled key signs results and
events. Ed25519 is deterministic, so both sides reproduce the vectors'
signatures byte for byte.

Fixtures for the proxy side carry `$expect.receiver: "proxy"` (default:
the server) and a `$context`: `{now, proxyId, connId, serverKeys, allow,
paused, seen}`, what the receiving proxy knows (`now` is cams-admin time,
`seen` the envelope ids already seen on the connection).
`valid-command-tokens-apply` has a `$context` and no `$expect`: the proxy runs it.

The proxy's check order is normative (the plans' section "The P2 contract",
cams-admin `docs/superpowers/plans/2026-10-06-migration-p2-cams-admin.md`):
cmdId readable (else `error bad_message`) → signature (`bad_signature`) →
proxyId/connId (`wrong_target`) → envelope id unseen (`replayed`) → `exp`
(`expired`) → journal (`duplicate`) → paused/env switch (`paused`) → allowed
(`not_allowed`) → rate (`rate_limited`) → `args.v` (`unsupported_version`) and
args (`invalid_args`) → allow entries the args need (`not_allowed`) → busy.

**`revocationOnly`** (optional boolean in a `command` body; `tokens.apply`
only; added after the first P2 contract, backward compatible): the set only
removes tokens from the proxy's current managed set: every entry of
`args.tokens` is in the current set with the same `id`, `kind`, `hash`,
`label` and `retireAt`. The proxy verifies the claim at step 10 (a false
claim → `invalid_args`); a true claim skips the pause (step 7, but never the
env kill switch: `paused`), the allow-list (step 8) and the allow entries the
args need (step 11). A proxy that predates it ignores the field and treats
the command as a plain `tokens.apply`. Proxy fixtures carry the proxy's
current set in `$context.tokens` and the env switch in `$context.enabled`
(default true).

Uniqueness of `id` and `hash` inside `tokens.apply`'s `tokens` cannot be said
in JSON Schema: it is checked in code on both sides.

The heartbeat's `proxy` block gains three optional fields (`commands`,
`tokens`, `configRevision`), optional in strict too, so P1 heartbeats stay
valid. A P2 proxy announces `capabilities: ["status", "commands"]`.

## Remote configuration (P3)

Additive: the envelope stays v1, the subprotocol `cams-admin.v1`, signatures
and JCS unchanged; no new message type and no new heartbeat field. P3
implements `config.get`, `config.set`, `config.unset`, `config.rollback`,
`camera.action`, `camera.name.set` and `proxy.restart` (all in the strict
`command` enum since P2), each with `commands/<name>.args` and
`commands/<name>.result` schemas. The full text (args, outcomes, results,
path checks) is "The P3 contract" in
`docs/superpowers/plans/2026-10-07-migration-p3-cams-admin.md`; it is binding
for both repositories.

**Every allow entry is off by default.** The disruptive entries are
`proxy.restart` and `camera.action:<a>` for the actions in
`DISRUPTIVE_ACTIONS` (`build.ts`); the UIs group them and ask for a typed
confirmation. `NEVER_REMOTE_ACTIONS` are never run for cams-admin, whatever
the allow-list says.

Changed steps of the check order:

- **Step 8 (allowed):** `camera.action` passes with at least one
  `camera.action:*` entry; every other command needs its own name.
- **Step 9 (rate, in memory):** the totals plus per-command windows:
  `config.set`, `config.unset` and `config.rollback` share one window of 6
  per minute (dry runs count); `camera.action` 12 per minute;
  `camera.name.set` 6 per minute; `tokens.apply` 6 per hour. `config.get`
  counts only toward the totals.
- **Step 11 (entries and budgets):** an action in `NEVER_REMOTE_ACTIONS` →
  `not_allowed`; otherwise `camera.action:<action>` must be allowed →
  else `not_allowed`; a disruptive action or `proxy.restart` must fit the
  **journal budget** (persisted: `proxy.restart` ≤ 2 per hour, disruptive
  `camera.action`s ≤ 6 per hour per proxy, whatever their status) → else
  `rate_limited` with `retryAfterS`.

`done` outcomes (nothing is written on anything but `ok` with
`dryRun: false`):

| command | `ok` | `conflict` | `failed` codes |
|---|---|---|---|
| `config.get` | the view | — | `store_error` |
| `config.set`, `config.unset` | the change list (also for a dry run) | `baseRevision` ≠ the current `configRevision` | `not_remote_settable`, `held_by_env`, `unknown_camera`, `widening_local_only`, `invalid_value`, `store_error` |
| `config.rollback` | the change list | a path the command changed has changed since | `no_backup`, `already_rolled_back`, `not_remote_settable`, `invalid_value`, `store_error` |
| `camera.action` | the action answered 2xx | — | the action's error code |
| `camera.name.set` | the name as read back | — | `invalid_name`, `camera_offline`, `camera_error`, `unknown_camera` |
| `proxy.restart` | `{restartAt}`; the restart follows the result | — | — |

**`remote-settable.json` is the upper bound:** cam-proxy's compiled list
must be a subset of `remote` (a test on each side); a path outside it is
never remote-settable, whatever a proxy reports. `narrow` paths move one way
only from cams-admin: Google Vision spending only down (`less`; 0 = no cap
for `dailyCap` and `perCameraDailyCap`), every retention period and size cap
only up (`more`; an unset size cap = no cap), so cams-admin can never make a
proxy delete data. `storage.*` and `cameras.*.storage.*` are local only.
A `config.rollback` is exempt from `narrow` (it restores what a local person
set).

Fixtures: a P3 proxy fixture's `$context` may carry `journal`, a list of
`{cmdId, command, at, action?}` the journal budget counts. Result fixtures
name their command in `$command`. The starred refused fixtures (bad path,
object value, 65 paths, no camera, never-remote action) pass the `command`
schema and fail their `commands/<name>.args` schema.

**Cross-check while the repos are out of step:** a command fixture whose
`body.command` cam-proxy `main` does not implement yet, and whose verdict
differs, is reported `pending` (not a failure) by
`scripts/contract/cam-proxy-commands.ts`; once cam-proxy implements P3,
nothing may be `pending`.
