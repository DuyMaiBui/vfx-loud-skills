#!/usr/bin/env bash
# Smoke test cho 4 gate của VFX Skill Cloud V0.
#   G1  claude mcp add --transport http  -> Connected
#   G2  vfx_search("cartoon ground impact") -> Knowledge Card + vfx:// URI
#   G3  vfx_fetch -> file trong Assets/VFXCloud/ , GUID giữ nguyên
#   G4  vfx_publish -> search thấy NGAY
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="${VFX_SERVER:-http://127.0.0.1:8787}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
step() { echo; echo "== $1"; }

BLOB_ONLY=0
[[ "${1:-}" == "--blob-only" ]] && BLOB_ONLY=1

cd "$ROOT"

step "0. server health"
if curl -fsS "$SERVER/healthz" >/dev/null; then
  ok "healthz $(curl -fsS "$SERVER/healthz")"
else
  bad "server không sống ở $SERVER — chạy ./scripts/dev-db.sh rồi AUTH_DISABLED=1 npm start"
  echo; echo "RESULT: PASS=$PASS FAIL=$FAIL"; exit 1
fi

step "B. vfx-bytes/1 blob + bundle routes (needs VFX_API_KEY when the server has one)"
KEY_H=(-H "x-vfx-key: ${VFX_API_KEY:-}")
BODY="smoke blob $(date +%s%N)"
BSHA="$(printf '%s' "$BODY" | sha256sum | awk '{print $1}')"
BGUID="${BSHA:0:32}"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
[[ "$(code -X PUT "${KEY_H[@]}" -H 'content-type: application/octet-stream' -H 'x-vfx-kind: material' --data-binary "$BODY" "$SERVER/v1/blob/$BSHA")" == "201" ]] \
  && ok "PUT /v1/blob/:sha -> 201" || bad "PUT /v1/blob/:sha"
[[ "$(curl -s "${KEY_H[@]}" -H 'content-type: application/json' -d "{\"sha256\":[\"$BSHA\"]}" "$SERVER/v1/blob/missing")" == '{"missing":[]}' ]] \
  && ok "POST /v1/blob/missing -> []" || bad "POST /v1/blob/missing"
[[ "$(code "${KEY_H[@]}" "$SERVER/v1/blob/$BSHA")" == "404" ]] \
  && ok "GET orphan blob -> 404" || bad "GET orphan blob not 404"
REG="$(curl -s "${KEY_H[@]}" -H 'content-type: application/json' -d "{\"files\":[{\"guid\":\"$BGUID\",\"variant\":\"original\",\"kind\":\"material\",\"path\":\"Assets/Smoke/probe.mat\",\"asset_sha256\":\"$BSHA\",\"meta_sha256\":null,\"pack\":\"smoke-probe\",\"license\":\"studio-internal\",\"visibility\":\"studio-only\",\"source\":{\"game\":null,\"origin\":\"smoke\"}}]}" "$SERVER/v1/asset-file/batch")"
grep -q '"status":"created"' <<<"$REG" && ok "POST /v1/asset-file/batch -> created" || bad "POST /v1/asset-file/batch: $REG"
[[ "$(curl -s "${KEY_H[@]}" "$SERVER/v1/blob/$BSHA")" == "$BODY" ]] \
  && ok "GET /v1/blob/:sha -> same bytes" || bad "GET /v1/blob/:sha bytes differ"
NOKEY="$(code "$SERVER/v1/blob/$BSHA")"
[[ "$NOKEY" == "401" || "$NOKEY" == "403" ]] && ok "GET blob without key -> $NOKEY" || bad "GET blob without key -> $NOKEY (must never be 200)"
[[ "$(code "${KEY_H[@]}" "$SERVER/v1/closure/recipe/probe-none/1")" == "404" ]] \
  && ok "GET /v1/closure unknown -> 404" || bad "GET /v1/closure unknown not 404"
PUBURI="$(curl -s "${KEY_H[@]}" -H 'content-type: application/json' -d "{\"type\":\"texture\",\"slug\":\"probe-blob-smoke\",\"name\":\"probe blob smoke\",\"license\":\"cc0\",\"b64\":\"$(printf 'png' | base64)\",\"fileName\":\"probe-blob-smoke.png\"}" "$SERVER/v1/publish" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).uri||'')}catch{}})")"
if [[ -n "$PUBURI" ]]; then
  CL="$(curl -s "${KEY_H[@]}" "$SERVER/v1/closure/${PUBURI#vfx://}")"
  grep -q '"schema":"vfx-bundle/1"' <<<"$CL" && grep -q '"file_count":1' <<<"$CL" && ok "GET /v1/closure -> vfx-bundle/1 with the root file" || bad "GET /v1/closure: ${CL:0:200}"
else
  bad "POST /v1/publish (probe texture) failed"
fi

if [[ $BLOB_ONLY -eq 1 ]]; then
  echo; echo "RESULT: PASS=$PASS FAIL=$FAIL"
  [[ $FAIL -eq 0 ]]; exit $?
fi

step "G1. claude mcp add --transport http"
claude mcp remove vfx-skill >/dev/null 2>&1 || true
if claude mcp add --transport http vfx-skill "$SERVER/mcp" >/dev/null 2>&1; then
  INFO="$(claude mcp get vfx-skill 2>&1)"
  if grep -q 'Status: ✔ Connected' <<<"$INFO"; then
    ok "vfx-skill Connected"
  else
    bad "added nhưng chưa Connected: $INFO"
  fi
else
  bad "claude mcp add thất bại"
fi

step "G2/G4/G5. MCP tools qua client thật (scripts/mcp-probe.mjs)"
PROBE_OUT="$(node scripts/mcp-probe.mjs 2>&1)"
PROBE_RC=$?
if [[ $PROBE_RC -ne 0 ]]; then
  bad "probe exit $PROBE_RC"
  echo "$PROBE_OUT" | tail -20
else
  grep -q 'vfx_search, vfx_facets, vfx_related, vfx_resolve, vfx_fetch, vfx_publish, vfx_recolor, vfx_review, vfx_review_result$' <<<"$PROBE_OUT" \
    && ok "tools/list: 9 tool" || bad "tools/list sai: $(head -1 <<<"$PROBE_OUT")"

  grep -q '"uri": "vfx://' <<<"$PROBE_OUT" \
    && ok "G2 search trả Knowledge Card + vfx:// URI" || bad "G2 không có vfx:// URI"

  grep -q '"download_url"' <<<"$PROBE_OUT" \
    && ok "G3 fetch trả download_url + sha256" || bad "G3 fetch thiếu download_url"

  grep -q 'G4 re-search hit == PASS' <<<"$PROBE_OUT" \
    && ok "G4 publish -> search thấy ngay" || bad "G4 không thấy resource vừa publish"

  grep -q '== G5 recolor == PASS' <<<"$PROBE_OUT" \
    && ok "G5 vfx_recolor đổi màu recipe recolorable" || bad "G5 vfx_recolor: $(grep 'G5 recolor' <<<"$PROBE_OUT")"

  grep -q '== G6 review == PASS' <<<"$PROBE_OUT" \
    && ok "G6 vfx_review -> chọn -> vfx_review_result" || bad "G6 review: $(grep 'G6 review' <<<"$PROBE_OUT")"
  REVIEW_SESSION="$(grep -o 'G6 review == [A-Z]* session=[0-9a-f-]*' <<<"$PROBE_OUT" | sed 's/.*session=//')"
fi

step "G3. fetch về Unity project + GUID giữ nguyên"
PROJECT="$WORK/proj"
mkdir -p "$PROJECT/Assets"
URI="vfx://texture/smoke-01/1"

if ! ./scripts/vfx-fetch.sh "$URI" "$PROJECT" >/dev/null 2>&1; then
  bad "lần fetch 1 thất bại"
else
  FILE="$PROJECT/Assets/VFXCloud/texture/smoke-01/smoke-01.png"
  if [[ ! -f "$FILE" ]]; then
    bad "file không nằm ở Assets/VFXCloud/texture/smoke-01/smoke-01.png"
  else
    ok "file về đúng Assets/VFXCloud/..."

    META="$FILE.meta"
    FIXED_GUID="1a2b3c4d5e6f7081920a3b4c5d6e7f80"
    printf 'fileFormatVersion: 2\nguid: %s\nTextureImporter:\n  internalIDToNameTable: []\n' "$FIXED_GUID" > "$META"

    printf 'corrupted-by-smoke-test' > "$FILE"

    if ./scripts/vfx-fetch.sh "$URI" "$PROJECT" >/dev/null 2>&1; then
      NOW_GUID="$(awk '/^guid:/{print $2}' "$META")"
      if [[ "$NOW_GUID" == "$FIXED_GUID" ]]; then
        ok "GUID giữ nguyên sau khi ghi đè nội dung ($NOW_GUID)"
      else
        bad "GUID đổi: mong đợi $FIXED_GUID, nhận $NOW_GUID"
      fi

      EXPECTED_SHA="$(curl -fsS "$SERVER/v1/resource/texture/smoke-01/1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).sha256))")"
      ACTUAL_SHA="$(sha256sum "$FILE" | awk '{print $1}')"
      [[ "$EXPECTED_SHA" == "$ACTUAL_SHA" ]] \
        && ok "nội dung khớp server sha256" || bad "nội dung lệch sha256"
    else
      bad "lần fetch 2 thất bại"
    fi
  fi
fi

step "ingest gate"
REJECTED="$(node -e "
import('./server/src/store.ts').then(async (s) => {
  try {
    await s.publish({ type: 'recipe', slug: 'smoke-unknown-license', name: 'x', license: 'unknown', b64: Buffer.from('x').toString('base64') });
    console.log('ACCEPTED');
  } catch (e) { console.log('REJECTED'); }
  process.exit(0);
});
" 2>/dev/null)"
[[ "$REJECTED" == "REJECTED" ]] && ok "license=unknown bị từ chối" || bad "license=unknown bị chấp nhận ($REJECTED)"

step "cleanup canary"
podman exec vfx-pg psql -U vfx -d vfxcloud -tAc "DELETE FROM resource WHERE slug LIKE 'probe-%' OR slug = 'smoke-unknown-license'" >/dev/null 2>&1 \
  && ok "đã dọn probe rows" || echo "  (bỏ qua: không gọi được psql)"
podman exec vfx-pg psql -U vfx -d vfxcloud -tAc "DELETE FROM asset_file WHERE pack = 'smoke-probe'" >/dev/null 2>&1 || true
if [[ -n "${REVIEW_SESSION:-}" ]]; then
  podman exec vfx-pg psql -U vfx -d vfxcloud -tAc "DELETE FROM review_session WHERE id = '$REVIEW_SESSION'" >/dev/null 2>&1 \
    && ok "đã dọn review session" || echo "  (bỏ qua: không xoá được review session $REVIEW_SESSION)"
fi

echo
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]]
