---
name: vfx-generator
description: Tạo hoặc sửa một VFX mới trong Unity bằng cách retrieve từ VFX Skill Cloud trước, compose lại nguyên liệu có sẵn, rồi validate. Dùng cho "tạo effect", "làm vụ nổ", "sửa VFX quá trắng", "make an impact", "compose reward burst".
---

# VFX Generator

Orchestrator cho một request tạo/sửa VFX. **Không bắt đầu bằng việc tạo mới** — luôn retrieve trước.

## Flow

```
Request
  ↓  1. hiểu style + intent
vfx_search            (Cloud MCP)
  ↓  2. chọn card
vfx_resolve           → manifest + dependencies
  ↓  3. fetch nguyên liệu (vfx_fetch.sh / Unity menu)
vfx_fetch
  ↓  4. đọc recipe YAML → dựng layers
text-edit trên filesystem   ← text-first
  ↓  5. nếu thao tác Editor-only → Unity MCP
Unity validation            ← Play mode, Console, overdraw
  ↓  6. pass → vfx_knowledge_extract (skill extractor)
vfx_publish
```

## Bước 1 — Hiểu request

Chốt 3 thứ trước khi search:

- **intent**: impact / reward / trail / ambient / magic / ui-feedback
- **style**: cartoon · stylized · realistic — và `mobile` nếu là game mobile
- **quy mô**: single hit / loop / one-shot burst

Ví dụ: *"vụ nổ nhỏ cho puzzle mobile"* → intent=`explosion`, style=`cartoon,mobile`, scale=`small`.

## Bước 2 — Retrieve

```
vfx_search(query="<intent> <style> <key element>", type?, tags?, limit: 8)
```

Chọn theo thứ tự ưu tiên: `recipe` → `component` → `technique` → `shader`/`code` → `texture`/`vfx`.

**Dừng lại nếu**: không có card nào score > 0.5 → mới nghĩ tới tạo asset mới.

## Bước 3 — Resolve & fetch

```
vfx_resolve(uri)      # xem dependencies + license + sha256
vfx_fetch(uri)        # → download_url
scripts/vfx-fetch.sh <uri> <Unity project root>
```

Dependencies (`resource_edge`) là graph — traversal nó để lấy đủ layer trước khi dựng.

## Bước 4 — Compose (text-first)

- `recipe` YAML → dựng từng layer trong ParticleSystem tương ứng.
- `component` YAML → copy tham số (emission, lifetime, size, blend, texture).
- `technique` MD → làm theo Structure + tránh mục **Common mistakes**.
- `shader` / `code` → copy thẳng vào project, sửa text.

Quy tắc sửa: precondition → patch → import → validation → **commit | rollback**. Không overwrite resource; publish version mới.

## Bước 5 — Validate (Unity MCP hoặc Editor tay)

Falsifiable, tối thiểu:

- Play mode chạy, Console không lỗi đỏ.
- Effect spawn đúng vị trí/intent.
- Overdraw không tệ hơn baseline.
- GUID asset cũ không đổi.

Chỉ gọi Unity MCP cho việc **Editor/runtime phải làm** (mở scene, instantiate, screenshot, profiler). Không nhờ nó sửa file text.

## Bước 6 — Contribute

Gọi skill `vfx-knowledge-extractor` để phân loại cái gì mới / cái gì tái dùng, rồi `vfx_publish`.

## Anti-patterns

- Tạo texture mới khi corpus đã có texture cùng semantic.
- Bỏ qua `Common mistakes` trong technique → lặp lại lỗi đã biết.
- Dùng Unity MCP sửa YAML mà Claude edit tay được.
- Publish khi chưa Play mode test.
