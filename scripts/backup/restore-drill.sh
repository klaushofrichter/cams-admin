#!/usr/bin/env bash
# restore-drill.sh: restores the PRODUCTION Litestream replica into a
# temporary folder on a workstation and prints per-table counts (spec §13.6).
# Read-only against the bucket. Uses the caller's own AWS credentials
# (Klaus's profile), never the app's, and never in GitHub Actions.
#   AWS_PROFILE=... scripts/backup/restore-drill.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
BUCKET="${BACKUP_S3_BUCKET:-klaushofrichter-k3s-cams-admin-backups}"
PREFIX="${BACKUP_S3_PREFIX:-cams-admin/prod/}"
REGION="${AWS_REGION:-us-east-1}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/cams-admin-drill.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
LITESTREAM="$("$ROOT/scripts/backup/litestream.sh")"
cat > "$WORK/ls.yml" <<YAML
dbs:
  - path: /var/lib/cams-admin/cams-admin.db
    replica:
      type: s3
      bucket: $BUCKET
      path: ${PREFIX}litestream
      region: $REGION
YAML
"$LITESTREAM" restore -config "$WORK/ls.yml" -o "$WORK/drill.db" /var/lib/cams-admin/cams-admin.db
cd "$ROOT" && npx tsx scripts/backup/restore-check.ts dump --db "$WORK/drill.db"
echo "restore-drill: OK (the restored copy is deleted on exit)"
