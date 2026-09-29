import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

process.env.AUTH_DISABLED = '1';
const { pool } = await import('./db.ts');
const { config } = await import('./config.ts');
const { buildHttp } = await import('./http.ts');

const created: { id: number; slug: string }[] = [];

after(async () => {
  // Remove every derived record this file published (rows cascade their edges), and its payload file.
  for (const c of created) {
    await pool.query('DELETE FROM resource WHERE id = $1', [c.id]).catch(() => undefined);
    await fs.rm(path.join(config.dataDir, 'recipe', c.slug), { recursive: true, force: true });
  }
  await pool.end().catch(() => undefined);
});

async function pickBase(recolorable: boolean): Promise<string | null> {
  try {
    const r = await pool.query<{ uri: string }>(
      `SELECT uri FROM resource WHERE type = 'recipe' AND meta->>'recolorable' = $1 AND meta ? 'family' ORDER BY slug LIMIT 1`,
      [String(recolorable)],
    );
    return r.rows[0]?.uri ?? null;
  } catch {
    return null;
  }
}

async function post(body: unknown): Promise<{ status: number; json: any }> {
  const app = await buildHttp();
  const res = await app.inject({ method: 'POST', url: '/v1/recolor', payload: body as object });
  await app.close();
  return { status: res.statusCode, json: res.json() };
}

test('POST /v1/recolor: hue shift returns payload, tint list and per-key changes; base untouched', async (t) => {
  const uri = await pickBase(true);
  if (!uri) return t.skip('no graph-built corpus in the database');
  const before = await pool.query('SELECT sha256(convert_to(meta::text, \'UTF8\')) h, version FROM resource WHERE uri = $1', [uri]);
  const { status, json } = await post({ uri, hueShiftDeg: 120 });
  assert.equal(status, 200);
  assert.equal(json.mode, 'hueShift');
  assert.ok(json.changes.length > 0);
  for (const c of json.changes) assert.notEqual(c.from, c.to);
  assert.ok(Array.isArray(json.tint));
  assert.ok(json.payload && typeof json.payload === 'object');
  assert.equal(json.base.recolorable, true);
  assert.equal(json.published, undefined);
  const after = await pool.query('SELECT sha256(convert_to(meta::text, \'UTF8\')) h, version FROM resource WHERE uri = $1', [uri]);
  assert.deepEqual(after.rows, before.rows);
});

test('POST /v1/recolor: same input is deterministic; includePayload:false drops the payload', async (t) => {
  const uri = await pickBase(true);
  if (!uri) return t.skip('no graph-built corpus in the database');
  const a = await post({ uri, targetColor: '#ff2020' });
  const b = await post({ uri, targetColor: '#ff2020', includePayload: false });
  assert.equal(a.status, 200);
  assert.deepEqual(b.json.changes, a.json.changes);
  assert.equal(b.json.payload, undefined);
});

test('POST /v1/recolor: bad input is a 400, unknown uri a 404', async () => {
  assert.equal((await post({ uri: 'vfx://recipe/nope/1', hueShiftDeg: 10 })).status, 404);
  assert.equal((await post({ hueShiftDeg: 10 })).status, 400);
  assert.equal((await post({ uri: 'vfx://recipe/x/1', hueShiftDeg: '10' })).status, 400);
  const uri = await pickBase(true);
  if (!uri) return;
  assert.equal((await post({ uri, targetColor: '#ff2020', hueShiftDeg: 10 })).status, 400);
  assert.equal((await post({ uri, targetColor: 'red' })).status, 400);
  assert.equal((await post({ uri })).status, 400);
});

test('publish:true creates one derived_from record (licence inherited, project) and is idempotent', async (t) => {
  const uri = await pickBase(true);
  if (!uri) return t.skip('no graph-built corpus in the database');
  const req = { uri, targetColor: '#2040ff', publish: true, includePayload: false };
  const first = await post(req);
  assert.equal(first.status, 200);
  const pub = first.json.published;
  const row = (await pool.query('SELECT id, slug, license, visibility, meta FROM resource WHERE uri = $1', [pub.uri])).rows[0];
  if (pub.created) created.push({ id: row.id, slug: row.slug });
  const base = (await pool.query('SELECT id, license, meta FROM resource WHERE uri = $1', [uri])).rows[0];
  assert.match(pub.slug, /-recolor-[0-9a-f]{6}/);
  assert.equal(pub.visibility, 'project');
  assert.equal(row.license, base.license);
  assert.equal(row.meta.license_class, base.meta.license_class);
  assert.equal(row.meta.ai_training, base.meta.ai_training);
  assert.equal(row.meta.recolorable, undefined, 'a derived record is not itself a family member');
  const edge = await pool.query(`SELECT 1 FROM resource_edge WHERE src = $1 AND dst = $2 AND rel = 'derived_from'`, [row.id, base.id]);
  assert.equal(edge.rowCount, 1);

  const count = async (): Promise<number> => Number((await pool.query(`SELECT COUNT(*) n FROM resource WHERE meta ? 'derived'`)).rows[0].n);
  const n1 = await count();
  const second = await post(req);
  assert.equal(second.json.published.uri, pub.uri);
  assert.equal(second.json.published.created, false);
  assert.equal(second.json.published.sha256, pub.sha256);
  assert.equal(await count(), n1, 're-run must create nothing');
});

test('published payload differs from the base only on colour rows (round-trips the emitter)', async (t) => {
  const uri = await pickBase(true);
  if (!uri) return t.skip('no graph-built corpus in the database');
  const res = await post({ uri, targetColor: '#2040ff', publish: true, includePayload: false });
  const pub = res.json.published;
  const row = (await pool.query('SELECT id, slug, storage_uri FROM resource WHERE uri = $1', [pub.uri])).rows[0];
  if (pub.created) created.push({ id: row.id, slug: row.slug });
  const baseRow = (await pool.query('SELECT storage_uri FROM resource WHERE uri = $1', [uri])).rows[0];
  const a = (await fs.readFile(path.join(config.dataDir, baseRow.storage_uri), 'utf8')).split('\n');
  const b = (await fs.readFile(path.join(config.dataDir, row.storage_uri), 'utf8')).split('\n');
  const colourish = /[Cc]olor|colorKeys|^\s*-\s*\[/;
  const changed = b.filter((l, i) => a[i] !== l);
  assert.ok(changed.length > 0);
  assert.ok(changed.every((l) => colourish.test(l) || /^\s+(blend|alphaKeys|gradient|min|max)/.test(l) || /^\s+- \[/.test(l)), `unexpected non-colour line changed: ${changed.find((l) => !colourish.test(l))}`);
  assert.ok(!b.some((l) => /active: "true"/.test(l)), 'booleans must not be re-quoted');
});
