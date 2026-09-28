---
name: stretched-particle
category: technique
engine: unity
license: cc0
---

# Stretched Particle (Velocity Stretch)

Dùng khi: bullet tracer · spark · debris bay nhanh · rain.

## Structure

1. Renderer → **Stretch Axis = Velocity**, Length Scale 1.5–3.0, Velocity Scale 0.5–1.
2. Alignment = Local (hoặc View nếu camera cố định).
3. Texture phải là **symmetric theo trục dài** → dùng `vfx://texture/bullet-trail-01/1`.
4. Speed cao (> 8) thì giảm length scale, không tăng thêm speed.

## Nguyên liệu tái dùng

- streak: `vfx://texture/bullet-trail-01/1`
- recipe: `vfx://recipe/projectile-trail/1`
- kỹ thuật liên quan: `vfx://technique/trail-streak/1`

## Mobile notes

- Stretch làm quad to ra → overdraw tăng theo bề mặt. Giữ lifetime ≤ 0.3s.
- Không kết hợp stretch + rotation random → méo hình.

## Common mistakes

- Stretch khi speed ≈ 0 → particle xẹp thành vệt, biến mất.
- Dùng texture asymmetric (nửa sáng/nửa tối) → đầu đuôi đảo lộn khi quay.
