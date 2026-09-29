/**
 * Recolor validation study.  npm run recolor:validate [-- --json out.json] [--verbose] [--limit N]
 *
 * Answers one question with evidence: **is recolouring the family base a good substitute for fetching
 * the real colour variant?** For every family that has a base and >= 1 variant it recolours the base
 * toward the variant's dominant colour and compares the result against the variant's actual params.
 *
 * Per family it reports:
 *   dE   — CIEDE2000 distance per matched colour key (mean / p90 / max), the "how wrong is the colour"
 *   keys — fraction of the variant's colour keys a recoloured base can produce at all
 *   verdict good | partial | poor
 *
 * A `poor` verdict has a mechanical cause, and the study names it:
 *   texture  — base and variant reference DIFFERENT textures, so the colour is baked into the image
 *              and no param shift and no material tint can reach it
 *   material — base and variant reference different materials/shaders (a different renderer, not a recolour)
 *   params   — same assets, but the params differ beyond hue (alpha ramps, key counts, structure)
 *   no-keys  — the variant carries no reachable colour key to compare against
 *
 * Read-only: never writes to the DB or to a payload.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { config } from '../server/src/config.ts';
import { pool } from '../server/src/db.ts';
import { parsePayload } from './extract/enrich.ts';
import { analysePayload, type AssetRef } from './graph/payload.ts';
import { evaluateFamily, percentile, VERDICT, type FamilyMember, type FamilyResult, type Reason, type VariantResult } from './graph/recolorable.ts';
import { loadRules } from './graph/rules.ts';

// The verdict logic lives in ./graph/recolorable.ts (shared with graph:build); re-exported so this
// module's public surface is unchanged.
export * from './graph/recolorable.ts';

interface Row {
  id: number;
  uri: string;
  slug: string;
  name: string;
  storage_uri: string;
  meta: { family?: string; pack?: string; source?: { prefabPath?: string } };
}

/* ------------------------------------------------------------------ the study */

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { json: { type: 'string' }, verbose: { type: 'boolean' }, limit: { type: 'string' }, 'top': { type: 'string' } },
    strict: true,
  });
  const rules = loadRules();
  const rows = (
    await pool.query<Row>(
      `SELECT id, uri, slug, name, storage_uri, meta FROM resource
        WHERE type = 'recipe' AND meta->>'extracted' = 'true' AND meta->>'family' IS NOT NULL
        ORDER BY meta->>'family', slug`,
    )
  ).rows;

  const byFamily = new Map<string, Row[]>();
  for (const r of rows) (byFamily.get(r.meta.family!) ?? byFamily.set(r.meta.family!, []).get(r.meta.family!)!).push(r);

  const payloads = new Map<number, { text: string; parsed: unknown }>();
  const facts = new Map<number, { assets: AssetRef[] }>();
  const load = async (r: Row): Promise<void> => {
    if (payloads.has(r.id)) return;
    const text = await fs.readFile(path.join(config.dataDir, r.storage_uri), 'utf8');
    payloads.set(r.id, { text, parsed: parsePayload(text) });
    facts.set(r.id, analysePayload(text, { assets: rules.assets, versionTokenPattern: rules.family.versionTokenPattern }));
  };

  const families: FamilyResult[] = [];
  const variants: VariantResult[] = [];
  const limit = values.limit ? Number(values.limit) : Number.POSITIVE_INFINITY;

  for (const [key, members] of [...byFamily].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (families.length >= limit) break;
    if (members.length < 2) continue; // a family with no variant has nothing to validate against
    // Canonical = lowest slug, matching seed/graph/family.ts.
    const sorted = [...members].sort((a, b) => (a.slug < b.slug ? -1 : 1));
    const base = sorted[0];
    const rest = sorted.slice(1);
    await load(base);
    for (const v of rest) await load(v);
    const member = (r: Row): FamilyMember => ({ uri: r.uri, parsed: payloads.get(r.id)!.parsed, facts: facts.get(r.id)! });
    const ev = evaluateFamily(key, member(base), rest.map(member));
    variants.push(...ev.variants);
    families.push(ev.family);
  }

  const byVerdict = {
    good: families.filter((f) => f.verdict === 'good').length,
    partial: families.filter((f) => f.verdict === 'partial').length,
    poor: families.filter((f) => f.verdict === 'poor').length,
    unmeasured: families.filter((f) => f.verdict === 'unmeasured').length,
  };
  const byReason = new Map<Reason, number>();
  for (const f of families) if (f.reason) byReason.set(f.reason, (byReason.get(f.reason) ?? 0) + 1);
  const measuredVariants = variants.filter((v) => Number.isFinite(v.dE));
  const allDE = measuredVariants.map((v) => v.dE).sort((a, b) => a - b);

  const report = {
    families: families.length,
    variants: variants.length,
    /** variants with a distance that could be computed — the population every dE number below covers */
    variantsMeasured: measuredVariants.length,
    /** excluded from dE: no colour key on the variant, or none on the base to shift */
    variantsUnmeasurable: variants.length - measuredVariants.length,
    byVerdict,
    byReason: Object.fromEntries([...byReason].sort((a, b) => b[1] - a[1])),
    dE: {
      mean: allDE.length ? allDE.reduce((s, x) => s + x, 0) / allDE.length : NaN,
      p10: percentile(allDE, 10),
      p50: percentile(allDE, 50),
      p90: percentile(allDE, 90),
      p99: percentile(allDE, 99),
      max: allDE.length ? allDE[allDE.length - 1] : NaN,
    },
    keyCoverageMean: measuredVariants.length ? measuredVariants.reduce((s, v) => s + v.keyCoverage, 0) / measuredVariants.length : 0,
    thresholds: VERDICT,
  };

  const line = (f: FamilyResult): string =>
    `${f.verdict.padEnd(10)} dE=${(Number.isFinite(f.dE) ? f.dE.toFixed(1) : '-').padStart(6)} p90=${(Number.isFinite(f.dE_p90) ? f.dE_p90.toFixed(1) : '-').padStart(6)} ` +
    `keys=${(f.keyCoverage * 100).toFixed(0).padStart(3)}%  ${f.good}/${f.variants} ok  ${(f.reason ?? '-').padEnd(13)} ${f.family}`;

  if (values.json) await fs.writeFile(values.json, JSON.stringify({ report, families, variants }, null, 1));

  console.log(JSON.stringify(report, null, 1));
  const top = Number(values.top ?? 5);
  console.log(`\n== ${top} GOOD families (recolor reproduces every variant) ==`);
  for (const f of families.filter((x) => x.verdict === 'good').slice(0, top)) console.log(line(f));
  console.log(`\n== ${top} POOR families (fetch the real variant) ==`);
  for (const f of families.filter((x) => x.verdict === 'poor').sort((a, b) => b.dE - a.dE).slice(0, top)) console.log(line(f));
  if (byVerdict.unmeasured) {
    console.log(`\n== ${byVerdict.unmeasured} UNMEASURED families (no colour key to compare) ==`);
    for (const f of families.filter((x) => x.verdict === 'unmeasured').slice(0, top)) console.log(line(f));
  }
  if (values.verbose) {
    console.log('\n== all families ==');
    for (const f of [...families].sort((a, b) => a.dE - b.dE)) console.log(line(f));
  }
}

main().catch((e) => {
  console.error(`error: ${(e as Error).stack ?? e}`);
  process.exitCode = 1;
});
