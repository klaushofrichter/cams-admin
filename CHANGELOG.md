# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Fixed

- A key redeemed by a proxy that had connected before with its previous key,
  and never used itself, showed as **active** after the pending-keys
  migration: the status snapshot had stamped the proxy's last hello onto it
  (a "last seen" older than the key), and migration 2 read that stamp as a
  confirmation. The snapshot now stamps the active key only, and migration 3
  turns such keys pending again (or retires them when a newer pending key
  exists).
- The proxy page updates live when a code is redeemed: the code box and
  "a code is live" go, the new pending key appears.

