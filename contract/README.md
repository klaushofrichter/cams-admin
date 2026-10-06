# The cams-admin proxy protocol, v1: the contract

This folder is the single written source of the wire format between
cam-proxy and cams-admin (spec
`docs/superpowers/specs/2026-10-06-cams-admin-phase1-design.md` §8, §15.4).
Both repositories test against it, so neither can change the payload alone.

| file | what |
|---|---|
| `v1/*.schema.json` | JSON Schema (draft 2020-12), **lenient**: what cams-admin accepts at run time. Unknown fields are ignored; health-summary enums are plain strings |
| `v1/strict/*.schema.json` | the same, **strict**: closed objects, every field required, enums enforced. For tests |
| `v1/fixtures/*.json` | `valid-*` (both accept), `invalid-*` (strict refuses; `$expect.runtime` is the server's answer), `drift-*` (the server accepts, strict refuses: the cases that catch drift) |
| `v1/vectors.json` | fixed Ed25519 test keys and the exact signed strings with their signatures |
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
