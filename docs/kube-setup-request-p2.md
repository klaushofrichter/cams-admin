# Request: migration phase 2 (commands and managed tokens)

**Status:** for information; nothing to apply before the cut-over. Spec
`docs/superpowers/specs/2026-10-06-cams-admin-migration-design.md` (§7, §10,
§11.4), plan `docs/superpowers/plans/2026-10-06-migration-p2-cams-admin.md`.
This repo is public: no token, address or credential goes into it.

## No manifest change

- Commands and their results travel on the existing proxy channel
  (`/proxy/v1/connect`, subprotocol `cams-admin.v1`). The cluster proxy
  already reaches cams-admin inside the cluster (the phase 1 NetworkPolicy).
- No new host, port, egress rule, Secret, ConfigMap or environment variable
  for cams-admin or cam-proxy. The database gains three tables by its own
  migration on start.
- Commands are off by default on every proxy: each proxy's own allow-list
  (set on the proxy with its local admin token) decides what cams-admin may
  send. cams-admin can't widen it.

## One Secret data change, at cut-over step 1 (spec §11.4)

After cams-admin has issued the managed client token (and, if wanted, the
admin token) for the cluster proxy, the `cams-cameras` Secret's
`cameras.json` gets them in place of that proxy's old `proxy.token` /
`proxy.adminToken`.

- Klaus hands the values over directly: never through a repo, an issue, a
  PR or a chat log. cams-admin shows each token once and keeps only its
  SHA-256 hash.
- **Rollback:** the previous Secret data. The old tokens (the proxy's
  `CAMPROXY_TOKENS` / local admin token) never stop working, so going back
  is only the Secret change and a cams restart.

## Nothing on the Pi that touches the cluster

The Pi's proxy is updated like any cam-proxy release; its tokens for the
cams instances are issued the same way, on its own card in cams-admin.
