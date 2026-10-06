# The cams-admin proxy protocol, v1: the contract

This folder is the single written source of the wire format between
cam-proxy and cams-admin (spec
`docs/superpowers/specs/2026-10-06-cams-admin-phase1-design.md` §8, §15.4).
Both repositories test against it, so neither can change the payload alone.

| file | what |
|---|---|
| `v1/*.schema.json` | JSON Schema (draft 2020-12), **lenient**: what cams-admin accepts at run time. Unknown fields are ignored; health-summary enums are plain strings |
| `v1/strict/*.schema.json` | the same, **strict**: closed objects, every field required, enums enforced. For tests |
| `v1/commands/*.schema.json` | per-command `args` and `result` schemas (P2: `tokens.apply`), lenient and in `v1/strict/commands/` |
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

Uniqueness of `id` and `hash` inside `tokens.apply`'s `tokens` cannot be said
in JSON Schema: it is checked in code on both sides.

The heartbeat's `proxy` block gains three optional fields (`commands`,
`tokens`, `configRevision`), optional in strict too, so P1 heartbeats stay
valid. A P2 proxy announces `capabilities: ["status", "commands"]`.
