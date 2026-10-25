# Proxy profile: what a proxy can hold

Status: approved by Klaus 2026-10-25 ("Ok to go!"), with his answers in §0. Repos: cam-proxy (the profile, its
report), cams-admin (shows it, checks moves against it), contract v1 (the report).

## 0. Klaus's answers (2026-10-25), binding over the rest

- A proxy without a profile asks for one on its **home page**; the person sets the
  values. No verification against the hardware (no storage or disk warnings).
  The values can be edited later (Settings page).
- Purpose: automatic resource management later. So: **APIs to query and set**
  the profile.
- **No presets.** Conservative defaults until the person sets values; getting
  them right is the person's job.
- The FTP check after a move (§4): wanted, lower priority, not in this round.
- The existing proxies get their values set by Claude (known capacity).

Rulings made from these (Claude, 2026-10-25):
- Set API: on the proxy only, `GET`/`PUT /control/profile` (local admin token,
  audited `config-change`). cams-admin reads it (heartbeat → proxy page, diag,
  `GET /api/v1/proxies/:id/profile`). cams-admin setting it is not in this round:
  the profile holds the storage budget, and cams-admin may never change storage
  limits today. Revisit with automatic resource management — cost if wrong: one
  more command later.
- "Home page": the proxy's own home page shows a "Set this proxy's profile" card
  until it is set; cams-admin's dashboard lists proxies without one.
- Defaults until set (`profile.set` false): `cameras` = cameras held (at least
  1), `storageGB` = none (today's `storage.*` budget applies), `name` = none.
- `profile.storageGB` (1..100000, optional): the storage this proxy may use. When
  set it is the size budget, in place of `storage.maxBytes`. Setting both is a
  config error; `storage.maxPercent` and `minFreeBytes` still apply as limits.
- Warnings dropped (no verification): `profile_over_disk`, `profile_storage_thin`.
  `profile_ftp_ports` and `profile_cameras_exceeded` stay: they are about ports
  and cameras the proxy really has, not the hardware.

## Why

On 2026-10-25 a move of cam3 (mini PC → een) was refused, and the cause took
an hour to find. een allowed 10 FTP passive ports, and a second camera needs 20.
Its firewall let only cam4 in. Nothing in cams-admin knew either fact before the
offer went out. Klaus: "We should introduce a 'profile' for a given proxy, i.e.
how many cameras a proxy can handle on the given hardware, how much storage
space is to be available, etc."

Goal: each proxy states its capacity once. Everything that follows from it is
derived, not typed by hand: FTP ports, camera storage shares, the firewall lines
for its cameras. cams-admin sees the profile and refuses a move that cannot fit
before an offer is sent. The target's own offer check stays the final word.

Non-goals: measuring how many cameras the hardware can really handle (the profile
is declared; load figures are shown next to it so a person can judge); cam-proxy
changing the firewall itself (needs root; stays a person's job); profiles across
accounts.

Anti-goals: cams-admin setting ports or storage limits (cams-admin may never set
them: a lower storage limit deletes recordings, docs/cams-admin.md `ui.config`);
a profile that silently changes a running proxy's ports or limits on upgrade.

## What exists today (measured in cam-proxy main, v2026.10.25.1)

- `moves.maxCameras` (local only, 1..64, unset = no limit): a move onto a proxy
  that holds that many is refused (`camera_limit`). While FTP is on it also sets
  the default FTP passive range (10 ports per camera from 30000, at most 100),
  makes an explicit range smaller than that a **load error**, and makes more than
  10 cameras a load error (`src/config/load.ts`).
- `storage.maxPercent` (10..99) or `storage.maxBytes`: the size budget;
  `storage.minFreeBytes`; per-camera `storage.sharePercent`; the per-kind caps
  `stills.maxGB`, `previews.maxGB`, `ftp.maxGB`.
- `src/health/host.ts`: the data volume's disk (size, free, used) everywhere;
  memory, load and CPU temperature only on a Pi or with `host.stats: on` (in a
  pod they would describe the node). "Platform" is Pi or not, plus the Pi model.
  No CPU core count or model today.
- cams-admin's heartbeat view (`/diag/proxies`) carries site, CA fingerprints,
  command policy, allow list and token counts. It has no capacity or hardware.
- Production (2026-10-25): een `maxCameras` 3, FTP 30000–30029; mini PC FTP
  30000–30019, no limit; Pi default FTP 30000–30009, no limit; cluster (cam2)
  no limit, no FTP.

## 1. The profile (cam-proxy)

A new local-only config block, set in config.json or on the proxy's Settings page
with the local admin token. cams-admin can never set it.

```json
"profile": { "name": "een (N100, 1 TB)", "cameras": 3, "storageGB": 600 }
```

- `profile.cameras` (1..10 while FTP is on, 1..64 otherwise): the most cameras
  this proxy holds. It replaces `moves.maxCameras`. The old name is still read as
  an alias for one release. Both set and different is a config error.
- `profile.firewall` (`ufw` or `nft`, default `ufw`): which lines to print
  (*my call*: a setting, not detection; the container can't see the host's
  firewall reliably).
- `profile.name` (optional, ≤60 characters): the hardware as people call it.
  Shown in cams-admin and on the e-paper display.
- The storage budget stays where it is (`storage.maxPercent` / `maxBytes`). The
  profile view shows it with the disk it applies to.

Derived values, never typed:

- **FTP passive range:** while FTP is on and `ftp.passive` is unset, 10 ports
  per camera from 30000, for `max(cameras, cameras held)`. A lower
  `profile.cameras` never shrinks the range below what the cameras held need
  (*my call*: no camera loses its ports on a restart).
- **An explicit `ftp.passive` smaller than the profile needs** is a warning
  (`profile_ftp_ports`), no longer a load error. It is a refusal of the move that
  would need the missing ports (*my call*: the "never stops a running proxy"
  promise holds; the mini PC's 30000–30019 with `cameras` 3 loads and warns).
  The existing rule "at least 10 ports per camera that has FTP" stays a load
  error: it describes cameras the proxy really runs.
- **Storage per camera:** `budget / cameras` is shown as what each camera can
  expect when the proxy is full. Shares (`sharePercent`) still win.
- **Firewall lines:** for each camera with FTP, the exact lines its host needs,
  from the camera's address and the proxy's FTP port and passive range:
  `sudo ufw allow from 192.0.2.85 to any port 2121 proto tcp` and
  `sudo ufw allow from 192.0.2.85 to any port 30000:30029 proto tcp`.
  Plain text for a person to run; nothing executes them. A host with nftables
  (the mini PC) gets the matching nft lines instead, by `profile.firewall`.

Warnings, shown on the proxy page and reported (never a load error, so an upgrade
can't stop a running proxy):

- `profile_cameras_exceeded`: the proxy holds more cameras than `cameras` (set
  lower after the fact). Nothing is removed.
- `profile_ftp_ports`: see above.

## 2. The report (cam-proxy → cams-admin)

The heartbeat body carries a `profile` object (contract v1, optional field; an
older proxy sends none). Shape, closed objects in strict: `set` boolean; `name`
string 1..60 or null; `cameras` 1..64; `storageGB` 1..100000 or null; `held`
0..64; `ftp` {`enabled` boolean, `port` 1..65535, `passive` {`from`, `to`} or
null}; `storage` {`budgetBytes`, `usedBytes`, `diskBytes`, `freeBytes`: integers
≥ 0 or null}; `hardware` {`pi` string or null, `cpuCores` 1..1024, `cpuModel`
string ≤ 100 or null, `memoryBytes` ≥ 0, `load5` number ≥ 0, `cpuTempC` number or
null}; `warnings` array of `profile_ftp_ports` | `profile_cameras_exceeded`;
`firewall` {`tool` `ufw` | `nft`, `lines`: at most 64 strings of ≤ 200
characters}. Example:

```json
"profile": {
  "set": true, "name": "een (N100, 1 TB)", "cameras": 3, "storageGB": 600, "held": 1,
  "ftp": { "enabled": true, "port": 2121, "passive": { "from": 30000, "to": 30029 } },
  "storage": { "budgetBytes": 600000000000, "usedBytes": 41000000000, "diskBytes": 1000000000000, "freeBytes": 880000000000 },
  "hardware": { "pi": null, "cpuCores": 4, "cpuModel": "Intel N100", "memoryBytes": 16000000000, "load5": 0.7, "cpuTempC": 48.5 },
  "warnings": [],
  "firewall": { "tool": "ufw", "lines": ["…"] }
}
```

Hardware (*my call*): cores, model and total memory from Node's `os` module and
the 5-minute load from `os.loadavg()` on every host, labelled "as seen by
cam-proxy". With Docker's host networking (een, mini PC, Pi) that is the host.
In a pod (the cluster) it is the node, which is why the cluster's card says so.
Temperature stays as today (Pi, or `host.stats: on`). The rollout turns
`host.stats` on for een and the mini PC.

The firewall lines hold camera LAN addresses. cams-admin already holds those (the
camera registry), so this exposes nothing new. They are never logged.

## 3. cams-admin

- **Proxy page:** a Profile card with the name, cameras held of capacity, the
  storage budget against disk and use, hardware with load and temperature, the
  warnings, and the firewall lines with a copy button. An older proxy shows
  "no profile reported (needs cam-proxy ≥ <release>)".
- **Move precheck:** three new rules after `target_receives`. Each is skipped
  (ok) when the target reports no profile:
  - `capacity`: `held < cameras`, else refused `camera_limit` with detail
    "een holds 3 of 3 cameras".
  - `ftp_ports`: with FTP on at the target, its passive range has at least
    `10 × (held + 1)` ports.
  - `space` (*my call*): cams-admin first knows the content size when the
    source's `move.request` arrives with its summary, so this is not a precheck
    rule. On the request, cams-admin compares the summary with the target's
    reported `budgetBytes − usedBytes` and its per-kind caps. A shortfall is not
    a refusal: the confirmation panel already offers to leave kinds out or keep
    the newest content, and it now names the profile figures.
  - New precheck reason `camera_limit` (cams-admin side; today only the target
    sends it).
- **Start move form:** before the request it shows the firewall lines the target
  will need for this camera (the moving camera's address against the target's FTP
  port and range), with "Run these on <target> first".
- **Diagnostics:** `/diag/proxies` gains the profile, so the diag token reads it.

## 4. After a move: does FTP reach the new proxy?

The move's check step (step 4) gains `ftp_reaches_target`. Two ways to check it:
- the camera's own FTP test, if the Reolink API has one (cam-sim must copy the
  real camera's answer, measured first, which needs Klaus's OK for the real
  camera);
- otherwise, waiting up to the camera's next motion clip.

A miss is a warning on the move ("FTP uploads don't reach een: check the
firewall lines"), not a failure. The camera's stills and events work without FTP.
Without a camera FTP test (*my call*): the check step ends as today, and the
FTP result arrives later as an event on the move, after the first clip or after
24 hours ("no FTP clip from cam3 on een in 24 h"). It never holds the move open.

## Decisions for Klaus (answered in §0)

1. **Who sets the profile:** recommended local only, on the proxy (like
   `maxCameras` today). Alternative: cams-admin may set `profile.name` only.
2. **Profile presets** ("Pi 4", "mini PC", "N100") with suggested camera counts:
   recommended not now. Declare per proxy; revisit once we have load figures from
   three cameras on een.
3. **The FTP check after a move (§4):** recommended yes, if the camera has an FTP
   test. Measuring it on a real camera needs your OK.

## Rollout

1. Contract: the optional heartbeat `profile` (cams-admin), phased like the
   refusal detail: cams-admin accepts it first.
2. cam-proxy: the profile block, the `maxCameras` alias, derived values, warnings,
   firewall lines, report. Release, then update een, the mini PC and the Pi.
   Their settings are kept: een's `moves.maxCameras` 3 reads as `profile.cameras` 3.
3. cams-admin: Profile card, precheck rules, Start-move firewall lines, diag.
4. Set the profiles: een "3 cameras", mini PC and Pi by Klaus's call (my
   suggestion: mini PC 3, Pi 1).
5. Then the cam3 move (mini PC → een) as the new baseline.

## Out of scope

Automatic capacity from load; cam-proxy changing firewalls; profiles for the
cluster (cam2 is a simulator, no FTP); cross-account moves.
