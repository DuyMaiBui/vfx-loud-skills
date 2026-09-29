/**
 * Recolour verdicts — the ONE place that decides whether a variant family is a recolour of its base.
 *
 * Shared by the validation study (seed/recolor-validate.ts) and the graph build (seed/graph/build.ts,
 * which stamps meta.recolorable on every family member). Two copies of the threshold or of the
 * family-verdict rule would let the report and the flag disagree about what "good" means.
 *
 * Pure: takes parsed payloads + their asset facts, touches no DB and no file.
 */
import { type Colour, colourDistance, rgbToHex } from '../../server/src/colour.ts';
import { payloadColours, recolor } from '../../server/src/recolor.ts';
import type { AssetRef } from './payload.ts';

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

export function percentile(xs: number[], p: number): number {
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

/** One family member as the verdict needs it: identity, parsed payload, referenced assets. */
export interface FamilyMember {
  uri: string;
  parsed: unknown;
  facts: { assets: AssetRef[] };
}

/**
 * Verdict for one family: recolour `base` toward each variant's dominant colour and compare.
 * A family is `good` only if EVERY variant is reproduced; nothing measurable is `unmeasured`, never `good`.
 */
export function evaluateFamily(family: string, base: FamilyMember, rest: FamilyMember[]): { family: FamilyResult; variants: VariantResult[] } {
  const perVariant: VariantResult[] = [];
  for (const v of rest) {
    const cmp = compareVariant(base.parsed, v.parsed);
    // Cause is only meaningful once we know the comparison could not be made at all.
    const reason: Reason = !Number.isFinite(cmp.dE) ? (cmp.keysBase === 0 ? 'no-base-keys' : 'no-keys') : causeOf(base.facts, v.facts);
    perVariant.push({
      base: base.uri,
      variant: v.uri,
      family,
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
  const verdict: Verdict = !measured.length ? 'unmeasured' : good === perVariant.length ? 'good' : poor > perVariant.length / 2 ? 'poor' : 'partial';
  const reasonCounts = new Map<Reason, number>();
  for (const v of perVariant) if (v.verdict !== 'good' && v.reason) reasonCounts.set(v.reason, (reasonCounts.get(v.reason) ?? 0) + 1);
  const topReason = [...reasonCounts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0];
  return {
    variants: perVariant,
    family: {
      family,
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
      verdict,
      reason: verdict === 'good' ? null : (topReason?.[0] ?? null),
      worst: verdict === 'good' ? null : (worst?.variant ?? null),
    },
  };
}

/** The flag stamped on every member of a family: only a `good` family is a substitute for its variants. */
export function recolorFlag(f: Pick<FamilyResult, 'verdict' | 'reason'>): { recolorable: boolean; recolorReason: string } {
  return f.verdict === 'good' ? { recolorable: true, recolorReason: 'ok' } : { recolorable: false, recolorReason: f.reason ?? 'params' };
}
