# Request: migration phase 4 (cams reads cams-admin)

**Status:** for the cut-over steps 5–7 of `docs/migration-p4-runbook.md`;
nothing to apply before Klaus says go for step 5. Spec
`docs/superpowers/specs/2026-10-06-cams-admin-migration-design.md` (§9.2,
§11.4, §11.6), plan `docs/superpowers/plans/2026-10-07-migration-p4-cams-admin.md`.
This repo is public: no token, address or credential goes into it.

The cams pods call cams-admin's service API (`/cams/v1/*`): every request
is signed by the cams instance's own Ed25519 key and every answer by
cams-admin's key, so the in-cluster hop may stay plain HTTP. Nothing here
adds a public host, a LAN port or broader egress.

## 1. NetworkPolicy (step 5)

- **Ingress** to the cams-admin pod's port 8080 from the cams ksvc pods
  (`serving.knative.dev/service: cams` in namespace `cams`).
- If namespace `cams` has (or gets) a default-deny **egress** policy: egress
  from those pods to cams-admin:8080. Nothing else.

## 2. Ingress path (step 6)

`https://cams-admin.skylar.technology/cams/v1/*` must reach the cams-admin
Service like `/proxy/v1/*` does (only if the ingress filters paths). The
Pi's cams uses the public host.

## 3. cams ksvc env (step 5, then step 7)

| when | env |
|---|---|
| step 5 | `CAMS_ADMIN_URL=http://<cams-admin Service>.<namespace>.svc.cluster.local:8080`, then (after the import) `CONFIG_SOURCE=shadow` |
| step 7 | `CONFIG_SOURCE=cams-admin` |
| rollback (either step) | `CONFIG_SOURCE=file` |

`CAMS_DATA_DIR` stays unset (cams uses the PVC folder of `PREFS_FILE`,
`/var/lib/cams`).

## 4. cams-admin env

`INTERNAL_URLS` gains the in-cluster Service origin if it isn't listed yet:
the enroll answer's `apiUrl` is the origin the request came in on only when
it is allow-listed, else `PUBLIC_URL`.

## 5. Enrollment (step 5)

One `kubectl exec -i` into the cams pod (Klaus or kube-setup):

```
kubectl exec -i -n cams <cams pod> -- node dist/server/cli.js admin-enroll --url $CAMS_ADMIN_URL
```

with the code on stdin. The code is shown once in cams-admin (Instances →
the instance → Enrollment), next to cams-admin's server key fingerprint,
which `admin-enroll` prints too: compare them (the in-cluster enroll answer
is plain HTTP and unsigned, like a proxy's enrollment). The key lands on the
`cams-data` PVC under `admin/`, mode 600.

## 6. Later, P4d (30 days after step 8, when Klaus says go; M §11.6)

Not part of this rollout:

- Secret `cams-camera-credentials` (`{"v":1,"home/cam1":{"user":"cams","password":"…"},…}`)
  mounted read-only with `CAMERA_CREDENTIALS_FILE`, replacing `cams-cameras`;
- `ALLOWED_EMAILS` removed from `cams-oauth`;
- `CAMPROXY_TOKENS` removed from `cam-proxy-secrets`.
