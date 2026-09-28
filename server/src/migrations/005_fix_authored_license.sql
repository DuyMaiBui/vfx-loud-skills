-- Fix license cho các record payload TỰ VIẾT (recipe YAML inline) vốn bị default nhầm
-- sang synty-store-eula vì chưa có nhánh mặc định ở seed.
-- Quy tắc: license nói về payload của record, không phải resource mà record tham chiếu
-- (recipe tham chiếu texture Synty vẫn là cc0; texture Synty giữ synty-store-eula).
UPDATE resource
SET license = 'cc0',
    meta = meta || jsonb_build_object('license_class', 'cc0', 'ai_training', true)
WHERE created_by = 'seed'
  AND license = 'synty-store-eula'
  AND meta->>'pack' = 'vfx-skill-cloud-authored';
