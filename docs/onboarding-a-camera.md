# Onboarding a camera

From a new camera on the LAN to a camera in every cams viewer. The steps
run in this order: the proxy first (it talks to the camera), then cams-admin
(it tells the viewers), then the checks. Everything except the camera
password can be scripted; the password stays with the camera's owner.

Placeholders below: `192.0.2.40` for the camera's address, `cam2` for its id
on the proxy, `garden` for its cams id, `acc_…` / `prx_…` for registry ids
(take them from `/api/v1/diag/proxies`), `cams-admin.example.net` and
`proxy.example.internal` for the hosts.

## 1. On the proxy (cam-proxy)

**Find it.** `POST /control/actions/find-camera` (or Settings → Find camera)
sends one ONVIF probe on the LAN and lists what answers: address (`useAddress`
when the answering address differs from the advertised one), model, name.
Only a proxy on the host network (the Pi, a mini PC) sees the LAN; in a pod
network nothing answers.

**Add it.** On a multi-camera proxy, add the camera with
`PUT /control/config`; it applies without a restart:

```sh
curl -fsS -X PUT -H 'Content-Type: application/json' \
  -d '{"cameras":{"cam2":{"host":"192.0.2.40"}}}' \
  https://proxy.example.internal/control/config
```

A single-camera proxy instead has `camera` in `config.json` and the address
in `CAMERA_HOST` (Settings → Find camera → "Use this address" writes it;
it applies after a restart of the proxy).

Pitfalls:

- With a `cameras` list the proxy refuses `CAMERA_HOST`: set each camera's
  `host` in the list instead.
- The single `camera` object takes no per-camera `ftp`; per-camera FTP
  needs the `cameras` list.
- An overrides entry `cameras.<id>` left over from a camera that moved away
  counts as an added camera and needs a `host`: remove it, or give it one.

**The camera password.** The camera's owner sets it on the proxy: the
environment variable `CAMPROXY_CAMERA_PASSWORD_<ID>` (the id upper-cased,
`-` → `_`, e.g. `CAMPROXY_CAMERA_PASSWORD_CAM2`) or cams Settings → Camera
login. Never through cams-admin (it never sees camera passwords), and never
by an automation that would have to hold the password.

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

**Camera login in each cams viewer.** The owner enters the camera's
password in cams Settings → Camera login. Until then the viewer lists the
camera as offline ("cams has no password for this camera yet") although
stills through the proxy work, because cams still talks to the camera
directly for status and settings. Each viewer keeps its own logins. A
planned change moves those calls behind the proxy, after which this step
goes away.

## 3. Checks

- **The viewer's camera list:** the camera is there, online, with its name.
- **Capabilities:** what the model offers shows up, e.g. the PTZ panel for a
  PTZ camera.
- **Clips:** if the camera should record clips to the proxy, set the
  camera's FTP target to the proxy (the proxy's FTP settings for that
  camera, then the camera's own FTP page) and check that a test clip
  arrives.
