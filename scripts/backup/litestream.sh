#!/usr/bin/env bash
# litestream.sh: prints the path of the pinned Litestream binary, downloading
# and checking it on first use (.cache/, gitignored). Spec §13.6.
set -euo pipefail
VERSION=0.5.17
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ASSET=darwin-arm64; SHA=e211f68ff7658d19f193f2914417afdf8f89a053ff8f263e5d6b3b1d3bbc7b08 ;;
  Darwin-x86_64) ASSET=darwin-x86_64; SHA=891875af09db152e93a4b31a8a79f538ce7ce702c132803cfe0a831e7cb1b7db ;;
  Linux-x86_64) ASSET=linux-x86_64; SHA=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d ;;
  Linux-aarch64) ASSET=linux-arm64; SHA=f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5 ;;
  *) echo "litestream.sh: no pinned build for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
DIR="$ROOT/.cache/litestream-$VERSION"
BIN="$DIR/litestream"
if [ ! -x "$BIN" ]; then
  mkdir -p "$DIR"
  TGZ="$DIR/litestream.tar.gz"
  curl -fsSL -o "$TGZ" "https://github.com/benbjohnson/litestream/releases/download/v$VERSION/litestream-$VERSION-$ASSET.tar.gz"
  GOT="$( (command -v sha256sum >/dev/null && sha256sum "$TGZ" || shasum -a 256 "$TGZ") | cut -d' ' -f1)"
  [ "$GOT" = "$SHA" ] || { echo "litestream.sh: checksum mismatch for $ASSET ($GOT)" >&2; rm -f "$TGZ"; exit 1; }
  tar -xzf "$TGZ" -C "$DIR" litestream
  rm -f "$TGZ"
fi
echo "$BIN"
