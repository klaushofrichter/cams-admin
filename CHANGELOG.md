# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- `scripts/create-secrets.sh --only viewer-key` keeps an existing viewer-token key: replacing it makes every viewer token uncopyable, so only `--rotate-viewer-key` does that.
