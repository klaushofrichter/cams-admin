# Read-only diagnostics API and token (issue #45)

Klaus (2026-10-22): "we need more diagnostic APIs... there is too much of me
looking for values somewhere." During the first real camera move every
cams-admin value (registry fields, routes, held changes, reported problems,
why a move was refused) had to come from Klaus as a screenshot, because every
`/api` route needs his Google sign-in.

## Goals

- A **diagnostics token**: issued by a signed-in sysadmin, shown once, stored
  only as its SHA-256 hash, with a name and an expiry, revocable, issue and
  revoke audited.
- A **read-only API** under `/api/v1/diag/` that takes either that token
  (`Authorization: Bearer …`) or a sysadmin session.
- Answers that carry **no secrets**: no token, hash, code, key, password,
  e-mail address or free-text note (the same guard as the cams-v1 snapshot:
  a test fills those columns with a marker and greps every answer).

## Non-goals

- The token never works on the existing `/api/v1/*` routes, and never on a
  write. The diag router has GET routes only; every other method is 405.
- No user list, no enrollment codes, no keys, no commands' parameters.
- No new network exposure: the same host and port as the UI.

## Token

- Format `cad_` + 32 random bytes base64url. Stored as `sha256:<hex>` in a new
  table `diag_tokens` (id `dgt_…`, name 1–64 chars, created by/at, expires at,
  revoked by/at).
- Lifetime 1–365 days, default 90. At most 5 live (not revoked, not expired)
  tokens.
- Audit actions `diag-token-issue` and `diag-token-revoke` (sysadmin). A bad
  bearer token is answered 401 and audited `diag-auth-refused`, throttled.
- Last use is kept in memory only (the write budget: reads never write the
  database); the list shows it since the last restart.
- Rate limit: 120 requests a minute per token hash (sessions keep the API's
  own per-session limit). Never per client address.

## Routes (all GET, `Cache-Control: no-store`)

| Route | Answer |
|---|---|
| `/diag` | the index: route list, server time, version |
| `/diag/proxies` | registry fields (url, TLS site and server name, CA fingerprints, runs on), state, version, pin, clock skew, problem count and the problem items of the last summary, reported site / CA fingerprints / commands policy / allow list / token counts, last heartbeat, reconcile |
| `/diag/cams-instances` | state, accounts served, routes (proxy, url, hidden), the live report: mode, applied vs current revision, held changes and held proxies (field names), kept-old, shadow, token counts, **problems with code and detail** |
| `/diag/cameras` | registry fields (cams id, name, proxy, proxy camera id, host, protocol, kind, move id), online |
| `/diag/moves` | recent moves (the moves view) with chunk counts |
| `/diag/moves/precheck?source=&target=&camera=` | every precheck rule in order with pass/fail and a detail (e.g. the instances that see the source but not the target) |
| `/diag/audit` | the audit list with the UI's filters |

## UI

A "Diagnostics" page: the token list (name, prefix of the hash, created,
expires, last used, revoked), "Issue token" (name, days) showing the token
once with a copy button and the command to save it on the Mac, and a revoke
button per token.

## On the Mac

The token lives in `~/.config/cams-admin/diag-token` (mode 600) and is used
as `curl -H "Authorization: Bearer $(cat ~/.config/cams-admin/diag-token)"`;
it is never printed. Recipe in `docs/diagnostics.md`.
