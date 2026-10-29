// Run through scripts/accept/with-testdb.sh (scratch DB, migration 010 applied). Never against the live DB.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { assertScratchDb } from '../server/src/test-fixtures/scratch-db.ts';
import { incompleteByDesignPacks, protectedReason, recordClosure } from './closure-record.ts';

assertScratchDb();
const { pool } = await import('../server/src/db.ts');
after(() => pool.end());

const q = async (sql: string, p?: unknown[]) => (await pool.query(sql, p)).rows;
const T = '2026-10-28T10:00:00.000Z';
const seed = (slug: string, state: string, cause: string | null) =>
  pool.query(`INSERT INTO preview_render (slug, state, cause, detail, shaders, run_id, rendered_at) VALUES ($1,$2,$3,'seeded','{}','r0',$4)`, [slug, state, cause, T]);
const get = async (slug: string) => (await q('SELECT state, cause, detail, run_id FROM preview_render WHERE slug = $1', [slug]))[0];
const finding = (slug: string) => ({ slug, reason: 'bytes_not_uploaded', unresolved: ['aa'] });
const PACKS = ['bypass-pack'];

test.beforeEach(async () => { await pool.query('DELETE FROM preview_render'); });

test('packs flagged without completeSource are incomplete by design (read from packs.json, namufx included)', () => {
  const d = incompleteByDesignPacks();
  assert.ok(d.includes('namufx-stylized-water'));
  assert.ok(!d.includes('retro-arsenal'));
});

test('a documented unfixable-* row is never overwritten by a closure finding', async () => {
  await seed('retro-arsenal-x', 'failed', 'unfixable-source');
  const r = await recordClosure(q, [finding('retro-arsenal-x')], [], 'verify-1', PACKS);
  assert.deepEqual(r.written, []);
  assert.equal((await get('retro-arsenal-x')).cause, 'unfixable-source');
});

test('an ok render of an incomplete-by-design pack stays ok', async () => {
  await seed('bypass-pack-splash', 'ok', null);
  const r = await recordClosure(q, [finding('bypass-pack-splash')], [], 'verify-1', PACKS);
  assert.equal(r.protectedSlugs.length, 1);
  assert.equal((await get('bypass-pack-splash')).state, 'ok');
});

test('an ok render of a complete pack still becomes closure-unresolved (a real regression is recorded)', async () => {
  await seed('retro-arsenal-y', 'ok', null);
  await recordClosure(q, [finding('retro-arsenal-y')], [], 'verify-1', PACKS);
  assert.equal((await get('retro-arsenal-y')).cause, 'closure-unresolved');
});

test('a slug with no row, or with another failure cause, is recorded', async () => {
  await seed('retro-arsenal-z', 'failed', 'magenta-pixel');
  const r = await recordClosure(q, [finding('retro-arsenal-new'), finding('retro-arsenal-z')], [], 'verify-1', PACKS);
  assert.deepEqual(r.written.sort(), ['retro-arsenal-new', 'retro-arsenal-z']);
});

test('existing behaviour kept: stale closure-unresolved rows of slugs now complete are cleared, other rows are not', async () => {
  await seed('a-1', 'failed', 'closure-unresolved');
  await seed('a-2', 'failed', 'unfixable-script');
  await seed('a-3', 'ok', null);
  const r = await recordClosure(q, [], ['a-1', 'a-2', 'a-3'], 'verify-1', PACKS);
  assert.equal(r.cleared, 1);
  assert.equal(await get('a-1'), undefined);
  assert.equal((await get('a-2')).cause, 'unfixable-script');
  assert.ok(await get('a-3'));
});

test('protectedReason is pure', () => {
  assert.equal(protectedReason('p-a', undefined, ['p']), null);
  assert.match(protectedReason('p-a', { state: 'failed', cause: 'unfixable-shader' }, [])!, /documented/);
  assert.equal(protectedReason('other-a', { state: 'ok', cause: null }, ['p']), null);
});
