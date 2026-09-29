import { after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_DISABLED = '1';
const { pool } = await import('./db.ts');
const { buildHttp } = await import('./http.ts');
const { layoutSet, parseUris, parseSet } = await import('./review.ts');

const sessions: string[] = [];
after(async () => {
  for (const s of sessions) await pool.query('DELETE FROM review_session WHERE id = $1', [s]).catch(() => undefined);
  await pool.end().catch(() => undefined);
});

async function api(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ status: number; json: any; body: string }> {
  const app = await buildHttp();
  const res = await app.inject({ method, url, payload: payload as object | undefined });
  await app.close();
  let json: any = null;
  try {
    json = res.json();
  } catch {
    /* html */
  }
  return { status: res.statusCode, json, body: res.body };
}

async function twoUris(): Promise<string[]> {
  const r = await pool.query<{ uri: string }>(`SELECT uri FROM resource WHERE type = 'recipe' ORDER BY slug LIMIT 2`);
  return r.rows.map((x) => x.uri);
}

test('URI and set validation', () => {
  assert.throws(() => parseUris([]), /empty/);
  assert.throws(() => parseUris(['vfx://recipe/x/1', 'http://evil']), /not a vfx:\/\/ URI/);
  assert.throws(() => parseUris(['vfx://recipe/../1']), /not a vfx:\/\/ URI/);
  assert.deepEqual(parseUris('vfx://recipe/a/1, vfx://recipe/a/1,vfx://recipe/b/2'), ['vfx://recipe/a/1', 'vfx://recipe/b/2']);
  assert.deepEqual(parseSet('muzzle,projectile'), ['muzzle', 'projectile']);
  assert.throws(() => parseSet(['Muzzle!']), /invalid role/);
  assert.throws(() => parseSet('a,b,c,d,e,f,g'), /at most/);
});

test('POST /v1/review: unknown URI is 404, malformed 400, empty request 400', async () => {
  const missing = await api('POST', '/v1/review', { uris: ['vfx://recipe/definitely-not-there/1'] });
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /definitely-not-there/);
  assert.equal((await api('POST', '/v1/review', { uris: ['nope'] })).status, 400);
  assert.equal((await api('POST', '/v1/review', {})).status, 400);
  assert.equal((await api('POST', '/v1/review', { q: 'fire', set: ['Bad Role'] })).status, 400);
  assert.equal((await api('POST', '/v1/review', { q: 'fire', filters: { nope: ['x'] } })).status, 400);
});

test('session/selection round trip, replace semantics, validation', async () => {
  const [a, b] = await twoUris();
  const created = await api('POST', '/v1/review', { uris: [a, b] });
  assert.equal(created.status, 200);
  const id: string = created.json.session;
  sessions.push(id);
  assert.equal(created.json.count, 2);
  assert.equal(created.json.url, `http://localhost:${process.env.PORT ?? 8787}/review?session=${id}`);

  const empty = await api('GET', `/v1/review/selection?session=${id}`);
  assert.deepEqual(empty.json.selection, []);
  assert.deepEqual(empty.json.uris, [a, b]);

  const put = await api('POST', '/v1/review/selection', { session: id, uris: [a], roles: { [a]: 'muzzle' } });
  assert.equal(put.status, 200);
  assert.equal(put.json.count, 1);
  const got = await api('GET', `/v1/review/selection?session=${id}`);
  assert.equal(got.json.selection.length, 1);
  assert.equal(got.json.selection[0].uri, a);
  assert.equal(got.json.selection[0].role, 'muzzle');

  // the page's own endpoint (no /v1, no key) is the same handler; submitting again replaces the pick set
  const again = await api('POST', '/review/selection', { session: id, uris: [b] });
  assert.equal(again.status, 200);
  assert.deepEqual((await api('GET', `/v1/review/selection?session=${id}`)).json.selection.map((x: any) => x.uri), [b]);

  assert.equal((await api('POST', '/v1/review/selection', { session: id, uris: ['vfx://recipe/other-thing/1'] })).status, 400);
  assert.equal((await api('POST', '/v1/review/selection', { session: id, uris: [a], roles: { [a]: 'BAD ROLE' } })).status, 400);
  assert.equal((await api('POST', '/v1/review/selection', { session: '00000000-0000-0000-0000-000000000000', uris: [] })).status, 404);
  assert.equal((await api('GET', '/v1/review/selection?session=zzz')).status, 400);
  assert.equal((await api('POST', '/v1/review/selection', { session: id, uris: [] })).json.count, 0);

  // deleting the session cascades its selection
  await api('POST', '/v1/review/selection', { session: id, uris: [a] });
  await pool.query('DELETE FROM review_session WHERE id = $1', [id]);
  const left = await pool.query('SELECT 1 FROM review_selection WHERE session_id = $1', [id]);
  assert.equal(left.rowCount, 0);
});

test('GET /review renders cards with a placeholder when there is no preview, and reopens by session', async () => {
  const [a, b] = await twoUris();
  const page = await api('GET', `/review?uris=${encodeURIComponent(`${a},${b}`)}`);
  assert.equal(page.status, 200);
  assert.equal((page.body.match(/<article /g) ?? []).length, 2);
  assert.match(page.body, /chưa có preview|<video /);
  assert.match(page.body, /Gửi lựa chọn/);
  const sid = /data-session="([0-9a-f-]{36})"/.exec(page.body)![1];
  sessions.push(sid);
  const reopened = await api('GET', `/review?session=${sid}`);
  assert.equal((reopened.body.match(/<article /g) ?? []).length, 2);
  assert.equal((await api('GET', '/review?session=00000000-0000-0000-0000-000000000000')).status, 404);
  assert.equal((await api('GET', '/review')).status, 400);
});

test('GET /review escapes hostile query text', async () => {
  const page = await api('GET', `/review?q=${encodeURIComponent('<script>alert(1)</script>__BODY__')}&limit=1`);
  assert.equal(page.status, 200);
  const m = /data-session="([0-9a-f-]{36})"/.exec(page.body);
  if (m) sessions.push(m[1]);
  assert.ok(!page.body.includes('<script>alert(1)'));
});

test('layoutSet puts pairs_with cards on the same row', () => {
  const mk = (uri: string, role: string, pairs: string[] = [], variants: string[] = []) => ({ uri, role, pairsWith: pairs.map((u) => ({ uri: u })), variants: variants.map((u) => ({ uri: u })) });
  const m1 = mk('m1', 'muzzle');
  const m2 = mk('m2', 'muzzle');
  const p1 = mk('p1', 'projectile', ['m2']); // pairs with the SECOND muzzle
  const p2 = mk('p2', 'projectile');
  const i1 = mk('i1', 'impact', [], ['p1x']);
  const m2pair = mk('i2', 'impact', ['m2']);
  const placed = layoutSet([m1, m2, p1, p2, i1, m2pair], ['muzzle', 'projectile', 'impact']);
  const at = (u: string) => placed.find((p) => p.item.uri === u)!;
  assert.equal(at('m1').row, 0);
  assert.equal(at('m2').row, 1);
  assert.equal(at('p1').row, at('m2').row);
  assert.equal(at('i2').row, at('m2').row);
  assert.equal(at('p1').col, 1);
  assert.equal(at('i2').col, 2);
  assert.equal(placed.length, 6); // nothing dropped
  const cells = new Set(placed.map((p) => `${p.col}:${p.row}`));
  assert.equal(cells.size, placed.length); // no two cards share a cell
});
