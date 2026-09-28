---
name: mesh-particle
category: technique
engine: unity
license: cc0
---

# Mesh Particle

Dùng khi: shell ejection · coin · debris 3D · lá rơi · explosion shards.

## Structure

1. Renderer → Render Mode = **Mesh**, chọn mesh thật (không billboard).
2. Rotation → kiểm tra 3-axis random; tránh gimbal flip khi angular velocity cao.
3. Shading = Deferred/Lit nếu mesh cần nắng; Unlit nếu stylized flat.
4. Collision/Physics → dùng baked curve, không bật Unity Physics per-particle.

## Nguyên liệu tái dùng

- shell casing texture: `vfx://texture/shell-01/1`
- shard: `vfx://texture/hexagon-01/1`
- prefab mẫu: `vfx://vfx/money-coins-burst/1`, `vfx://vfx/sparks/1`
- technique liên quan: `vfx://technique/radial-burst/1`

## Mobile notes

- Mesh particle = nhiều triangle. Giữ ≤ 100 tri/particle, count ≤ 20.
- Prefer 1 mesh atlas material thay vì mỗi loại 1 material.

## Common mistakes

- Mesh scale 0 → không thấy gì (kiểm tra `startSize` và mesh bounds).
- Shadow casting bật cho mọi mesh particle → shadow pass đắt; chỉ bật cho boss moment.
