---
name: flipbook-smoke
category: technique
engine: unity
license: cc0
---

# Flipbook Smoke (Texture Sheet Animation)

Dùng khi: smoke · steam · cloud · fumes có chuyển động bên trong.

## Structure

1. ParticleSystem → **Texture Sheet Animation** → Mode = Grid, Tiles = NxN (4x4 hoặc 8x8).
2. Cycles 1–2; với smoke giữ **Cycles = 1** để không bị lặp lộ.
3. Frame over Time = Two Constants để điều tốc (0 → 1) hoặc linear.
4. Blend **alpha**, không additive (smoke additive sẽ sáng lên khi chồng).
5. Tiling phải khớp texture atlas — không dùng `vfx://texture/particle-sheet-a/1` làm flipbook.

## Nguyên liệu tái dùng

- smoke puff: `vfx://texture/smoke-01/1`
- fumes: `vfx://texture/fumes-01/1`, `vfx://texture/fumes-02/1`
- recipe: `vfx://recipe/soft-smoke-plume/1`
- component: `vfx://component/soft-dust/1`

## Mobile notes

- Flipbook = nhiều frame → không tăng draw call nhưng tăng bandwidth. Ẩn nửa frame cuối nếu lifetime ngắn.
- Không simultaneous flipbook + rotation random cao → vệt màu nhòe.

## Common mistakes

- Tiles sai (ví dụ 8x8 nhưng texture chỉ 4x4) → hiện 16 bức ảnh nhỏ trong 1 particle.
- Alpha map bị premultiply sai → viền đen quanh puff.
