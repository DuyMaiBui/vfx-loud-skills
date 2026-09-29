import { pool } from './db.ts';
import { candidateFilter, countFacets, type CandidateArgs, type FacetCounts } from './facet-query.ts';
import type { Facets } from './facets.ts';
import { ranking } from './rank.ts';

/**
 * Candidate cut-off for `query` facets: the SAME score as /v1/search, restricted to rows that match
 * the query lexically (original words or their synonym / Vietnamese expansion), best
 * FACET_CANDIDATES rows. /v1/search has no lexical floor because it only returns its top `limit`;
 * counting over every row (the hashing embedder gives all rows a positive cosine) would make every
 * count meaningless, so a lexical match is the floor. Without a query: every row matching the filters.
 */
export const FACET_CANDIDATES = Number(process.env.FACET_CANDIDATES ?? 1000);

export interface FacetsArgs extends CandidateArgs {
  query?: string;
}
export interface FacetsResult {
  total: number;
  facets: FacetCounts;
}

interface CandRow {
  facets: Facets | null;
  style: string[] | null;
}

export async function facets(args: FacetsArgs): Promise<FacetsResult> {
  const query = args.query?.trim();
  let rows: CandRow[];
  if (query) {
    const r = await ranking(query);
    const f = candidateFilter(args, 8);
    const res = await pool.query<CandRow>(
      `WITH ${r.cte}
       SELECT meta->'facets' AS facets, style
         FROM resource, q
        WHERE ${f.sql} AND ${r.lexical}
        ORDER BY ${r.score} DESC, id
        LIMIT $${8 + f.params.length}`,
      [...r.params, ...f.params, FACET_CANDIDATES],
    );
    rows = res.rows;
  } else {
    const f = candidateFilter(args, 1);
    rows = (await pool.query<CandRow>(`SELECT meta->'facets' AS facets, style FROM resource WHERE ${f.sql}`, f.params)).rows;
  }
  return { total: rows.length, facets: countFacets(rows) };
}
