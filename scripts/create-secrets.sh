#!/usr/bin/env bash
# Creates cams-admin's Kubernetes Secrets (and the deploy token on GitHub)
# from the repo's local .env, following cam-proxy's sync-secrets.sh: key
# names are printed, values never; values never go on a command line.
# Run by Klaus or with his OK, after kube-setup created the namespaces
# (docs/kube-setup-request.md). Never from tests or CI.
#
#   scripts/create-secrets.sh [--only check|oauth|signing|viewer-key|backup|runner|github|all]
#                             [--dry-run] [--env-file PATH] [--rotate-viewer-key]
#
#   check (default): every key present and well-formed; nothing is applied.
#   oauth:   Secret cams-admin-oauth: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
#            GOOGLE_REDIRECT_URI (default: the production callback), ALLOWED_EMAILS
#   signing: Secret cams-admin-signing: signing-key.pem from the file named
#            by SIGNING_KEY_PEM_FILE (made by scripts/gen-signing-key.ts;
#            mode 600). Replacing it means re-enrolling every proxy.
#   viewer-key: Secret cams-admin-viewer-token-key: key = 32 random bytes as
#            base64 from the file named by VIEWER_TOKEN_KEY_FILE_LOCAL (mode
#            600). A missing file is made first (openssl rand -base64 32, mode
#            600) and its path printed: keep that copy, the key is never
#            printed. An existing Secret is kept: replacing it makes every
#            viewer token uncopyable, so only --rotate-viewer-key does that.
#   backup:  Secret cams-admin-backup: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
#            AWS_REGION, BACKUP_S3_BUCKET, BACKUP_S3_PREFIX (app + Litestream)
#   runner:  Secret runner-pat (key token) in cams-admin-runner: CAMSADMIN_GITHUB_PAT
#   github:  repo secret KUBE_SETUP_DEPLOY_TOKEN from GITHUB_KUBE_SETUP_PAT
# KUBE_CONTEXT (required for the Secrets) comes from the env file too.
set -euo pipefail
umask 077

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
DRY=0
ROTATE_VIEWER_KEY=0
ONLY=check
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --rotate-viewer-key) ROTATE_VIEWER_KEY=1 ;;
    --only) ONLY="$2"; shift ;;
    --env-file) ENV_FILE="$2"; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "create-secrets: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case "$ONLY" in check|oauth|signing|viewer-key|backup|runner|github|all) ;; *) echo "create-secrets: bad --only $ONLY" >&2; exit 2 ;; esac
die() { echo "create-secrets: $*" >&2; exit 1; }

# Temp files hold secret values. They live in one private directory (mode 700)
# that the EXIT trap removes, on Ctrl-C, SIGTERM and SIGHUP too.
# The signal traps only note the signal; the script exits at its next
# checkpoint (stop_if_signalled), a plain exit that runs the EXIT trap. Calling
# exit inside a signal trap is unreliable: when the signal lands while bash
# reads a $(…) (every value is read that way), bash can drop the EXIT trap
# half way and even carry on with the script, so the secret file stayed
# behind (issue #114).
SECRET_DIR=
SIG=
cleanup() { if [ -n "$SECRET_DIR" ]; then rm -rf -- "$SECRET_DIR"; fi; return 0; }
trap cleanup EXIT
trap 'SIG=130' INT
trap 'SIG=143' TERM
trap 'SIG=129' HUP
stop_if_signalled() { if [ -n "$SIG" ]; then exit "$SIG"; fi; }
# Sets NEWTMP to a new empty file in SECRET_DIR (not via $(…): a subshell would
# lose SECRET_DIR).
NTMP=0
newtmp() {
  [ -n "$SECRET_DIR" ] || SECRET_DIR=$(mktemp -d "${TMPDIR:-/tmp}/cams-admin-secret.XXXXXX")
  NTMP=$((NTMP + 1)); NEWTMP="$SECRET_DIR/$NTMP"; : > "$NEWTMP"
  stop_if_signalled
}

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
need() { local k; for k in "$@"; do [ -n "$(get "$k")" ] || die "missing $k in $ENV_FILE"; stop_if_signalled; done; }
say() { stop_if_signalled; if [ "$DRY" = 1 ]; then echo "would $*"; else echo "$*"; fi; }
want() { [ "$ONLY" = "$1" ] || [ "$ONLY" = all ]; }

OAUTH=(GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET ALLOWED_EMAILS)
DEFAULT_REDIRECT=https://cams-admin.skylar.technology/auth/callback
BACKUP=(AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION BACKUP_S3_BUCKET BACKUP_S3_PREFIX)

# Check first, so a bad line stops the run before anything changes.
for k in "${OAUTH[@]}" GOOGLE_REDIRECT_URI "${BACKUP[@]}" SIGNING_KEY_PEM_FILE VIEWER_TOKEN_KEY_FILE_LOCAL CAMSADMIN_GITHUB_PAT GITHUB_KUBE_SETUP_PAT KUBE_CONTEXT; do get "$k" >/dev/null; stop_if_signalled; done
if [ "$ONLY" = check ]; then
  for k in "${OAUTH[@]}" "${BACKUP[@]}" SIGNING_KEY_PEM_FILE VIEWER_TOKEN_KEY_FILE_LOCAL CAMSADMIN_GITHUB_PAT GITHUB_KUBE_SETUP_PAT KUBE_CONTEXT; do
    if [ -n "$(get "$k")" ]; then echo "ok      $k"; else echo "missing $k"; fi
  done
  [ -n "$(get GOOGLE_REDIRECT_URI)" ] || echo "default GOOGLE_REDIRECT_URI ($DEFAULT_REDIRECT)"
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
  [ "$name" = cams-admin-oauth ] && names="$names, GOOGLE_REDIRECT_URI"
  say "apply secret $name in $ns (context $CONTEXT): $names"
  [ "$DRY" = 1 ] && return 0
  local tmp; newtmp; tmp="$NEWTMP"
  local k; for k in "$@"; do printf '%s=%s\n' "$k" "$(get "$k")" >> "$tmp"; done
  if [ "$name" = cams-admin-oauth ]; then
    local ru; ru=$(get GOOGLE_REDIRECT_URI); printf 'GOOGLE_REDIRECT_URI=%s\n' "${ru:-$DEFAULT_REDIRECT}" >> "$tmp"
  fi
  stop_if_signalled
  kubectl --context "$CONTEXT" -n "$ns" create secret generic "$name" --from-env-file="$tmp" --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f - >/dev/null
  rm -f "$tmp"
  stop_if_signalled
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
viewer_key_kept=0
if want viewer-key && [ "$ROTATE_VIEWER_KEY" = 0 ]; then
  [ -n "$CONTEXT" ] || die "set KUBE_CONTEXT in $ENV_FILE"
  if kubectl --context "$CONTEXT" -n cams-admin get secret cams-admin-viewer-token-key >/dev/null 2>&1; then
    say "secret cams-admin-viewer-token-key already exists: kept. Replacing it makes every viewer token uncopyable; only --rotate-viewer-key does that."
    viewer_key_kept=1
  fi
fi
if want viewer-key && [ "$viewer_key_kept" = 0 ]; then
  need VIEWER_TOKEN_KEY_FILE_LOCAL
  vk=$(get VIEWER_TOKEN_KEY_FILE_LOCAL)
  [ -n "$CONTEXT" ] || die "set KUBE_CONTEXT in $ENV_FILE"
  if [ ! -e "$vk" ]; then
    say "create $vk: 32 random bytes as base64, mode 600 (keep this copy; the key is not printed)"
    if [ "$DRY" = 0 ]; then
      [ -d "$(dirname -- "$vk")" ] || die "the folder of VIEWER_TOKEN_KEY_FILE_LOCAL does not exist"
      (umask 077; openssl rand -base64 32 > "$vk") || die "openssl rand failed"
      chmod 600 "$vk"
    fi
  fi
  if [ "$DRY" = 0 ] || [ -e "$vk" ]; then
    [ -f "$vk" ] || die "VIEWER_TOKEN_KEY_FILE_LOCAL does not name a file"
    vm=$(stat -c '%a' "$vk" 2>/dev/null || stat -f '%Lp' "$vk")
    case "$vm" in *00) ;; *) die "the viewer token key file is readable by others (chmod 600)" ;; esac
    # 32 bytes once decoded; checked without printing it.
    [ "$(tr -d ' \r\n' < "$vk" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d ' ')" = 32 ] || die "the viewer token key file must hold 32 bytes as base64 (openssl rand -base64 32)"
  fi
  stop_if_signalled
  say "apply secret cams-admin-viewer-token-key in cams-admin (context $CONTEXT): key"
  if [ "$DRY" = 0 ]; then
    kubectl --context "$CONTEXT" -n cams-admin create secret generic cams-admin-viewer-token-key --from-file=key="$vk" --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f - >/dev/null
  fi
fi
if want runner; then
  need CAMSADMIN_GITHUB_PAT
  [ -n "$CONTEXT" ] || die "set KUBE_CONTEXT in $ENV_FILE"
  say "apply secret runner-pat in cams-admin-runner (context $CONTEXT): token"
  if [ "$DRY" = 0 ]; then
    newtmp; tmp="$NEWTMP"; printf 'token=%s\n' "$(get CAMSADMIN_GITHUB_PAT)" > "$tmp"
    stop_if_signalled
    kubectl --context "$CONTEXT" -n cams-admin-runner create secret generic runner-pat --from-env-file="$tmp" --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f - >/dev/null
    rm -f "$tmp"
    stop_if_signalled
  fi
fi
if want github; then
  need GITHUB_KUBE_SETUP_PAT
  say "set github secret KUBE_SETUP_DEPLOY_TOKEN on klaushofrichter/cams-admin"
  [ "$DRY" = 1 ] || printf '%s' "$(get GITHUB_KUBE_SETUP_PAT)" | gh secret set KUBE_SETUP_DEPLOY_TOKEN --repo klaushofrichter/cams-admin >/dev/null
fi
stop_if_signalled
