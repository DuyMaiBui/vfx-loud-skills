---
name: vfx-authoring
description: Author or fix Unity VFX through the VFX Skill Cloud — search existing assets first, fetch with GUID preservation, publish back only after Unity validation. Use for "tạo effect", "sửa VFX", "vfx_search", "vfx://", "publish effect", "search VFX", "fetch vfx asset".
---

# VFX Skill Cloud authoring

Cloud MCP server cung cấp 4 tool. Unity client chỉ là thin writer. Agent là orchestrator.

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
2. **MCP không bao giờ trả binary.** `vfx_search` → Knowledge Card + `vfx://` URI. `vfx_resolve` → manifest. `vfx_fetch` → `download_url` + `sha256`, client tự tải.
3. **Không overwrite.** `vfx_publish` luôn tạo version mới (`v2`, `v3`…).
4. **Giữ GUID.** File về `Assets/VFXCloud/<type>/<slug>/<slug>.<ext>` — tên ổn định qua mọi version, `.meta` không bao giờ bị đụng.
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

`vfx_search(query, type?, tags?, limit?)` → `{count, cards[]}`.

Query bằng tiếng Anh, mô tả hành vi: `"cartoon ground impact soft dust"`, `"reward burst confetti coins"`.

Lọc `type` ∈ `texture | shader | code | recipe | component | vfx` nếu biết muốn gì.

### 2. Chọn + đọc manifest

`vfx_resolve(uri)` → metadata, `dependencies`, `download_url`, `file_name`, `sha256`.

`vfx_fetch(uri)` → thêm `target_hint` và `fetch_command`. Dùng cái này khi đã quyết định lấy.

### 3. Tải về

Cách nhanh (không cần Unity):

```bash
cd /var/home/mike/Documents/Work/The1/vfx-skill-cloud
./scripts/vfx-fetch.sh vfx://texture/smoke-01/1 /path/to/UnityProject
```

Cách trong Unity: menu **TheOne → VFX Cloud → Fetch URI…** → dán URI → Fetch. Client tự verify `sha256`, ghi file, `ImportAsset`, rồi log GUID trước/sau để chứng minh GUID không đổi.

Kết quả nằm ở `Assets/VFXCloud/<type>/<slug>/`.

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

## Server

| Thing | Where |
| --- | --- |
| Repo | `/var/home/mike/Documents/Work/The1/vfx-skill-cloud` |
| Endpoint | `http://127.0.0.1:8787` — `/mcp`, `/healthz`, `/v1/...` |
| DB | podman `vfx-pg` (pgvector:pg17), `vfx/vfx@127.0.0.1:5432/vfxcloud` |
| Files | `data/<type>/<slug>/v<version>.<ext>` |
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
| `.meta` bị đụng / GUID đổi | Client bug — chỉ được ghi file, không được ghi `.meta` |
| `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | Node strip-only: cấm parameter property, enum, namespace |

## Deferred (không làm ở V0)

Capability resolver · patch engine · extraction AI · usage ranking · visibility filter · VFX Graph edit · multi-tenant auth · compose/analyze.
