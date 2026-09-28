---
name: depth-fade-particle
category: technique
engine: unity
license: cc0
---

# Depth Fade (Soft Particles)

Dùng khi: smoke chạm đất · fog · dust sát tường · water splash.

## Structure

1. Bật **Soft Particles** (URP: Depth Texture ON, camera depth prepass nếu cần).
2. `Soft Particles Fade Distance` = 0.2–0.6 (mobile giữ nhỏ).
3. Nếu không soft → particle hiện **đường cắt cứng** khi gặp geometry.

## Nguyên liệu tái dùng

- smoke: `vfx://texture/smoke-01/1`
- soft spot: `vfx://texture/soft-spot-01/1`
- shader alpha: `vfx://shader/particle-soft-alpha/1`
- recipe: `vfx://recipe/soft-smoke-plume/1`

## Performance

- Depth texture = thêm 1 lần resolve trên mobile. Chỉ bật khi project đã cần camera depth.
- Không kết hợp depth fade + alpha-to-coverage.

## Common mistakes

- Depth fade bật nhưng camera không có depth texture → soft particle biến mất hoàn toàn.
- Fade distance quá lớn (> 1.5) → particle mờ dần khi đứng gần, khó thấy trên màn nhỏ.
