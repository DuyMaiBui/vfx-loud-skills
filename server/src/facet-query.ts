import { ARRAY_FACETS, FACET_NAMES, SCALAR_FACETS, type Facets } from './facets.ts';
import { expandQuery } from './vocab.ts';

/** `{ facetName: [value, ...] }`: values within a facet are OR-ed, facets are AND-ed. */
export type FacetFilters = Record<string, string[]>;

export class FilterError extends Error {}

/** Validate an untrusted `filters` object: known facet names, string[] values (a lone string is wrapped). */
export function normalizeFilters(raw: unknown): FacetFilters {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new FilterError('filters must be an object of facetName -> string[]');
  const out: FacetFilters = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!FACET_NAMES.includes(name)) throw new FilterError(`unknown facet "${name}" (known: ${FACET_NAMES.join(', ')})`);
    const list = typeof v === 'string' ? [v] : v;
    if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) throw new FilterError(`filters.${name} must be a string[]`);
    const vals = (list as string[]).map((x) => x.trim()).filter(Boolean);
    if (vals.length) out[name] = name === 'style' ? vals : vals.map((x) => x.toLowerCase());
  }
  return out;
}

export interface CandidateArgs {
  type?: string;
  tags?: string[];
  style?: string[];
  keywords?: string[];
  filters?: FacetFilters;
}

/** Style aliases ("cartoon", "low poly") -> canonical style ids, as /v1/search always did. */
export const canonicalStyles = (xs: string[]): string[] => xs.map((s) => expandQuery(s).styles[0] ?? s.toLowerCase());

/**
 * WHERE fragment (ANDed conditions) for type / tags / style / keywords / visibility / facet filters.
 * Parameters are numbered from `first`. `filters.style` is merged (OR) with the `style` argument.
 */
export function candidateFilter(a: CandidateArgs, first: number): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses: string[] = [];
  const add = (sql: (n: number) => string, value: unknown): void => {
    params.push(value);
    clauses.push(sql(first + params.length - 1));
  };
  if (a.type) add((n) => `type = $${n}::text`, a.type);
  if (a.tags?.length) add((n) => `tags && $${n}::text[]`, a.tags);
  const styles = canonicalStyles([...(a.style ?? []), ...(a.filters?.style ?? [])]);
  if (styles.length) add((n) => `style && $${n}::text[]`, styles);
  if (a.keywords?.length) add((n) => `(meta->'keywords') ?| $${n}::text[]`, a.keywords.map((k) => k.toLowerCase()));
  for (const [name, vals] of Object.entries(a.filters ?? {})) {
    if (name === 'style') continue;
    if ((ARRAY_FACETS as readonly string[]).includes(name)) add((n) => `(meta->'facets'->'${name}') ?| $${n}::text[]`, vals);
    else if ((SCALAR_FACETS as readonly string[]).includes(name)) add((n) => `(meta->'facets'->>'${name}') = ANY($${n}::text[])`, vals);
  }
  // V0 chua co auth -> luon thay ca 3 muc. Cot da san sang cho V0.4.
  add((n) => `visibility = ANY($${n}::text[])`, ['project', 'team', 'global']);
  return { sql: clauses.join(' AND '), params };
}

export interface FacetCount {
  value: string;
  count: number;
}
export type FacetCounts = Record<string, FacetCount[]>;

/** Count facet values over candidate rows. Every facet name is present; rows lacking a facet do not count. */
export function countFacets(rows: Array<{ facets: Facets | null; style: string[] | null }>): FacetCounts {
  const tallies = new Map<string, Map<string, number>>(FACET_NAMES.map((n) => [n, new Map()]));
  const bump = (name: string, v: string): void => {
    const t = tallies.get(name) as Map<string, number>;
    t.set(v, (t.get(v) ?? 0) + 1);
  };
  for (const r of rows) {
    const f = (r.facets ?? {}) as Record<string, unknown>;
    for (const name of ARRAY_FACETS) for (const v of new Set(Array.isArray(f[name]) ? (f[name] as string[]) : [])) bump(name, v);
    for (const name of SCALAR_FACETS) if (typeof f[name] === 'string') bump(name, f[name] as string);
    for (const v of new Set(r.style ?? [])) bump('style', v);
  }
  return Object.fromEntries(
    [...tallies].map(([name, t]) => [name, [...t].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1))]),
  );
}
