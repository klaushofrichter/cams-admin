# cams-admin

[![Release](https://img.shields.io/github/v/release/klaushofrichter/cams-admin?label=release&color=blue)](https://github.com/klaushofrichter/cams-admin/releases)
[![PR checks](https://github.com/klaushofrichter/cams-admin/actions/workflows/production-checks.yml/badge.svg)](https://github.com/klaushofrichter/cams-admin/actions/workflows/production-checks.yml)
[![Build and publish image](https://github.com/klaushofrichter/cams-admin/actions/workflows/build-push.yml/badge.svg?branch=main)](https://github.com/klaushofrichter/cams-admin/actions/workflows/build-push.yml)
[![Deploy production](https://github.com/klaushofrichter/cams-admin/actions/workflows/deploy-production.yml/badge.svg?branch=production)](https://github.com/klaushofrichter/cams-admin/actions/workflows/deploy-production.yml)
[![Dependabot](https://img.shields.io/badge/dependabot-enabled-025E8C?logo=dependabot&logoColor=white)](https://github.com/klaushofrichter/cams-admin/security/dependabot)

<!-- The release badge is the newest tag. Dependabot is a static badge:
     alerts and security updates are repository settings
     (docs/repo-setup.md), version updates come from .github/dependabot.yml.
     No version numbers in the text below. -->

Account and configuration management for the camera fleet:
[cams](https://github.com/klaushofrichter/cams) (the viewer),
[cam-proxy](https://github.com/klaushofrichter/cam-proxy) (the camera gateway) and
[cam-sim](https://github.com/klaushofrichter/cam-sim) (the simulated camera).
It will run at `cams-admin.skylar.technology`. Phase 1 is specified in
[docs/superpowers/specs/2026-10-06-cams-admin-phase1-design.md](docs/superpowers/specs/2026-10-06-cams-admin-phase1-design.md).

## What it does (phase 1)

- **Registry:** accounts; users with roles (admin, viewer; one email may be
  in several accounts); proxies with where they run, URL, DNS name, site and
  pinned CA fingerprints; cameras and simulated cameras, each tied to a proxy
  of its own account.
- **Proxy enrollment:** a one-time code (shown once, stored as a hash) and an
  Ed25519 key made on the proxy. cams-admin keeps only the public key.
- **The proxy channel:** each proxy keeps one outbound WebSocket
  (`/proxy/v1/connect`, subprotocol `cams-admin.v1`), so it needs no open
  port. Its health summary arrives as a heartbeat every 30 s. The protocol is
  written down as JSON Schema in [contract/](contract/README.md), which both
  repositories test against.
- **Live dashboard:** every account, proxy and camera, live over SSE. A
  proxy is offline 90 s after its last heartbeat; its cameras then show
  unknown. Reconciliation (reported vs registered cameras, pin mismatches)
  is shown, never applied by itself.
- **Audit log** of every administrator action, enrollment and key event.
- **Backup:** Litestream to S3 (hourly sync; a graceful stop syncs
  everything) and a daily `VACUUM INTO` snapshot, both 30 days, plus
  **Backup now** for before a major change. The restore is tested on every
  PR ([docs/restore.md](docs/restore.md)).

There is no video: cams-admin is a control plane, not in any data path.
Camera passwords and cam-proxy tokens never pass through it.

## Running it

```sh
npm ci && npm run build
scripts/localstack/start.sh     # cams-admin + 4 real cam-proxies + 7 cam-sims on 127.0.0.1
scripts/localstack/stop.sh
```

[docs/localstack.md](docs/localstack.md) describes the stack (three
accounts; sign-in through a fake Google). For production settings see the
spec's §14 and [docs/kube-setup-request.md](docs/kube-setup-request.md);
the Secrets come from `.env` through `scripts/create-secrets.sh`
(names in [.env.example](.env.example); values are never printed).

## Testing

| | |
|---|---|
| `npm test` | unit and integration (vitest): the registry and its database rules, the protocol, the contract fixtures over the wire, every health-summary field end to end, fault injection, the database write budget, sign-in and CSRF, the backup |
| `npm run test:e2e` | Playwright, desktop and phone, against the built server and a fake Google |
| `scripts/backup/restore-test.sh` | Litestream and the snapshot against a local S3, restored and compared |
| `scripts/contract/cam-proxy-check.sh` | cam-proxy main's real health summary against the strict contract |
| `npm run load -- --proxies 50 --cameras 4 --duration 60m` | the load test (CI runs 20 proxies for 2 minutes) |

The proxy monitoring is tested the way spec §15.4 lays out: protocol
conformance, every metric arriving and shown, ageing out, reconnects, clock
skew, cams-admin restarts, a blackholed and a slow link, hostile input,
revocation, two proxies sharing a key, and load.

## Repository

`main` is the default branch (unprotected); `production` is protected and
deploys ([docs/repo-setup.md](docs/repo-setup.md)). Phases 2–5 (tokens,
remote configuration, cams reading from cams-admin, deployment) are in the
spec's §12.
