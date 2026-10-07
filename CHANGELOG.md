# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Added
- cams instances (migration phase 4): register the cluster's and the Pi's cams, the accounts each serves, per-proxy routes (a URL, or hidden for that instance), one-time `CAC1` enrollment codes, keys, *Rotate now*, *Block*, *Delete*.
- The cams service API `/cams/v1/*` (contract `contract/cams-v1/`): signed requests and answers, a signed configuration snapshot per instance with an ETag, token-hash registration and retirement for cams, status reports kept in memory.
- Import of cams's redacted `export-config` into an account (dry run, idempotent, cross-checked against the live proxies, never deletes) and an Export of a `cameras.json` for cams's file mode; `npm run import` for the local stack.
- Routes are default-deny (a proxy reaches an instance only through a route); key revocation, re-enrollment, Block and Delete revoke the instance's tokens at once and survive a restore (`cams-revocations.jsonl`); an import's Apply is bound to its dry run.
- Audit actor type `cams`; the audit log's actor filter lists it.
- Pages: *cams* (instances: served accounts, routes, enrollment code shown once with both commands and the server key fingerprint, keys, status from the reports, Rotate now, Block, Delete), an account's *Import* tab (dry run, mismatches to accept, Apply; Export per instance), and the cams instances on the dashboard.
- Local stack: two cams instances enrolled by a reference cams client; `scripts/rehearse/` (localize real exports, the cams-admin side of the cut-over rehearsal).
- Remote configuration (migration phase 3). The proxy page now has a
  **Settings** card: the proxy's settings as it reports them, with changes
  made through a dry-run diff and an explicit Apply. The card shows when the
  settings were changed on the proxy, shows conflicts side by side, and offers
  Roll back from the Commands card.
- A **Camera actions** card: camera actions, renames and a proxy restart,
  each one only if the proxy allows it. Disruptive actions need their name
  typed. A camera row on the Account page links to its actions.
- Retention periods and size caps can only be raised from cams-admin,
  Google Vision limits only lowered. Storage settings, capture and listener
  on/off switches, and health thresholds are local only.
- Disruptive actions are limited across the fleet: one proxy at a time, at
  most 3 in 10 minutes. The audit log names every changed setting with its
  old and new value. Secret-shaped values from a proxy are never stored.
- Contract: args and result schemas for the P3 commands,
  `contract/v1/remote-settable.json`, and new fixtures and vectors.

