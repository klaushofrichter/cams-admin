# PoE switches: account switches, camera power, verified power-cycles

Status: design, 2026-11-07. Agreed with Klaus in chat; marked calls are mine.
Repos: cams-admin (switch records, camera power, orchestration), cam-proxy
(switch operation, port finding, power-cycle).

## Why

Today a proxy has one PoE switch in its own config (`poeSwitch.model/host/
ports/offSeconds`) and each camera a `poeSwitch.port`. That breaks in ways seen
on een:

- The port is typed in by hand and goes stale when a cable moves; a stale port
  power-cycles the wrong camera.
- One switch per proxy: a switch on the LAN that powers cameras of several
  proxies can't be described.
- A camera on an adapter (the E1 on een's switch port 2: data only, 0 W) looks
  the same as a PoE camera until a power-cycle is refused.

Klaus (2026-11-07): an account has PoE switches, like it has cameras; a camera's
switch and port are known in one place, verified before use, surveyed from time
to time; no power-cycle on an unverified port unless forced; switches can be
onboarded, configured, moved between proxies and offboarded.

## Decisions (Klaus)

- A switch belongs to one account and is never shared across accounts. cams-admin
  gets a **Switches** tab on the account page, with APIs to add, manage and
  remove switches.
- A switch can sit behind a proxy (een's 192.168.60.0/24 segment) or directly on
  the LAN.
- The camera ↔ switch/port relation is kept in **one place**, with an API to
  query it.
- The port is verified before every power-cycle (the camera may have moved).
  If it's not on the expected port, all ports of all the account's switches are
  searched. No power-cycle on a port that can't be verified, **except a forced
  power-cycle** (admin, explicit confirmation).
- A camera may not be PoE powered (E1, or any camera on an adapter): no
  power-cycle then.
- The mapping may be surveyed from time to time.
- Switches need onboarding, configuring, moving between proxies and offboarding.
- A proxy without cams-admin (standalone) has no PoE power-cycle (Klaus: ok).

## Measured facts this rests on

- GPS-208 (`sscpoe-web`) has no MAC table (callcmd 114 empty on firmware 6.1.x).
- Its port detail (101) has `rx[]`/`tx[]` current rates per internal index (plus
  index 9 = uplink). A 4–5 s ping burst to a camera (`ping -s 1400 -i 0.005`)
  raises that camera's port `tx` 10–30× above the others (2026-11-05, all four
  of een's cameras found: 1 cam4, 2 e1, 3 cam3, 4 cam1).
- One web session at a time; a session left open locks the switch ~3 min.
- A power-cycle (10 s off) brings a camera back in 31–46 s.

## The model

### Switch (cams-admin record)

`sw_…` id, account, name, model (`sscpoe-web`), address (host as seen from the
operating proxy), port count, `offSeconds` (default 10), operating proxy, and
what the switch reported at the last read: serial, firmware, when.

### The operating proxy

Exactly one proxy of the account talks to a switch: logs in, reads, switches
PoE. It holds the switch password (entered on that proxy's admin page, like a
camera password; cams-admin never sees it). Why one:

- the switch's single web session: one operator serializes every use in the
  proxy's existing queue, so two proxies never fight over the session;
- the operator can reach the switch's cameras: a switch carries its cameras'
  network, so a proxy that reaches the switch's management address reaches the
  cameras on it and can send them the test traffic.

The operator is about who talks to the switch, not who owns the cameras: a LAN
switch operated by the mini PC's proxy can power cameras of the Pi's proxy. So
**a camera move between proxies doesn't touch the switch** (the camera's power
record stays; the operator still reaches it). A camera that physically moves to
another network is on another switch anyway; the next verify or survey finds it.

### Camera power (cams-admin, on the camera record: the one place)

`power` on the camera record, one of:

- `poe { switchId, port, watts, verifiedAt }`: powered by that port;
- `data-only { switchId, port, verifiedAt }`: its traffic is on that port but
  the port draws 0 W (adapter-powered, the E1 case): no power-cycle;
- `adapter`: declared by an admin (not on any of our switches): no power-cycle,
  surveys skip it;
- `unknown`: never found.

"Which cameras are on switch X" is a query over camera records; the switch
record holds no camera list. A port holds at most one camera; a survey result
that puts a second camera on a port moves the old one to `unknown` (audited).

### Finding a camera (`locate`)

On the operator: read the switch (baseline rates), ping-burst the camera's
host for ~5 s, read again during the burst; the port whose `tx` (or `rx`) rose
clearly above every other port (ratio threshold, my call: ≥5× the next
highest and above a floor) is the camera's port. Ambiguous → not found. The
answer includes the port's watts and link, so `poe` vs `data-only` follows.

The pinged address is the camera's `host` as cams-admin has it (the same
address the owning proxy uses). The operator is on the switch's network, so
it reaches that address; if it can't, `locate` answers "camera not reachable
from the operator", which a survey reports, never as "not found" silently.

The burst needs ICMP from the proxy container: `ping` in the image (Docker's
default capabilities include NET_RAW). My call; a TCP fallback is not planned.

### Verify

`locate` restricted to the mapped switch: the camera's traffic must show on the
mapped port, and the port must have PoE on and draw power. Passing updates
`verifiedAt` and `watts`.

### Power-cycle

1. Verify the mapping.
2. Not on the mapped port, or `unknown`: search: `locate` on every switch of the
   account (one after another, each through its operator). Found → update the
   mapping (audited), go on. `data-only`/`adapter` → refused: "not PoE powered".
3. Not verifiable (camera doesn't answer, port not found) → refused, with the
   reason and the last known mapping.
4. Cycle through the operator (the existing `PoeSwitch.cycle`: refuses a port
   with PoE off or 0 W, always turns PoE on again, retries).

**Forced power-cycle:** admin only, explicit confirmation naming switch and
port ("Cut power on Switch 2 port 3 without verification?"). Allowed for a
`poe` mapping only (never `data-only`/`adapter`), still refused on a port that
draws 0 W (the switch-level check stays). Audited as forced.

Callers: cams-admin (camera page button, API) and cam-proxy's Maintenance page
(asks cams-admin through the channel, see below). There is no automatic
power-cycle today and this design adds none.

A hung camera that doesn't even answer ping can't be verified: only a forced
power-cycle reaches it (Klaus: verify or force; no softer fallback such as
"port still draws the recorded watts").

**Who does what (my call).** The operating proxy does the switch work: verify,
cut, wait, PoE on (with its retries), and the switch-side audit record
(`switch-port-cycled`, naming the camera). The camera's own proxy keeps its
reboot state machine (cooldown, dropping the camera token, the "rebooting"
watch, the camera-side audit): cams-admin sends it `camera.power.cycling` when
the operator reports PoE off and `camera.power.cycled` when it's on again (or
failed). When operator and owner are the same proxy (een), the same messages
go to itself through cams-admin, so there is one path.

**Asking from a proxy (my call).** The channel has no proxy → cams-admin
request/response today. The Maintenance button sends an event
`camera.power.cycle.request {cameraId, force}`; cams-admin answers later with a
command `camera.power.cycle.result {ok, reason, switch, port}` (plus the
`cycling`/`cycled` messages above). The page shows "asked cams-admin…" until
the result arrives.

**Without cams-admin (my call).** These stay local on the operator and work
with cams-admin unreachable: turning PoE on again after a cut (retries, and at
stop), and a per-port "Turn PoE on" on the operator's Proxy settings → PoE
switches. Starting a power-cycle needs cams-admin.

### Survey

`locate` for each camera of the account that isn't `adapter`, one at a time,
per switch through its operator. When: a camera added or its address changed;
a switch added or moved; daily (my call: 03:30 local of the account, outside
the retention run); a "Survey now" button on a switch and on the Switches tab.
Results update mappings; each change is audited. A survey is one command per
switch (`switch.survey {cameras: [{id, host}]}`), so the operator runs the
bursts one after another inside one command instead of one queued command per
camera (cams-admin's queue keeps one command in flight per proxy). The daily
time uses the account's proxies' local time (accounts store no time zone). A camera found nowhere keeps
its last mapping but is marked "not seen in the last survey" (not reset to
`unknown`, my call: a camera that is down shouldn't lose its mapping, the
forced power-cycle needs it).

## Switch lifecycle

### Onboarding

1. Add the switch in cams-admin (Switches tab → Add): name, model, address,
   operating proxy. Record state `pending`.
2. Set the switch password on the operating proxy's admin page (Proxy settings
   → PoE switches; or `scripts/` on its stdin). Never through cams-admin.
3. cams-admin tests it through the operator (`switch.read`): login, port
   detail, logout. Records serial, firmware, port count. State `active`.
   Refused when the serial is already a switch of any account (one account per
   switch).
4. A survey runs and fills in the camera mappings.

### Configuring

Name, address, `offSeconds`, survey on/off: cams-admin, audited. A changed
address is tested before it's saved (serial must match).

### Moving to another operating proxy

No decommissioning: the switch holds no proxy-specific config (we only ever
switch PoE), and it keeps switching traffic and power all the time.

1. Set the password on the new operator.
2. Move in cams-admin (new operator, and the address as seen from it if it
   differs). cams-admin tests through the new operator (serial must match)
   before it flips the record; a failed test changes nothing.
3. The old operator drops the password (command `switch.forget`).
4. Survey. Audited as one move.

A physical move (the switch to another network) is the same plus a new address.

### Offboarding

Remove in cams-admin: cameras on it go to `unknown` (audited); the operator
makes sure every port with a mapped `poe` camera has PoE on, then forgets the
password; the record is deleted. The switch itself keeps working as a plain
PoE switch.

## APIs (cams-admin)

- `GET /accounts/:acc/switches`, `POST /accounts/:acc/switches`
- `GET /switches/:id` (record + the operator's live read: ports with watts,
  link, mapped camera), `PATCH /switches/:id` (config, move), `DELETE
  /switches/:id` (offboard)
- `POST /switches/:id/test`, `POST /switches/:id/survey`, `POST
  /accounts/:acc/switches/survey`
- `GET /cameras/:id/power`, `PUT /cameras/:id/power` (declare `adapter`, or
  propose `{switchId, port}`: saved only after verify), `POST
  /cameras/:id/power/verify`, `POST /cameras/:id/power/cycle` (`{force:
  true}` for a forced one)
- MCP (read-only, existing fleet tools pattern): switches and camera power.

Commands to the operating proxy: `switch.read`, `switch.locate {host}`,
`switch.survey {cameras}`,
`switch.cycle {port, expectedWatts}`, `switch.poeOn {port}`, `switch.forget`.
To the camera's own proxy: `camera.power.cycling`, `camera.power.cycled`,
`camera.power.cycle.result`. Upward from a proxy (event):
`camera.power.cycle.request` (Maintenance button).

## cam-proxy

- Switch operation keyed by switch id: driver, session queue, password (secrets
  file, like camera passwords), per switch instead of one per host.
- `locate` (rates in the driver's detail; ping burst).
- The `poeSwitch.*` config (host and camera level) is removed after migration.
- Camera settings shows the camera's power from cams-admin ("PoE: Switch 2,
  port 3, verified 2 h ago" / "Data only: power adapter" / "Unknown: Find").
  Proxy settings lists the switches this proxy operates (password set or not).

## Migration (een)

1. Release both sides with the old config still read.
2. Add een's switch (192.168.60.2) with een's proxy as operator; the password is
   already on een (moved from `CAMPROXY_POE_SWITCH_PASSWORD` to the per-switch
   secret on start).
3. Survey: expected cam4 port 1, e1 port 2 (`data-only`), cam3 port 3, cam1
   port 4.
4. Remove the old `poeSwitch.*` config.

## Out of scope

- Other switch models (a new driver later).
- Switch config beyond PoE on/off (VLANs, firmware).
- Standalone proxies (no PoE power-cycle).

## My calls (check these)

- Locate threshold ≥5× the next port and a floor; ambiguous = not found.
- ICMP ping burst from the container; no TCP fallback.
- Daily survey at 03:30 account-local.
- A camera not found in a survey keeps its last mapping, marked "not seen".
- Forced power-cycle still refused on a 0 W port.
- One camera per port; a second camera found on a port replaces the first.
- The operator does the switch work, the camera's proxy keeps its reboot
  state machine, linked by cams-admin messages.
- Maintenance asks by event and gets the result as a later command.
- PoE-on recovery stays local on the operator and works without cams-admin.
- Locate pings the camera's `host` as cams-admin has it.
- Survey as one batch command per switch.
