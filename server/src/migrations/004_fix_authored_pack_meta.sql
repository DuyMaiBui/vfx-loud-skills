-- Sửa meta.pack cho các record do VFX Skill Cloud tự viết (manifest inline + contentFile),
-- vốn bị gán nhầm vào pack Synty. Record có e.source (file PNG thật của Synty) giữ nguyên.
-- Điều kiện meta->>'source' = 'manifest-inline' là duy nhất: record Synty mang tên file PNG.
UPDATE resource
SET meta = meta || jsonb_build_object('pack', 'vfx-skill-cloud-authored')
WHERE created_by = 'seed'
  AND meta->>'source' = 'manifest-inline'
  AND meta->>'pack' = 'synty-polygon-particle-fx';
