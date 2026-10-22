# Operations tokens and hands-off moves — design

Status: draft for Klaus's review (2026-10-22). Spans cams-admin, cams and cam-proxy.

## Why

Klaus, 2026-10-22: "we need to eliminate the manual confirmations when it is in the context of content move. Generally, if we can create an API that can do the settings instead of a person, we should offer this, protected by tokens which can be provided when the move process is initialized."

Today a move between two proxies needs these human steps (inventory, with code references, in the session notes):

| # | Step | Who / where | Per |
|---|------|-------------|-----|
| 1 | Allow `move.send` / `move.receive` | proxy's own admin (Cams-Admin page or host CLI) | proxy, once |
| 2 | Registry `tlsSite`, `tlsServername`, CA fingerprints | cams-admin sysadmin | proxy, once (and at each CA rotation) |
| 3 | Route from every cams instance that sees the source to the target (`not_routed`) | cams-admin sysadmin | instance × proxy, once |
| 4 | Trust the target proxy in cams ("Confirm" banner) | cams account admin | instance × proxy, once (and at each CA rotation) |
| 5 | Clear a per-instance host override (`no_host_override`) | cams-admin sysadmin | rare |
| 6 | Start the move | source proxy page | move |
| 7 | Approve the plan (the one confirmation panel) | source proxy page | move |
| 8 | Confirm a camera that this cams instance never confirmed (cams #269) | cams account admin | camera × instance |

Plus host work outside any API (firewall ports, stale config leftovers). Those stay human.

Even read-only, cams-admin needed Klaus's sign-in until the diagnostics token. Writes still do, so even revoking six stale tokens takes eight clicks.

## Goals

- Every cams-admin setting a person sets in the UI can also be set by an API call with a bearer token, so Claude (or a script) can do it.
- A move needs at most one human decision (the plan approval, Klaus's 2026-10-21 rule). Steps 2, 3, 4, 5 and 8 happen automatically for the move. Step 7 can be pre-approved within bounds given at the start.
- Each token is narrow: it names what it may do, it is shown once, it is stored as a SHA-256 hash, and it expires. Every use is audited under the token's id.

## Non-goals

- No token can read or set camera passwords, read a proxy token, or issue proxy tokens. Issuing returns a secret, which stays a sign-in action.
- No remote change to a proxy's allow-list (step 1). That list is the proxy owner's brake against a compromised cams-admin. Instead, step 1 is done once per proxy now, on the host (§4).
- No change to firewall or host config.

## 1. Operations tokens (cams-admin)

A sibling of the diagnostics token (`server/diag/tokens.ts`), with write scopes.

- Format `cao_` plus 32 random bytes in base64url. Table `ops_tokens`: id `opt_…`, name, hash, scopes (JSON list), created/expires/revoked, as in `diag_tokens`. Revocation goes through the same journal (kind `ops-token`), so a restore can't bring a token back.
- Issued and revoked by a signed-in sysadmin on the Diagnostics page. Lifetime 1–90 days, default 30. At most 5 live tokens.
- Scopes:
  - `tokens`: retire and revoke proxy tokens, apply the token set.
  - `routes`: set and delete cams-instance routes, and clear camera overrides.
  - `registry`: set a proxy's `tlsSite`, `tlsServername`, `caFingerprints`, but only to the values that proxy itself reports (status `tls.site`, `/tls/ca.pem` fingerprint). A token can't type in its own pins.
  - `moves`: request, cancel and end-transfer a move, and pre-approve its plan (§2).
- Bearer only (`Authorization: Bearer cao_…`). There is no cookie, so CSRF doesn't apply. Rate limit 60 writes per minute per token.
- Audit actor `ops-token:<8hex>` (the hash prefix) and the token's name.
- Implementation: the existing write routes accept either a sysadmin session or an ops token whose scope covers the route. A scope table maps route to scope, and anything not listed refuses tokens. A test runs every route in `server/api/router.ts` against the table, so a new route can't take tokens by accident.
- Klaus would issue one token for me with `tokens routes registry moves`. It is stored at `~/.config/cams-admin/ops-token`, mode 600, like the diag token.

## 2. Moves started from cams-admin, with a move grant

- `POST /api/v1/moves` `{source, target, camera, plan: {kinds, spaceChoice, budgetMinutes}, autoApprove: bool}` (session or `moves` scope). cams-admin runs the precheck. **Before** refusing on `not_routed`, `site_ca` or `no_host_override`, it fixes each one itself where it can:
  - creates the missing routes (step 3);
  - fills the registry TLS fields from what the proxy reports (step 2);
  - clears the override (step 5).
  
  Each fix is audited under the move's id, and the precheck report lists what was fixed. Today's precheck rules stay as they are; only these three become "fixable".
- cams-admin then sends the source a new command, `move.begin {camera, target, bounds}`, in place of the click on the proxy page (step 6). The request has to come from the source, because only the source holds the camera's connection and password; camera passwords never come from cams-admin. `move.begin` is under `move.send`, so the source's owner still decides whether the proxy takes part. The source then runs the same `request()` as the page does (`src/moves/source.ts`), with the actor "cams-admin move <id>".
- **Move grant.** The request produces a grant `{moveId, source, target, camera, plan bounds, expiry}`. It is held by cams-admin and is not a bearer secret for the caller. The grant is what "a token provided when the move process is initialized" means here, and it carries two things:
  - **Pre-approval (step 7).** The bounds go to the source with `move.begin`. When the target's answer fits them, the **source** approves its own offer, exactly as `approve()` does after a click: same kinds, space choice as asked, estimate within the budget. The audit line names the grant. If the answer falls outside the bounds, the offer waits for a human, as today. Approval stays at the proxy, and cams-admin's `plan_changed` guard still checks it.
  - **Move attestation for cams (steps 4 and 8),** §3.
- The grant ends at done, cancelled or expired. It can't be reused for another camera or another target.

## 3. cams accepts a move attestation (steps 4 and 8)

- The snapshot already carries `moveId`. It will also carry an attestation `{moveId, camsId, cameraId, sourceProxyId, targetProxyId, proxyUrl, caFingerprints, tlsServername, expiresAt}`, signed with the key cams already uses to check snapshots.
- cams accepts the target proxy and the camera without a banner when all of these hold:
  - the attestation verifies and names this instance;
  - it hasn't expired (24 hours);
  - **the source proxy is already trusted in this cams instance**;
  - host and protocol are unchanged;
  - the TLS name matches `<proxyCameraId>.<site>.internal`.

  The trust log records action `move-attested`.
- The source-trusted rule is the limit on the trade-off below. cams-admin can extend trust only along a move from a proxy this cams already trusts, so it can't introduce a proxy from nowhere.
- Trade-off: §9.2 of the move spec chose a human click here, so that a compromised cams-admin can't point cams at a proxy of its choosing. The proxy's enrolled key and the move handshake (both proxies agree, the source's admin allowed `move.send`) are what stand behind the attestation now. **Klaus's ruling is needed on this.**
- CA rotation (the same banner, memory "avoid human confirmations") could use the same attestation later, signed by the proxy's enrolled key. That stays out of scope here; it gets its own issue.

## 4. The allow-list, once per proxy

Step 1 stays local. I allow `move.send` and `move.receive` on een and the mini PC now, using `cam-proxy admin-commands allow` on each host with the host's admin token, never printed. The Pi stays out, since it has no site CA. New proxies get the entries at setup (cam-proxy docs).

## 5. Rollout

1. cams-admin: ops tokens, scope table, route-coverage test. Klaus issues the token, and I revoke the 8 stale tokens with it.
2. cams-admin: `POST /moves`, the fixers, the grant and auto-approve.
3. cams-admin + cams: the attestation in the snapshot (bump `SNAPSHOT_FORMAT`), with verify and accept in cams.
2b. cam-proxy: the `move.begin` command (validator, the `move.send` entry, request plus auto-approve within bounds), then the contract re-vendor. This ships with step 2.

Each step is its own PR, with tests and a release.

## Left to the builder

The exact route-to-scope table, the field names, and the UI for issuing tokens (a copy of the diagnostics one).
