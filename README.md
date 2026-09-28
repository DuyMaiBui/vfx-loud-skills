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

## Chạy

```bash
./scripts/dev-db.sh up          # container Postgres + pgvector  (podman)
./scripts/server.sh restart     # server + migrate, log /tmp/opencode/vfx-server.log
npm run seed                    # seed corpus (idempotent)

./scripts/fetch-kenney.sh       # tải Kenney Particle Pack (CC0) → seed/vendor/kenney
npm run seed                    #   → ingest 80 texture Kenney

./scripts/smoke.sh              # chạy đủ 4 gate
```

Skills + MCP cho Unity project đã được bật sẵn:

- `Unity/.mcp.json` → server `vfx-skill` (⚠️ lần đầu mở `claude` phải approve)
- `Unity/.claude/skills/vfx-*` → symlink về repo này

## 4 tool (MCP)

| Tool | Làm gì |
| --- | --- |
| `vfx_search` | Semantic + keyword search → Knowledge Card + `vfx://` URI |
| `vfx_resolve` | URI → version, `file_name`, `download_url`, `sha256`, `dependencies` |
| `vfx_fetch` | URL tải payload. `scripts/vfx-fetch.sh <uri> <unity project root>` ghi file + verify sha256, không đụng `.meta` |
| `vfx_publish` | Payload mới → version mới + `linkDependencies` (cập nhật graph, không overwrite) |

REST kèm: `/healthz`, `/v1/search`, `/v1/resource/:type/:slug/:version[/file]`, `/v1/publish`.

## Corpus

**159 resource · 90 edge (knowledge graph)**

| type | số | nguồn |
| --- | --- | --- |
| `texture` | 108 | 28 Synty (EULA) + 80 Kenney (CC0) |
| `vfx` | 21 | Synty prefab |
| `recipe` | 8 | tự viết (inline YAML) |
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

- `cc0` → 110 record (Kenney 80 + nội dung tự viết 30)
- `synty-store-eula` → 49 record (`proprietary-commercial`, `ai_training=false`)

`license="unknown"` **bị server từ chối** (ingest gate, có test).

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
- Menu `Tools → VFX Cloud → Fetch…` (`VfxCloudFetchWindow`)
- Compile sạch 0 lỗi/0 warning (kiểm bằng `dotnet` + `UnityEngine/UnityEditor.dll`,
  không qua Editor — vì license headless)

## Cut trong V0

`vfx_find_similar`, compose/analyze, patch/rollback engine, capability resolver,
extraction AI, usage/feedback ranking, visibility enforcement, R2 storage, preview
image, visibility phân quyền, `feedback` tool. Nằm ở ladder V0.1–V0.5 trong
`plans/260928-1659-vfx-skill-cloud-v0/plan.md`.

Chưa làm: ingestion Brackeys/OpenGameArt (mới có Kenney + Synty), texture semantic
schema (provenance fields), `preview_uri` (toàn NULL).
