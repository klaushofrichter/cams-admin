# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Fixed

- Enrollment answers with the `connectUrl` on the origin the proxy enrolled
  on, when that origin is `PUBLIC_URL` or in the new optional
  `INTERNAL_URLS` (e.g. the in-cluster Service URL); any other Host gets the
  public URL. The cluster's cam-proxy, which enrolls in-cluster, refused the
  public `wss://` URL as "on another host".
- A redeemed key is **pending** until its first hello: an enroll answer the
  proxy refused or lost no longer leaves an active key nobody holds, and a
  re-enrollment keeps the working key until the new key connects. A pending
  key expires after 24 h; the next code retires it. The proxy page shows
  pending keys; the audit log has `key-confirmed`.

