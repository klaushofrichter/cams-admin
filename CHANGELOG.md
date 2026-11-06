# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- Groundwork for managing Google Vision from cams-admin: the proxy protocol now describes reading a proxy's Vision use (`analytics.usage.get`) and lets cams-admin switch Vision on and raise its monthly limit, but only up to a ceiling set locally at each proxy (refused as `above_local_ceiling` otherwise). Switching off and lowering stay allowed. No visible change yet; the Vision tab comes later.
- `scripts/create-secrets.sh --only viewer-key` keeps an existing viewer-token key: replacing it makes every viewer token uncopyable, so only `--rotate-viewer-key` does that.
