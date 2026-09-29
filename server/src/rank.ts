import { getEmbedder } from './embed.ts';
import { expandQuery } from './vocab.ts';

/**
 * The ONE ranking definition shared by /v1/search and /v1/facets. Hybrid: cosine of the (hashing)
 * embedding vs. weighted full-text rank. Weights are env-tunable. Parameters $1..$7 are reserved
 * for the ranking; callers append their own filter parameters from $8.
 */
export const W_VEC = Number(process.env.SEARCH_W_VEC ?? 0.3);
const W_ALL = 0.15; // bonus when EVERY word the user typed is present ("blue fire" prefers blue AND fire)
const W_EXPANSION = 0.6; // synonym / Vietnamese-alias words count less than the user's own words

/** Words -> a safe OR tsquery string ("bubbl | burst"); empty when nothing usable. */
function orQuery(words: string[]): string {
  const ok = [...new Set(words.map((w) => w.replace(/[^\p{L}\p{N}]+/gu, '')).filter((w) => w.length > 1))];
  return ok.join(' | ');
}

/** Words -> an AND tsquery string ("blue & fire"). */
function andQuery(words: string[]): string {
  return orQuery(words).split(' | ').filter(Boolean).join(' & ');
}

export interface Ranking {
  /** `q AS (...)` CTE body: WITH <cte> */
  cte: string;
  /** SQL expression: relevance score of `resource` against the query. */
  score: string;
  /** SQL expression: true when the row matches the query lexically (original words or expansion). */
  lexical: string;
  /** Values for $1..$7. */
  params: unknown[];
  /** Style ids the query itself implies (informational). */
  styles: string[];
}

export async function ranking(query: string): Promise<Ranking> {
  const ex = expandQuery(query);
  const vec = await getEmbedder().embed(ex.text);
  const literal = vec.map((x) => Number(x.toFixed(6))).join(',');
  const qAll = ex.original.length > 1 ? andQuery(ex.original) : '';
  return {
    cte: `q AS (
       SELECT $1::vector AS v,
              CASE WHEN $2 = '' THEN NULL ELSE to_tsquery('english', $2) END AS orig,
              CASE WHEN $3 = '' THEN NULL ELSE to_tsquery('english', $3) END AS exp,
              CASE WHEN $6 = '' THEN NULL ELSE to_tsquery('english', $6) END AS allq
     )`,
    score: `(
              $4::float * GREATEST(0, 1 - (embedding <=> q.v))
            + (1 - $4::float) * (
                COALESCE(ts_rank_cd('{0.1,0.2,0.4,1.0}', search_tsv, q.orig, 32), 0)
              + $5::float * COALESCE(ts_rank_cd('{0.1,0.2,0.4,1.0}', search_tsv, q.exp, 32), 0)
              + $7::float * (CASE WHEN q.allq IS NOT NULL AND search_tsv @@ q.allq THEN 1 ELSE 0 END))
            )`,
    lexical: `(COALESCE(search_tsv @@ q.orig, false) OR COALESCE(search_tsv @@ q.exp, false))`,
    params: [`[${literal}]`, orQuery(ex.original), orQuery(ex.expansion), W_VEC, W_EXPANSION, qAll, W_ALL],
    styles: ex.styles,
  };
}
