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
| `/diag/moves?accountId=` | the newest 100 moves with chunk counts |
| `/diag/moves/precheck?source=&target=&camera=` | every precheck rule in order with ok, reason and a detail; `camera` is the registry id or the cams id |
| `/diag/audit?account=&actorType=&action=&from=&to=&limit=&cursor=` | the audit log, as on the Audit page, with every e-mail address replaced by `email:` + 8 hex of its SHA-256 |
