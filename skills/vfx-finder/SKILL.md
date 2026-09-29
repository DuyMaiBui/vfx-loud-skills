---
name: vfx-finder
description: Tìm đúng VFX bằng hỏi-đáp: hỏi vài câu thu hẹp (loại, style, màu), rồi đưa 3-5 lựa chọn mô tả style và cách chuyển động. Dùng cho "tìm VFX", "find a VFX", "chọn effect".
---

# VFX Finder

Luồng **tương tác** để chốt đúng một VFX trong Cloud. Không đoán và trả bừa top-1: hỏi ít câu nhưng trúng, cho user **thấy style + cách nó chuyển động**, để user chọn.

Trả lời bằng **ngôn ngữ của user** (Việt hoặc Anh). Facet/URI/tên tool giữ nguyên tiếng Anh.

## Contract (server phải cung cấp)

- Mỗi record: `meta.facets` (mọi key tuỳ chọn), `meta.style` (string[]), `meta.behavior` (1–3 câu tiếng Anh: người xem thấy gì theo thời gian).
- `meta.facets`: `category[]`, `subcategory[]` (`"<category>/<sub>"`), `element[]`, `colors[]`, `playback` (`loop|one-shot`), `duration` (`short|medium|long`), `scale` (`small|medium|large`), `motion[]`, `shape[]`, `renderMode[]`, `cost` (`low|medium|high`).
- `vfx_facets({query?, type?, filters?, style?, keywords?})` → `{total, facets: {<tên>: [{value, count}]}}`. Tên facet = key của `meta.facets` + `"style"`.
- `vfx_search` nhận cùng `filters`; mỗi card có `uri, name, score, description, facets, behavior`.
- Lọc: **OR trong một facet, AND giữa các facet**.

## Flow

### 1. Parse request

Tách request thành `filters` (giá trị facet rõ ràng) và `keywords` (còn lại). Dùng bảng đồng nghĩa/tiếng Việt ở `server/src/vocab.json` làm tham chiếu (không copy vào đây). Vd "nổ" → `category: explosion`, "toon" → `style: toon`, "loop/lặp" → `playback: loop`.

Facet user đã nói = **đã giải quyết**, không hỏi lại.

### 2. Đếm ứng viên

`vfx_facets(query, type="recipe", filters, style?, keywords?)`. Nếu `total ≤ 5` → nhảy sang bước 5. Nếu `total = 0` → xem "Edge cases".

### 3. Chọn câu hỏi kế tiếp (theo information value)

- Chọn facet **chưa giải quyết** mà count các value chia ứng viên **đều nhất** (không value nào áp đảo).
- Ưu tiên thứ tự: category/subcategory → element → style → playback → colors → scale/duration.
- **Không hỏi** facet chỉ có 1 value, hoặc user đã nói, hoặc user đã trả "any".
- Tối đa **3 câu hỏi** cả flow. Hết quota → sang bước 5 dù còn nhiều.

### 4. Hỏi

Dùng tool hỏi có cấu trúc của host (Claude Code: `AskUserQuestion`; nếu bị defer thì `ToolSearch select:AskUserQuestion` trước, không hỏi bằng văn xuôi).

- 2–4 option = top value theo count, kèm count: `Toon (412)`. Có thể thêm option "Không quan trọng / Any".
- **Một câu mỗi lượt.** Sau mỗi đáp án: thêm vào `filters`, gọi lại `vfx_facets`, quay bước 2.

### 5. Đưa option card

`vfx_search(query, type="recipe", filters, limit: 5)`, lấy 3–5 card đầu. Mỗi card theo mẫu:

```
<n>. <name>  —  <style, cách nhau bằng " / ">
   Hành vi: <1 dòng lấy từ `behavior`, dịch sang ngôn ngữ user>
   <playback> · <duration> · <scale> · cost <cost>
   <vfx:// URI>
```

- Dòng "Hành vi" phải đến từ `behavior` của server, **không tự bịa**. Thiếu `behavior` → dùng `description`, ghi rõ "(mô tả, chưa có behavior)".
- Facet nào thiếu thì bỏ khỏi dòng 3, không điền đoán.
- Sau danh sách, hỏi bằng tool hỏi có cấu trúc: chọn 1 card, hoặc "Tinh chỉnh" (quay lại bước 4 với facet chưa hỏi, còn trong quota), hoặc "Không cái nào hợp".

### 6. Chốt

User chọn → chuyển sang flow `vfx-authoring` (`vfx_resolve` → `vfx_fetch` → …). Không nhắc lại các bước đó ở đây.

## Edge cases

| Tình huống | Xử lý |
| --- | --- |
| 0 kết quả | Bỏ filter thêm vào **gần nhất**, gọi lại; nói rõ đã bỏ filter nào ("Không có hiệu ứng *xanh lá*, đã bỏ điều kiện màu"). Vẫn 0 thì bỏ tiếp từng filter một, mỗi lần nói rõ. |
| "any" / "không quan trọng" | Đánh dấu facet đó skipped, không hỏi lại, không thêm filter. Không tính là câu hỏi mới nếu là trả lời cho câu vừa hỏi. |
| User đưa sẵn `vfx://` URI | Bỏ hẳn flow hỏi; đi thẳng `vfx_resolve` theo `vfx-authoring`. |
| Agent routed/headless, không có tool hỏi | Không hỏi. In danh sách **đánh số** (câu hỏi + option kèm count, hoặc option card nếu đã ≤5) rồi **dừng**, chờ user trả lời ở lượt sau. |
| `vfx_facets` lỗi/không có | Fallback `vfx_search` thường theo `vfx-authoring`; báo user finder đang thu hẹp không được. |
| Request quá mơ hồ ("làm cái effect") | Câu đầu hỏi category (top values); không đoán. |

## Ví dụ

2 ví dụ làm sẵn (Việt: "tạo hiệu ứng nổ cho game toon"; Anh: "blue water splash"), số đếm chỉ minh hoạ: `references/examples.md`.
