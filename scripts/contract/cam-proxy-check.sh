#!/usr/bin/env bash
# cam-proxy-check.sh [REF]: a shallow clone of cam-proxy (default main) and
# the contract cross-check against it: the heartbeat (cam-proxy's real
# buildHealth) and the P2 commands (its real command check and JCS).
# A network failure fails (no skip).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
REF="${1:-main}"
DIR="$(mktemp -d "${TMPDIR:-/tmp}/cams-admin-contract.XXXXXX")"
trap 'rm -rf "$DIR"' EXIT
git clone -q --depth 1 --branch "$REF" https://github.com/klaushofrichter/cam-proxy.git "$DIR/cam-proxy"
echo "cam-proxy $REF at $(git -C "$DIR/cam-proxy" rev-parse --short HEAD)"
cd "$ROOT" && npx tsx scripts/contract/cam-proxy-heartbeat.ts "$DIR/cam-proxy"
# The clone has no node_modules: cam-proxy's modules resolve shared packages from here.
NODE_PATH="$ROOT/node_modules" npx tsx scripts/contract/cam-proxy-commands.ts "$DIR/cam-proxy"
