# VFX Skill Cloud V0

Một **Skill Cloud** cho VFX: retrieve knowledge (Knowledge Card + `vfx://` URI) thay vì
copy nguyên khối asset. Agent search → resolve → fetch → **text-edit** → validate trong
Unity → publish ngược lại nếu đáng reuse.

Vertical slice "deploy now": MCP server HTTP + Postgres/pgvector + Unity Editor client.

## Cổng kiểm soát (4 gate)

| Gate | Yêu cầu | Trạng thái |
| --- | --- | --- |
| G1 | `claude mcp add --transport http` kết nối được | ✅ |
| G2 | `vfx_search("cartoon ground impact")` trả card + `vfx://` URI | ✅ |
| G3 | `vfx_fetch` → file vào `Assets/VFXCloud/`, GUID không đổi | ✅ (filesystem) / ⏳ Editor tay |
| G4 | `vfx_publish` → search ra lại ngay | ✅ |

`./scripts/smoke.sh` → **PASS=11 FAIL=0**.

**Chưa verify được headless:** Unity 6000.3.15f1 `-batchmode` chết với
"No valid Unity Editor license" (thiếu entitlement `com.unity.editor.headless`).
Nên phần "hiện đúng trong Editor" + 3 request thật phải làm tay trong Editor.

## Status (đo 2026-10-29)

Số liệu từ DB sống (chỉ `SELECT`) và `data/reports/*.json`. Mỗi dòng có khoá trong backtick; `scripts/accept/phase-13.sh` đối chiếu từng khoá với nguồn, lệch là FAIL.

| Khoá | Giá trị | Nguồn |
|---|---|---|
| `resources` | 3472 | DB `resource` (khớp `/healthz`) |
| `recipes` | 3316 | DB `resource` type=recipe: 3248 có sẵn + 68 game (`studio-internal`, `studio-only`) |
| `game_recipes_removed` | 48 | `seed/extract/unfixable-scripts.json` (5 `unfixable-script` + 43 chỉ có UIParticle; 116 trích được − 48 = 68) |
| `resource_edges` | 18738 | DB `resource_edge` |
| `asset_files_original` | 5466 | `data/reports/upload-original.json` `.files` |
| `asset_files_urp` | 655 | DB `asset_file` variant=urp (637 `Particles/Unlit` + 18 `URP/Lit`) |
| `asset_blobs` | 11563 | DB `asset_blob` (10908 của `original` + 655 của `urp`) |
| `original_bytes` | 1576075529 | `data/reports/upload-original.json` `.bytes` (trước nén) |
| `blob_stored_bytes` | 365817839 | DB `sum(stored_bytes)` (sau gzip của kind văn bản) |
| `closure_urp_checked` | 3305 | `data/reports/closure-verify-urp.json` `.checked` |
| `closure_urp_complete` | 3293 | `data/reports/closure-verify-urp.json` `.complete` |
| `closure_urp_incomplete` | 12 | `.incomplete`: 10 `bytes_not_uploaded` + 2 `unresolved`, cả 12 đều là namufx (pack chỉ có tham số) |
| `closure_urp_dangling` | 305 | `.dangling`: recipe có ít nhất một GUID dangling (24 GUID khác nhau) |
| `previews_rendered` | 1768 | DB `preview_render` |
| `previews_ok` | 1753 | DB `preview_render` state=ok |
| `previews_failed` | 15 | DB `preview_render` state=failed; cả 15 là `unfixable-source`, đúng bằng 15 mục của `tools/preview/waivers.json` |
| `fixable_failures` | 0 | `scripts/accept/phase-11.sh` FIXABLE=0 |
| `preview_gifs` | 1753 | DB `preview_gif` (`previews:consistency`: consistent) |
| `magenta_allow` | 4 | `tools/preview/magenta-allow.txt` (dòng không phải comment) |

Chưa đo lại, nên không có trong bảng:

- `data/reports/closure-verify.json` (`variant=original`: 3353 checked, 3341 complete) là báo cáo **trước** khi gỡ 48 recipe. Chạy lại `node seed/verify-closure.ts --all --variant original` để có số mới.
- `data/accept/logs/` của phase 12 (clean project) không có bảng pass/fail; `control.exit=1` và `build-recipe.exit=0` là hai tín hiệu duy nhất còn lại. Chạy lại cần Unity Editor.
- `data/reports/phase-9.out` (2026-10-28) ghi một FAIL `pinned_baseline_corpus_clone`; chưa chạy lại sau các thay đổi sau đó.

## Chạy

```bash
./scripts/dev-db.sh up          # container Postgres + pgvector  (podman)
./scripts/server.sh restart     # server + migrate, log /tmp/opencode/vfx-server.log
npm run seed                    # seed corpus (idempotent)

./scripts/fetch-kenney.sh       # (tuỳ chọn) tải lại Kenney từ kenney.nl nếu bị xoá
./scripts/fetch-flipbooks.sh    # (tuỳ chọn) tải lại 5 spritesheet CC0 từ OpenGameArt
npm run seed                    # ingest — Kenney + flipbook đã vendored ở seed/vendor/

./scripts/smoke.sh              # chạy đủ 4 gate
```

Skills + MCP cho Unity project đã được bật sẵn:

- `Unity/.mcp.json` → server `vfx-skill` (⚠️ lần đầu mở `claude` phải approve)
- `Unity/.claude/skills/vfx-*` → symlink về repo này

## Tool (MCP)

| Tool | Làm gì |
| --- | --- |
| `vfx_search` | Semantic + keyword search → Knowledge Card + `vfx://` URI |
| `vfx_facets` | Đếm record theo từng facet cho `query` + `filters` → biết nên hỏi user câu gì tiếp |
| `vfx_resolve` | URI → version, `file_name`, `download_url`, `sha256`, `dependencies` |
| `vfx_review` / `vfx_review_result` | Mở trang review cho ứng viên / bộ (trả `url` + `session`) và đọc lựa chọn của user |
| `vfx_fetch` | Metadata + `closure` (legacy, không đổi) + `bundle` (`vfx-bundle/1`: mọi file Unity cần để render, kèm `.meta` gốc để GUID giữ nguyên). Input `variant`: `urp` (mặc định) \| `original`. MCP chỉ trả URL + metadata, không bao giờ bytes. `scripts/vfx-fetch.sh <uri> <unity project root>` tải và verify sha256 toàn bộ bundle rồi mới ghi file. Chi tiết: § Bytes and bundle API |
| `vfx_publish` | Payload mới → version mới + `linkDependencies` (cập nhật graph, không overwrite). Effect đã chỉnh từ record có sẵn: `derived_from`, `modifications`, `unity`, `visibility` (xem **Publish-back**) |

## Knowledge graph

`npm run graph:build` (idempotent, chỉ ghi phần chênh lệch; luật + ngưỡng ở `seed/graph/rules.json`, `seed/graph/knowledge-links.json`) dựng:

| rel | ý nghĩa |
| --- | --- |
| `variant_of` | cùng effect khác màu/version: cùng pack + folder + tên đã bỏ từ màu/version, **và** cùng số node + cùng node path/module. `meta.family` trên mọi thành viên, edge tới thành viên canonical (slug nhỏ nhất) |
| `pairs_with` | cùng bộ muzzle + projectile + impact (pack Archanor), theo stem tên + màu. `meta.pairRole`, `meta.pairSet` |
| `uses` (recipe → asset) | bảng `asset` + `resource_asset`: material/texture/shader/mesh theo GUID, metadata. Bytes của các file đó nằm ở `asset_file` + `asset_blob` (§ Bytes and bundle API). Tách bảng riêng, không phải `resource`, để không lọt vào search/facets/healthz |
| `similar_to` | dùng chung material/texture, Jaccard, top-10 mỗi recipe (`weight`) |
| `applies_to` | technique/component/shader/code → recipe áp dụng, theo mapping facet trong JSON |

`/v1/search`: mỗi họ biến thể một card (`variants`, `collapseVariants:false` để tắt), `pairsWith`; graph expansion boost hàng xóm của top hit, `SEARCH_W_GRAPH` (mặc định 0.3, 0 = tắt). `GET|POST /v1/related` + MCP `vfx_related`. `vfx_resolve` trả thêm `assets`. `npm run corpus:sha` = fingerprint payload của mọi record (không đổi qua graph:build).

### Review (xem bằng mắt + chọn)

`GET /review?uris=<vfx://…,vfx://…>` hoặc `?q=…&type=recipe&filters=<json>&set=muzzle,projectile,impact` (`per=`, `limit=`): trang HTML tĩnh, lưới card (video lặp/poster lazy-load, tên, pack, style, behavior, playback/duration/scale/cost, chip màu, badge "có thể đổi màu", link cùng bộ), nền sáng/tối, nút "Chọn" + "Gửi lựa chọn". Có `set` thì chia cột theo role và effect `pairs_with` nằm cùng hàng; mỗi role chọn một. Mỗi lần mở tạo một **session** (URL sau đó là `/review?session=<id>`).

- `POST /v1/review` `{uris | q, type?, filters?, set?, per?, limit?}` → `{session, url, count}` (URI phải tồn tại, không thì 404).
- `POST /v1/review/selection` `{session, uris[], roles?: {uri: role}}` — thay toàn bộ lựa chọn của session (uri phải thuộc session). Trang dùng bản không cần key: `POST /review/selection` (session id là capability).
- `GET /v1/review/selection?session=` → `{session, query, uris, selection: [{uri, role, chosen_at}]}`.
- MCP: `vfx_review` (cùng input POST /v1/review) và `vfx_review_result {session}`. Bảng `review_session`, `review_selection` (migration 008).
- Khi `AUTH` bật, mở `/review?q=|uris=` cần header key (trình duyệt không gửi được): tạo session bằng `POST /v1/review` rồi mở `url`.

**Preview** (`data/previews/`, gitignored, do lane Unity điền): `GET /previews/<slug>.webm|.webp` (MIME đúng, `Range` → 206 để seek, `ETag`/`Cache-Control`, chỉ nhận tên phẳng `<slug>.webm|webp` nên không path traversal). Trang review đọc `data/previews/index.json` = `{"version":1,"items":{"<slug>":{"webm","poster","bytes","fps","frames","size":256,"renderedAt"}}}` (slug = đoạn giữa của `vfx://recipe/<slug>/<version>`), tự nạp lại khi file đổi (mtime), không cần restart. Biến thể không có entry riêng dùng bản canonical (slug thấp nhất) của họ; không có gì thì card ghi "chưa có preview" — toàn bộ luồng chạy được khi thư mục trống.

### Preview GIF trong DB

Webm/poster ở lại trên đĩa; **GIF nằm trong Postgres** (bảng `preview_gif`, migration 009) nên một bộ effect xem được từ DB, bằng `<img>` thường, không cần video element hay file rời.

| Cột | Nghĩa |
| --- | --- |
| `slug` (PK) | đoạn giữa của `vfx://recipe/<slug>/<version>`; một dòng mỗi slug (bản encode mới nhất) |
| `gif` | bytes GIF (`bytea`, loop vô hạn) |
| `width`, `height`, `frames`, `fps`, `bytes` | đọc lại từ chính file GIF; `bytes = octet_length(gif)` có CHECK |
| `sha256` | hash nội dung GIF = ETag |
| `source_sha256`, `builder` | hash webm nguồn + thế hệ encoder: khoá idempotent |
| `encoder` | nấc ladder thắng, vd `192px@12fps/96c` |
| `created_at`, `updated_at` | lần nạp đầu / lần thay bytes gần nhất |

**Encode** (ffmpeg `palettegen`/`paletteuse`, `-loop 0`) từ `data/previews/<slug>.webm`. **Ngân sách: tối đa 130 KB mỗi GIF, rộng ≤ 192 px** (nguồn 256 px; một trang review bộ có 24–48 GIF). Ladder bước xuống chỉ khi vượt trần: `192px/12fps/96c` → `160/12/64` → `144/10/48` → `128/10/32`; nếu cả nấc cuối vẫn vượt thì lưu bản nhỏ nhất và báo `OVER BUDGET`. Đo trên 14 preview thật (nguồn 256 px, 24 fps, 48 frame): nấc 1 cho **min 1.9 KB, median 13.5 KB, max 127.1 KB, tổng 14 file 404 KB** (`confetti-falling`); cùng ca xấu nhất ở nấc cuối 43.1 KB.

**Nạp vào DB** (idempotent theo hash nội dung: webm không đổi + cùng `builder` thì không ghi gì):

```bash
npm run previews:gif                       # mọi slug trong data/previews/index.json
npm run previews:gif -- --only a,b         # một phần
npm run previews:gif -- --force            # encode lại dù hash khớp
npm run previews:gif -- --json             # tóm tắt một dòng JSON
```

Render đi vào DB thế nào: lane Unity ghi `data/previews/*.webm` + `index.json` → `BatchEntry.Run` (`-executeMethod VfxPreview.BatchEntry.Run`) chạy `node seed/preview-gif-ingest.ts --json` ở bước cuối (bỏ bằng `-skipGifIngest`; lỗi chỉ log, không đổi exit code của render). Render bằng Editor đang mở (`tools/preview/run.json`) không qua `BatchEntry`: chạy `npm run previews:gif` sau khi `_status.json` có `state: done`. Đổi cách encode (ladder/filter) thì tăng `GIF_BUILDER` trong `server/src/preview-gif-encode.ts`.

**Màu magenta = shader thiếu** (`Hidden/InternalErrorShader`): URP không vẽ được shader built-in/custom của pack (Retro Arsenal, Epic Toon FX powerbox) nên Unity tô hồng (255,0,255) phẳng. Ba lớp chặn, cùng một định nghĩa ở `server/src/magenta.ts` (TS) và `MagentaMath.cs` (C#, cùng bảng vector test):

1. **Convert** (`MaterialMapping.cs` thuần + `MaterialConverter.cs`): shader có rule riêng (`Archanor VFX/Retro Arsenal/*`, `ETFX_PowerboxUnlit`) hoặc legacy/Standard particle → `URP/Particles/Unlit`, giữ texture, tint, blend (alpha/additive/opaque) và render queue. Glow HDR bị chặn ở `GlowCap` (LDR không có bloom). Log `[BatchEntry] converted N x <rule>`; `-noConvert` bỏ qua để chẩn đoán.
2. **Cổng trước render** (`PreviewCell`): prefab còn material URP không vẽ được → target `failed` với lý do, media cũ của slug bị xóa. **Cổng pixel** (`PreviewBatch`): clip có frame magenta → `failed`, không ghi ra index nên không bao giờ lên DB.
3. **Cổng ingest** (`ingestPreviews`): GIF vừa encode là magenta → không lưu, xóa hàng cũ của slug (không preview tốt hơn preview hồng). Slug đúng là magenta thật: thêm vào `tools/preview/magenta-allow.txt`.

Quét DB: `npm run previews:magenta` (liệt kê slug magenta, exit 1 nếu có; `-- --out file.txt` ghi danh sách để đưa vào `run.json` `only`; `-- --purge` xóa các hàng đó; `-- --json`).

- `GET|HEAD /previews/<slug>.gif` → `200 image/gif` từ DB, `ETag: "<sha256>"` (`If-None-Match` → 304), `Cache-Control: public, max-age=300, must-revalidate` (URL không đánh dấu nội dung nên không `immutable`). Slug không có GIF hoặc tên sai ngữ pháp → 404.
- Card (`vfx_search`, `vfx_review`, `/v1/search`): trường mới `gif: {url, path, width, height, frames, fps, bytes, sha256, viaFamily} | null` (`viaFamily: true` = mượn GIF của bản canonical trong họ biến thể). `preview_uri` (trước đây luôn `null`) nay bằng `gif.url` khi chưa có giá trị riêng, nên client cũ chỉ đọc `preview_uri` vẫn có preview.
- `/review` (cả chế độ `set` theo role) dùng `<img class="gif" src="/previews/<slug>.gif">` khi có GIF — tự chạy ở mọi cột cùng lúc, không cần JS; webm/poster là fallback cho effect đã render mà chưa nạp. Header đếm GIF là "có preview".

REST kèm: `/healthz`, `/v1/search`, `/v1/facets`, `/v1/resource/:type/:slug/:version[/file]`, `/v1/publish`.

## Publish-back (effect đã chỉnh → recipe tái dùng)

Owner chấp nhận một VFX đã chỉnh trong game (bỏ layer, rescale, retime, recolor, ghép nhiều effect) → publish thành recipe `derived` + preview để lần sau `vfx_search` ra. Quy trình đầy đủ (4 bước, trigger, "không publish khi owner chưa chấp nhận") nằm ở **`skills/vfx-authoring` § "Publish-back on accept"**; server hỗ trợ:

- `vfx_publish` / `POST /v1/publish`: `derived_from` (URI nguồn, mỗi URI một cạnh `derived_from`), `modifications` (`[{op, target, from?, to?, note?}]`, lưu ở `meta.derived.modifications`), `unity: {path, guid}` (lưu `meta.unity`), `visibility`. License phải **kế thừa**: yếu hơn nguồn hoặc đổi nhãn cùng mức → 400; ghép nhiều nguồn thì nguồn chặt nhất thắng. Record derived bắt buộc `category`, `tags`, `meta.behavior`. `dependencies` nêu rõ mà không tồn tại → 404 (không bỏ lặng lẽ); mọi lỗi được kiểm **trước** khi ghi file.
- Closure: `vfx_fetch` trả `closure` (phụ thuộc bắc cầu qua cạnh `uses`, sâu nhất trước, không gồm chính nó, không theo `derived_from`); `scripts/vfx-fetch.sh` tải cả closure.
- Preview: `node tools/preview/targets.ts` thêm recipe derived có prefab vào danh sách render.

**Hook nhắc**: `hooks/vfx-publish-back-check.mjs` (Node, không dependency, fail-open, ~30 ms). Event `Stop`: quét record provenance của game (`art/provenance/**/vfxcloud-*.json`, mặc định) và in **một dòng cho mỗi record có `modification` / `modifications` / `composed_from` mà chưa có `published_uri`**; không bao giờ chặn (luôn exit 0). Record được coi là xong khi có `published_uri` (`vfx://…`), `publish_waiver` (lý do), hoặc `owner_accepted: false`. Mỗi record chỉ nhắc một lần cho mỗi phiên bản file (`VFX_PUBLISH_BACK_ALWAYS=1` để nhắc mỗi lượt). Biến: `VFX_PROVENANCE_DIRS` (mặc định `art/provenance`, ngăn cách `:`), `VFX_PUBLISH_BACK_JSON=1` (in `{"systemMessage": …}`), `VFX_PUBLISH_BACK_OFF=1`.

Project dùng đăng ký trong `.claude/settings.json` (giữ `"_t1k_owner": "user"` để `t1k update` không xoá):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /var/home/mike/Documents/Work/The1/vfx-skill-cloud/hooks/vfx-publish-back-check.mjs",
            "timeout": 5,
            "_t1k_owner": "user"
          }
        ]
      }
    ]
  }
}
```

(Sửa đường dẫn nếu repo này nằm chỗ khác.) Test: `node --test hooks/*.test.mjs`.

## Facets, behavior và hỏi-đáp thu hẹp

Mỗi record có `meta.facets` (phân loại mịn) và `meta.behavior` (1–3 câu tiếng Anh thường mô tả **người xem thấy gì theo thời gian**), sinh **deterministic** từ tên/path/pack và payload. Không model, không mạng. Bảng ánh xạ + ngưỡng nằm ở `server/src/facets.json` (data, sửa xong chạy `npm run reindex`), không hardcode trong logic.

| Facet | Kiểu | Giá trị / cách suy ra |
| --- | --- | --- |
| `category` | string[] | explosion, impact, projectile, muzzle, beam, trail, aura, buff, heal, shield, pickup, portal, weather, ambient, ui, blood, smoke, fire, magic. Từ tên record trước, không khớp mới xuống token của thư mục/tag; tối đa 3, theo thứ tự xuất hiện trong tên |
| `subcategory` | string[] | `"<category>/<sub>"`, vd `explosion/ground`, `impact/slash`, `projectile/missile`, `weather/rain` |
| `element` | string[] | fire, water, ice, lightning, poison, earth, wind, light, dark, arcane, blood, smoke, energy (từ vocab concept, `magic` → `arcane`) |
| `colors` | string[] | tên màu trong vocab: tên record + màu start chiếm ưu thế của payload |
| `playback` | `loop` \| `one-shot` | có node nào `looping` |
| `duration` | `short` \| `medium` \| `long` | **thời gian nhìn thấy** = max mọi node của (startDelay + thời gian emit + lifetime hạt dài nhất), không lấy `duration` mặc định 5 s của Unity. `<0.5s` short, `>2s` long |
| `scale` | `small` \| `medium` \| `large` | max node của `startSize × max(1, bán kính shape)` (box: nửa cạnh dài nhất). `<1` small, `>4` large |
| `motion` | string[] | radial, upward, downward, directional, orbit, static, spiral, falling (từ startSpeed + shape + gravity + velocity/force module + hướng xoay của node). Heuristic: cha không có ParticleSystem không được tính |
| `shape` | string[] | sphere, hemisphere, cone, ring, box, mesh, edge, point (shape module tắt), line |
| `renderMode` | string[] | billboard, stretched, mesh, line, trail |
| `cost` | `low` \| `medium` \| `high` | tổng `maxNumParticles` + số node các node đang emit. `high` khi ≥5000 hạt hoặc ≥8 node; `medium` khi ≥2500 hạt hoặc ≥5 node |

Thiếu facet nào thì **bỏ key** (record hand-written chỉ có facet suy ra được từ tên/category/tags; record chỉ có effect component không có playback/duration/scale/motion). `npm run facets:report` in phân bố giá trị và số record thiếu từng facet.

### `POST /v1/facets`

```json
{ "query": "explosion", "type": "recipe", "filters": { "style": ["toon"], "playback": ["one-shot"] }, "style": [], "keywords": [] }
```
→ `{ "total": 309, "facets": { "category": [{ "value": "explosion", "count": 288 }, ...], ... } }`

- Facet name = các key của `meta.facets` + `style` (cột style của record). Tên lạ → 400.
- Trong một facet các giá trị **OR**; giữa các facet **AND**. `filters.style` gộp OR với `style`.
- Đếm trên tập ứng viên khớp `query` + `filters` (+ `type`, `style`, `keywords`). Đếm gồm cả giá trị đã lọc, nên "explosion" và `filters.category=[explosion]` cho count nhất quán.
- **Cut-off khi có `query`**: cùng công thức điểm với `/v1/search`, nhưng chỉ giữ record khớp từ khóa (từ gốc hoặc đồng nghĩa/tiếng Việt), lấy tối đa `FACET_CANDIDATES` (mặc định 1000) record điểm cao nhất. `/v1/search` không cần ngưỡng vì chỉ trả top `limit`; đếm trên mọi record sẽ vô nghĩa (embedder cho mọi record cosine > 0). Không có `query` = mọi record khớp filters.
- Record thiếu một facet không được đếm ở facet đó.

`POST /v1/search` nhận thêm `filters` (cùng ngữ nghĩa). Mỗi card có thêm `facets` (`{}` nếu không có) và `behavior` (chuỗi, `null` nếu không có). MCP: `vfx_facets` cùng input/output; `vfx_search` có thêm `filters`.

## Corpus

**3472 resource · 18738 edge (knowledge graph)** — số đo 2026-10-29, xem § Status

| type | số | nguồn |
| --- | --- | --- |
| `texture` | 113 | 28 Synty (EULA) + 80 Kenney (CC0) + 5 OpenGameArt flipbook (CC0) |
| `vfx` | 21 | Synty prefab |
| `recipe` | 3316 | 3248 pack đã ingest + 68 game (`studio-internal`) + 8 tự viết (inline YAML) |
| `technique` | 9 | tự viết |
| `component` | 6 | tự viết |
| `shader` | 3 | tự viết (URP) |
| `code` | 3 | tự viết (C#) |
| `skill` | 1 | `vfx-authoring` |

Graph được dựng lại mỗi lần `npm run seed` (`relinkAll`) bằng cách quét URI
`vfx://<type>/<slug>/<version>` trong name, description và payload text — nên
`vfx_resolve` trả về danh sách dependencies thật, không phải `[]`.

## License

Xem **[LICENSES.md](LICENSES.md)** — taxonomy đầy đủ. Mỗi record mang
`license` + `meta.license_class` + `meta.ai_training`.

- `cc0` → 118 resource · `synty-store-eula` → 229 · `asset-store-eula` → 3057 · `studio-internal` → 68 (game recipe, `visibility=studio-only`, `ai_training=false`). Số đo: `SELECT license, count(*) FROM resource GROUP BY 1`.

`license="unknown"` **bị server từ chối** (ingest gate, có test).

## Flipbook schema

Texture flipbook mang `meta.flipbook` có cấu trúc để agent set đúng Texture Sheet
Animation mà không cần mở file đoán lưới:

```json
{ "columns": 6, "rows": 5, "frames": 30, "cell": [256, 256],
  "order": "row-major", "loop": false, "background": "transparent" }
```

`background` ∈ `transparent` | `opaque-black` (nếu `opaque-black` thì **bắt buộc**
blend additive). Grid được kiểm chứng bằng gutter alpha, không phải đọc tên file:

| URI | lưới | frame | cell |
| --- | --- | --- | --- |
| `vfx://texture/oga-explosion-atlas/1` | 3×3 | 9 | 512² |
| `vfx://texture/oga-smoke-sheet/1` | 5×5 | 25 | 256² |
| `vfx://texture/oga-firework-sheet/1` | 6×5 | 30 | 256² |
| `vfx://texture/oga-flame-sheet/1` | 5×5 | 25 | 128² |
| `vfx://texture/oga-flame-strip/1` | 25×1 | 25 | 128² |

Nguồn/author/license đầy đủ: `seed/vendor/flipbooks/SOURCES.md`.

## Skills

| Skill | Dùng khi |
| --- | --- |
| `vfx-authoring` | Workflow tổng: search → resolve → fetch → text-edit → validate → publish. Chứa **text-first editing policy** (7 luật) và bảng quyết định text-edit vs Unity MCP. |
| `vfx-generator` | "tạo vụ nổ", "sửa effect quá trắng" — orchestrator retrieve-trước-rồi-compose. |
| `vfx-knowledge-extractor` | "/vfx learn", contribute-back — phân loại NEW/REUSE/IMPROVEMENT/DUPLICATE/PROJECT-SPECIFIC/EXPERIMENTAL trước khi publish. |

## Unity client

`unity/Packages/com.mike.vfx-cloud` — package local, đã add vào
`Unity/VFXSource/Packages/manifest.json` bằng `file:` reference.

- `VfxCloudSettings` (Project Settings), `VfxCloudManifest`, `VfxCloudFetcher`
- Menu `TheOne → VFX Cloud → Fetch URI…` (`VfxCloudFetchWindow`): ô Server, API key, Variant (`urp` | `original`), On conflict (`refuse` | `skip` | `overwrite`), nút Fetch. Cài bundle `vfx-bytes/1` như `vfx-fetch.sh`, cùng exit code (§ Bytes and bundle API).
- Batch (không mở cửa sổ): `-executeMethod VfxCloud.Editor.BatchFetch.Run -vfxUri <vfx://…> [-vfxVariant urp|original] [-vfxOnConflict refuse|skip|overwrite] [-vfxServer <url>] [-vfxKey <key>] [-vfxRoot <dir>]`; mỗi tham số mặc định lấy từ env tương ứng (`VFX_VARIANT`, `VFX_ON_CONFLICT`, `VFX_SERVER`, `VFX_API_KEY`, `VFX_ROOT`). Thoát khác 0 khi lỗi.
- Compile sạch 0 lỗi/0 warning (kiểm bằng `dotnet` + `UnityEngine/UnityEditor.dll`,
  không qua Editor — vì license headless)

## Bytes and bundle API (vfx-bytes/1)

Human copy of the contract. The field-level SSOT is `plans/261028-self-contained-vfx-fetch/plan.md` § Contract (C1-C10), executed as `server/src/bundle-contract.ts`; do not copy field lists elsewhere.

- Bytes are content-addressed files under `DATA_DIR/blobs/<sha[0:2]>/<sha[2:4]>/<sha256>` (text kinds gzipped at rest). Metadata lives in Postgres: `asset_blob`, `asset_file` (one row per `(guid, variant)`), `preview_render` (migration 010).
- `variant=original` is vendor bytes. `variant=urp` is the converted material, same guid, path and `.meta`. Packages and Unity built-ins are listed in `requires`, never shipped. `dangling` lists GUIDs a shipped file references that no readable source of its fully swept pack defines (the vendor pack has the same hole, e.g. Retro Arsenal's `_Ramp` slot; Unity shows an empty texture): a warning, the bundle stays `complete`. Clients surface it (`vfx-fetch.sh` summary key `dangling` plus a stderr warning, the Unity window a warning line) and keep their exit codes. A GUID that a root references, or that a partial folder copy might simply lack, stays `unresolved` (an error).
- Blob routes need `x-vfx-key` even under `AUTH_DISABLED=1`. Opt out only with `VFX_BLOB_ALLOW_ANON=1`. MCP never carries bytes.

| Route | Purpose |
| --- | --- |
| `POST /v1/blob/missing` | which of these sha256 values are not stored yet |
| `PUT /v1/blob/:sha256` | store raw bytes (the body must hash to `:sha256`) |
| `GET /v1/blob/:sha256` | fetch raw bytes (ETag, immutable cache) |
| `POST /v1/asset-file/batch` | register files (per-item `created`/`unchanged`/`replaced`/`rejected`) |
| `GET /v1/asset-file/:guid?variant=` | one `BundleFile` |
| `GET /v1/closure/:type/:slug/:version?variant=` | the `Bundle` for a recipe (default `urp`) |

Env: `VFX_BLOB_MAX_BYTES` (256 MiB), `VFX_BUNDLE_MAX_FILES` (3000), `VFX_BLOB_ALLOW_ANON`.

Tests run on scratch databases only: `bash scripts/accept/with-testdb.sh <lane> <cmd>` creates `vfxcloud_test_<lane>`, migrates it and drops it on exit. `npm test` against the live `vfxcloud` DB is refused by `assertScratchDb()` in the DB-backed contract tests.

### Ai được lấy bytes, và variant nào

- Bytes chỉ đi qua route blob có `x-vfx-key`. Không có `VFX_API_KEY` và không có `VFX_BLOB_ALLOW_ANON=1` thì 403. Mục đích: bytes của pack mua không lộ qua compose mặc định (`AUTH_DISABLED=1`, bind `0.0.0.0`).
- `asset_file` không bao giờ `visibility=global` (CHECK). License được phép kèm bytes: `synty-store-eula`, `asset-store-eula`, `studio-internal`. `unknown`, `restricted` và mọi `ai_training=true` bị từ chối (`forbidden`).
- `original`: bytes gốc của vendor (`.unitypackage`, thư mục namufx, thư mục game). Không bao giờ lấy từ `unity/VFXPreview/Assets/ImportedPacks` vì đó là bản đã convert tại chỗ.
- `urp`: material đã convert sang URP, cùng guid, path và `.meta` với bản gốc; chỉ có ở material. Sinh bởi `VfxPreview.UrpExport` không cap glow. Là mặc định của `vfx_fetch`, `vfx-fetch.sh`, `/v1/closure` và Unity client.

### Bundle: đọc gì trước khi báo "xong"

| Trường | Nghĩa | Việc phải làm |
|---|---|---|
| `complete: true` | mọi GUID mà root tham chiếu đều có file hoặc thuộc Unity/UPM | cài được |
| `complete: false`, `reason: no_prefab` | recipe không có prefab (recipe viết tay); `files` rỗng | `vfx-fetch.sh` thoát 5. Dùng `VFX_FETCH_LEGACY=1` (D18) |
| `complete: false`, `reason: bytes_not_uploaded` | prefab có GUID nhưng chưa có dòng `asset_file` | báo lỗi, chưa cài được |
| `unresolved` | GUID không có nguồn nào | lỗi thật, `complete:false`. Chỉ cài với `VFX_ALLOW_INCOMPLETE=1` |
| `requires` | GUID thuộc Unity built-in hoặc package UPM (không ship) | cảnh báo; `VFX_STRICT_REQUIRES=1` làm thoát 6 nếu package thiếu trong `Packages/manifest.json` |
| `dangling` | GUID mà pack vendor cũng không định nghĩa (Unity hiện slot trống) | chỉ cảnh báo; không đổi `complete` hay exit code. 17 script game bị bỏ có chủ ý (`stripped`) cũng nằm ở đây |
| `cycles` | vòng tham chiếu, đã cắt | thông tin |

Chi tiết trường và thứ tự file: plan `plans/261028-self-contained-vfx-fetch/plan.md` § Contract (C4).

### `vfx-fetch.sh`

```bash
scripts/vfx-fetch.sh vfx://recipe/<slug>/<version> [project_root]
VFX_DRY_RUN=1 scripts/vfx-fetch.sh vfx://recipe/<slug>/1 /path/to/Unity   # chỉ in kế hoạch
```

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `VFX_SERVER` | `http://127.0.0.1:8787` | |
| `VFX_API_KEY` | (trống) | gửi là `x-vfx-key`; bắt buộc cho route blob |
| `VFX_PROJECT` | thư mục hiện tại | project root khi không truyền tham số |
| `VFX_VARIANT` | `urp` | `urp` \| `original` |
| `VFX_ON_CONFLICT` | `refuse` | `refuse` \| `skip` \| `overwrite`; không bao giờ xóa |
| `VFX_ROOT` | (trống) | đổi prefix `Assets/VFXCloud/<pack>/` thành `<VFX_ROOT>/` |
| `VFX_DRY_RUN` | (trống) | `1`: in kế hoạch, không ghi gì |
| `VFX_ALLOW_INCOMPLETE` | (trống) | `1`: cài dù `complete:false` |
| `VFX_STRICT_REQUIRES` | (trống) | `1`: thoát 6 khi thiếu package |
| `VFX_FETCH_LEGACY` | (trống) | `1`: đường cũ theo từng resource; `VFX_FETCH_DEPS=0` chỉ có tác dụng ở đường này |

| Exit | Nghĩa |
|---|---|
| 0 | ok |
| 1 | lỗi mạng, server hoặc cài đặt |
| 2 | sai cách gọi |
| 3 | xung đột bị từ chối (`refuse`) |
| 4 | sha256 không khớp; không có gì được ghi |
| 5 | bundle `complete:false` (và không có `VFX_ALLOW_INCOMPLETE=1`) |
| 6 | package bắt buộc thiếu (`VFX_STRICT_REQUIRES=1`) |
| 7 | `guid:` trong `.meta` đổi sau khi cài (thường do Editor đang mở import song song) |

Quy trình cài: mọi blob tải về `Temp/vfx-cloud-<random>/` và verify sha256 trước; chỉ khi tất cả đúng mới di chuyển. Mỗi file ghi `.meta` trước rồi mới ghi asset; `.meta` là bản byte-exact của vendor, nên GUID giữ nguyên. Nhật ký `Temp/vfx-cloud-journal.json` cho phép hoàn tác khi lỗi ở pha di chuyển. Dòng JSON cuối stdout: `{"uri","variant","written","unchanged","reused","skipped","requires_missing","dangling","complete"}`.

### Uploader, verifier, backup

```bash
node seed/upload-blobs.ts                                   # dry run: không gửi gì
node seed/upload-blobs.ts --yes --limit 5                   # smoke
node seed/upload-blobs.ts --yes --resume                    # đầy đủ, chạy lại an toàn
node seed/upload-blobs.ts --yes --variant urp --urp-dir data/export/urp
node seed/verify-closure.ts --all --variant urp             # chỉ đọc; --sample N, --slugs a,b@2
node seed/verify-closure.ts --all --variant urp --record    # ghi preview_render (xem dưới)
podman exec vfx-pg pg_dump -U vfx -Fc vfxcloud > data/backups/vfxcloud-$(date +%Y%m%d-%H%M%S).dump
```

- Uploader: `--skip-kinds audio,script`, `--pack <slug>`, `--dangling-map server/src/dangling-guids.json` (chỉ khi chạy toàn bộ `original`). Exit: 0 ok, 1 có file lỗi hoặc bị từ chối, 2 sai cách gọi, 75 server không tới được sau retry.
- Verifier: exit 0 (không đầy đủ là một phát hiện, không phải lỗi), 1 sha256 sai hoặc bundle không đọc được, 2 sai cách gọi, 75 server không tới được. Báo cáo ở `data/reports/closure-verify*.json`.
- `--record` ghi `preview_render(state='failed', cause='closure-unresolved')` cho recipe không đầy đủ. Không bao giờ ghi đè dòng `unfixable-*` hay dòng `ok` của pack không đánh dấu `completeSource` (namufx, `seed/extract/packs.json`). Xóa dòng `closure-unresolved` cũ của các slug nay đã đầy đủ.
- Backup trước mọi lệnh migrate hoặc ghi hàng loạt: lệnh `pg_dump` ở trên; kiểm tra bằng `pg_restore --list <file>`.

### Chu kỳ render và đọc lỗi

1. Khôi phục bản gốc: `node scripts/preview-restore-originals.ts` (`--dry-run` để xem trước).
2. Export bản publish: menu `Tools/VFX Preview/5. Export URP Variant (keep Editor open)` hoặc `-executeMethod VfxPreview.UrpExport.Run -vfxExport data/export/urp` (không cap glow, C8). Rồi upload `urp` như trên.
3. Khôi phục bản gốc lần nữa, convert cho preview (`GlowCap=1.25`), render: `BatchEntry.Run`, hoặc `tools/preview/run.json` với `only`.
4. Nạp lỗi: `node seed/preview-failures-ingest.ts` (đọc `data/previews/_failures.json`), rồi `npm run previews:gif`, `npm run previews:magenta`, `npm run previews:consistency`.

Đọc lỗi:

```sql
SELECT cause, count(*) FROM preview_render WHERE state='failed' GROUP BY 1;
```

Cause `unfixable-shader`, `unfixable-source`, `unfixable-script` là lỗi đã có chứng cứ. Mọi cause khác là việc cần sửa; `scripts/accept/phase-11.sh` đếm chúng là `FIXABLE` và phải bằng 0.

- `tools/preview/waivers.json`: mục ghi nhận lỗi đã có chứng cứ (cause phải là `unfixable-*`). Chỉ đổi nhãn lỗi mà render đã tạo ra, không tạo ra ảnh.
- `tools/preview/magenta-allow.txt`: slug magenta thật đã kiểm tra (không phải lỗi shader). `npm run previews:magenta -- --no-allow` bỏ qua danh sách này.
- `npm run previews:consistency`: có dòng `preview_gif` khi và chỉ khi lần render mới nhất là `ok`.

## Cut trong V0

`vfx_find_similar`, compose/analyze, patch/rollback engine, capability resolver,
extraction AI, usage/feedback ranking, visibility enforcement, R2 storage, preview
image, visibility phân quyền, `feedback` tool. Nằm ở ladder V0.1–V0.5 trong
`plans/260928-1659-vfx-skill-cloud-v0/plan.md`.

Chưa làm: ingestion Brackeys (đã có Kenney + Synty + OpenGameArt flipbook), texture
semantic schema mở rộng ngoài flipbook (provenance/UV hints cho texture thường),
`preview_uri` riêng cho từng record (cột vẫn NULL; card lấy URL GIF từ `preview_gif`, video qua `/previews` + `data/previews/index.json`, xem Review).

## Extractor (unitypackage -> recipe)

`node seed/extract-unitypackage.ts --pack <slug> --out <dir> [--limit N]` (`--list-packs` để xem slug).
Đọc thẳng `.unitypackage`, ghi `<dir>/<pack>/<slug>.{json,yaml}` + `skipped.jsonl`; **không** seed DB.
Test: `npm test`.
