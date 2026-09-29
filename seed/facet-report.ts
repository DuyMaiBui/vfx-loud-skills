/**
 * Corpus facet report: value distribution per facet (top values, rows missing the facet) and a few
 * meta.behavior samples from different packs.
 *   node seed/facet-report.ts [--top 12] [--samples 5]
 */
import { parseArgs } from 'node:util';
import { pool } from '../server/src/db.ts';
import { ARRAY_FACETS, SCALAR_FACETS } from '../server/src/facets.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { top: { type: 'string' }, samples: { type: 'string' } }, strict: true });
  const top = Number(values.top ?? 12);
  const total = Number((await pool.query('SELECT COUNT(*) AS n FROM resource')).rows[0].n);
  console.log(`rows=${total}`);
  for (const f of [...ARRAY_FACETS, ...SCALAR_FACETS]) {
    const isArr = (ARRAY_FACETS as readonly string[]).includes(f);
    const vals = await pool.query<{ v: string; n: string }>(
      isArr
        ? `SELECT e AS v, COUNT(*) AS n FROM resource, jsonb_array_elements_text(meta->'facets'->'${f}') e GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT $1`
        : `SELECT meta->'facets'->>'${f}' AS v, COUNT(*) AS n FROM resource WHERE meta->'facets' ? '${f}' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT $1`,
      [top],
    );
    const missing = Number((await pool.query(`SELECT COUNT(*) AS n FROM resource WHERE NOT (COALESCE(meta->'facets','{}'::jsonb) ? '${f}')`)).rows[0].n);
    console.log(`\n${f}  (missing on ${missing}/${total})`);
    console.log('  ' + vals.rows.map((r) => `${r.v}=${r.n}`).join('  '));
  }
  const s = await pool.query<{ pack: string; name: string; behavior: string }>(
    `SELECT DISTINCT ON (meta->>'pack') meta->>'pack' AS pack, name, meta->>'behavior' AS behavior
       FROM resource WHERE meta ? 'behavior' ORDER BY meta->>'pack', id LIMIT $1`,
    [Number(values.samples ?? 5) * 2],
  );
  console.log('\nbehavior samples (one per pack)');
  for (const r of s.rows.slice(0, Number(values.samples ?? 5))) console.log(`  [${r.pack}] ${r.name}\n    ${r.behavior}`);
  await pool.end();
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
