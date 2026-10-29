// Emits targets.json for the VFXPreview renderer:
// extracted recipes with empty meta.family + the canonical (lowest-slug) member of each family,
// plus every extracted recipe WITHOUT a prefab as {slug, prefabGuid:null} (the render records it as skipped:no-prefab, so
// `preview_render` covers every recipe that is a target or skipped by design), plus every published DERIVED recipe (publish-back: skills/vfx-authoring) that depends on a `.prefab` record.
// A derived recipe's prefab must be on disk in the preview project first: scripts/vfx-fetch.sh <recipe uri> unity/VFXPreview.
// The 10 hand-written recipes (recipe-spec.ts HAND_WRITTEN) are appended as {prefabGuid:null}.
// usage: node tools/preview/targets.ts [out=tools/preview/targets.json]
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { HAND_WRITTEN } from '../recipe-prefab/recipe-spec.ts';

const out = process.argv[2] ?? new URL('./targets.json', import.meta.url).pathname;

// DATABASE_URL wins. Without it, build the local dev URL from PG* parts (libpq names) with the dev defaults of
// the local vfx-pg container (scripts/dev-db.sh). Built via URL so no source line carries a literal user:pass@ URL.
function devDatabaseUrl(): string {
  const u = new URL(`postgres://${process.env.PGHOST ?? '127.0.0.1'}:${process.env.PGPORT ?? '5432'}/${process.env.PGDATABASE ?? 'vfxcloud'}`);
  u.username = process.env.PGUSER ?? 'vfx';
  u.password = process.env.PGPASSWORD ?? 'vfx';
  return u.toString();
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? devDatabaseUrl() });
const { rows } = await pool.query(`
  SELECT DISTINCT ON (COALESCE(NULLIF(meta->>'family',''), slug))
         slug, meta->>'pack' AS pack, meta->'source'->>'prefabPath' AS "prefabPath",
         meta->'source'->>'prefabGuid' AS "prefabGuid", COALESCE(meta->>'family','') AS family,
         meta->'facets'->>'playback' AS playback
    FROM resource
   WHERE type = 'recipe' AND meta->>'extracted' = 'true' AND meta->'source'->>'prefabGuid' IS NOT NULL
   ORDER BY COALESCE(NULLIF(meta->>'family',''), slug), slug`);
const derived = await pool.query(`
  SELECT DISTINCT ON (r.slug) r.slug, r.meta->>'pack' AS pack, p.slug AS "prefabSlug",
         COALESCE(p.meta->'unity'->>'guid', '') AS "prefabGuid", r.meta->'facets'->>'playback' AS playback
    FROM resource r
    JOIN resource_edge e ON e.src = r.id AND e.rel = 'uses'
    JOIN resource p ON p.id = e.dst AND p.type = 'vfx' AND p.storage_uri LIKE '%.prefab'
   WHERE r.type = 'recipe' AND r.meta ? 'derived'
   ORDER BY r.slug, p.slug`);
const noPrefab = await pool.query(`
  SELECT slug, meta->>'pack' AS pack, meta->'facets'->>'playback' AS playback
    FROM resource
   WHERE type = 'recipe' AND meta->>'extracted' = 'true' AND meta->'source'->>'prefabGuid' IS NULL
   ORDER BY slug`);
// The hand-written recipes have no prefab and are not `extracted`: list them as prefabGuid:null so tools/recipe-prefab/merge-targets.ts can fill the built ones.
const handWritten = await pool.query(
  `SELECT DISTINCT slug, meta->>'pack' AS pack, meta->'facets'->>'playback' AS playback FROM resource WHERE type = 'recipe' AND slug = ANY($1) ORDER BY slug`,
  [HAND_WRITTEN]);
await pool.end();
const targets = rows.map((r) => ({ slug: r.slug, pack: r.pack, prefabPath: r.prefabPath, prefabGuid: r.prefabGuid, family: r.family, playback: r.playback ?? '' }));
for (const d of derived.rows) {
  targets.push({ slug: d.slug, pack: d.pack ?? '', prefabPath: `Assets/VFXCloud/vfx/${d.prefabSlug}/${d.prefabSlug}.prefab`, prefabGuid: d.prefabGuid, family: '', playback: d.playback ?? '' });
}
for (const n of noPrefab.rows) {
  targets.push({ slug: n.slug, pack: n.pack ?? '', prefabPath: null, prefabGuid: null, family: '', playback: n.playback ?? '' });
}
const have = new Set(targets.map((t) => t.slug));
for (const h of handWritten.rows) if (!have.has(h.slug)) targets.push({ slug: h.slug, pack: h.pack ?? '', prefabPath: null, prefabGuid: null, family: '', playback: h.playback ?? '' });
writeFileSync(out, JSON.stringify(targets, null, 1));
console.log(`${targets.length} targets -> ${out}`);
