import fs from 'node:fs';
import path from 'node:path';
import { pool } from './db.ts';
import { VfxError } from './errors.ts';

/**
 * Search-time view of the knowledge graph built by `npm run graph:build` (seed/graph). Reads only:
 * variants (meta.family), pairs_with companions, neighbour boost, and the /v1/related neighbourhood.
 */
interface GraphConfig {
  relWeights: Record<string, number>;
  seeds: number;
  seedMinRatio: number;
  poolMultiplier: number;
  minPool: number;
  maxPairsWith: number;
  maxVariants: number;
  relatedDefaultLimit: number;
  relatedMaxLimit: number;
  relOrder: string[];
}

export const GRAPH: GraphConfig = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'graph.json'), 'utf8'));

/** Weight of the graph-expansion boost. 0 = off. */
export const W_GRAPH = Number(process.env.SEARCH_W_GRAPH ?? 0.3);

export interface Variant {
  uri: string;
  colors: string[];
  name: string;
}
export interface PairsWith {
  uri: string;
  name: string;
  category: string;
}

export interface RowKey {
  id: number;
  uri: string;
  family: string | null;
  score: number;
  /** row matched the query lexically (original words or expansion). */
  lexical: boolean;
}

/** Card identity: the family when variants are collapsed, else the record itself. */
export const keyOf = (r: Pick<RowKey, 'uri' | 'family'>, collapse: boolean): string => (collapse && r.family ? r.family : r.uri);

/**
 * Graph expansion: neighbours (variant_of / pairs_with / similar_to) of the strongest hits get
 * `w * relWeight * seedScore` added, so a card linked to a strong hit can overtake a weaker unrelated one.
 * Only re-ranks the rows already retrieved (no injection). Rows must be sorted by score desc.
 */
export async function graphBonus(rows: RowKey[], w: number, collapse: boolean): Promise<Map<string, number>> {
  const bonus = new Map<string, number>();
  if (w <= 0 || rows.length < 2) return bonus;
  // Seeds must be real matches: lexical hits scoring close to the best hit. A weak neighbour is not a seed.
  const top = rows[0].score;
  const seeds = rows.filter((r) => r.lexical && r.score >= GRAPH.seedMinRatio * top).slice(0, GRAPH.seeds);
  if (!seeds.length) return bonus;
  const seedScore = new Map(seeds.map((s) => [keyOf(s, collapse), s.score]));
  const keys = [...seedScore.keys()];
  const lexicalKeys = new Set(rows.filter((r) => r.lexical).map((r) => keyOf(r, collapse)));
  const e = await pool.query<{ ak: string; bk: string; rel: string }>(
    `SELECT COALESCE(a.meta->>'family', a.uri) AS ak, COALESCE(b.meta->>'family', b.uri) AS bk, e.rel
       FROM resource_edge e JOIN resource a ON a.id = e.src JOIN resource b ON b.id = e.dst
      WHERE e.rel = ANY($1::text[])
        AND (a.uri = ANY($2::text[]) OR b.uri = ANY($2::text[]) OR a.meta->>'family' = ANY($2::text[]) OR b.meta->>'family' = ANY($2::text[]))`,
    [Object.keys(GRAPH.relWeights), keys],
  );
  const put = (neighbour: string, seed: string, rel: string): void => {
    if (neighbour === seed || !lexicalKeys.has(neighbour)) return; // boost only neighbours that already match the query
    const v = GRAPH.relWeights[rel] * (seedScore.get(seed) ?? 0);
    if (v > (bonus.get(neighbour) ?? 0)) bonus.set(neighbour, v);
  };
  for (const r of e.rows) {
    if (seedScore.has(r.ak)) put(r.bk, r.ak, r.rel);
    if (seedScore.has(r.bk)) put(r.ak, r.bk, r.rel);
  }
  return bonus;
}

/** All members of the given families, for the `variants` of a collapsed card. */
export async function variantsOf(families: string[]): Promise<Map<string, Variant[]>> {
  const out = new Map<string, Variant[]>();
  if (!families.length) return out;
  const r = await pool.query<{ fam: string; uri: string; name: string; colors: string[] | null }>(
    `SELECT meta->>'family' AS fam, uri, name,
            ARRAY(SELECT jsonb_array_elements_text(COALESCE(meta->'facets'->'colors', '[]'::jsonb))) AS colors
       FROM resource WHERE meta->>'family' = ANY($1::text[]) ORDER BY name, id`,
    [families],
  );
  for (const x of r.rows) (out.get(x.fam) ?? out.set(x.fam, []).get(x.fam)!).push({ uri: x.uri, colors: x.colors ?? [], name: x.name });
  return out;
}

/** Companions (pairs_with) of each record id: at most maxPairsWith, round-robin across roles. */
export async function pairsOf(ids: number[]): Promise<Map<number, PairsWith[]>> {
  const out = new Map<number, PairsWith[]>();
  if (!ids.length) return out;
  const r = await pool.query<{ cid: number; uri: string; name: string; role: string | null }>(
    `SELECT e.src AS cid, r.uri, r.name, COALESCE(r.meta->>'pairRole', r.meta->'facets'->'category'->>0) AS role
       FROM resource_edge e JOIN resource r ON r.id = e.dst WHERE e.rel = 'pairs_with' AND e.src = ANY($1::bigint[])
     UNION ALL
     SELECT e.dst AS cid, r.uri, r.name, COALESCE(r.meta->>'pairRole', r.meta->'facets'->'category'->>0) AS role
       FROM resource_edge e JOIN resource r ON r.id = e.src WHERE e.rel = 'pairs_with' AND e.dst = ANY($1::bigint[])
     ORDER BY 1, 4, 3`,
    [ids],
  );
  const byCard = new Map<number, Map<string, PairsWith[]>>();
  for (const x of r.rows) {
    const roles = byCard.get(Number(x.cid)) ?? byCard.set(Number(x.cid), new Map()).get(Number(x.cid))!;
    const role = x.role ?? '';
    (roles.get(role) ?? roles.set(role, []).get(role)!).push({ uri: x.uri, name: x.name, category: role });
  }
  for (const [cid, roles] of byCard) {
    const lanes = [...roles.values()];
    const picked: PairsWith[] = [];
    for (let i = 0; picked.length < GRAPH.maxPairsWith && lanes.some((l) => i < l.length); i++) {
      for (const l of lanes) if (i < l.length && picked.length < GRAPH.maxPairsWith) picked.push(l[i]);
    }
    out.set(cid, picked);
  }
  return out;
}

export interface Related {
  uri: string;
  name: string;
  type: string;
  rel: string;
  /** out: this -> other, in: other -> this, family: same variant family (no edge row needed). */
  direction: 'out' | 'in' | 'family';
  weight: number | null;
  category: string | null;
}

/** Graph neighbourhood of a record: edges in both directions plus its variant siblings. */
export async function related(uri: string, opts: { rel?: string; limit?: number }): Promise<{ uri: string; family: string | null; related: Related[] }> {
  const known = GRAPH.relOrder;
  if (opts.rel !== undefined && !known.includes(opts.rel)) throw new VfxError(`unknown rel "${opts.rel}" (known: ${known.join(', ')})`, 'invalid');
  const limit = Math.min(Math.max(opts.limit ?? GRAPH.relatedDefaultLimit, 1), GRAPH.relatedMaxLimit);
  const me = await pool.query<{ id: number; family: string | null }>('SELECT id, meta->>\'family\' AS family FROM resource WHERE uri = $1', [uri]);
  if (!me.rowCount) throw new VfxError(`Not found: ${uri}`, 'not_found');
  const { id, family } = me.rows[0];
  const rels = opts.rel ? [opts.rel] : known;

  const edges = await pool.query<Related>(
    `SELECT o.uri, o.name, o.type, e.rel, e.weight,
            CASE WHEN e.src = $1 THEN 'out' ELSE 'in' END AS direction,
            COALESCE(o.meta->>'pairRole', o.meta->'facets'->'category'->>0) AS category
       FROM resource_edge e JOIN resource o ON o.id = CASE WHEN e.src = $1 THEN e.dst ELSE e.src END
      WHERE (e.src = $1 OR e.dst = $1) AND e.rel = ANY($2::text[]) AND e.rel <> 'variant_of'`,
    [id, rels],
  );
  const sibs =
    family && rels.includes('variant_of')
      ? await pool.query<Related>(
          `SELECT uri, name, type, 'variant_of' AS rel, 1::real AS weight, 'family' AS direction,
                  meta->'facets'->'category'->>0 AS category
             FROM resource WHERE meta->>'family' = $1 AND id <> $2`,
          [family, id],
        )
      : { rows: [] as Related[] };

  const rank = (r: string): number => known.indexOf(r);
  const all = [...sibs.rows, ...edges.rows].sort(
    (a, b) => rank(a.rel) - rank(b.rel) || (b.weight ?? -1) - (a.weight ?? -1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.uri < b.uri ? -1 : 1),
  );
  return { uri, family, related: all.slice(0, limit).map((r) => ({ ...r, weight: r.weight === null ? null : Number(Number(r.weight).toFixed(3)) })) };
}
