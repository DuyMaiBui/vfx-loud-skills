---
name: vfx-authoring
description: Author or fix Unity VFX through the VFX Skill Cloud — search existing assets first, fetch with GUID preservation, publish back only after Unity validation. Use for "tạo effect", "sửa VFX", "vfx_search", "vfx://", "publish effect", "search VFX", "fetch vfx asset".
---

# VFX Skill Cloud authoring

Cloud MCP server cung cấp 7 tool (`vfx_search`, `vfx_facets`, `vfx_related`, `vfx_resolve`, `vfx_fetch`, `vfx_publish`, `vfx_recolor`). Unity client chỉ là thin writer. Agent là orchestrator.

## Precondition

Server phải sống:

```bash
curl -s http://127.0.0.1:8787/healthz   # {"ok":true,...}
```

Nếu chết:

```bash
cd /var/home/mike/Documents/Work/The1/vfx-skill-cloud
# Postgres (một lần mỗi boot)
./scripts/dev-db.sh
AUTH_DISABLED=1 nohup node server/src/index.ts > /tmp/opencode/vfx-server.log 2>&1 &
```

Server đã được đăng ký: `claude mcp add --transport http vfx-skill http://127.0.0.1:8787/mcp` (scope local trong repo `vfx-skill-cloud`).

## Luật bất di bất dịch

1. **Search trước, tạo sau.** Mọi yêu cầu effect mới/lỗi VFX đều bắt đầu bằng `vfx_search`.
2. **MCP không bao giờ trả binary.** `vfx_search` → Knowledge Card + `vfx://` URI. `vfx_resolve` → manifest. `vfx_fetch` → `download_url` + `sha256` + `bundle` (vfx-bundle/1, mặc định `variant=urp`). Bytes chỉ tải được bằng `x-vfx-key` qua `download_url`.
3. **Không overwrite.** `vfx_publish` luôn tạo version mới (`v2`, `v3`…).
4. **Giữ GUID.** Bundle cài vào `Assets/VFXCloud/<pack>/<path>` kèm `<file>.meta` là bản byte-exact của vendor, nên `guid:` giữ nguyên. Không tự viết `.meta`, không sửa `guid:` trong file.
5. **License gate.** `license="unknown"` bị từ chối. Synty pack → `synty-store-eula`. Tự viết → `cc0`.
6. **Chỉ publish cái đã validate trong Unity.** Chưa chạy được thì đừng publish.

## Text-first, MCP-second, validation-always

Đây là **core design rule** của hệ thống. Cloud MCP trả *"cái nào nên dùng"*; Unity MCP (nếu có) làm *"xây/test thế nào"*; **agent là orchestrator**.

### Bảng quyết định

| Thao tác | Cách làm |
| --- | --- |
| Sửa `.prefab` / `.asset` / `.unity` / `.mat` YAML | **Text edit trực tiếp** |
| Sửa `.cs`, `.shader`, `.shadergraph` (JSON), config | **Text edit trực tiếp** |
| Sửa `.vfx` (VFX Graph) cấu trúc | Unity MCP / Editor |
| Resolve asset reference mà Unity tự giữ | Unity MCP |
| Scene manipulation, instantiate, mở scene | Unity MCP |
| Runtime validation (play, screenshot, overdraw, FPS) | Unity MCP |
| Import + generate `.meta` | để Unity tự làm (không viết tay `.meta`) |

### 7 luật

1. Không dùng Unity MCP nếu filesystem/text editing đủ khả năng.
2. Không sửa binary asset khi còn source representation chỉnh sửa được.
3. Không overwrite resource — luôn tạo version/patch.
4. **Giữ Unity GUID và serialized references.**
5. Mọi patch phải có **precondition**.
6. Mọi thay đổi cần **validation** phù hợp.
7. Failure phải **rollback** được.

Kèm: không sửa file generated/derived khi chưa rõ ownership; sau khi text edit chỉ gọi Unity MCP để **validate**, không để nó sửa lại file.

## Workflow

### 1. Tìm

`vfx_search(query, type?, tags?, style?, keywords?, limit?)` → `{count, cards[]}` (mỗi card có `style[]` và `keywords[]`).

Query tiếng Anh hoặc tiếng Việt, ngắn và cụ thể: `"water splash"`, `"blue fire"`, `"nổ lửa"`, `"hồi máu"`, `"mưa"`. Từ đồng nghĩa được mở rộng tự động (vocab ở `server/src/vocab.json`).

- `style` lọc theo pack style: `toon | stylized | retro | sci-fi | low-poly` (`"cartoon"`, `"low poly"` cũng được). Vd `vfx_search("explosion", type="recipe", style=["retro"])`.
- `keywords` lọc record có BẤT KỲ keyword: element (`fire water ice lightning poison smoke blood earth wind magic`), use (`explosion impact muzzle projectile beam buff heal shield trail pickup portal teleport levelup slash`), weather (`rain snow`), màu (`red orange yellow green cyan blue purple pink white black gold`), loop (`looping | one-shot`). Vd `keywords=["blue","one-shot"]`.
- Muốn RECIPE tham số hoá thì đặt `type="recipe"`; nếu không, texture cùng tên (vd `bubble-01`) có thể đứng trước.
- Đo chất lượng: `npm run eval:search` (`--type recipe`). Index lại sau khi đổi vocab: `npm run reindex` (idempotent, không đụng payload/sha256/version).

Lọc `type` ∈ `texture | shader | code | recipe | component | vfx` nếu biết muốn gì.

### 2. Chọn + đọc manifest

`vfx_resolve(uri)` → metadata, `dependencies`, `download_url`, `file_name`, `sha256`.

`vfx_fetch(uri, variant?)` → thêm `target_hint`, `fetch_command`, `closure` (legacy, giữ nguyên) và `bundle`. Dùng cái này khi đã quyết định lấy. `variant`: `urp` (mặc định, material đã convert) hoặc `original` (bytes gốc của vendor).

### 2b. Cần màu khác? Recolor hay lấy biến thể

Card/record có `recolorable` (`vfx_search` card, hoặc `meta.recolorable` trong `vfx_resolve`):

| `recolorable` | Làm gì |
| --- | --- |
| `true` | `vfx_recolor({uri, targetColor \| hueShiftDeg, publish: true, includePayload: false})` → record mới `derived_from` (license kế thừa, `visibility=project`, slug `<gốc>-recolor-<hex>`), rồi `vfx_fetch(published.uri)`. Cùng đầu vào chạy lại trả record cũ (`published.created:false`), không tạo thêm. |
| `false` / `null` | **Không recolor.** Lấy biến thể thật (`variants` của card, hoặc `vfx_related(uri, rel:"variant_of")`). `recolorReason`: `texture` (màu nằm trong ảnh), `params` (khác hue ở chỗ khác), `no-keys` / `no-base-keys` (không có key màu để dịch). |

Recolor chỉ đổi màu params của particle; `tint` là material cần nhuộm trên BẢN SAO ở Unity (không sửa material dùng chung). Record gốc không bị sửa. Không có `targetColor`/`hueShiftDeg` thì hỏi user; đỏ ≈ `#ff2020`. CLI tương đương: `npm run recolor -- <uri> --target '#ff2020' [--publish]`.

### 3. Tải về

Cách nhanh (không cần Unity):

```bash
cd /var/home/mike/Documents/Work/The1/vfx-skill-cloud
./scripts/vfx-fetch.sh vfx://texture/smoke-01/1 /path/to/UnityProject
```

Cách trong Unity: menu **TheOne → VFX Cloud → Fetch URI…** → dán URI → Fetch. Client tự verify `sha256` từng blob trước khi ghi, ghi `.meta` trước asset, rồi kiểm tra GUID sau import (`AssetPathToGUID` phải khớp bundle). Chọn `variant` và `On conflict` trong cửa sổ.

Kết quả nằm ở `Assets/VFXCloud/<pack>/`. Cùng kết quả bằng batch: `-executeMethod VfxCloud.Editor.BatchFetch.Run -vfxUri <uri>`.

### 3b. Đọc bundle trước khi báo "xong"

Chỉ coi là đủ khi `bundle.complete` là `true`. Phân biệt các trường (chi tiết và exit code: README § Bytes and bundle API):

| Trường | Ý nghĩa cho agent |
|---|---|
| `complete: false`, `reason: no_prefab` | recipe không có prefab (recipe viết tay). Không phải lỗi dữ liệu: lấy bằng `VFX_FETCH_LEGACY=1 ./scripts/vfx-fetch.sh <uri> <project>` |
| `complete: false`, `reason: bytes_not_uploaded` | chưa đủ bytes trên server. Báo người dùng, không tự cài dở |
| `unresolved` (không rỗng) | GUID không có nguồn. Đây là lỗi làm `complete:false`; không dùng `VFX_ALLOW_INCOMPLETE=1` để "cho qua" |
| `requires` | Unity built-in hoặc package UPM, không ship. Chỉ cảnh báo; thiếu package thì cài package đó |
| `dangling` | GUID vendor pack cũng không có (slot trống). Chỉ cảnh báo, không chặn `complete`; không báo là lỗi cài đặt |

`vfx-fetch.sh` exit 3 (xung đột) thì không ghi gì; đổi `VFX_ON_CONFLICT` chỉ khi người dùng đồng ý. Exit 7 (`.meta` đổi GUID sau khi cài) thường do Editor đang import song song: đóng hoặc đợi Editor rồi cài lại.

### 4. Tác giả trong Unity

- `type=recipe` → file YAML mô tả layers/components. Đọc nó rồi dựng ParticleSystem/VFX Graph tương ứng trong scene.
- `type=vfx` → `.prefab` Synty. Instantiate, chỉnh cho khớp art style của game.
- `type=texture` → sprite/texture dùng trong particle.

### 5. Validate

Falsifiable — phải có bằng chứng trước khi publish:

- Effect spawn được trong Play mode, không lỗi Console.
- Overdraw/frame không tệ hơn baseline (Profiler nếu cần).
- Đúng intent đã search (so lại Knowledge Card).

### 6. Trả lại cloud

`vfx_publish(type, slug, name, license, b64?|file_path?, description?, tags?, style?, category?, file_name?, meta?)`

- Machine chạy server local → dùng `file_path` (đường dẫn tuyệt đối trên máy server).
- Server remote → `b64` (base64 của nội dung file).
- `slug` phải `a-z0-9` + `-`.
- Publish `recipe` YAML: `file_name="ten-cong-thuc.yaml"`.

Ngay sau publish, gọi lại `vfx_search` với query liên quan để xác nhận nó đã xuất hiện (G4).

Effect đã **chỉnh từ record có sẵn** (bỏ layer, đổi scale/thời gian/màu, ghép nhiều effect) có luật riêng: xem [Publish-back on accept](#publish-back-on-accept). `vfx_publish` có thêm `derived_from`, `modifications`, `unity`, `visibility` cho đúng việc đó.

## Publish-back on accept

Một effect đẹp mà chỉ nằm trong một game thì lần sau phải làm lại từ đầu. Khi owner **chấp nhận** một VFX đã được chỉnh trong game, nó thành recipe tái dùng được, **trong cùng task với thay đổi ở game**, không để "lần sau".

### Trigger

Cả hai điều kiện:

1. VFX trong game **khác bản Cloud gốc**: bỏ/thêm layer, rescale, retime, recolor, đổi material/texture, hoặc **ghép nhiều effect thành một**. Dấu hiệu: record provenance của game (NutSort: `art/provenance/nutsort/vfxcloud-<slug>.json`) có `modification` / `modifications` / `composed_from`.
2. **Owner đã chấp nhận** kết quả (lời owner trong phiên, hoặc đã ghi vào record: `owner_order`). Owner chưa duyệt, đang thử, hoặc bị loại → **KHÔNG publish**. Ghi `"publish_waiver": "<lý do>"` (hoặc `"owner_accepted": false`) vào record để hook không nhắc nữa.

Effect không đổi gì so với Cloud (chỉ fetch) thì không có gì để publish.

### Việc phải làm (đủ 4 bước, theo thứ tự)

**1. Publish một recipe `derived`** bằng `vfx_publish`. Publish từng file **theo thứ tự phụ thuộc** (cái được dùng trước, cái dùng sau):

| Bước | File | `type` | Ghi chú |
| --- | --- | --- | --- |
| a | texture / material MỚI (đã sửa hoặc tự tạo) | `texture` (png), `vfx` (`.mat`) | `unity: {path, guid}` lấy từ `.meta` của file; `dependencies` = URI file nó tham chiếu. File **không đổi** so với Cloud thì KHÔNG publish lại, dùng URI sẵn có trong `dependencies`. |
| b | prefab dùng được | `vfx` (`file_name` = `<Tên>.prefab`) | `unity: {path, guid}`, `dependencies` = material/texture ở bước a (hoặc URI sẵn có), `derived_from` = nguồn. |
| c | recipe | `recipe` (YAML) | Lấy YAML của recipe nguồn (`vfx_fetch`), áp **đúng các thay đổi đó** vào `particleNodes`; ghép effect thì gộp node của từng nguồn. `dependencies: [<prefab uri>]`. |

Trên recipe (bước c) bắt buộc:

- `derived_from`: mọi URI nguồn (một hoặc nhiều nếu ghép). Mỗi URI tạo một cạnh `derived_from`.
- `modifications`: danh sách **máy đọc được**, mỗi phần tử `{op, target, from?, to?, note?}`, `op` ∈ `remove-layer | add-layer | rescale | retime | recolor | retarget-material | retarget-texture | compose | other` (`other` bắt buộc `note`). Vd bỏ vòng xoáy của level-up rồi thu nhỏ:
  `[{"op":"remove-layer","target":"FX_LevelUp_Swirl_01"},{"op":"rescale","target":"root","from":1,"to":0.16}]`.
- `license`: **kế thừa**. Server từ chối license yếu hơn nguồn, hoặc đổi nhãn cùng mức (Synty → `asset-store-eula`). Ghép nhiều nguồn khác license thì lấy nguồn **chặt nhất**. `unknown` vẫn bị từ chối.
- `category`, `tags`, `style`, `meta.behavior` (1–3 câu tiếng Anh: người xem thấy gì theo thời gian) — không đủ thì server từ chối. Nên thêm `meta.facets` (xem `vfx_resolve` của nguồn để lấy mẫu) và `meta.keywords` để `vfx_search` lọc được.
- `visibility`: mặc định `project`; chỉ nâng khi owner nói.

**Kiểm tra closure** (trước khi coi là xong): `vfx_fetch(<recipe uri>)` phải trả `bundle.complete: true` (mục 3b), và `closure` liệt kê đủ prefab + material + texture kèm `unity.guid`. Thử thật: `./scripts/vfx-fetch.sh <recipe uri> <thư mục thử>` ghi đủ mọi file. `complete:false` do `unresolved` hoặc `bytes_not_uploaded` = chưa publish đủ, quay lại bước a/b.

**2. Preview**: render qua preview lane rồi nạp GIF vào DB.
`./scripts/vfx-fetch.sh <recipe uri> unity/VFXPreview` (closure vào project preview) → `node tools/preview/targets.ts` (thêm recipe derived vào targets) → render lane với `only: ["<slug>"]` trong `tools/preview/run.json` → `npm run previews:gif -- --only <slug>`. Lane chạy bằng `BatchEntry` thì bước ingest tự chạy ở cuối. Xem README § Preview.

**3. Verify**: `vfx_search("<tên effect>", type: "recipe")` thấy recipe mới, card có `gif` (không `null`) và `derived_from`/modifications đúng trong `vfx_resolve(...).meta.derived`; `curl -sI <gif.url>` trả `200 image/gif`.

**4. Ghi uri về record provenance của game**, cùng commit với thay đổi game:

```json
"published_uri": "vfx://recipe/<slug>/<version>",
"published_at": "YYYY-MM-DD"
```

Bảng "VFX Cloud" của game (NutSort: `node scripts/nutsort/vfxcloud-table.cjs --write`) sinh lại từ các record, không sửa tay.

### Không làm

- Publish khi owner chưa chấp nhận, hoặc khi chưa validate trong Unity (luật 6).
- Overwrite bản gốc: publish luôn tạo slug/version mới; recipe chỉnh có slug riêng, vd `<gốc>-<mô tả ngắn>`.
- Publish file của pack mà license không cho phép (asset ngoài Cloud, không có license rõ) — dừng và hỏi owner.
- Bỏ qua nhắc nhở: hook `hooks/vfx-publish-back-check.mjs` (event `Stop`) in một dòng cho mỗi record đã chỉnh mà chưa có `published_uri`. Đã publish → thêm `published_uri`; cố ý không publish → `publish_waiver`.

## Server

| Thing | Where |
| --- | --- |
| Repo | `/var/home/mike/Documents/Work/The1/vfx-skill-cloud` |
| Endpoint | `http://127.0.0.1:8787` — `/mcp`, `/healthz`, `/v1/...` |
| DB | podman `vfx-pg` (pgvector:pg17), `vfx/vfx@127.0.0.1:5432/vfxcloud` |
| Files | `data/<type>/<slug>/v<version>.<ext>` (resource) · `data/blobs/<sha[0:2]>/<sha[2:4]>/<sha256>` (bytes của bundle, gzip cho kind văn bản) |
| Seed | `seed/manifest.json` + `npm run seed` (idempotent, bỏ qua slug đã có) |
| Unity pkg | `unity/Packages/com.mike.vfx-cloud` (file: reference vào Unity project) |
| Smoke | `./scripts/smoke.sh` |

## Khi lỗi

| Symptom | Nguyên nhân / cách |
| --- | --- |
| `curl` healthz fail | Server chết → xem `/tmp/opencode/vfx-server.log` |
| `generation expression is not immutable` | `tags::text` không immutable — đã dùng cột `search_text` do app ghi. Đừng trả về `tags::text` trong generated column. |
| `license "unknown" bị từ chối` | Ingest gate — phải khai license thật |
| MCP `Authorization header invalid` | Chưa set token; dev thì `AUTH_DISABLED=1` |
| `vfx-fetch.sh` exit 7 (`guid_changed`) | `.meta` không còn GUID của bundle sau khi cài: Editor đã import file đó song song. Đóng hoặc đợi Editor, rồi cài lại (không sửa tay `.meta`) |
| `vfx-fetch.sh` exit 4 (sha256) | Bytes tải về không khớp: không có file nào được ghi. Thử lại; nếu lặp lại thì báo server |
| `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | Node strip-only: cấm parameter property, enum, namespace |

## Deferred (không làm ở V0)

Capability resolver · patch engine · extraction AI · usage ranking · visibility filter · VFX Graph edit · multi-tenant auth · compose/analyze.
