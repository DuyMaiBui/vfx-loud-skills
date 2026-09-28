-- Backfill meta.license_class / meta.ai_training cho các bản ghi seed trước khi taxonomy tồn tại.
-- Xem LICENSES.md.  Nguyên tắc: thiếu bằng chứng → ai_training = false.
UPDATE resource
SET meta = meta || jsonb_build_object(
  'license_class', CASE
    WHEN lower(license) = 'cc0' THEN 'cc0'
    WHEN lower(license) LIKE 'cc-by%' THEN 'cc-attribution'
    WHEN lower(license) = 'synty-store-eula' THEN 'proprietary-commercial'
    WHEN lower(license) = 'restricted' THEN 'restricted'
    ELSE 'unknown'
  END,
  'ai_training', (lower(license) = 'cc0'
                  OR lower(license) LIKE 'cc-by%'
                  OR lower(license) = 'ai-training-allowed')
)
WHERE meta->>'license_class' IS NULL;
