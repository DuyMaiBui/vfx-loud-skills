#!/usr/bin/env bash
# Install a vfx:// resource, with its WHOLE closure, into a Unity project (thin wrapper over vfx-fetch-bundle.mjs).
#
#   scripts/vfx-fetch.sh vfx://recipe/<slug>/<version> [project_root]
#   scripts/vfx-fetch.sh --help
#
# Writes every file of the bundle (shaders, textures, materials, meshes, prefab...) under
# Assets/VFXCloud/<pack>/..., each as <file> + <file>.meta with the ORIGINAL .meta bytes, so GUIDs survive.
# Nothing is written before every blob is downloaded and sha256-verified; conflicts are refused by default.
# The last stdout line is a JSON summary {"uri","variant","written","unchanged","reused","skipped","requires_missing","complete"}.
#
# Environment (plan.md C7):
#   VFX_SERVER (default http://127.0.0.1:8787)   VFX_API_KEY (x-vfx-key)   VFX_PROJECT (default project root)
#   VFX_VARIANT=urp|original   VFX_ON_CONFLICT=refuse|skip|overwrite   VFX_ROOT=<dir> re-roots Assets/VFXCloud/<pack>
#   VFX_DRY_RUN=1   VFX_ALLOW_INCOMPLETE=1   VFX_STRICT_REQUIRES=1
#   VFX_FETCH_LEGACY=1  old per-resource path (one resource file + its dependencies, no .meta handling), kept for comparison
# Exit codes: 0 ok, 1 network/server/install error, 2 usage, 3 conflict refused, 4 sha256 mismatch,
#   5 bundle incomplete, 6 required package missing (VFX_STRICT_REQUIRES=1), 7 .meta guid changed after the move.
set -euo pipefail

# ---- previous per-resource implementation (VFX_FETCH_LEGACY=1) ------------------------------------------------
# Tải 1 vfx:// asset về Unity project. Ghi vào Assets/VFXCloud/<type>/<slug>/<file_name>, KHÔNG đụng .meta,
# sha256 khớp -> skip, khác -> cảnh báo + ghi đè nội dung. Tải cả `dependencies` trước (VFX_FETCH_DEPS=0 để tắt).
legacy_fetch() {
URI="${1:-}"
PROJECT="${2:-${VFX_PROJECT:-$PWD}}"
SERVER="${VFX_SERVER:-http://127.0.0.1:8787}"

REST="${URI#vfx://}"          # type/slug/version
IFS='/' read -r TYPE SLUG VERSION EXTRA <<< "$REST"
if [[ -z "$TYPE" || -z "$SLUG" || -z "$VERSION" || -n "${EXTRA:-}" ]]; then
  echo "sai định dạng uri: $URI (cần vfx://type/slug/version)" >&2
  exit 2
fi

MANIFEST=$(curl -fsS "$SERVER/v1/resource/$TYPE/$SLUG/$VERSION")
json() { node -e "const s=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=s.$1;process.stdout.write(v==null?'':String(v))"; }

# Dependencies first, so a file is never on disk before the files it references. VFX_FETCH_SEEN breaks cycles.
case " ${VFX_FETCH_SEEN:-} " in *" $URI "*) exit 0 ;; esac
export VFX_FETCH_SEEN="${VFX_FETCH_SEEN:-} $URI"
if [[ "${VFX_FETCH_DEPS:-1}" != "0" ]]; then
  while IFS= read -r DEP; do
    [[ -n "$DEP" ]] || continue
    "$0" "$DEP" "$PROJECT" || { echo "dependency $DEP của $URI không tải được" >&2; exit 1; }
  done < <(printf '%s' "$MANIFEST" | node -e "const s=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write((s.dependencies||[]).map((d)=>d+'\n').join(''))")
fi

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
}

URI="${1:-}"
case "$URI" in
  -h|--help) exec node "$(dirname "$0")/vfx-fetch-bundle.mjs" --help ;;
esac

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

if [[ "${VFX_FETCH_LEGACY:-0}" == "1" ]]; then
  legacy_fetch "$@"
  exit $?
fi

command -v node >/dev/null 2>&1 || { echo "vfx-fetch: node is required" >&2; exit 1; }
exec node "$(dirname "$0")/vfx-fetch-bundle.mjs" "$@"
