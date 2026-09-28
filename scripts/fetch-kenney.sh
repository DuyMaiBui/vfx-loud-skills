#!/usr/bin/env bash
# Tải Kenney Particle Pack (CC0) về seed/vendor/kenney để seed.
# Idempotent: đã có PNG thì bỏ qua.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/seed/vendor/kenney"
PAGE_URL="https://kenney.nl/assets/particle-pack"

if compgen -G "$DEST/*.png" > /dev/null; then
  echo "đã có $(ls "$DEST"/*.png | wc -l) PNG ở $DEST — bỏ qua"
  exit 0
fi

mkdir -p "$DEST"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ZIP_URL="$(curl -fsSL "$PAGE_URL" -A 'Mozilla/5.0' | grep -oE 'https://[^"'\'' ]*\.zip' | head -1)"
if [[ -z "$ZIP_URL" ]]; then
  echo "không tìm được link zip trên $PAGE_URL" >&2
  exit 1
fi
echo "tải $ZIP_URL"

curl -fsSL -o "$WORK/pack.zip" "$ZIP_URL"
unzip -q "$WORK/pack.zip" -d "$WORK/pack"

SRC="$(find "$WORK/pack" -type d -name 'PNG (Transparent)' | head -1)"
if [[ -z "$SRC" ]]; then
  echo "không thấy thư mục 'PNG (Transparent)'" >&2
  exit 1
fi

cp "$SRC"/*.png "$DEST/"
cp "$(find "$WORK/pack" -maxdepth 2 -iname 'License.txt' | head -1)" "$DEST/License.txt"

echo "OK: $(ls "$DEST"/*.png | wc -l) PNG + License.txt → $DEST"
