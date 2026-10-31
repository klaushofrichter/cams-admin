# Onboarding a camera

From a new camera on the LAN to a camera in every cams viewer. The steps
run in this order: the proxy first (it talks to the camera), then cams-admin
(it tells the viewers), then the checks. Everything except the camera
password can be scripted; the password stays with the camera's owner, who
types it once.

Placeholders below: `192.0.2.40` for the camera's address, `cam2` for its id
on the proxy, `garden` for its cams id, `acc_…` / `prx_…` for registry ids
(take them from `/api/v1/diag/proxies`), `cams-admin.example.net` and
`proxy.example.internal` for the hosts.

## 1. On the proxy (cam-proxy)

All of it is cam-proxy's API (its README, "Onboarding a camera"), without
file edits or a restart, on a several-camera proxy and on the Pi alike, and
only with the proxy's own admin token or admin page: none of these steps is a
cams-admin command, because they carry the camera's password or decide where
it goes.

**The short way: the script.** cam-proxy's `scripts/onboard-camera.sh` runs
the steps below in order, on the proxy host or anywhere that reaches the
proxy, and waits until cams-admin has the camera too:

```sh
export CAMPROXY_URL=http://proxy.example.internal:8480 CAMPROXY_ADMIN_TOKEN_FILE=<file with the proxy's admin token>
export CAMS_ADMIN_URL=https://cams-admin.example.net \
  CAMS_ADMIN_DIAG_TOKEN_FILE=~/.config/cams-admin/diag-token CAMS_ADMIN_OPS_TOKEN_FILE=~/.config/cams-admin/ops-token
scripts/onboard-camera.sh --find
scripts/onboard-camera.sh --host 192.0.2.40 --id cam2 --name Garden --time --cams-admin-proxy prx_… --cams-id garden
```

It shows the certificate the camera serves; type `yes` once it matches the
camera's own page, then the camera password (not echoed). One `ok`/`FAIL`
line per step. The ops token needs `onboard` to adopt (without it the
account must adopt by itself, below). `scripts/offboard-camera.sh --id cam2
--cams-admin-proxy prx_…` is the reverse (an ops token with `offboard`).

**Step by step:**

1. **Find it.** `POST /control/actions/find-camera` (or Settings → Find
   camera) sends one ONVIF probe on the LAN and lists what answers: address
   (`useAddress` when the answering address differs from the advertised
   one), model, name. Only a proxy on the host network (the Pi, a mini PC)
   sees the LAN; in a pod network nothing answers.
2. **Probe it.** `POST /control/actions/camera-probe` `{host}`: which ports
   answer and the certificate the camera serves (its fingerprint). Compare
   the fingerprint with the camera's own web page.
3. **Add it.** `POST /control/cameras` `{id, name, host, password, trust:
   {fingerprint}}`: the proxy logs in with the password first and stores
   nothing unless the camera accepts it, over https only to that
   certificate; then the password is stored, the certificate pinned, and the
   camera runs at once. On the Pi it replaces a camera that moved away or was
   offboarded, and writes `CAMERA_HOST`.
4. **Extras**, each optional: `camera-time-set` (zone from `time.zone`),
   `camera-ftp-setup` (clips to the proxy), as camera actions.
5. **Ready.** `GET /control/cameras/cam2/onboarding` until `ready` (each
   step with why and the fix).

The password comes from the camera's owner, once, in the proxy's admin page
(Camera password, Add camera) or on the script's stdin. Never through
cams-admin (it never sees camera passwords), and cams viewers no longer need
it: they reach the camera through its proxy.

Once the proxy reaches the camera, its next heartbeat reports it to
cams-admin.

## 2. In cams-admin

**The proxy reports it.** A camera the proxy reports and the registry lacks
shows on the proxy page under Reconciliation as "reported, not registered",
on the dashboard as a badge, and in the diagnostics API:

```sh
curl -fsS -H "Authorization: Bearer $(cat ~/.config/cams-admin/diag-token)" \
  https://cams-admin.example.net/api/v1/diag/proxies/prx_…/unregistered
# {"proxyId":"prx_…","accountId":"acc_…","reported":true,
#  "items":[{"ref":"cam2","name":"Camera 2","model":"…","online":true,"proposedCamsId":"cam2"}]}
```

`reported` is false until the proxy has sent a summary. `proposedCamsId` is
the proxy's id, or `<proxy name>-<id>` when the account already has that cams
id.

**Adopt it.** Either the proxy page's "Add to account as …" button (a
sign-in), or a script with an operations token holding the scope `onboard`
(Diagnostics → Operations tokens; see [diagnostics.md](diagnostics.md)):

```sh
curl -fsS -X POST -H "Authorization: Bearer $(cat ~/.config/cams-admin/ops-token)" -H 'Content-Type: application/json' \
  -d '{"proxyCameraId":"cam2","camsId":"garden","name":"Garden"}' \
  "https://cams-admin.example.net/api/v1/accounts/acc_…/proxies/prx_…/adopt"
```

`camsId`, `name` and `kind` (default `camera`) are optional; without them the
proposed cams id and the reported name are used. The camera is registered
with host `from-proxy` (the viewers reach it through the proxy) and the model
from the report; the model also fills itself from later heartbeats. The adopt
is audited as `camera-adopt`, with the token as the actor. A plain
`POST /accounts/:accountId/cameras` stays with a sign-in.

**The viewers follow.** Each cams viewer that shows the account applies the
new configuration within about a minute (`config_applied` in its log).
Without the adopt the viewers don't list the camera at all, however well the
proxy serves it.

To change the camera later (name, host, TLS name), PATCH it with the row's
`version` (`rowVersion` in `/diag/cameras`; the field in the body is
`version`, not `rowVersion`) and an operations token with `registry`.

**No camera login in the viewers.** A viewer reaches a camera through its
proxy (status, snapshot, live video, settings), so it needs no camera
password. Only a camera whose proxy is older than cam-proxy's camera calls
still needs one in cams Settings → Camera login.

## The scripted path

Every cams-admin step above can run without a sign-in, except two that stay
with a person on purpose: enrolling the proxy, and switching auto-adopt on.

1. **Adopt.** Either the account adopts by itself (Accounts → the account →
   "Add cameras automatically when their proxy reports them ready"; off by
   default, set only signed in): a camera the proxy reports ready (its
   required onboarding steps done) is added with host `from-proxy`, audited
   `camera-adopt` with the actor `system:auto-adopt`. A camera removed from
   the account or moved off that proxy is never added back by itself (a
   manual adopt lifts that). Or a script adopts it with an `onboard` token, as
   above.
2. **The proxy's pins.** A proxy without pins in the registry takes the
   site-CA fingerprints it reports on its next heartbeat (audit
   `system:proxy-report`). A change of existing pins is never automatic: the
   proxy page's "Use the reported pins", or
   `POST …/proxies/prx_…/pins/from-report` with a `registry` token.
3. **Optional steps, as each proxy allows** (scope `actions`): the full
   status `POST …/proxies/prx_…/cameras/cam2/onboarding/refresh`; the time
   (`camera-time-set`) and the camera's FTP target (`camera-ftp-setup`) as
   camera actions, with the action's name typed back:

   ```sh
   curl -fsS -X POST -H "Authorization: Bearer $(cat ~/.config/cams-admin/ops-token)" -H 'Content-Type: application/json' \
     -d '{"camera":"cam2","action":"camera-time-set","confirm":"camera-time-set"}' \
     "https://cams-admin.example.net/api/v1/accounts/acc_…/proxies/prx_…/actions"
   ```

   Both are off on each proxy until its owner allows them there (409
   `not_allowed_on_proxy`), and count against the fleet budget for
   disruptive actions. A script must not assume them.
4. **Wait for ready.** Poll the camera's onboarding view until `ready` is
   true; `missing` says what is still open (see
   [diagnostics.md](diagnostics.md), "A camera's onboarding"):

   ```sh
   until curl -fsS -H "Authorization: Bearer $(cat ~/.config/cams-admin/diag-token)" \
       https://cams-admin.example.net/api/v1/diag/cameras/garden/onboarding | grep -q '"ready":true'; do sleep 30; done
   ```

   A viewer that holds a change (`viewer:<name>:held`) waits for someone to
   confirm it in that viewer: that is never scripted.

## 3. Checks

- **The viewer's camera list:** the camera is there, online, with its name.
- **Capabilities:** what the model offers shows up, e.g. the PTZ panel for a
  PTZ camera.
- **Clips:** if the camera should record clips to the proxy, set the
  camera's FTP target to the proxy (the proxy's FTP settings for that
  camera, then the camera's own FTP page) and check that a test clip
  arrives.
