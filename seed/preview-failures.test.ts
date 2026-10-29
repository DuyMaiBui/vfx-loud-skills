// Run through scripts/accept/with-testdb.sh (scratch DB, migration 010 applied). Never against the live DB.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { assertScratchDb } from '../server/src/test-fixtures/scratch-db.ts';
import { buildUpsert, ingestFailures, parseFailures, summarize } from './preview-failures.ts';

assertScratchDb();
const { pool } = await import('../server/src/db.ts');
after(async () => { await wipe(); await pool.end(); });

const T1 = '2026-10-28T10:00:00.000Z';
const T2 = '2026-10-28T11:00:00.000Z';
const item = (state: string, cause: string | null, at: string, extra: object = {}) => ({ state, cause, detail: null, shaders: [], renderedAt: at, ...extra });
const file = (runId: string, items: Record<string, unknown>): string => JSON.stringify({ version: 1, runId, items });
const row = async (slug: string) => (await pool.query('SELECT * FROM preview_render WHERE slug = $1', [slug])).rows[0];

// Scoped to this file's own synthetic slugs: node --test runs files concurrently in ONE shared DB (corpus-clone profile),
// so a blanket DELETE / table-wide count would collide with other files' preview_render rows.
const wipe = () => pool.query("DELETE FROM preview_render WHERE slug LIKE 'pft-%'");
test.beforeEach(wipe);

test('a failed item without a cause is rejected at parse', () => {
  assert.throws(() => parseFailures(file(T1, { 'pft-a-1': item('failed', null, T1) })), /cause/);
});

test('an invented cause and a skipped item with a failure cause are rejected', () => {
  assert.throws(() => parseFailures(file(T1, { 'pft-a-1': item('failed', 'looks-wrong', T1) })), /cause/);
  assert.throws(() => parseFailures(file(T1, { 'pft-a-1': item('skipped', 'magenta-pixel', T1) })), /cause/);
});

test('skipped rows are stored but never counted as failures', async () => {
  const f = parseFailures(file(T1, {
    'pft-a-1': item('ok', null, T1),
    'pft-a-2': item('skipped', 'no-prefab', T1),
    'pft-a-3': item('failed', 'unrenderable-material', T1, { shaders: ['Foo/Bar'] }),
  }));
  const s = await ingestFailures(pool, f);
  assert.equal(s.failed, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.ok, 1);
  assert.equal(s.written, 3);
  assert.deepEqual((await row('pft-a-3')).shaders, ['Foo/Bar']);
  assert.equal((await row('pft-a-2')).state, 'skipped');
});

test('upsert is idempotent: the same file twice leaves one row per slug', async () => {
  const f = parseFailures(file(T1, { 'pft-a-1': item('failed', 'exception', T1, { detail: 'boom' }) }));
  await ingestFailures(pool, f);
  await ingestFailures(pool, f);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM preview_render WHERE slug LIKE \'pft-%\'')).rows[0].n, 1);
  assert.equal((await row('pft-a-1')).detail, 'boom');
});

test('latest run wins and an older run never overwrites a newer one', async () => {
  await ingestFailures(pool, parseFailures(file(T2, { 'pft-a-1': item('ok', null, T2) })));
  const stale = await ingestFailures(pool, parseFailures(file(T1, { 'pft-a-1': item('failed', 'magenta-pixel', T1) })));
  assert.equal(stale.written, 0);
  assert.equal(stale.stale, 1);
  assert.equal((await row('pft-a-1')).state, 'ok');
  await ingestFailures(pool, parseFailures(file(T2, { 'pft-a-1': item('failed', 'magenta-pixel', T2) })));
  assert.equal((await row('pft-a-1')).state, 'failed');
});

test('the DB CHECK constraints reject what parse would have (defence in depth)', async () => {
  const forged = { version: 1 as const, runId: T1, items: { 'pft-a-1': item('failed', null, T1) } } as unknown as Parameters<typeof buildUpsert>[0];
  const { sql, params } = buildUpsert(forged);
  await assert.rejects(pool.query(sql, params), /check constraint/);
});

test('a DB without migration 010 is refused with a clear message', async () => {
  const noTable = { query: async () => ({ rows: [{ t: null }], rowCount: 1 }) };
  await assert.rejects(ingestFailures(noTable, parseFailures(file(T1, { 'pft-a-1': item('ok', null, T1) }))), /migration 010/);
});

test('summarize counts an empty file as zero everything', () => {
  assert.deepEqual(summarize(parseFailures(file(T1, {}))), { runId: T1, total: 0, ok: 0, failed: 0, skipped: 0, written: 0, stale: 0 });
});
