---
name: shockwave-ring
category: technique
engine: unity
license: cc0
---

# Shockwave Ring

Dùng khi: ground impact · landing · boss slam · ability cast start.

## Structure

1. Một quad/circle facing camera (hoặc align theo surface normal nếu là decal).
2. Scale nhanh từ 0.2 → 1.8 trong 0.25–0.35s.
3. Blend **additive**, không alpha — ring không được che ảnh phía sau.
4. Alpha 1 → 0 tuyến tính, kết thúc trước khi scale chạm đích.
5. Không xoay; giữ rotation cố định để ring tròn.

## Nguyên liệu tái dùng

- texture ring: `vfx://texture/ring-01/1`
- recipe tham chiếu: `vfx://recipe/cartoon-ground-impact/1`
- component: `vfx://component/shockwave-ring/1`
- biến thể semicircle (spray một chiều): `vfx://texture/semicircle-01/1`

## Khi nào KHÔNG dùng

- Surface nghiêng mạnh → dùng `vfx://technique/surface-decal-impact/1` thay vì ring billboard.
- Hiệu ứng nhỏ (pickup) → ring quá nặng, dùng `vfx://texture/circle-02/1` pop nhẹ.

## Common mistakes

- Scale > 2.0 → ring thành vòng tròn mỏng, mất cảm giác lực.
- Đặt ring cùng layer alpha với dust → hai lớp che nhau, mất độ sâu.
