# cams-admin

Account and configuration management for the camera fleet (cams, cam-proxy,
cam-sim). Spec: `docs/superpowers/specs/2026-10-06-cams-admin-phase1-design.md`.

## Rules

- **Public repository.** No secrets, tokens, AWS account ids, home addresses,
  MACs, serials or LAN IP plans; fixtures use RFC 5737 / RFC 2606. No clips or
  media.
- **`.env`** (mode 600, gitignored) holds the real credentials. Never read it
  into a session, print it, or source it; `scripts/create-secrets.sh` reads
  it without printing (names in `.env.example`).
- **Never** the real camera, the Pi, the cluster or the real S3 bucket from
  tests or the Mac (the local stack and CI use a local S3). Cluster changes go
  through the kube-setup session (`docs/kube-setup-request.md`).
- **Rate limits never key on the client address** (hairpin NAT, forged
  `X-Forwarded-For`): session, proxy id, code hash, or global.
- **Live status stays in memory**; the database is written on meaningful
  changes and a 10-minute snapshot (S3 cost). Keep `test/write-budget.test.ts`
  green.
- **The protocol contract** is `contract/` (`npm run contract:make` after
  changing `contract/build.ts`). A new summary field goes into the contract
  first; cam-proxy vendors it.
- **Commands:** the contract's check order (contract/README.md) is
  normative; a change to a command, a result or an event goes into
  `contract/` first, and `scripts/contract/cam-proxy-check.sh` must stay
  green against cam-proxy `main`.
- **The cams service API:** its check order (`contract/cams-v1/README.md`)
  is normative; a change goes into `contract/cams-build.ts` first
  (`npm run contract:make`) and cams vendors `contract/cams-v1/`. A snapshot,
  report, import diff or export never carries a password, token, hash, code
  or key (the guard tests fill columns with markers).
- **P3 settings changes go through preview → apply by preview id;** never add
  a route that writes proxy settings without a preview. A new remote-settable
  setting goes into `contract/v1/remote-settable.json` (via
  `contract/build.ts`) first. Remote writes may never make a proxy delete
  data (retention and size caps only up, `storage.*` local only).
- **Tokens are shown once and stored only as SHA-256 hashes** (8 hex digits
  in views and audit details). Never log, store, audit or test with a real
  token.
- **e2e lock:** before any Playwright run in a shared scratchpad, take the
  lock the coordinator names (`mkdir …/e2e.lock`, retry every 30 s), `rmdir`
  after. Never kill processes by name pattern: stop only PIDs you started.
- Branches: feature → PR to `main` → promotion PR to `production`. Merge only
  when all checks pass; stage files explicitly. CHANGELOG `## [Unreleased]`
  is harvested and emptied by the deploy.

## Ports (local)

cams-admin 29000, fake Google 29001, local S3 29010, local-stack proxies
29100–29400, cam-sims 29500+, local-stack cams instances 29600–29619,
restore test 29012–29031, e2e 29190–29195.
