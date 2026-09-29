# vfx-finder — worked examples

**Toàn bộ số đếm, tên, URI dưới đây là MINH HOẠ**, không phải dữ liệu thật của corpus.

## 1. Tiếng Việt: "tạo hiệu ứng nổ cho game toon"

Bước 1: "nổ" → `category: explosion`; "toon" → `style: toon`. Đã giải quyết: category, style.

Bước 2: `vfx_facets(type="recipe", filters={category:["explosion"]}, style=["toon"])` → `total: 38`.
Facet còn lại (minh hoạ): `element` fire 20 / smoke 9 / magic 6 / ice 3; `playback` one-shot 33 / loop 5; `colors` orange 18 / white 9 / purple 6 / blue 5.

Bước 3: category+style xong; `element` chia đều nhất (không value nào >55%), `playback` lệch (33/5) → hỏi `element`.

Bước 4 (AskUserQuestion, tiếng Việt):
> Vụ nổ thuộc nguyên tố nào?  — Lửa (20) · Khói (9) · Ma thuật (6) · Băng (3)

User: "Lửa". Re-query → `total: 20`; `scale` small 6 / medium 9 / large 5 chia đều → câu 2:
> Cỡ vụ nổ?  — Vừa (9) · Nhỏ (6) · Lớn (5) · Không quan trọng

User: "Vừa". Re-query → `total: 4` (≤5) → sang bước 5.

Bước 5:
```
1. Toon Fire Burst — toon
   Hành vi: Quả cầu lửa cam nở nhanh rồi tan thành khói mỏng trong khoảng nửa giây.
   one-shot · short · medium · cost low
   vfx://recipe/toon-fire-burst/1
2. Cartoon Bomb Pop — toon / stylized
   Hành vi: Chớp trắng, vòng sóng xung kích bung ra, mảnh lửa nhỏ bắn toả rồi mờ dần.
   one-shot · short · medium · cost medium
   vfx://recipe/cartoon-bomb-pop/1
3. Comic Boom — toon
   Hành vi: Chữ "BOOM" bật to kèm quầng lửa vàng, rung nhẹ rồi thu nhỏ biến mất.
   one-shot · medium · medium · cost low
   vfx://recipe/comic-boom/1
```
Hỏi: "Chọn cái nào, hay muốn tinh chỉnh?" — Chọn 1 / 2 / 3 / Tinh chỉnh / Không cái nào hợp.
User chọn 1 → chuyển `vfx-authoring` với `vfx://recipe/toon-fire-burst/1`.

## 2. English: "blue water splash"

Bước 1: "water" → `element: water`; "splash" → `category: impact` (theo vocab.json); "blue" → `colors: blue`. Không nói style, playback.

Bước 2: `vfx_facets(type="recipe", filters={element:["water"], colors:["blue"], category:["impact"]})` → `total: 14`.
Facet (minh hoạ): `style` stylized 6 / toon 5 / realistic 3; `playback` one-shot 13 / loop 1; `scale` small 7 / medium 5 / large 2.

Bước 3: `playback` lệch (13/1) → bỏ; `style` chia đều nhất → hỏi.

Bước 4:
> Which style?  — Stylized (6) · Toon (5) · Realistic (3)

User: "Toon". Re-query → `total: 5` (≤5) → bước 5 (chỉ dùng 1 câu hỏi).

Bước 5:
```
1. Toon Water Splash — toon
   Behavior: A blue droplet crown bursts up from the surface, then falls back as small rings spread out.
   one-shot · short · small · cost low
   vfx://recipe/toon-water-splash/1
2. Big Blue Plunge — toon / stylized
   Behavior: A tall column of water shoots up, collapses outward into foam, and ripples fade over a second.
   one-shot · medium · large · cost medium
   vfx://recipe/big-blue-plunge/1
```
Ask: "Pick one, refine, or none fits?" (structured question tool). If headless: print the numbered list above and stop.
