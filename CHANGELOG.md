# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- New **Vision** tab on the Account page (system admins): see each proxy's Google Vision state, this month's and today's calls (per camera on request) and its limits; Refresh asks the proxies. Set a proxy's monthly limit there (0 = off): cams-admin may switch Vision on or raise the limit only up to the ceiling set locally at that proxy, and the proxy has the final word. The diagnostics API shows the stored figures too.
- Groundwork for managing Google Vision from cams-admin: the proxy protocol now describes reading a proxy's Vision use (`analytics.usage.get`) and lets cams-admin switch Vision on and raise its monthly limit, but only up to a ceiling set locally at each proxy (refused as `above_local_ceiling` otherwise). Switching off and lowering stay allowed. No visible change yet; the Vision tab comes later.
- `scripts/create-secrets.sh --only viewer-key` keeps an existing viewer-token key: replacing it makes every viewer token uncopyable, so only `--rotate-viewer-key` does that.
