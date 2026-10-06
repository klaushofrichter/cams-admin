# Request: cams-admin in the cluster, and its S3 backup (draft)

**Status:** draft. To be sent to the kube-setup session (cluster parts) and to
Klaus (AWS parts) once Klaus has approved the phase 1 spec
(`docs/superpowers/specs/2026-10-06-cams-admin-phase1-design.md`, §13 and §14).
Nothing here has been applied. This repo is public: names below are
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
  `deployments`, `resourceNames: [cams-admin]`.
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
  - Containers:
    - `app`: port 8080; readiness and liveness on `/health`;
    - `litestream` (sidecar): `litestream replicate`, image pinned by digest;
    - init container `restore`: `litestream restore -if-db-not-exists
      -if-replica-exists`.
  - Security context as in requirement 7 of
    `docs/cluster-deployment-requirements.md`: user 1000, read-only root,
    no privilege escalation, all capabilities dropped.
  - Resources (first guess, to be revisited after a week): app requests
    50m/128Mi with limits 500m/256Mi; litestream requests 10m/32Mi with a
    limit of 64Mi.
- **PVC `cams-admin-data`:**
  - 1Gi `local-path`, reclaim policy **Retain**, mounted at
    `/var/lib/cams-admin` in all three containers.
  - **No Velero volume annotation.** A file-level copy of a live SQLite file
    isn't consistent; Litestream and the daily snapshot are the backup.
- **Service `cams-admin`:** port 8080.
- **Ingress:**
  - Traefik, host `cams-admin.skylar.technology`, path `/`, to the Service.
  - A cert-manager `letsencrypt-prod` certificate with
    `issue-temporary-certificate: "true"`, so a pending certificate can't take
    other hosts down.
  - WebSocket upgrades on `/proxy/v1/connect` must pass through. Traefik does
    this by default; please keep any middleware from buffering or timing out
    long-lived connections.
  - cams-admin is **public by design**: proxies on the home LAN, and later in
    a cloud, connect to it from outside. Klaus approved the name; the DNS
    record exists.
- **Secrets** (created by `scripts/create-secrets.sh` from the repo's local
  `.env`, without printing; please don't create them from the kube-setup
  side):
  - `cams-admin-oauth`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
    `GOOGLE_REDIRECT_URI`, `SYSADMIN_EMAILS`;
  - `cams-admin-signing`: `signing-key.pem` (Ed25519), mounted as a file;
  - `cams-admin-backup`: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
    `AWS_REGION`, `BACKUP_S3_BUCKET`, `BACKUP_S3_PREFIX` (used by both the app
    and the Litestream containers).
- **Environment** (no secrets, in the Deployment):
  - `PUBLIC_URL=https://cams-admin.skylar.technology`;
  - `DB_FILE=/var/lib/cams-admin/cams-admin.db`;
  - `TRUST_PROXY=1`;
  - `TZ` as for cams.

## 3. NetworkPolicies

- `cams-admin` ingress: from Traefik on 8080, and from pods `app: cam-proxy`
  in namespace `cam-proxy` on 8080. The cluster's proxy reaches cams-admin
  over the Service, because it has no internet egress.
- `cams-admin` egress:
  - DNS;
  - TCP 443 to addresses outside the cluster: Google's OAuth and token
    endpoints, and S3. NetworkPolicy can't name hosts, so this is "443 to
    non-cluster CIDRs".
- `cam-proxy` egress (an addition to `allow-egress`): to pods of the
  `cams-admin` Deployment, TCP 8080. This is needed only when the cluster's
  proxy is enrolled; it can wait for that step.

## 4. AWS S3 bucket and IAM user (Klaus)

- **Bucket:**
  - Klaus's account; name and region are his choice (placeholder:
    `BUCKET` in a region near the cluster).
  - **Block Public Access:** all four settings on.
  - **Versioning:** on.
  - **Default encryption:** SSE-S3.
  - **Bucket policy:** deny requests without TLS
    (`aws:SecureTransport = false`).
- **Lifecycle:**
  - `cams-admin/prod/snapshots/`: current objects expire after 90 days;
  - noncurrent versions: expire 30 days after becoming noncurrent;
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
      "Resource": "arn:aws:s3:::BUCKET",
      "Condition": { "StringLike": { "s3:prefix": ["cams-admin/prod/", "cams-admin/prod/*"] } } },
    { "Sid": "ObjectsInPrefix", "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::BUCKET/cams-admin/prod/*" } ] }
```

- **The key** goes into the repo's local `.env` (gitignored).
  `scripts/create-secrets.sh` turns it into the `cams-admin-backup` Secret.
- **Later, in a cloud:** an IAM role with the same policy replaces the user.
