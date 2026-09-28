---
name: trail-streak
category: technique
engine: unity
license: cc0
---

# Trail Streak

Dùng khi: projectile trail · swoosh · wing flap trail · dash after-image.

## Structure

1. Chọn: **Trail Renderer** trong ParticleSystem, hoặc Renderer → bật trail.
2. Tiêm lifetime particle ngắn (0.15–0.3s), time 0.2–0.4.
3. Width curve rơi về 0 ở đuôi.
4. Không dùng texture hình tròn → dùng streak: `vfx://texture/bullet-trail-01/1`.
5. Texture mode = **Stretch** (Rotate Together) để đuôi không méo.

## Nguyên liệu tái dùng

- streak texture: `vfx://texture/bullet-trail-01/1`
- recipe: `vfx://recipe/projectile-trail/1`
- kỹ thuật kéo giãn: `vfx://technique/stretched-particle/1`

## Mobile notes

- Trail với nhiều point = nhiều vertex. Giử minVertexDistance ≈ 0.1.
- Tắt trail khi object đứng yên (time = 0) để không tạo blob.

## Common mistakes

- Trail time dài hơn lifetime projectile → vệt treo lơ lửng sau khi đạn biến mất.
- Dùng additive trên trail sáng giữa ngày → mất độ tương phản.
