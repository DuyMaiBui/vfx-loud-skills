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
- `vfx_search` nhận cùng `filters`; mỗi card có `uri, name, score, description, facets, behavior`, `recolorable` (`true|false|null`) + `recolorReason` (`ok|params|texture|no-keys|no-base-keys`), `variants: [{uri, colors, name}]` (các biến thể màu/version của cùng effect đã gộp vào card, gồm chính nó; `[]` nếu không có) và `pairsWith: [{uri, name, category}]` (effect cùng bộ: muzzle / projectile / impact). `collapseVariants:false` để tắt gộp.
- `vfx_recolor({uri, targetColor | hueShiftDeg, preserveLuminance?, publish?, includePayload?})` → payload đã đổi màu + `tint` + `changes`; `publish:true` tạo record MỚI `derived_from` (idempotent, license kế thừa). Chỉ tin khi `recolorable: true`: họ biến thể đã đo, recolor base ≈ bản màu thật (dE ≤ 10 trên mọi biến thể). `false`/`null` = màu nằm trong texture hoặc params khác hue → **lấy biến thể thật**.
- `vfx_related({uri, rel?, limit?})` → hàng xóm trong graph (`variant_of`, `pairs_with`, `similar_to`, `applies_to`).
- `vfx_review({uris | q, type?, filters?, set?, per?, limit?})` → `{session, url, count}`: trang web so sánh bằng mắt (`url` dạng `http://localhost:8787/review?session=…`). `vfx_review_result({session})` → `{selection: [{uri, role, chosen_at}], uris, query}`; `selection` rỗng = user chưa bấm "Gửi lựa chọn". Với `set` (`["muzzle","projectile","impact"]`) mỗi role một cột, mỗi role user chọn tối đa một effect. Preview video có thể chưa có: card ghi "chưa có preview", review vẫn dùng được (so bằng tên / behavior / màu).
- Lọc: **OR trong một facet, AND giữa các facet**.

## Review flow (xem bằng mắt, chọn cả bộ)

Dùng thay cho bước 5 dạng text khi: (a) user xin **BỘ** effect ("bộ skill lửa: muzzle, projectile, impact", "cả set"), hoặc (b) user muốn **so sánh bằng mắt** vài ứng viên ("cho tôi xem", "compare"). Yêu cầu một effect đơn, đã rõ → giữ luồng text bên dưới.

1. Parse request như bước 1. Bộ → `set` = các role user nêu (tên category: muzzle, projectile, impact, ...); thiếu role thì hỏi bằng tool hỏi có cấu trúc, không đoán. Đã có sẵn danh sách ứng viên → `uris`.
2. `vfx_review({q, type:"recipe", filters, set, per: 6})` (hoặc `{uris}`) → lấy `url` và `session`. Một call, không cần `vfx_facets`/`vfx_search` trước; `filters` chỉ khi user đã nói rõ (element, style, colors...).
3. Đưa user **URL đó** (nguyên văn, `http://localhost:8787/review?session=…`) và nói: mở, chọn mỗi role một effect (xem video nếu có), bấm "Gửi lựa chọn". Cho biết `count` ứng viên. Nếu nhiều card ghi "chưa có preview" thì nói thẳng là chưa có video, chọn theo behavior/màu.
4. Hỏi bằng tool hỏi có cấu trúc (Claude Code: `AskUserQuestion`; bị defer thì `ToolSearch select:AskUserQuestion` trước): **"Đã chọn xong và bấm Gửi lựa chọn chưa?"** (option: "Xong rồi", "Cho thêm ứng viên / đổi tiêu chí", "Bỏ"). Không có tool hỏi (routed/headless) → in URL rồi **dừng**, chờ lượt sau.
5. "Xong rồi" → `vfx_review_result({session})`. `selection` rỗng → nói user chưa gửi, hỏi lại (đừng tự chọn top-1). "Thêm/đổi tiêu chí" → tạo session MỚI (`vfx_review` lại), không sửa session cũ.
6. Với **từng** pick trong `selection` (dùng `uri` + `role`): áp dụng bước 6 dưới đây (recolor nếu `recolorable` và user muốn màu khác, ngược lại `vfx_resolve` → `vfx_fetch` theo `vfx-authoring`). Không hỏi lại "kèm muzzle/impact?": bộ đã được chọn theo role. Tóm tắt cuối: mỗi role → effect nào, màu nào.

Không mở URL hộ user, không thử tải `url` bằng tool (trang chỉ dành cho trình duyệt của user). Server không chạy / `vfx_review` lỗi → quay về luồng text (bước 1–6) và báo user ngắn gọn.

## Flow (text-card, mặc định và fallback)

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
   Màu: <colors của variants, cách nhau " / ">        (chỉ khi variants có ≥2 màu; bỏ dòng nếu không)
   Màu: có thể đổi màu                               (chỉ khi `recolorable: true`; ghi ở dòng riêng, cạnh/sau dòng màu trên)
   <playback> · <duration> · <scale> · cost <cost>
   <vfx:// URI>
```

- Dòng "Màu" lấy từ `variants[].colors` của server (vd `Màu: blue / red / green`), không tự suy. Một card = một họ biến thể; user chọn màu ở bước 6.
- Dòng `Màu: có thể đổi màu` chỉ in khi card có `recolorable === true` (server đã đo). `false`/`null` → **không in**, không đoán.

- Dòng "Hành vi" phải đến từ `behavior` của server, **không tự bịa**. Thiếu `behavior` → dùng `description`, ghi rõ "(mô tả, chưa có behavior)".
- Facet nào thiếu thì bỏ khỏi dòng 3, không điền đoán.
- Sau danh sách, hỏi bằng tool hỏi có cấu trúc: chọn 1 card, hoặc "Tinh chỉnh" (quay lại bước 4 với facet chưa hỏi, còn trong quota), hoặc "Không cái nào hợp".

### 6. Chốt

**Card `recolorable: true`** — khi user chọn, đề nghị đổi màu bằng `vfx_recolor` thay vì lấy biến thể (tool hỏi có cấu trúc; option: các màu trong `variants` (dùng đúng biến thể thật), "Đổi sang màu khác…" (hỏi hex hoặc tên màu → `targetColor`), hoặc "Lấy biến thể có sẵn"). Chọn đổi màu → `vfx_recolor({uri: <uri card>, targetColor | hueShiftDeg, publish: true, includePayload: false})`, rồi `vfx_fetch(published.uri)`. Báo user số `changes`; `tint` không rỗng thì nói material cần nhuộm trên BẢN SAO. `published.created:false` = đã có từ trước, dùng lại. Muốn đúng màu đã có trong `variants` thì lấy biến thể thật, không recolor.

**Card `recolorable: false`** (hoặc `null`) — không đề nghị recolor: user cần màu khác thì lấy đúng biến thể trong `variants` (hoặc `vfx_related(uri, rel:"variant_of")`) như dưới; `recolorReason: texture` = màu nằm trong ảnh, không đổi bằng tham số được. Không có biến thể màu đó → nói thẳng là không có, đừng recolor.

Nếu card có nhiều màu trong `variants` mà user chưa nói màu (và không đi nhánh recolor), hỏi màu (tool hỏi có cấu trúc, option = các màu trong `variants`) rồi dùng `uri` của biến thể đó.

Sau khi user chọn xong 1 effect và `pairsWith` không rỗng: hỏi thêm bằng tool hỏi có cấu trúc **"Kèm muzzle/impact cùng bộ?"** (câu hỏi ghi theo `category` có thật trong `pairsWith`, vd muzzle / projectile / impact; option: từng companion `name`, "Lấy cả bộ", "Không, chỉ cái này"). Companion khác màu thì lấy `vfx_related(uri, rel:"pairs_with")` của biến thể đã chọn. Không có tool hỏi → in danh sách đánh số rồi dừng. Companion được chọn cũng đi qua flow dưới.

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
