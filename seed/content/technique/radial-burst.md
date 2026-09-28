---
name: radial-burst
category: technique
engine: unity
license: cc0
---

# Radial Burst

Dùng khi: impact · explosion · pickup burst · destruction · celebration.

## Structure

1. Spawn toàn bộ particle từ một điểm.
2. Hướng = random đều trên hình tròn (2D) hoặc trên cầu (3D).
3. Velocity ban đầu cao, có drag để chậm lại.
4. Scale giảm theo lifetime.
5. Alpha rơi về 0 ở ~70–80% lifetime.

## Nguyên liệu tái dùng

- shockwave: `vfx://texture/ring-01/1`
- core: `vfx://texture/circle-01/1`
- debris: `vfx://texture/ground-break-01/1`
- recipe mẫu: `vfx://recipe/cartoon-ground-impact/1`
- component mẫu: `vfx://component/debris-burst/1`

## Mobile notes

- Một ParticleSystem duy nhất, dùng burst emission thay vì spawn GameObject từng cái.
- Tránh MonoBehaviour per-particle.
- Dùng atlas: `vfx://texture/particle-sheet-a/1`

## Common mistakes

- Velocity tuyến tính → trông giả. Luôn có drag.
- Cùng lifetime cho mọi particle → chuyển động cơ khí.
- Quá nhiều particle spawn cùng lúc → overdraw spike (giữ burst count ≤ 12 cho puzzle mobile).
