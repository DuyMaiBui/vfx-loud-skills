#!/usr/bin/env bash
# Tải các flipbook / spritesheet CC0 từ OpenGameArt về seed/vendor/flipbooks.
# Idempotent: đã đủ file thì bỏ qua. Metadata grid nằm trong seed/manifest.json (meta.flipbook).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/seed/vendor/flipbooks"
OGA="https://opengameart.org/sites/default/files"

mkdir -p "$DEST"

need() { [[ -s "$DEST/$1" ]] || return 0; return 1; }

fetch() { # fetch <url> <out>
  if [[ -s "$DEST/$2" ]]; then echo "  = $2"; return 0; fi
  echo "  ↓ $2"
  curl -fsSL -A 'Mozilla/5.0' -o "$DEST/$2.part" "$1"
  mv "$DEST/$2.part" "$DEST/$2"
}

echo "OpenGameArt CC0 flipbooks → $DEST"

fetch "$OGA/explosion_atlas.png"            "explosion-atlas-3x3.png"
fetch "$OGA/smoke_sheet.png"                "smoke-sheet-5x5.png"
fetch "$OGA/Firework.png"                   "firework-6x5.png"

if [[ ! -s "$DEST/flame-5x5.png" || ! -s "$DEST/flame-strip-25.png" ]]; then
  echo "  ↓ firespritesheet.zip (flame)"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL -A 'Mozilla/5.0' -o "$TMP/f.zip" "$OGA/firespritesheet.zip"
  unzip -q "$TMP/f.zip" -d "$TMP"
  cp "$TMP/fireSheet5x5.png" "$DEST/flame-5x5.png"
  cp "$TMP/fireSheet.png"    "$DEST/flame-strip-25.png"
fi

cat > "$DEST/SOURCES.md" <<'EOF'
# Flipbook sources (tải bởi scripts/fetch-flipbooks.sh)

| File | Nguồn | Tác giả | License |
| --- | --- | --- | --- |
| `explosion-atlas-3x3.png` | opengameart.org/content/explosion-particles-sprite-atlas | TheJosh (derived from Kenney.nl) | CC0 |
| `smoke-sheet-5x5.png` | opengameart.org/content/smoke-sprite-sheet | ohyhei | CC0 |
| `firework-6x5.png` | opengameart.org/content/fireworks-effect-spritesheet | jellyfizh | CC0 |
| `flame-5x5.png` | opengameart.org/content/animated-flame-fire-sprite-sheet | highwizard | CC0 |
| `flame-strip-25.png` | cùng pack trên | highwizard | CC0 |

Credit "Kenney.nl" cho `explosion-atlas-3x3.png` là optional nhưng nên làm (CC0).
EOF

echo "OK: $(ls "$DEST"/*.png | wc -l) PNG → $DEST"
