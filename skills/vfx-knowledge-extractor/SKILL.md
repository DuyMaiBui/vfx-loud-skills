---
name: vfx-knowledge-extractor
description: Rút knowledge tái sử dụng từ một VFX vừa hoàn thành rồi contribute lên VFX Skill Cloud — phân loại NEW/REUSE/IMPROVEMENT/DUPLICATE/PROJECT-SPECIFIC/EXPERIMENTAL trước khi vfx_publish. Dùng cho "/vfx learn", "extract knowledge", "contribute back", "trả về cloud".
---

# VFX Knowledge Extractor

Vòng lặp contribute-back. **Không publish toàn bộ** — chỉ phần generalize được.

```
Completed VFX
  ↓  so sánh với corpus (vfx_search nhiều trục)
Extract
  ↓  phân loại 6 mức
Human approval (nếu PROJECT → TEAM/GLOBAL)
  ↓  viết metadata + license thật
vfx_publish
  ↓  verify bằng vfx_search ngay
```

## Bước 1 — So sánh với corpus

Chạy `vfx_search` theo từng trục của VFX vừa làm:

- intent chính (`"ground impact"`)
- element cấu thành (`"shockwave ring"`, `"soft dust"`, `"debris"`)
- kỹ thuật (`"velocity stretch"`, `"depth fade"`)

Ghi lại card nào **đã có** (REUSE) và card nào **thiếu** (candidate NEW).

## Bước 2 — Phân loại

| Mức | Nghĩa | Hành động |
| --- | --- | --- |
| `NEW` | technique/component/texture chưa từng có | publish ngay |
| `REUSE` | chỉ dùng lại đồ có sẵn | **không publish** |
| `IMPROVEMENT` | đã có nhưng bản này hay hơn | publish version mới, ghi `meta.improves` |
| `DUPLICATE` | trùng semantic với card khác | không publish; cân nhắc merge metadata |
| `PROJECT-SPECIFIC` | art riêng của game (boss, chest skin) | **không publish** — giữ PROJECT-private |
| `EXPERIMENTAL` | thử nghiệm chưa ổn định | publish `visibility=project`, `meta.experimental=true` |

Chỉ 4 loại đầu (NEW/REUSE/IMPROVEMENT/EXPERIMENTAL) mới đi tiếp. `PROJECT-SPECIFIC` và `DUPLICATE` dừng ở đây.

## Bước 3 — Tách artifact

Hỏi VFX vừa làm có gì **tái sử được độc lập**:

- texture mới → `type=texture`
- shader/keyword mới → `type=shader`
- C# pattern → `type=code`
- tham số/layer → `type=recipe`
- khối dựng lại được → `type=component`
- cách làm chung → `type=technique`
- workflow → `type=skill`

Mỗi artifact một resource. **Không gộp prefab + texture + recipe vào 1 record.**

## Bước 4 — Metadata

Mỗi record bắt buộc:

- `name`, `description` (tiếng Anh, chứa từ sẽ được search)
- `tags` (5–8, semantic, không trùng name)
- `style` (cartoon/stylized/realistic + mobile/puzzle nếu phù hợp)
- `category`
- **`license` thật** — `unknown` bị server từ chối
- `dependencies` nếu URI chưa nằm trong payload text

## Bước 5 — Publish & verify

```
vfx_publish(...)            → { uri, version, dependencies }
vfx_search(<query liên quan>)  → phải thấy uri vừa ra, score cao
```

Không thấy → dừng, debug (kiểm tra embedding text, license, slug).

## Chống knowledge pollution

- Không publish mọi biến thể nhỏ (`soft-dust-01..09`) — chỉ khi khác biệt cấu trúc thật.
- Không publish tutorial/README chung.
- Không publish file generated (`.meta`, `Library/`).
- Không publish asset có license `unknown` hoặc AI-training-restricted.
- Khi mơ hồ → để `visibility=project`, người ta promote sau.
