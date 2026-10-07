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

## Commands and managed tokens (migration phase 2)

- **Signed commands:** cams-admin sends a proxy signed, versioned,
  idempotent commands on the same channel (Ed25519 over RFC 8785 canonical
  JSON, bound to the proxy and the connection, 60 s lifetime). It keeps one
  in flight per proxy, re-sends with the same `cmdId` until the proxy
  answers, and stores the proxy's signed result as evidence. In phase 2 the
  only command is `tokens.apply`.
- **The proxy decides:** commands are off by default on every proxy. Each
  proxy's own allow-list (set locally with its admin token) says what
  cams-admin may send, and it can pause them. cams-admin shows what the proxy
  reports and never assumes more.
- **Managed tokens:** on a proxy's page, *Issue client token* / *Issue admin
  token* makes a 32-byte token, shows it **once**, and stores only its
  SHA-256 hash. The proxy gets the full managed set (`tokens.apply`, with a
  revision). Rotate by issuing a new token, switching cams to it, then
  *Retire* (the proxy stops accepting it at the time you choose) or *Revoke*
  the old one. A revoke is kept at once whatever the proxy can take; it goes
  out as a revocation-only set, which a proxy accepts even while paused or
  without `tokens.apply` allowed (never with its env kill switch off), and the
  card says "not yet on proxy" until the proxy has it. A proxy that missed a
  set (offline, refused) gets the current one again from its next heartbeat.

## Remote configuration (migration phase 3)

- **What cams-admin can do to a proxy:** read its settings (`config.get`),
  change the remote-settable ones (`config.set`, `config.unset`), roll a
  change back (`config.rollback`), run the remote camera actions, rename a
  camera on the camera (`camera.name.set`) and restart the proxy
  (`proxy.restart`). Each one is a signed command, and **each must be allowed
  on the proxy itself** (off by default, set with the proxy's own admin
  token). cams-admin offers only what the proxy reports as allowed.
- **Which settings:** only those in
  [`contract/v1/remote-settable.json`](contract/v1/remote-settable.json)
  that the proxy also reports as settable. Addresses, ports, files, trust,
  users and `camsAdmin.*` are never remote. Settings held in the proxy's
  environment are read only.
- **Dry run first:** *Review changes* asks the proxy for a dry run and shows
  the diff. *Apply* then sends exactly that dry run (apply by preview id);
  there is no other way to write a proxy's settings. If the settings change
  on the proxy in between, the card shows "changed on the proxy" and a table
  of "on the proxy now" next to "your change". From there you can *Use mine*
  (a new dry run) or *Keep the proxy's*.
- **Roll back:** a real settings change in the Commands card has *Roll back*:
  first a dry run of the rollback, then *Apply rollback*. The proxy refuses
  the rollback for any setting that changed since.
- **Camera actions:** each camera on the proxy page gets the allowed actions
  as buttons. The disruptive ones (reboot, power-cycle, worker restart, FTP
  setup/off, NTP set, cert push, proxy restart) are grouped, and each asks
  you to type the action's name. The proxy runs the action, re-reads what it
  wrote, and limits disruptive actions per hour.
- **Threat model:** a compromised cams-admin can only change remote-settable
  settings and run allowed actions. It can never touch addresses, trust,
  users or `camsAdmin.*`. It can never raise Google Vision spending, shorten
  a retention period, lower a size cap or touch `storage.*`, so it can't make
  a proxy delete stills, clips, events or audit records. Every change is in
  the proxy's audit log and on its card with Undo, and a local pause on the
  proxy stops all of it.

## cams instances and the service API (migration phase 4)

- **A cams instance** (the cluster's cams, the Pi's) is registered in
  cams-admin (*Instances*) with the accounts it serves. It enrolls once with
  a one-time `CAC1-…` code and its own Ed25519 key (`admin-enroll` in cams;
  compare the server key fingerprint it prints with the instance page).
- **The service API** (`/cams/v1/*`, contract `contract/cams-v1/`): every
  request is signed by the instance's key (method, path, time, nonce, body
  hash) and checked in a fixed order (clock skew answered with the server
  time, nonces remembered 10 minutes, 60 requests a minute per instance, a
  global budget for failed signatures); every answer is signed by
  cams-admin's key, errors included.
- **The snapshot** (`GET /cams/v1/config`, with an ETag) carries the served
  accounts' users and roles, proxies (at the instance's route URL) and
  cameras, and the ids and states of the tokens the instance holds. It is
  signed as a whole, so cams verifies its cached copy at every start. It
  never carries a password, token, hash, code or key.
- **Routes are default-deny:** an instance sees a proxy (and its cameras,
  and may hold tokens for it) only through a route: the registered URL, or
  its own URL (the Pi reaches its proxy over loopback). A proxy added later
  reaches no instance until it is routed; an import routes the proxies its
  file uses. Hiding a proxy or removing a served account revokes the tokens
  the instance holds there.
- **Tokens:** cams generates its own proxy tokens and registers only their
  hashes (`POST /cams/v1/tokens`); cams-admin sends them to the proxy.
  *Rotate now* on the instance page makes cams register new ones and retire
  the old (with a grace period). Revoking its key, a re-enrollment, Block
  and Delete revoke everything it holds at once; these revocations are
  journaled outside the database, so a restore can't bring them back.
- **Import and export:** an account's *Import* reads cams's redacted
  `export-config` output (dry run first, idempotent, cross-checked against
  what the live proxies report; it never deletes and never changes a
  proxy's registered URL). *Export* writes a `cameras.json` without
  passwords and tokens, for cams's file mode if cams-admin is ever lost
  ([docs/restore.md](docs/restore.md)). The cut-over is
  [docs/migration-p4-runbook.md](docs/migration-p4-runbook.md).

There is no video: cams-admin is a control plane, not in any data path.
Camera passwords never pass through it; a managed proxy token passes through
it exactly once, in the answer that shows it.

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
| `npm run load -- --proxies 50 --cameras 4 --duration 60m [--sample 60s] [--snapshots DIR]` | the load test (CI runs 20 proxies for 2 minutes); the leak check is the live heap after a forced GC (Theil–Sen trend), `--snapshots` keeps start/end heap snapshots for `npx tsx scripts/load/heap-diff.ts` |

The proxy monitoring is tested the way spec §15.4 lays out: protocol
conformance, every metric arriving and shown, ageing out, reconnects, clock
skew, cams-admin restarts, a blackholed and a slow link, hostile input,
revocation, two proxies sharing a key, and load.

## Repository

`main` is the default branch (unprotected); `production` is protected and
deploys ([docs/repo-setup.md](docs/repo-setup.md)). Phases 2–5 (tokens,
remote configuration, cams reading from cams-admin, deployment) are in the
spec's §12.
