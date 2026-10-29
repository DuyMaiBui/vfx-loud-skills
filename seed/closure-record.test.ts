// Run through scripts/accept/with-testdb.sh (scratch DB, migration 010 applied). Never against the live DB.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { assertScratchDb } from '../server/src/test-fixtures/scratch-db.ts';
import { incompleteByDesignPacks, protectedReason, recordClosure } from './closure-record.ts';

assertScratchDb();
const { pool } = await import('../server/src/db.ts');
after(async () => { await wipe(); await pool.end(); });

const q = async (sql: string, p?: unknown[]) => (await pool.query(sql, p)).rows;
const T = '2026-10-28T10:00:00.000Z';
const seed = (slug: string, state: string, cause: string | null) =>
  pool.query(`INSERT INTO preview_render (slug, state, cause, detail, shaders, run_id, rendered_at) VALUES ($1,$2,$3,'seeded','{}','r0',$4)`, [slug, state, cause, T]);
const get = async (slug: string) => (await q('SELECT state, cause, detail, run_id FROM preview_render WHERE slug = $1', [slug]))[0];
const finding = (slug: string) => ({ slug, reason: 'bytes_not_uploaded', unresolved: ['aa'] });
const PACKS = ['crt-bypass-pack'];

// Scoped to this file's own synthetic slugs: node --test runs files concurrently in ONE shared DB (corpus-clone profile),
// so a blanket DELETE would wipe other files' rows (and theirs ours).
const OWN = "slug LIKE 'crt-%'";
const wipe = () => pool.query(`DELETE FROM preview_render WHERE ${OWN}`);
test.beforeEach(wipe);

test('packs flagged without completeSource are incomplete by design (read from packs.json, namufx included)', () => {
  const d = incompleteByDesignPacks();
  assert.ok(d.includes('namufx-stylized-water'));
  assert.ok(!d.includes('retro-arsenal'));
});

test('a documented unfixable-* row is never overwritten by a closure finding', async () => {
  await seed('crt-retro-arsenal-x', 'failed', 'unfixable-source');
  const r = await recordClosure(q, [finding('crt-retro-arsenal-x')], [], 'verify-1', PACKS);
  assert.deepEqual(r.written, []);
  assert.equal((await get('crt-retro-arsenal-x')).cause, 'unfixable-source');
});

test('an ok render of an incomplete-by-design pack stays ok', async () => {
  await seed('crt-bypass-pack-splash', 'ok', null);
  const r = await recordClosure(q, [finding('crt-bypass-pack-splash')], [], 'verify-1', PACKS);
  assert.equal(r.protectedSlugs.length, 1);
  assert.equal((await get('crt-bypass-pack-splash')).state, 'ok');
});

test('an ok render of a complete pack still becomes closure-unresolved (a real regression is recorded)', async () => {
  await seed('crt-retro-arsenal-y', 'ok', null);
  await recordClosure(q, [finding('crt-retro-arsenal-y')], [], 'verify-1', PACKS);
  assert.equal((await get('crt-retro-arsenal-y')).cause, 'closure-unresolved');
});

test('a slug with no row, or with another failure cause, is recorded', async () => {
  await seed('crt-retro-arsenal-z', 'failed', 'magenta-pixel');
  const r = await recordClosure(q, [finding('crt-retro-arsenal-new'), finding('crt-retro-arsenal-z')], [], 'verify-1', PACKS);
  assert.deepEqual(r.written.sort(), ['crt-retro-arsenal-new', 'crt-retro-arsenal-z']);
});

test('existing behaviour kept: stale closure-unresolved rows of slugs now complete are cleared, other rows are not', async () => {
  await seed('crt-a-1', 'failed', 'closure-unresolved');
  await seed('crt-a-2', 'failed', 'unfixable-script');
  await seed('crt-a-3', 'ok', null);
  const r = await recordClosure(q, [], ['crt-a-1', 'crt-a-2', 'crt-a-3'], 'verify-1', PACKS);
  assert.equal(r.cleared, 1);
  assert.equal(await get('crt-a-1'), undefined);
  assert.equal((await get('crt-a-2')).cause, 'unfixable-script');
  assert.ok(await get('crt-a-3'));
});

test('protectedReason is pure', () => {
  assert.equal(protectedReason('p-a', undefined, ['p']), null);
  assert.match(protectedReason('p-a', { state: 'failed', cause: 'unfixable-shader' }, [])!, /documented/);
  assert.equal(protectedReason('other-a', { state: 'ok', cause: null }, ['p']), null);
});
