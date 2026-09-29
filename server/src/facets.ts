import fs from 'node:fs';
import path from 'node:path';
import { conceptsForTokens, singular } from './vocab.ts';

/**
 * The facet contract (meta.facets) and its DATA-driven text derivation. Every mapping table
 * (category terms, thresholds, shape / render-mode codes, behaviour phrases) is in `facets.json`;
 * nothing here names a category or a threshold.
 */
export interface Facets {
  category?: string[];
  subcategory?: string[];
  element?: string[];
  colors?: string[];
  playback?: 'loop' | 'one-shot';
  duration?: 'short' | 'medium' | 'long';
  scale?: 'small' | 'medium' | 'large';
  motion?: string[];
  shape?: string[];
  renderMode?: string[];
  cost?: 'low' | 'medium' | 'high';
}

/** Facets whose value is a string[] on the record. */
export const ARRAY_FACETS = ['category', 'subcategory', 'element', 'colors', 'motion', 'shape', 'renderMode'] as const;
/** Facets whose value is a single string on the record. */
export const SCALAR_FACETS = ['playback', 'duration', 'scale', 'cost'] as const;
/** Every facet name the API knows: the meta.facets keys plus `style` (the record's style column). */
export const FACET_NAMES: readonly string[] = [...ARRAY_FACETS, ...SCALAR_FACETS, 'style'];

export interface FacetRules {
  limits: { maxCategories: number };
  thresholds: {
    durationSec: { shortBelow: number; longAbove: number };
    scale: { smallBelow: number; largeAbove: number };
    cost: { mediumParticles: number; highParticles: number; mediumNodes: number; highNodes: number };
    motion: { minSpeed: number; minGravity: number; radialConeAngle: number; verticalDirection: number };
  };
  elements: string[];
  elementFromConcept: Record<string, string>;
  categories: Record<string, { terms: string[]; subcategories: Record<string, string[]> }>;
  shapeTypes: Record<string, string>;
  radialShapes: string[];
  renderModes: Record<string, string>;
  effectKindShapes: Record<string, string>;
  effectKindRenderModes: Record<string, string>;
  behavior: BehaviorRules;
}

export interface BehaviorRules {
  loop: Record<string, string>;
  emission: Record<string, string>;
  defaultNoun: string;
  nounByCategory: Record<string, string>;
  nounByElement: Record<string, string>;
  motion: Record<string, string>;
  motionPriority: string[];
  shape: Record<string, string>;
  fade: string;
  grow: string;
  shrink: string;
  layerNouns: Record<string, string>;
  effect: { kinds: Record<string, string>; template: string };
}

let cached: FacetRules | undefined;
export function getFacetRules(): FacetRules {
  if (!cached) {
    const file = path.join(path.dirname(new URL(import.meta.url).pathname), 'facets.json');
    cached = JSON.parse(fs.readFileSync(file, 'utf8')) as FacetRules;
  }
  return cached;
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];
/** Singularised tokens, plus the letter runs of digit-glued ones ("punch2blue" -> punch, blue). */
const stems = (tokens: string[]): string[] => tokens.flatMap((t) => [t, ...(/\d/.test(t) ? t.split(/\d+/).filter((x) => x.length > 1) : [])]).map(singular);

/**
 * Category / subcategory / element from tokens. `primary` (the record's own name) decides the
 * category; when it matches nothing the `fallback` tokens (folders, tags) are tried. Categories are
 * ordered by where their first term appears in `primary` (then rule order) and capped at
 * `limits.maxCategories`. Sub-categories are looked up in primary + fallback of matched categories.
 */
export function deriveTextFacets(primary: string[], fallback: string[]): Pick<Facets, 'category' | 'subcategory' | 'element'> {
  const rules = getFacetRules();
  const p = stems(primary);
  const all = new Set([...p, ...stems(fallback)]);
  const rank = (tokens: string[]): Array<[string, number]> =>
    Object.entries(rules.categories)
      .map(([id, c]): [string, number] => [id, Math.min(...c.terms.map((t) => (tokens.includes(t) ? tokens.indexOf(t) : Infinity)))])
      .filter(([, pos]) => pos !== Infinity)
      .sort((a, b) => a[1] - b[1]);
  let matched = rank(p);
  if (!matched.length) matched = rank([...all]);
  const category = matched.slice(0, rules.limits.maxCategories).map(([id]) => id);
  const subcategory = category.flatMap((id) =>
    Object.entries(rules.categories[id].subcategories)
      .filter(([, terms]) => terms.some((t) => all.has(t)))
      .map(([sub]) => `${id}/${sub}`),
  );
  const element = uniq(
    conceptsForTokens([...all]).element.map((e) => rules.elementFromConcept[e] ?? e).filter((e) => rules.elements.includes(e)),
  );
  return { category, subcategory, element };
}

/** Drop empty arrays / undefined so "missing = key omitted", and fix the key order of the contract. */
export function compactFacets(f: Facets): Facets {
  const out: Record<string, unknown> = {};
  for (const k of [...ARRAY_FACETS.slice(0, 4), 'playback', 'duration', 'scale', 'motion', 'shape', 'renderMode', 'cost']) {
    const v = (f as Record<string, unknown>)[k];
    if (v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out as Facets;
}
