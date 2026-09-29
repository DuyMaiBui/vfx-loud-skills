// Emits targets.json for the VFXPreview renderer:
// extracted recipes with empty meta.family + the canonical (lowest-slug) member of each family.
// usage: node tools/preview/targets.ts [out=tools/preview/targets.json]
import { writeFileSync } from 'node:fs';
import pg from 'pg';

const out = process.argv[2] ?? new URL('./targets.json', import.meta.url).pathname;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://vfx:vfx@127.0.0.1:5432/vfxcloud' });
const { rows } = await pool.query(`
  SELECT DISTINCT ON (COALESCE(NULLIF(meta->>'family',''), slug))
         slug, meta->>'pack' AS pack, meta->'source'->>'prefabPath' AS "prefabPath",
         meta->'source'->>'prefabGuid' AS "prefabGuid", COALESCE(meta->>'family','') AS family,
         meta->'facets'->>'playback' AS playback
    FROM resource
   WHERE type = 'recipe' AND meta->>'extracted' = 'true' AND meta->'source'->>'prefabGuid' IS NOT NULL
   ORDER BY COALESCE(NULLIF(meta->>'family',''), slug), slug`);
await pool.end();
const targets = rows.map((r) => ({ slug: r.slug, pack: r.pack, prefabPath: r.prefabPath, prefabGuid: r.prefabGuid, family: r.family, playback: r.playback ?? '' }));
writeFileSync(out, JSON.stringify(targets, null, 1));
console.log(`${targets.length} targets -> ${out}`);
