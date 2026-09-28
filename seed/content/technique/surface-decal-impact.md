---
name: surface-decal-impact
category: technique
engine: unity
license: cc0
---

# Surface Decal / Aligned Impact

Dùng khi: impact trên tường/sàn nghiêng · bullet hole · footstep trên mặt phẳng · wet splash.

## Structure

1. Spawn particle tại điểm va chạm, **Rotation = Quaternion.LookRotation(normal)**.
2. Renderer → Alignment = **3D World** (không billboard) để decal dính mặt phẳng.
3. Scale theo hướng dọc bình thường để không bị **z-fighting** (offset nhẹ 0.01).
4. Alpha fade cuối lifetime, không scale về 0 (mất decal sớm).

## Nguyên liệu tái dùng

- debris/break: `vfx://texture/ground-break-01/1`
- half-circle spray: `vfx://texture/half-circle-01/1`
- recipe: `vfx://recipe/cartoon-ground-impact/1`
- controller pattern: `vfx://code/surface-impact-controller/1`
- kỹ thuật đối lập (billboard): `vfx://technique/shockwave-ring/1`

## Khi nào cần Unity MCP

- Resolve surface normal/UV trỏ về material → cần Editor/runtime.
- Đặt decal vào đúng sorting/queue với shader của môi trường.

## Common mistakes

- Alignment = View cho decal → decal quay theo camera, trượt trên tường khi camera di chuyển.
- Quên offset → z-fighting nhấp nháy.
