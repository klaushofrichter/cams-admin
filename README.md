# cams-admin

Account and configuration management for the camera fleet:
[cams](https://github.com/klaushofrichter/cams) (the viewer),
[cam-proxy](https://github.com/klaushofrichter/cam-proxy) (the camera gateway) and
[cam-sim](https://github.com/klaushofrichter/cam-sim) (the simulated camera).
It will run at `cams-admin.skylar.technology`.

**Status: design.** Nothing is built yet. Phase 1 is specified in
[docs/superpowers/specs/2026-10-06-cams-admin-phase1-design.md](docs/superpowers/specs/2026-10-06-cams-admin-phase1-design.md).
The cluster and S3 setup it needs is requested in
[docs/kube-setup-request.md](docs/kube-setup-request.md).

## What it is

- **Accounts.** An account is one cams setup, identified by an account name.
  It has users with roles (admin, viewer), proxies, cameras and simulated
  cameras. The same email can be a user of several accounts.
- **Proxy enrollment.** A one-time code enrolls a cam-proxy. The proxy then
  keeps one outbound connection to cams-admin, so it needs no open port.
- **Live status.** Each proxy sends a heartbeat with its health summary every
  30 seconds. The dashboard shows every account's proxies and cameras live,
  even when cams-admin is not on their network.
- **Audit log** of every administrator action and enrollment.
- **Backup:** SQLite, replicated continuously to S3 (Litestream), plus a daily
  snapshot.

There is no video. cams-admin is not in any data path: cams keeps talking to
the proxies directly, and camera passwords never pass through cams-admin.

## Phases

1. Registry, enrollment, heartbeat channel, dashboard (specified).
2. Tokens: cams-admin issues and rotates the cams↔proxy tokens.
3. Remote configuration: signed, audited commands over the channel.
4. cams reads accounts, users, roles and cameras from cams-admin (account
   picker at login).
5. Deployment: creating simulated cameras, an installer wizard for proxy
   hosts.
