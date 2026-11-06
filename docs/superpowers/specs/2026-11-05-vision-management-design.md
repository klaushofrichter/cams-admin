# Vision management from cams-admin — design

Status: draft for Klaus's review, 2026-11-05. Repos: cams-admin (this one, drives the feature), cam-proxy, the shared contract (`contract/`).

## Why

Google Vision is switched on or off and given its monthly budget per cam-proxy, at the proxy only. On 2026-11-05 it turned out to be off on een (no key, limit 0) after the cameras moved there, and nobody had noticed. Klaus wants to see and manage it from cams-admin, per account, without visiting each proxy.

## Klaus's decisions (2026-11-05)

- Vision is managed on the **Account page** in cams-admin.
- No live consumption updates; a **Refresh button** pulls the settings and use of the account's proxies.
- **One setting per proxy:** the monthly call limit ("contingent"). **0 = off.**
- Built so **other vision providers** can be added later.
- cams-admin may raise the limit and switch Vision on, but only **up to a ceiling set locally at the proxy** (Klaus: "Ok" to that guard). The ceiling keeps a compromised cams-admin from spending without bound.

## Non-goals

- The API key never travels through cams-admin. It stays in each proxy's environment (or the proxy's Settings page). cams-admin only learns whether a key is present.
- No change to the per-kind switches (person, vehicle, pet): they stay local.
- The daily caps and checks per day stay as they are (remote, lower only).
- No change to cams.

## Today (facts)

- cam-proxy: `analytics.googleVision.enabled` is local only (`src/fleet/remote-settable.ts:34`). `monthlyLimit` is remote but **narrow `less`** (`:61`): cams-admin can only lower it. `monthlyLimit` 0 means no calls (`src/config/schema.ts:238`).
- cams-admin mirrors those rules (`contract/build.ts:576-605` `REMOTE_SETTABLE`; `server/config/narrow.ts`).
- The proxy's usage (`GET /control/analytics`: enabled, keySource, month/today calls and limits, paused, lastError, per-camera counts) is not reported to cams-admin at all.
- `config.get` (`server/config/service.ts:124`) is the existing request/response command; settings go through `config.set` preview + apply.

## Design

### cam-proxy

1. **New local-only setting per provider:** `analytics.googleVision.remoteMaxMonthly` (integer 0–100000). The most monthly calls cams-admin may allow. **Default 0: cams-admin can't switch Vision on** until someone at the proxy sets a ceiling. Local only, like `enabled` today; shown on the proxy's Settings page in the Google Vision card ("cams-admin may allow up to N calls a month; 0 = cams-admin can't switch Vision on").
2. **New remote rule kind `ceiling`** (beside `less`/`more`) for `monthlyLimit`: a remote value is accepted when it is **at or below the current value** (lowering is always allowed, as today) **or at or below the proxy's current `<provider>.remoteMaxMonthly`**. Otherwise refused `above_local_ceiling` (with `detail` naming the ceiling). So a limit of 5,000 with a ceiling of 1,000 can go to 3,000 or 0, but not to 6,000.
3. **`enabled` becomes remote-settable in one direction always and the other gated:** `enabled:false` is accepted from cams-admin at any ceiling (switching off is always safe); `enabled:true` only when the ceiling is above 0 (else `above_local_ceiling`). cams-admin always sends `enabled` and `monthlyLimit` together in one `config.set` (`enabled = limit > 0`), so "0 = off" is literal: Vision is switched off, not just starved. `config.set` is already all-or-nothing across its paths (a refused leaf refuses the command).
4. **New read command `analytics.usage.get`** (args `{v:1}`), answered from the same state as `GET /control/analytics`, shaped by provider so another provider is one more array entry:
   ```json
   { "v": 1, "at": 1793927000000, "providers": [ {
       "id": "google-vision", "name": "Google Vision",
       "enabled": true, "key": "env",            // "env" | "manual" | "none"; never the key or its mask
       "monthlyLimit": 1000, "remoteMaxMonthly": 1000, "dailyCap": 0,
       "month": { "calls": 84 }, "today": { "calls": 9 },
       "paused": null, "lastError": null,      // paused: {reason, until}; lastError: {at, message}
       "cameras": [ { "id": "cam1", "today": 3, "month": 40 } ] } ] }
   ```
   Allowed by a new allow entry `analytics.usage.get` (read only; in the default command policy like `config.get`). A proxy with a saved policy (`data/admin/policy.json`) doesn't pick up new defaults, so it needs `admin-commands allow analytics.usage.get` once; a refusal shows on the tab as *Not allowed at the proxy*. Its own rate budget (10 a minute per proxy), not audited (read only, like `config.get`).
5. Audit: unchanged mechanism; the `config-change` record from cams-admin names `enabled` and `monthlyLimit`. A refused raise writes `auth-refused` / `local-setting` as today.

### Contract (`contract/build.ts`)

- `REMOTE_SETTABLE`: `analytics.googleVision.enabled` moves to remote with rule `ceiling-gated`; `monthlyLimit` gets `narrow: "ceiling"`. `remoteMaxMonthly` is listed as local only.
- New command `analytics.usage.get` (args and result schemas, lenient and strict), allow entry, fixtures and vectors. Vendor into cam-proxy `test/contract/cams-admin-v1/` as usual.
- Older proxies don't know the command: cams-admin shows "proxy too old for Vision management" for them (the proxy's reported `commands` list says it).

### cams-admin

1. **Account page, new tab "Vision"** (beside users, proxies, cameras …): one row per proxy of the account, one sub-row per provider:
   - Proxy name, provider, and one state word, the first that applies: *Offline* (no answer, old figures shown with their age), *Proxy too old*, *Not allowed at the proxy*, *Paused: invalid key / quota until …* (warning), *Off* (`enabled` false or limit 0), *On, no key* (warning), *Limit reached this month* (warning), *On*. Beside it, always the raw values: enabled, limit, ceiling. "cams-admin can't switch it on: no ceiling at the proxy" is a note when the ceiling is 0.
   - This month: calls / limit, and today; per camera in an expandable line.
   - **Monthly limit** input (0 = off; the page checks against the ceiling from the last refresh, shown next to it: "up to 1,000"; the proxy has the final word), with a Save button. Save calls the Vision route below, which runs the existing preview + apply flow (`server/config/service.ts`) server side, sending `enabled` and `monthlyLimit` together. A refusal (preview error or `above_local_ceiling` at apply) shows at the row, and a refresh of that proxy follows a successful save.
   - "As of <time>" per proxy.
2. **Refresh button** for the tab: queues `analytics.usage.get` for every online proxy of the account and answers 202 at once; the page polls the stored figures every 2 s for up to 30 s, then stops. Results go to a new table `proxy_analytics (proxy_id PRIMARY KEY REFERENCES proxies ON DELETE CASCADE, fetched_at, result JSON)`; the latest answer replaces the row. A proxy that hasn't answered shows the old figures with their age. One refresh in flight per proxy (skipped silently if one is running).
3. **API**, all **system admin only** (checked in the Vision service itself, not only by hiding the tab): `GET /api/v1/accounts/:a/vision` (stored figures of the account's proxies, joined on `proxies.account_id`, so another account's proxy never appears), `POST /api/v1/accounts/:a/vision/refresh` (202), `PUT /api/v1/accounts/:a/vision/proxies/:p/providers/:provider` `{monthlyLimit}` (202 with the command id; preview + apply server side).
4. **Diag** (`/api/v1/diag`): include the stored Vision figures per proxy, so Claude can read them without asking.

### Release order

1. Contract change in cams-admin (no behaviour yet).
2. cam-proxy: ceiling setting, rule changes, `analytics.usage.get`; release; update the Pi and een.
3. cams-admin: the tab, table, routes; release.
4. On een and the Pi, Claude runs `admin-commands allow analytics.usage.get` (read only, so no question to Klaus).
5. On een, Klaus (or Claude with een's admin token, after Klaus's yes) sets `remoteMaxMonthly`. **Proposed: 1,000** (Google's free monthly amount).

## Tests (main ones)

- cam-proxy: remote `monthlyLimit` above the ceiling refused `above_local_ceiling`; at or below accepted; remote `enabled` refused with ceiling 0 and accepted above 0; `remoteMaxMonthly` refused remotely; `analytics.usage.get` never contains the key or its mask; lowering the ceiling below the current limit leaves the limit (the ceiling only gates future remote changes) and the Settings page says so.
- cams-admin: preview error shown at the row; 0 sends `enabled:false`; offline and too-old proxies shown as such; refresh stores and shows the age; non-system-admin gets 403.
- Contract: fixtures for the new command round-trip in both repos.

## My calls (Claude), to check

- **Ceiling default 0**, so nothing changes on any proxy until its local admin opts in. The alternative (default 1,000) would let cams-admin switch Vision on everywhere at once.
- Lowering the ceiling doesn't lower an existing limit (no surprise switch-off); it only bounds the next remote change.
- The tab is **system admin only** for now; account admins could get read access later.
- `enabled` and `monthlyLimit` always change together from cams-admin; switching off and lowering are never gated.
- The usage command has its own rate budget and isn't audited.
- Refresh answers at once and the page polls; no long-held request.
- The proxy's per-kind switches stay local and aren't shown on the tab (only the provider's state).
