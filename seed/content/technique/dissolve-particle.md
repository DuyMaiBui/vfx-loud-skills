---
name: dissolve-particle
category: technique
engine: unity
license: cc0
---

# Dissolve Particle

Dùng khi: smoke tan dần · magic biến mất · corpse rã · fire tắt.

## Structure

1. Shader graph/code nhận `_Dissolve` (0 → 1 theo lifetime).
2. Noise texture 1 sample (không procedural) → so với threshold.
3. Softness = 0.05–0.15 để mép tan mượt.
4. Alpha clip khi noise < threshold; giữ alpha còn lại đang fade.

## Parameters

`_Dissolve` · `_NoiseScale` · `_Softness` · `_Alpha` · `_Color`

## Nguyên liệu tái dùng

- shader: `vfx://shader/particle-dissolve/1`
- noise/spot: `vfx://texture/soft-spot-dark-01/1`
- smoke: `vfx://texture/smoke-01/1`
- technique nền: `vfx://technique/flipbook-smoke/1`

## Performance

- Tối đa 1 texture sample cho noise.
- **Tránh**: nhiều lần procedural noise, screen-space sampling, distortion đắt trên mobile.
- Phù hợp: Particle System + VFX Graph.

## Common mistakes

- Dissolve theo alpha thay vì theo noise → tan đều, không có "ngọn lửa ăn mòn".
- Noise scale quá lớn → hạt lấm tấm, mất cảm giác mượt.
