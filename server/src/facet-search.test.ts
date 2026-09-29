import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateFilter, countFacets, FilterError, normalizeFilters } from './facet-query.ts';

process.env.AUTH_DISABLED = '1';
const { pool } = await import('./db.ts');
const { buildHttp } = await import('./http.ts');

after(async () => {
  await pool.end().catch(() => undefined);
});

async function dbUp(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

test('normalizeFilters: known facets only, string[] values, lone string wrapped, empty dropped', () => {
  assert.deepEqual(normalizeFilters({ category: ['Explosion'], playback: 'one-shot', motion: [] }), { category: ['explosion'], playback: ['one-shot'] });
  assert.deepEqual(normalizeFilters(undefined), {});
  assert.throws(() => normalizeFilters({ nope: ['x'] }), FilterError);
  assert.throws(() => normalizeFilters({ category: [1] }), FilterError);
  assert.throws(() => normalizeFilters([]), FilterError);
});

test('countFacets: per-value counts, missing facets uncounted, ordered by count then value', () => {
  const rows = [
    { facets: { category: ['explosion', 'fire'], playback: 'one-shot' as const, cost: 'low' as const }, style: ['toon'] },
    { facets: { category: ['explosion'], playback: 'loop' as const }, style: ['toon', 'stylized'] },
    { facets: { category: ['beam'] }, style: [] },
    { facets: null, style: null },
  ];
  const c = countFacets(rows);
  assert.deepEqual(c.category, [{ value: 'explosion', count: 2 }, { value: 'beam', count: 1 }, { value: 'fire', count: 1 }]);
  assert.deepEqual(c.playback, [{ value: 'loop', count: 1 }, { value: 'one-shot', count: 1 }]);
  assert.deepEqual(c.cost, [{ value: 'low', count: 1 }]);
  assert.deepEqual(c.style, [{ value: 'toon', count: 2 }, { value: 'stylized', count: 1 }]);
  assert.deepEqual(c.motion, []);
});

test('candidateFilter SQL: OR within a facet, AND across facets, scalar facets, style merge', async (t) => {
  if (!(await dbUp())) return t.skip('database not reachable');
  const rows = [
    [1, ['toon'], { category: ['explosion', 'fire'], playback: 'one-shot' }],
    [2, ['retro'], { category: ['beam'], playback: 'loop' }],
    [3, ['toon'], { category: ['explosion'], playback: 'loop' }],
    [4, ['retro'], { category: ['portal'], playback: 'one-shot' }],
    [5, ['toon'], {}],
  ] as const;
  const values = rows.map((r) => `(${r[0]}, 'recipe', ARRAY[]::text[], ARRAY[${r[1].map((s) => `'${s}'`).join(',')}]::text[], '${JSON.stringify({ keywords: [], facets: r[2] })}'::jsonb, 'project')`).join(',');
  const ids = async (args: Parameters<typeof candidateFilter>[0]): Promise<number[]> => {
    const f = candidateFilter(args, 1);
    const res = await pool.query<{ id: number }>(`WITH resource(id, type, tags, style, meta, visibility) AS (VALUES ${values}) SELECT id FROM resource WHERE ${f.sql} ORDER BY id`, f.params);
    return res.rows.map((r) => r.id);
  };
  assert.deepEqual(await ids({ filters: { category: ['explosion'] } }), [1, 3]);
  assert.deepEqual(await ids({ filters: { category: ['beam', 'portal'] } }), [2, 4], 'values inside one facet are OR-ed');
  assert.deepEqual(await ids({ filters: { category: ['explosion'], playback: ['loop'] } }), [3], 'facets are AND-ed');
  assert.deepEqual(await ids({ filters: { category: ['explosion', 'beam'], playback: ['one-shot', 'loop'] } }), [1, 2, 3]);
  assert.deepEqual(await ids({ filters: { style: ['toon'], playback: ['one-shot'] } }), [1]);
  assert.deepEqual(await ids({ style: ['cartoon'], filters: { category: ['explosion'] } }), [1, 3], 'style aliases are canonicalised');
  assert.deepEqual(await ids({ filters: {} }), [1, 2, 3, 4, 5]);
});

test('POST /v1/facets over the corpus: totals, OR / AND consistency, unknown facet is a 400', async (t) => {
  if (!(await dbUp())) return t.skip('database not reachable');
  const total = Number((await pool.query('SELECT COUNT(*) AS n FROM resource')).rows[0].n);
  const withFacets = Number((await pool.query("SELECT COUNT(*) AS n FROM resource WHERE meta ? 'facets'")).rows[0].n);
  if (total < 100 || withFacets < 100) return t.skip('corpus not seeded / re-indexed');
  const app = await buildHttp();
  const call = async (body: unknown): Promise<{ total: number; facets: Record<string, Array<{ value: string; count: number }>> }> => {
    const res = await app.inject({ method: 'POST', url: '/v1/facets', payload: body as object });
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };
  const count = (r: Awaited<ReturnType<typeof call>>, facet: string, value: string): number => r.facets[facet].find((x) => x.value === value)?.count ?? 0;

  const all = await call({ type: 'recipe' });
  assert.ok(all.total > 100);
  for (const list of Object.values(all.facets)) for (const x of list) assert.ok(x.count <= all.total);

  const loop = await call({ type: 'recipe', filters: { playback: ['loop'] } });
  const shot = await call({ type: 'recipe', filters: { playback: ['one-shot'] } });
  const both = await call({ type: 'recipe', filters: { playback: ['loop', 'one-shot'] } });
  assert.equal(both.total, loop.total + shot.total, 'OR within a facet: disjoint values add up');
  assert.equal(count(all, 'playback', 'loop'), loop.total, 'a value count equals the total once filtered to it');

  const cat = (await call({ type: 'recipe', filters: { category: ['explosion'] } }));
  const catAndLoop = await call({ type: 'recipe', filters: { category: ['explosion'], playback: ['loop'] } });
  assert.ok(catAndLoop.total <= Math.min(cat.total, loop.total), 'AND across facets narrows');
  assert.equal(catAndLoop.total, count(cat, 'playback', 'loop'));

  const q = await call({ query: 'explosion', type: 'recipe' });
  const qToon = await call({ query: 'explosion', type: 'recipe', filters: { style: ['toon'] } });
  assert.ok(q.total > 0 && qToon.total > 0 && qToon.total < q.total, 'a style filter shrinks the query candidate set');
  assert.equal(count(q, 'style', 'toon'), qToon.total);

  const bad = await app.inject({ method: 'POST', url: '/v1/facets', payload: { filters: { nope: ['x'] } } });
  assert.equal(bad.statusCode, 400);
  const search = await app.inject({ method: 'POST', url: '/v1/search', payload: { query: 'explosion', type: 'recipe', filters: { category: ['explosion'], playback: ['one-shot'] }, limit: 5 } });
  assert.equal(search.statusCode, 200, search.body);
  const cards = search.json().cards as Array<{ facets: { category?: string[]; playback?: string }; behavior: string | null }>;
  assert.ok(cards.length > 0);
  for (const c of cards) {
    assert.ok(c.facets.category?.includes('explosion'));
    assert.equal(c.facets.playback, 'one-shot');
    assert.equal(typeof c.behavior, 'string');
  }
  await app.close();
});
