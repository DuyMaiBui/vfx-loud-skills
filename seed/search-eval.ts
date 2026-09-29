/**
 * Search-quality eval. Relevance is judged from slug / pack / type only (see search-eval.json note).
 *   node seed/search-eval.ts [--url http://127.0.0.1:8787] [--json out.json] [--verbose]
 * recall@5 = relevant hits in top 5 / min(5, R) (R = relevant rows in the corpus); MRR@10 = 1/rank of
 * the first relevant hit in the top 10 (0 if none).
 *
 * Variant collapsing: /v1/search returns ONE card per variant family, so "top 5" means 5 cards. A family
 * card counts as relevant if ANY member of the family is relevant (the card itself or any of its
 * `variants`), and R counts relevant UNITS (a family = 1, a lone record = 1), so recall@5 stays a
 * fraction of what a 5-card list could hold. `--no-collapse` sends collapseVariants:false and judges/counts
 * plain records exactly like the pre-graph runs. `--graph-weight W` overrides SEARCH_W_GRAPH per request.
 * `graphQueries` in search-eval.json are reported in their own section (never mixed into OVERALL).
 * `--compare before.json` prints every query whose recall@5 / MRR@10 differ from an earlier `--json` dump.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pool } from '../server/src/db.ts';

interface Q { id: string; q: string; group: string; relevant: { slug?: string; slugAlso?: string; packs?: string[] } }
interface Row { uri: string; slug: string; type: string; pack: string | null; family: string | null }
interface Out { id: string; q: string; group: string; R: number; recall5: number; mrr10: number; top3: string[] }

const here = path.dirname(fileURLToPath(import.meta.url));

export function isRelevant(r: Row, rel: Q['relevant'], types: string[]): boolean {
  if (!types.includes(r.type)) return false;
  if (rel.packs && !(r.pack && rel.packs.includes(r.pack))) return false;
  if (rel.slug && !new RegExp(rel.slug).test(r.slug)) return false;
  if (rel.slugAlso && !new RegExp(rel.slugAlso).test(r.slug)) return false;
  return true;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      type: { type: 'string' }, url: { type: 'string' }, json: { type: 'string' }, verbose: { type: 'boolean' },
      'no-collapse': { type: 'boolean' }, 'graph-weight': { type: 'string' }, compare: { type: 'string' },
    },
    strict: true,
  });
  const url = values.url ?? process.env.VFX_URL ?? 'http://127.0.0.1:8787';
  const doc = JSON.parse(await fs.readFile(path.join(here, 'search-eval.json'), 'utf8')) as { types: string[]; queries: Q[]; graphQueries?: Q[] };
  const corpus = (await pool.query<Row>("SELECT uri, slug, type, meta->>'pack' AS pack, meta->>'family' AS family FROM resource")).rows;
  const collapse = !values['no-collapse'];
  const unit = (r: Row): string => (collapse && r.family ? r.family : r.uri);

  const byUri = new Map(corpus.map((r) => [r.uri, r]));
  const runSet = async (queries: Q[]): Promise<Out[]> => {
    const out: Out[] = [];
    for (const q of queries) {
      const R = new Set(corpus.filter((r) => isRelevant(r, q.relevant, doc.types)).map(unit)).size;
      const res = await fetch(`${url}/v1/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: q.q,
          limit: 10,
          ...(values.type ? { type: values.type } : {}),
          ...(collapse ? {} : { collapseVariants: false }),
          ...(values['graph-weight'] !== undefined ? { graphWeight: Number(values['graph-weight']) } : {}),
        }),
      });
      if (!res.ok) throw new Error(`search "${q.q}": HTTP ${res.status} ${await res.text()}`);
      const cards = ((await res.json()) as { cards: Array<{ uri: string; variants?: Array<{ uri: string }> }> }).cards;
      // a card is relevant if it, or (collapsed) any member of its family, is relevant
      const flags = cards.map((c) => [c.uri, ...(collapse ? (c.variants ?? []).map((v) => v.uri) : [])].some((u) => byUri.has(u) && isRelevant(byUri.get(u) as Row, q.relevant, doc.types)));
      const hits5 = flags.slice(0, 5).filter(Boolean).length;
      const first = flags.findIndex(Boolean);
      out.push({
        id: q.id, q: q.q, group: q.group, R,
        recall5: R === 0 ? NaN : hits5 / Math.min(5, R),
        mrr10: first === -1 ? 0 : 1 / (first + 1),
        top3: cards.slice(0, 3).map((c, i) => `${flags[i] ? '+' : '-'}${byUri.get(c.uri)?.slug ?? c.uri}`),
      });
    }
    return out;
  };
  const mean = (xs: Out[], f: (o: Out) => number): number => xs.reduce((s, o) => s + f(o), 0) / xs.length;
  const print = (title: string, out: Out[]): void => {
    const valid = out.filter((o) => !Number.isNaN(o.recall5));
    if (title) console.log(`\n== ${title}`);
    console.log('query'.padEnd(24), 'R'.padStart(5), 'rec@5'.padStart(6), 'mrr@10'.padStart(7));
    for (const o of out) {
      console.log(o.q.padEnd(24), String(o.R).padStart(5), Number.isNaN(o.recall5) ? '  n/a ' : o.recall5.toFixed(2).padStart(6), o.mrr10.toFixed(2).padStart(7), values.verbose ? '  ' + o.top3.join(' ') : '');
    }
    console.log(`${title ? title.toUpperCase() : 'OVERALL'} (${valid.length}/${out.length} judged)  recall@5=${mean(valid, (o) => o.recall5).toFixed(3)}  MRR@10=${mean(valid, (o) => o.mrr10).toFixed(3)}`);
  };

  const out = await runSet(doc.queries);
  print('', out);
  const graphOut = doc.graphQueries?.length ? await runSet(doc.graphQueries) : [];
  if (graphOut.length) print('graph queries', graphOut);

  if (values.compare) {
    const prev = JSON.parse(await fs.readFile(values.compare, 'utf8')) as Out[];
    const was = new Map(prev.map((o) => [o.id, o]));
    console.log(`\n== per-query diff vs ${values.compare} (only queries that changed)`);
    for (const o of [...out, ...graphOut]) {
      const p = was.get(o.id);
      if (!p) continue;
      const dr = (Number.isNaN(o.recall5) ? 0 : o.recall5) - (Number.isNaN(p.recall5) ? 0 : p.recall5);
      const dm = o.mrr10 - p.mrr10;
      if (Math.abs(dr) > 1e-9 || Math.abs(dm) > 1e-9) console.log(o.q.padEnd(24), `rec@5 ${p.recall5.toFixed(2)} -> ${o.recall5.toFixed(2)}`, `  mrr@10 ${p.mrr10.toFixed(2)} -> ${o.mrr10.toFixed(2)}`);
    }
  }
  if (values.json) await fs.writeFile(values.json, JSON.stringify([...out, ...graphOut], null, 1));
  await pool.end();
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
