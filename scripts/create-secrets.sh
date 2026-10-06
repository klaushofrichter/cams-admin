#!/usr/bin/env bash
# Creates cams-admin's Kubernetes Secrets (and the deploy token on GitHub)
# from the repo's local .env, following cam-proxy's sync-secrets.sh: key
# names are printed, values never; values never go on a command line.
# Run by Klaus or with his OK, after kube-setup created the namespaces
# (docs/kube-setup-request.md). Never from tests or CI.
#
#   scripts/create-secrets.sh [--only check|oauth|signing|backup|runner|github|all]
#                             [--dry-run] [--env-file PATH]
#
#   check (default): every key present and well-formed; nothing is applied.
#   oauth:   Secret cams-admin-oauth: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
#            GOOGLE_REDIRECT_URI, SYSADMIN_EMAILS
#   signing: Secret cams-admin-signing: signing-key.pem from the file named
#            by SIGNING_KEY_PEM_FILE (made by scripts/gen-signing-key.ts;
#            mode 600). Replacing it means re-enrolling every proxy.
#   backup:  Secret cams-admin-backup: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
#            AWS_REGION, BACKUP_S3_BUCKET, BACKUP_S3_PREFIX (app + Litestream)
#   runner:  Secret runner-pat (key token) in cams-admin-runner: RUNNER_PAT
#   github:  repo secret KUBE_SETUP_DEPLOY_TOKEN from GITHUB_KUBE_SETUP_PAT
# KUBE_CONTEXT (required for the Secrets) comes from the env file too.
set -euo pipefail
umask 077

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
DRY=0
ONLY=check
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --only) ONLY="$2"; shift ;;
    --env-file) ENV_FILE="$2"; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "create-secrets: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case "$ONLY" in check|oauth|signing|backup|runner|github|all) ;; *) echo "create-secrets: bad --only $ONLY" >&2; exit 2 ;; esac
die() { echo "create-secrets: $*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "$ENV_FILE not found"
perms=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")
case "$perms" in *00) ;; *) die "$ENV_FILE is readable by others (mode $perms); run: chmod 600 $ENV_FILE" ;; esac

raw() { K="$1" awk 'index($0, ENVIRON["K"] "=") == 1 { print substr($0, length(ENVIRON["K"]) + 2); exit }' "$ENV_FILE"; }
get() {
  local v
  v=$(raw "$1")
  if [[ "$v" =~ [[:space:]]# ]]; then die "$1 has an inline comment; put comments on their own line"; fi
  v="${v%$'\r'}"
  case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
  printf '%s' "$v"
}
need() { local k; for k in "$@"; do [ -n "$(get "$k")" ] || die "missing $k in $ENV_FILE"; done; }
say() { if [ "$DRY" = 1 ]; then echo "would $*"; else echo "$*"; fi; }
want() { [ "$ONLY" = "$1" ] || [ "$ONLY" = all ]; }

OAUTH=(GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REDIRECT_URI SYSADMIN_EMAILS)
BACKUP=(AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION BACKUP_S3_BUCKET BACKUP_S3_PREFIX)

# Check first, so a bad line stops the run before anything changes.
for k in "${OAUTH[@]}" "${BACKUP[@]}" SIGNING_KEY_PEM_FILE RUNNER_PAT GITHUB_KUBE_SETUP_PAT KUBE_CONTEXT; do get "$k" >/dev/null; done
if [ "$ONLY" = check ]; then
  for k in "${OAUTH[@]}" "${BACKUP[@]}" SIGNING_KEY_PEM_FILE RUNNER_PAT GITHUB_KUBE_SETUP_PAT KUBE_CONTEXT; do
    if [ -n "$(get "$k")" ]; then echo "ok      $k"; else echo "missing $k"; fi
  done
  [ "$(get AWS_REGION)" = us-east-1 ] || echo "note    AWS_REGION is not us-east-1 (the bucket's region)"
  [ "$(get BACKUP_S3_PREFIX)" = cams-admin/prod/ ] || echo "note    BACKUP_S3_PREFIX is not cams-admin/prod/ (the IAM policy's prefix)"
  exit 0
fi

CONTEXT=$(get KUBE_CONTEXT)
apply_env_secret() { # NAMESPACE NAME KEY...
  local ns="$1" name="$2"; shift 2
  need "$@"
  [ -n "$CONTEXT" ] || die "set KUBE_CONTEXT in $ENV_FILE (there is no default context)"
  local names; names=$(printf '%s, ' "$@"); names=${names%, }
  say "apply secret $name in $ns (context $CONTEXT): $names"
  [ "$DRY" = 1 ] && return 0
  local tmp; tmp=$(mktemp)
  local k; for k in "$@"; do printf '%s=%s\n' "$k" "$(get "$k")" >> "$tmp"; done
  kubectl --context "$CONTEXT" -n "$ns" create secret generic "$name" --from-env-file="$tmp" --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f - >/dev/null
  rm -f "$tmp"
}

want oauth && apply_env_secret cams-admin cams-admin-oauth "${OAUTH[@]}"
want backup && apply_env_secret cams-admin cams-admin-backup "${BACKUP[@]}"
if want signing; then
  need SIGNING_KEY_PEM_FILE
  pem=$(get SIGNING_KEY_PEM_FILE)
  [ -f "$pem" ] || die "SIGNING_KEY_PEM_FILE does not name a file"
  pm=$(stat -c '%a' "$pem" 2>/dev/null || stat -f '%Lp' "$pem")
  case "$pm" in *00) ;; *) die "the signing key file is readable by others (chmod 600)" ;; esac
  [ -n "$CONTEXT" ] || die "set KUBE_CONTEXT in $ENV_FILE"
  say "apply secret cams-admin-signing in cams-admin (context $CONTEXT): signing-key.pem"
  if [ "$DRY" = 0 ]; then
    kubectl --context "$CONTEXT" -n cams-admin create secret generic cams-admin-signing --from-file=signing-key.pem="$pem" --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f - >/dev/null
  fi
fi
if want runner; then
  need RUNNER_PAT
  [ -n "$CONTEXT" ] || die "set KUBE_CONTEXT in $ENV_FILE"
  say "apply secret runner-pat in cams-admin-runner (context $CONTEXT): token"
  if [ "$DRY" = 0 ]; then
    tmp=$(mktemp); printf 'token=%s\n' "$(get RUNNER_PAT)" > "$tmp"
    kubectl --context "$CONTEXT" -n cams-admin-runner create secret generic runner-pat --from-env-file="$tmp" --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f - >/dev/null
    rm -f "$tmp"
  fi
fi
if want github; then
  need GITHUB_KUBE_SETUP_PAT
  say "set github secret KUBE_SETUP_DEPLOY_TOKEN on klaushofrichter/cams-admin"
  [ "$DRY" = 1 ] || printf '%s' "$(get GITHUB_KUBE_SETUP_PAT)" | gh secret set KUBE_SETUP_DEPLOY_TOKEN --repo klaushofrichter/cams-admin >/dev/null
fi
