# Diagnostics API

Read-only answers about cams-admin's state for tools and sessions on a
sysadmin's machine, without a Google sign-in (issue #45, spec
`docs/superpowers/specs/2026-10-22-diagnostics-token-design.md`).

## The token

Diagnostics page (`#/diagnostics`) → name, days (1–365, default 90) → Issue
token. It is shown once. On the Mac press Copy, then:

```sh
mkdir -p ~/.config/cams-admin && (umask 077; pbpaste > ~/.config/cams-admin/diag-token)
```

At most 5 tokens are live at a time. Revoke one on the same page; a revoke is
also written to the revocation journal, so a restore from an older backup
can't bring it back. Issue and revoke are audited (`diag-token-issue`,
`diag-token-revoke`); refused bearer tokens are audited as `diag-auth-refused`
(throttled).

The token opens only the GET routes below. It never opens another `/api/v1`
route or a write (405), and no answer carries a token, hash, code, key,
e-mail address or note. 120 requests a minute per token.

## Use

Never print the token; read it from the file in the command:

```sh
diag() { curl -fsS -H "Authorization: Bearer $(cat ~/.config/cams-admin/diag-token)" "https://cams-admin.example.net/api/v1/diag$1"; }
diag /cams-instances | jq '.items[] | {name, problems: .report.problems}'
diag "/moves/precheck?source=prx_…&target=prx_…&camera=porch" | jq '.rules[] | select(.ok | not)'
```

A signed-in sysadmin's browser session works on the same routes.

| Route | Answer |
|---|---|
| `/diag` | version, server time, the route list |
| `/diag/proxies` | registry fields (url, TLS site and server name, CA fingerprints), state, version, pin, clock skew, the problem items of the last summary, reported site / CA fingerprints / commands policy / allow list / token counts, last heartbeat, reconcile |
| `/diag/cams-instances` | state, accounts, routes, the last report: mode, applied vs current revision, held changes and held proxies, kept-old, shadow, token counts, problems (code, account, detail) |
| `/diag/cameras` | registry fields (cams id, model, proxy, proxy camera id, host, protocol, TLS name), move id, online |
| `/diag/tokens` | per proxy, its managed tokens: holder (cams instance id and name, or `manual`), label, kind, state, on proxy, created, retire/revoke times, last token command; no hash |
| `/diag/moves?accountId=` | the newest 100 moves with chunk counts |
| `/diag/moves/precheck?source=&target=&camera=` | every precheck rule in order with ok, reason and a detail; `camera` is the registry id or the cams id |
| `/diag/audit?account=&actorType=&action=&from=&to=&limit=&cursor=` | the audit log, as on the Audit page, with every e-mail address replaced by `email:` + 8 hex of its SHA-256 |

## Operations tokens

A diagnostics token only reads. An operations token (`cao_…`) lets a script
make a few writes without a Google sign-in: revoke a proxy token, set a cams
route, cancel a move. Each token carries the scopes ticked when it was issued.

Diagnostics page → Operations tokens → name, days, scopes → Issue token. As
with the diagnostics token it is shown once, and it is stored only as a hash
(the page and the audit show 8 hex of it). On the Mac press Copy, then:

```sh
mkdir -p ~/.config/cams-admin && (umask 077; pbpaste > ~/.config/cams-admin/ops-token)
```

Limits: 1–90 days (default 30), at most 5 live at a time, 60 writes a minute
per token (else 429 `rate_limited`). Revoke on the same page; a revoke is
journalled like the diagnostics token's, so a restore can't bring it back.
Issue and revoke are audited (`ops-token-issue`, `ops-token-revoke`); a
refused token is audited as `ops-auth-refused` and a token outside its scopes
as `ops-scope-refused` (both throttled). A write by a token is audited with the
actor `ops-token:<8 hex>`. The list is also at `/diag/ops-tokens`.

| Scope | Method and path (relative to `/api/v1`) |
|---|---|
| `tokens` | `POST /accounts/:accountId/proxies/:proxyId/tokens/:tokenId/revoke` |
| `tokens` | `POST /accounts/:accountId/proxies/:proxyId/tokens/:tokenId/retire` |
| `tokens` | `POST /accounts/:accountId/proxies/:proxyId/tokens/apply` |
| `routes` | `PUT /cams-instances/:instanceId/routes/:proxyId` |
| `routes` | `DELETE /cams-instances/:instanceId/routes/:proxyId` |
| `routes` | `DELETE /cams-instances/:instanceId/camera-overrides/:cameraId` |
| `moves` | `POST /moves` |
| `moves` | `POST /moves/:moveId/cancel` |
| `moves` | `POST /moves/:moveId/end-transfer` |

Paths must be exactly as listed (the fixed words in lower case, ids as issued, no trailing slash). Anything else,
and every route not in the table, gets 403 `scope`. No token can issue proxy
tokens, cams enrollment codes, diagnostics tokens or operations tokens, read
or set camera passwords, or reach a GET route under `/api/v1`: reads go
through the diagnostics token. A bearer request needs no `X-Cams-Admin`
header, and a session cookie sent with it is ignored. A bad, expired or
revoked token gets 401.

```sh
curl -fsS -X POST -H "Authorization: Bearer $(cat ~/.config/cams-admin/ops-token)" -H 'Content-Type: application/json' \
  "https://cams-admin.example.net/api/v1/accounts/acc_…/proxies/prx_…/tokens/tok_…/revoke"
```

(`acc_…`, `prx_…` and `tok_…` are placeholders; take the real ids from
`/diag/proxies` and `/diag/tokens`.)

## Start a move

`POST /api/v1/moves` starts a camera move from cams-admin. A session works too
(with `X-Cams-Admin`); a script uses an operations token with scope `moves`.

```sh
curl -fsS -X POST -H "Authorization: Bearer $(cat ~/.config/cams-admin/ops-token)" -H 'Content-Type: application/json' \
  -d '{"sourceProxyId":"prx_…","targetProxyId":"prx_…","cameraId":"porch","bounds":{"transfer":true,"kinds":["clips","stills","events","checks","archive"],"space":"fit","maxBudgetS":3600}}' \
  https://cams-admin.example.net/api/v1/moves
```

(`prx_…` and `porch` are placeholders: take the proxy ids from `/diag/proxies`.
`cameraId` is the registry id or the cams id within the source's account.)

`bounds` is required, but may be `null` (no pre-approval): `transfer` (copy
content), `kinds` (what may be copied), `space` (the space choice the move
plan may have), `maxBudgetS` (60 to 604800 seconds).

What it does, in this order:

1. Checks the request and the source: the camera is on the source, the source
   is online, allows `move.send` and has its URL and TLS name in the registry;
   the target has its URL. Then it runs the precheck (as
   `/diag/moves/precheck`).
2. If a rule other than the three below fails, it answers 409 and has changed
   nothing.
3. It fixes the three fixable rules:
   - `routed`: adds a visible cams route (url empty) to the target on every
     cams instance that sees the source. A route that is hidden on purpose is
     not unhidden; that instance keeps failing and the answer is 409.
   - `site_ca`: writes the registry's site for a proxy from the site the
     proxy itself reports, only where the registry has none. A registry site
     that differs from the reported one is not overwritten.
   - `no_host_override`: clears the camera's per-instance host (a set camera
     user stays).
4. It re-checks and queues the command `move.begin` on the source, which then
   makes the usual move request.

What it does not do: it never writes CA fingerprints or the TLS name (set
those by hand), never fixes any other rule (offline, busy, other account, no
`move.receive`), and never sends a camera password. Each fix is audited as
`move-fix`, the command as `move-begin`. A fix stays when the request is
refused later, for example a host-override fix when the source then refuses
the command (busy, no site CA): the fixes are audited, there is no move, and a
second request starts from the fixed state.

Answers:

- 202 `{commandId, fixed, report}`: the command is queued. `fixed` lists what
  was changed (`{rule, instanceId, proxyId}` for `routed`, `{rule, proxyId,
  site}` for `site_ca`, `{rule, instanceId, cameraId}` for `no_host_override`);
  `report` is the precheck report after the fixes.
- 400 `{error: "invalid", field}`: the body is wrong (`sourceProxyId`,
  `targetProxyId`, `cameraId` or `bounds`).
- 404 `{error: "not_found", field}`: unknown source or camera.
- 409 `{error, reason?, report?, fixed?}`: `precheck` (with the report and its
  `reason`, such as `target_offline`), or one of `camera_not_on_source`,
  `source_offline`, `moves_not_allowed`, `source_registry_incomplete`,
  `target_registry_incomplete`.

`autoApprove` on a move only means that the request carried bounds. The source
proxy decides: it approves its own offer when the target's answer fits the
bounds, and otherwise it waits for a person to approve, as for any move.

The Moves page has a Start move form (account, source proxy, camera, target
proxy; one click) that sends this same `POST /moves` with the default bounds
(everything, space `fit`, 24 h). A 409 or 422 answer is shown as the failed
precheck rules.

Follow the move with the diagnostics token (the command's own result is
session-only):

1. The 202 gives `commandId`. When the source has taken the command, the audit
   has a second `move-begin` row with outcome `ok` and the same `cmdId` plus the
   `requestId`: `GET /api/v1/diag/audit?action=move-begin`. A refusal or failure
   is a `move-begin` row with outcome `failed` and its `code`.
2. The move with that request: `GET /api/v1/diag/moves?requestId=rq_…`. It
   returns an empty list until the source's request has arrived. Each move
   carries its `requestId`, `autoApprove` and `bounds`.

The source must run a cam-proxy that knows `move.begin`: an older one allows
`move.send` but answers `not_allowed`, and the fixes stay. Errors from queuing the
command (429 `rate_limited`, 400 `invalid_args`, 409 `paused_on_proxy` or
`not_allowed_on_proxy`) also undo the fixes; the token's limit of 60 writes a
minute applies.
