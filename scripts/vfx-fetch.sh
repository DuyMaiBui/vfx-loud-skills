#!/usr/bin/env bash
# Tải 1 vfx:// asset về Unity project.
#
#   scripts/vfx-fetch.sh vfx://texture/smoke-01/1 [project_root]
#
# Quy tắc:
#   - Ghi file vào Assets/VFXCloud/<type>/<slug>/<file_name>
#   - KHÔNG BAO GIỜ đụng vào file .meta -> GUID giữ nguyên
#   - Nếu file đã có mà sha256 khác -> cảnh báo, ghi đè NỘI DUNG (meta vẫn giữ)
#   - Nếu đã đúng sha256 -> skip
set -euo pipefail

URI="${1:-}"
PROJECT="${2:-${VFX_PROJECT:-$PWD}}"
SERVER="${VFX_SERVER:-http://127.0.0.1:8787}"

if [[ -z "$URI" ]]; then
  echo "usage: $0 vfx://<type>/<slug>/<version> [project_root]" >&2
  exit 2
fi

if [[ "$URI" != vfx://* ]]; then
  echo "uri phải bắt đầu bằng vfx:// (nhận: $URI)" >&2
  exit 2
fi

REST="${URI#vfx://}"          # type/slug/version
IFS='/' read -r TYPE SLUG VERSION EXTRA <<< "$REST"
if [[ -z "$TYPE" || -z "$SLUG" || -z "$VERSION" || -n "${EXTRA:-}" ]]; then
  echo "sai định dạng uri: $URI (cần vfx://type/slug/version)" >&2
  exit 2
fi

MANIFEST=$(curl -fsS "$SERVER/v1/resource/$TYPE/$SLUG/$VERSION")
json() { node -e "const s=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=s.$1;process.stdout.write(v==null?'':String(v))"; }

FILE_NAME=$(printf '%s' "$MANIFEST" | json file_name)
SHA256=$(printf '%s' "$MANIFEST" | json sha256)
BYTES=$(printf '%s' "$MANIFEST" | json bytes)
DOWNLOAD=$(printf '%s' "$MANIFEST" | json download_url)
LICENSE=$(printf '%s' "$MANIFEST" | json license)

if [[ -z "$FILE_NAME" || -z "$DOWNLOAD" ]]; then
  echo "manifest không đủ trường: $MANIFEST" >&2
  exit 1
fi

TARGET_DIR="$PROJECT/Assets/VFXCloud/$TYPE/$SLUG"
TARGET="$TARGET_DIR/$FILE_NAME"

mkdir -p "$TARGET_DIR"

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
curl -fsS -o "$TMP" "$DOWNLOAD"

ACTUAL=$(sha256sum "$TMP" | awk '{print $1}')
if [[ -n "$SHA256" && "$ACTUAL" != "$SHA256" ]]; then
  echo "sha256 KHÔNG khớp server ($ACTUAL != $SHA256)" >&2
  exit 1
fi

if [[ -f "$TARGET" ]]; then
  EXISTING=$(sha256sum "$TARGET" | awk '{print $1}')
  if [[ "$EXISTING" == "$ACTUAL" ]]; then
    echo "skip (đã đúng): $TARGET"
    exit 0
  fi
  echo "cảnh báo: $TARGET đã tồn tại với nội dung khác -> ghi đè nội dung, GIỮ .meta" >&2
fi

mv "$TMP" "$TARGET"
trap - EXIT

echo "wrote $TARGET  (${BYTES:-?} bytes, sha256=${ACTUAL:0:12}…, license=$LICENSE)"
if [[ -f "$TARGET.meta" ]]; then
  echo "meta giữ nguyên (GUID): $TARGET.meta"
else
  echo "meta mới sẽ do Unity sinh ra ở lần import kế (GUID là mới)"
fi
