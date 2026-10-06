# Request: cams-admin in the cluster, and its S3 backup

**Status:** the phase 1 spec is approved (Klaus, 2026-10-06), and the
kube-setup session answered the first draft on 2026-10-06; its points are
folded in below. Nothing here has been applied
(`docs/superpowers/specs/2026-10-06-cams-admin-phase1-design.md`, §13 and §14). This repo is public: names below are
placeholders where the real value is Klaus's or kube-setup's choice, and no
credential ever goes into this repo.

cams-admin is a small Node app (one process, SQLite, a Litestream sidecar). It
follows the cam-proxy pattern: this repo owns the image, the release workflow
and `scripts/create-secrets.sh`; kube-setup owns every manifest.

Order as always: **commit, push, then apply.**

## 1. Namespaces and runner

- Namespaces `cams-admin` (workload) and `cams-admin-runner`. The runner is
  repo-scoped to klaushofrichter/cams-admin, with labels
  `[self-hosted, k3s]`, about 512Mi (the deploy job runs kubectl, git and curl
  only; Playwright runs on GitHub runners).
- The registration PAT goes in Secret `runner-pat` (key `token`), from the
  repo's local `.env`. The cams-admin session can create it once the namespace
  exists.
- ServiceAccount `deploy-sa` in `cams-admin-runner`, and Role
  `cams-admin-deployer` in `cams-admin`: `get`, `watch` and `patch` on
  `deployments`, `resourceNames: [cams-admin]`. The deploy job polls the
  Deployment's status instead of `kubectl rollout status`, as cam-sim and
  cam-proxy do.
- Later (not needed for the first deploy): a Secret `cams-admin-canary` in
  `cams-admin-runner`, mounted into the runner, holding a canary proxy's key
  file, so the deploy job can hold a WebSocket for 5 minutes. Until it
  exists the job skips that check with a warning.
- The runner namespace gets a default-deny ingress NetworkPolicy.
- Add both namespaces to `bootstrap.sh` and `scripts/export.sh`.

## 2. Workload (namespace `cams-admin`)

- **Deployment `cams-admin`, not a Knative service.**
  - The proxies hold long-lived WebSocket connections, which Knative would cut
    at the revision's `timeoutSeconds`.
  - SQLite allows one writer, so the pod must never be scaled out or run as two
    revisions at once.
  - Settings: `replicas: 1`, `strategy: Recreate`.
  - Image on one line, digest-pinned (`ghcr.io/klaushofrichter/cams-admin`).
    The ghcr package is public.
  - Containers, in this order:
    - init container `restore`: `litestream restore -if-db-not-exists
      -if-replica-exists`;
    - `litestream` as a **native sidecar** (an init container with
      `restartPolicy: Always`, Kubernetes 1.36): `litestream replicate`,
      image pinned by digest, metrics on 9090;
    - `app`: port 8080; readiness and liveness on `/health`.
  - `terminationGracePeriodSeconds: 60`, so Litestream finishes its final
    sync after the app stops (it syncs only hourly otherwise:
    `deploy/litestream.yml`, the source for the pod's Litestream ConfigMap).
  - An `emptyDir` `/tmp` (Memory, 16Mi, as cam-proxy) for the app, and for
    Litestream too if it needs one, because the root filesystem is read-only.
  - An `emptyDir` `/run/litestream` (Memory, 1Mi) mounted in **both** the app
    and the Litestream sidecar: Litestream's control socket
    (`/run/litestream/litestream.sock`), which the app's **Backup now**
    button uses to force a sync (`LITESTREAM_SOCKET`). Both containers run
    as uid 1000, so the socket's mode 600 is enough.
  - Litestream's config is `deploy/litestream.yml` in this repo (a ConfigMap
    on your side).
  - Pod annotations `k8s.grafana.com/scrape: "true"` and
    `k8s.grafana.com/metrics.portNumber: "9090"` (Litestream's metrics; not
    `prometheus.io/*`). `/health` also reports `backup.lastReplicationAt` and
    `backup.lastSnapshotAt` for the Grafana dead-man alert kube-setup adds.
    Since 2026-10-06 `lastReplicationAt` is the LastModified of the newest
    replica object in S3 (end to end, restored from S3 after a restart), and
    an idle database writes once per sync interval so that it keeps
    uploading; the alert contract is unchanged (now − lastReplicationAt >
    7500 s = 2 × 3600 + 300 for 15 min; no data = alerting).
  - Security context as in requirement 7 of
    `docs/cluster-deployment-requirements.md`: user 1000, read-only root,
    no privilege escalation, all capabilities dropped.
  - Resources (first guess, to be revisited after a week): app requests
    50m/128Mi with limits 500m/256Mi; litestream requests 10m/32Mi with a
    limit of 64Mi.
- **PVC `cams-admin-data`:**
  - 1Gi `local-path`, mounted at `/var/lib/cams-admin` in all three
    containers. kube-setup patches the PV to **Retain** after the first
    bind.
  - **No Velero volume annotation.** A file-level copy of a live SQLite file
    isn't consistent; Litestream and the daily snapshot are the backup.
- **Service `cams-admin`:** port 8080.
- **Ingress:**
  - Its own Traefik Ingress (or IngressRoute plus a standalone Certificate)
    in namespace `cams-admin`, not the shared knative-gateway Ingress. Host
    `cams-admin.skylar.technology`, path `/`, to the Service.
  - A cert-manager `letsencrypt-prod` certificate over HTTP-01 (v1.21,
    `pathType: Exact` is fine) with `issue-temporary-certificate: "true"`, so
    a pending certificate can't take other hosts down.
  - **The one WebSocket path is `/proxy/v1/connect`** (with
    `POST /proxy/v1/enroll` beside it). Upgrades must pass through; please
    keep any middleware from buffering long-lived connections.
  - Traefik's entrypoint `readTimeout` of 60 s is fine: the server pings
    each proxy socket every 25 s, and proxies send a heartbeat every 30 s.
    The deploy job holds a WebSocket through the public ingress for at least
    5 minutes to prove it (with a canary proxy key; see §1 below).
  - cams-admin is **public by design**: proxies on the home LAN, and later in
    a cloud, connect to it from outside. Klaus approved the name; the DNS
    record exists.
- **Secrets** (created by `scripts/create-secrets.sh` from the repo's local
  `.env`, without printing; please don't create them from the kube-setup
  side):
  - `cams-admin-oauth`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
    `GOOGLE_REDIRECT_URI`, `ALLOWED_EMAILS`;
  - `cams-admin-signing`: `signing-key.pem` (Ed25519), mounted as a file;
  - `cams-admin-backup`: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
    `AWS_REGION`, `BACKUP_S3_BUCKET`, `BACKUP_S3_PREFIX` (used by both the app
    and the Litestream containers).
- **Environment** (no secrets, in the Deployment):
  - `PUBLIC_URL=https://cams-admin.skylar.technology`;
  - `DB_FILE=/var/lib/cams-admin/cams-admin.db`;
  - `TRUST_PROXY=1` (for the scheme only: cams-admin never keys a rate limit
    or a throttle on the client address, since LAN proxies hairpin in as
    `192.168.1.1` and the in-cluster cam-proxy could forge
    `X-Forwarded-For`; limits key on the session, the proxy id or the code);
  - `LITESTREAM_METRICS_URL=http://127.0.0.1:9090/metrics`;
  - `LITESTREAM_SOCKET=/run/litestream/litestream.sock`;
  - `LITESTREAM_SYNC_INTERVAL_S=3600` (the sync interval of `deploy/litestream.yml`; a dead-man alert on `/health`'s `backup.lastReplicationAt` should allow 2 × it + 5 min);
  - `BACKUP_SNAPSHOT_RETENTION_DAYS=30`;
  - `TZ` as for cams.
- **Monitoring:** an UptimeRobot monitor may use `HEAD /health`, which
  answers 200 (tested).

## 3. NetworkPolicies

- `cams-admin` ingress: from Traefik on 8080, and from pods `app: cam-proxy`
  in namespace `cam-proxy` on 8080. The cluster's proxy reaches cams-admin
  over the Service, because it has no internet egress.
- With default-deny ingress, also Traefik (`kube-system`,
  `app.kubernetes.io/name=traefik`) to pods labelled
  `acme.cert-manager.io/http01-solver=true` on 8089, so HTTP-01 can solve.
- `cams-admin` egress:
  - DNS;
  - TCP 443 to `ipBlock 0.0.0.0/0` except `10.42.0.0/16`, `10.43.0.0/16` and
    `192.168.1.0/24`: Google's OAuth and token endpoints, and S3.
- **Stated plainly:** the in-cluster path
  `http://cams-admin.cams-admin.svc.cluster.local:8080` is plain HTTP. The
  cluster proxy's one-time enrollment code crosses it in clear, once; that is
  accepted behind the NetworkPolicies on both ends. Every later session is
  authenticated by Ed25519 signatures over a per-connection nonce, which a
  sniffer can't replay.
- `cam-proxy` egress (an addition to `allow-egress`): to pods of the
  `cams-admin` Deployment, TCP 8080. This is needed only when the cluster's
  proxy is enrolled; it can wait for that step.

## 4. AWS S3 bucket and IAM user (Klaus)

- **Bucket:**
  - `klaushofrichter-k3s-cams-admin-backups` in `us-east-1`, a dedicated
    bucket (never Velero's or the hostpath-backups bucket); prefix
    `cams-admin/prod/`. Klaus creates the bucket, the IAM user and the key
    himself; the key goes straight into a file. The AWS account id is never
    written into this public repo.
  - **Block Public Access:** all four settings on.
  - **Versioning:** on.
  - **Default encryption:** SSE-S3.
  - **Bucket policy:** deny requests without TLS
    (`aws:SecureTransport = false`).
- **Lifecycle:**
  - `cams-admin/prod/snapshots/`: current objects expire after **30 days**
    (the app's `BACKUP_SNAPSHOT_RETENTION_DAYS` default; raising one means
    raising the other);
  - noncurrent versions: expire 30 days after becoming noncurrent;
  - expired object delete markers: removed;
  - incomplete multipart uploads: aborted after 7 days.
- **IAM user `cams-admin-backup-prod`:**
  - no console access;
  - one access key (rotated every 90 days, as in
    `docs/api-token-rotation.md`);
  - only this inline policy:

```json
{ "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ListPrefix", "Effect": "Allow", "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::klaushofrichter-k3s-cams-admin-backups",
      "Condition": { "StringLike": { "s3:prefix": ["cams-admin/prod/", "cams-admin/prod/*"] } } },
    { "Sid": "ObjectsInPrefix", "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject",
                 "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": "arn:aws:s3:::klaushofrichter-k3s-cams-admin-backups/cams-admin/prod/*" } ] }
```

- **The key** goes into the repo's local `.env` (gitignored).
  `scripts/create-secrets.sh` turns it into the `cams-admin-backup` Secret.
- **Later, in a cloud:** an IAM role with the same policy replaces the user.
