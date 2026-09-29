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
import { type Colour, colourDistance, rgbToHex } from '../server/src/colour.ts';
import { payloadColours, recolor } from '../server/src/recolor.ts';
import { parsePayload } from './extract/enrich.ts';
import { analysePayload, type AssetRef } from './graph/payload.ts';
import { loadRules } from './graph/rules.ts';

interface Row {
  id: number;
  uri: string;
  slug: string;
  name: string;
  storage_uri: string;
  meta: { family?: string; pack?: string; source?: { prefabPath?: string } };
}

export type Verdict = 'good' | 'partial' | 'poor' | 'unmeasured';
export type Reason = 'texture' | 'material' | 'params' | 'no-keys' | 'no-base-keys' | null;

export interface FamilyResult {
  family: string;
  base: string;
  variants: number;
  /** variants a recoloured base reproduces well */
  good: number;
  partial: number;
  poor: number;
  /** variants with no colour key to compare — excluded from the dE numbers, never counted as good */
  unmeasured: number;
  /** mean over variants of the mean per-key CIEDE2000 */
  dE: number;
  dE_p90: number;
  dE_max: number;
  /** mean over variants of (matched keys / variant keys) */
  keyCoverage: number;
  verdict: Verdict;
  reason: Reason;
  /** the worst variant, for the sample listings */
  worst: string | null;
}

export interface VariantResult {
  base: string;
  variant: string;
  family: string;
  dE: number;
  dE_p90: number;
  dE_max: number;
  keyCoverage: number;
  keysVariant: number;
  /** colour keys the BASE has — 0 here means the transform had nothing to shift, not that it failed */
  keysBase: number;
  verdict: Verdict;
  reason: Reason;
}

/* ------------------------------------------------------------------ colour extraction */

/** A colour that carries no hue information (white core, black smoke) cannot be a recolor target. */
const isChromatic = (c: Colour): boolean => {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  return max > 0.06 && (max - min) / max >= 0.16;
};

/** The colour the variant reads as: the most saturated chromatic colour it has, weighted by alpha. */
export function dominantColour(colours: { colour: Colour }[]): Colour | null {
  const chroma = colours.filter((x) => isChromatic(x.colour));
  if (!chroma.length) return null;
  let best = chroma[0].colour;
  let bestScore = -1;
  for (const x of chroma) {
    const c = x.colour;
    const max = Math.max(c.r, c.g, c.b);
    const min = Math.min(c.r, c.g, c.b);
    const score = ((max - min) / max) * (0.25 + 0.75 * max) * (0.35 + 0.65 * c.a);
    if (score > bestScore) (bestScore = score, (best = c));
  }
  return best;
}

/* ------------------------------------------------------------------ comparison */

function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

/** Thresholds live here so the report and the graph pass cannot disagree about what "good" means. */
export const VERDICT = { goodDE: 10, partialDE: 25, goodCoverage: 0.75, partialCoverage: 0.4 } as const;

function verdictOf(dE: number, coverage: number): Verdict {
  if (!Number.isFinite(dE)) return 'unmeasured';
  if (coverage >= VERDICT.goodCoverage && dE <= VERDICT.goodDE) return 'good';
  if (coverage >= VERDICT.partialCoverage && dE <= VERDICT.partialDE) return 'partial';
  return 'poor';
}

/**
 * Compare one variant against a recolour of its family base.
 *
 * Keys are matched by their path with the array indices dropped — base and variant can have different
 * key counts, and a positional match would compare unrelated rows and report noise as error.
 *
 * `dE` is NaN, never 0, when there is nothing to compare: zero measured keys is not a perfect match,
 * and folding it in as one drags the reported mean toward zero and hides the families that actually
 * failed. `keysBase` is returned so the caller can tell "the variant has no colour keys" from "the
 * base has none to shift" — different causes, different fixes.
 */
export function compareVariant(
  basePayload: unknown,
  variantPayload: unknown,
): { dE: number; dE_p90: number; dE_max: number; coverage: number; keysVariant: number; keysBase: number; target: Colour | null } {
  const vColours = payloadColours(variantPayload);
  const keysBase = payloadColours(basePayload).length;
  const target = dominantColour(vColours);
  const none = { dE: NaN, dE_p90: NaN, dE_max: NaN, coverage: 0, keysVariant: vColours.length, keysBase, target };
  if (!target || !vColours.length) return none;

  const shifted = recolor(basePayload, { targetColor: rgbToHex(target) }).payload;
  const bColours = payloadColours(shifted);
  const bucket = (xs: { path: string; colour: Colour }[]): Map<string, Colour[]> => {
    const m = new Map<string, Colour[]>();
    for (const x of xs) {
      const k = x.path.replace(/\[\d+\]/g, '[]');
      (m.get(k) ?? m.set(k, []).get(k)!).push(x.colour);
    }
    return m;
  };
  const b = bucket(bColours);

  const distances: number[] = [];
  let matched = 0;
  for (const [key, colours] of bucket(vColours)) {
    const cands = b.get(key);
    if (!cands || !cands.length) continue;
    // Compare each variant colour to its nearest base colour at the same key: a recoloured base is a
    // substitute if EVERY colour the variant shows is reachable, not just the average.
    for (const vc of colours) {
      matched++;
      let best = Number.POSITIVE_INFINITY;
      for (const bc of cands) best = Math.min(best, colourDistance(vc, bc));
      distances.push(best);
    }
  }
  if (!distances.length) return none;
  const mean = distances.reduce((s, x) => s + x, 0) / distances.length;
  return {
    dE: mean,
    dE_p90: percentile(distances, 90),
    dE_max: Math.max(...distances),
    coverage: matched / vColours.length,
    keysVariant: vColours.length,
    keysBase,
    target,
  };
}

/** Why a family is not recolourable, from the assets its base and variants reference. */
export function causeOf(baseFacts: { assets: AssetRef[] }, variantFacts: { assets: AssetRef[] }): Reason {
  const key = (a: AssetRef): string => `${a.kind}:${a.guid}`;
  const bm = new Set(baseFacts.assets.filter((a) => a.kind === 'material').map(key));
  const vm = new Set(variantFacts.assets.filter((a) => a.kind === 'material').map(key));
  const bt = new Set(baseFacts.assets.filter((a) => a.kind === 'texture').map((a) => a.guid));
  const vt = new Set(variantFacts.assets.filter((a) => a.kind === 'texture').map((a) => a.guid));
  const differ = (x: Set<string>, y: Set<string>): boolean => x.size > 0 && y.size > 0 && [...x].some((g) => !y.has(g));
  if (differ(bt, vt)) return 'texture';
  if (differ(bm, vm)) return 'material';
  return 'params';
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
    const perVariant: VariantResult[] = [];
    for (const v of rest) {
      await load(v);
      const cmp = compareVariant(payloads.get(base.id)!.parsed, payloads.get(v.id)!.parsed);
      // Cause is only meaningful once we know the comparison could not be made at all.
      const reason: Reason = !Number.isFinite(cmp.dE)
        ? cmp.keysBase === 0
          ? 'no-base-keys'
          : 'no-keys'
        : causeOf(facts.get(base.id)!, facts.get(v.id)!);
      perVariant.push({
        base: base.uri,
        variant: v.uri,
        family: key,
        dE: cmp.dE,
        dE_p90: cmp.dE_p90,
        dE_max: cmp.dE_max,
        keyCoverage: cmp.coverage,
        keysVariant: cmp.keysVariant,
        keysBase: cmp.keysBase,
        verdict: verdictOf(cmp.dE, cmp.coverage),
        reason,
      });
    }
    variants.push(...perVariant);
    // Only measured variants enter the dE numbers — an unmeasurable one has no distance, and counting
    // it as 0 would report the family as a perfect recolour.
    const measured = perVariant.filter((v) => Number.isFinite(v.dE));
    const dEs = measured.map((v) => v.dE);
    const worst = [...measured].sort((a, b) => b.dE - a.dE)[0];
    const good = perVariant.filter((v) => v.verdict === 'good').length;
    const partial = perVariant.filter((v) => v.verdict === 'partial').length;
    const poor = perVariant.filter((v) => v.verdict === 'poor').length;
    const unmeasured = perVariant.filter((v) => v.verdict === 'unmeasured').length;
    const meanDE = dEs.length ? dEs.reduce((s, x) => s + x, 0) / dEs.length : NaN;
    const meanCoverage = measured.length ? measured.reduce((s, v) => s + v.keyCoverage, 0) / measured.length : 0;
    // A family is recolourable only if recolouring reproduces its variants — a base that gets 1 of 4
    // right is not a substitute, it is a coin flip with a plausible-looking mean. Nothing measurable
    // means "unknown", which must not be laundered into "good".
    const familyVerdict: Verdict =
      !measured.length ? 'unmeasured' : good === perVariant.length ? 'good' : poor > perVariant.length / 2 ? 'poor' : 'partial';
    const reasonCounts = new Map<Reason, number>();
    for (const v of perVariant) if (v.verdict !== 'good' && v.reason) reasonCounts.set(v.reason, (reasonCounts.get(v.reason) ?? 0) + 1);
    const topReason = [...reasonCounts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0];
    families.push({
      family: key,
      base: base.uri,
      variants: perVariant.length,
      good,
      partial,
      poor,
      unmeasured,
      dE: meanDE,
      dE_p90: dEs.length ? percentile(dEs, 90) : NaN,
      dE_max: dEs.length ? Math.max(...dEs) : NaN,
      keyCoverage: meanCoverage,
      verdict: familyVerdict,
      reason: familyVerdict === 'good' ? null : (topReason?.[0] ?? null),
      worst: familyVerdict === 'good' ? null : (worst?.variant ?? null),
    });
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
