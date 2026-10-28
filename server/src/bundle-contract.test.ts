import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AssetFileInputSchema,
  BundleSchema,
  ErrorEnvelopeSchema,
  KIND_RANK,
  KINDS,
  kindOfPath,
  RenderFailureFileSchema,
  reroot,
} from './bundle-contract.ts';
import { assertScratchDb } from './test-fixtures/scratch-db.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(here, 'test-fixtures', name), 'utf8'));
const clone = <T>(v: T): T => structuredClone(v);

const SHA = 'a'.repeat(64);
const GUID = 'b'.repeat(32);

// ---------- pure: schemas, classification, reroot (no DB) ----------

test('the sample bundle fixture is a valid vfx-bundle/1 (C4)', () => {
  const parsed = BundleSchema.safeParse(fixture('bundle-sample.json'));
  assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues));
});

test('a bundle with an extra key or a missing key fails (strict, C4 null semantics)', () => {
  const extra = clone(fixture('bundle-sample.json')) as Record<string, unknown>;
  extra.surprise = true;
  assert.equal(BundleSchema.safeParse(extra).success, false, 'extra key');
  const missing = clone(fixture('bundle-sample.json')) as Record<string, unknown>;
  delete missing.cycles;
  assert.equal(BundleSchema.safeParse(missing).success, false, 'missing key');
});

test('a bundle whose file_count disagrees with files, or that is complete with unresolved entries, fails', () => {
  const badCount = clone(fixture('bundle-sample.json')) as { file_count: number };
  badCount.file_count += 1;
  assert.equal(BundleSchema.safeParse(badCount).success, false, 'file_count');
  const unresolved = clone(fixture('bundle-sample.json')) as { unresolved: unknown[] };
  unresolved.unresolved = [{ guid: GUID, referenced_by: [GUID] }];
  assert.equal(BundleSchema.safeParse(unresolved).success, false, 'complete true with unresolved');
});

test('reason set means files is empty and complete is false (C4)', () => {
  const b = clone(fixture('bundle-sample.json')) as Record<string, unknown>;
  b.reason = 'no_prefab';
  assert.equal(BundleSchema.safeParse(b).success, false, 'reason with files and complete true');
});

test('variant urp with a non-material is rejected by the input schema (C3)', () => {
  const input = {
    guid: GUID, variant: 'urp', kind: 'texture', path: 'Assets/a.png', asset_sha256: SHA, meta_sha256: null,
    pack: 'p', license: 'studio-internal', visibility: 'studio-only',
    source: { game: null, origin: 'x' }, urp: { rule: 'r', glow_cap: null, shader_guid: GUID },
  };
  assert.equal(AssetFileInputSchema.safeParse(input).success, false);
  assert.equal(AssetFileInputSchema.safeParse({ ...input, kind: 'material' }).success, true, 'material urp is fine');
});

test('an asset input with a bad guid or sha256 shape, or visibility global, fails (C1, C2)', () => {
  const base = {
    guid: GUID, variant: 'original', kind: 'prefab', path: 'Assets/a.prefab', asset_sha256: SHA, meta_sha256: null,
    pack: 'p', license: 'studio-internal', visibility: 'studio-only', source: { game: 'A', origin: 'x' },
  };
  assert.equal(AssetFileInputSchema.safeParse(base).success, true);
  assert.equal(AssetFileInputSchema.safeParse({ ...base, guid: 'G'.repeat(32) }).success, false, 'upper-case guid');
  assert.equal(AssetFileInputSchema.safeParse({ ...base, asset_sha256: 'abc' }).success, false, 'short sha');
  assert.equal(AssetFileInputSchema.safeParse({ ...base, visibility: 'global' }).success, false, 'global never for bytes');
});

test('kindOfPath: Unity extensions map to the contract kinds; .asmref is asmdef; unknown is other', () => {
  assert.equal(kindOfPath('Assets/a/Boom.prefab'), 'prefab');
  assert.equal(kindOfPath('Assets/a/Fire.MAT'), 'material');
  assert.equal(kindOfPath('Assets/a/Fire.png'), 'texture');
  assert.equal(kindOfPath('Assets/a/Fx.shadergraph'), 'shader');
  assert.equal(kindOfPath('Assets/a/Fx.asmref'), 'asmdef');
  assert.equal(kindOfPath('Assets/a/Fx.asmdef'), 'asmdef');
  assert.equal(kindOfPath('Assets/a/Whoosh.wav'), 'audio');
  assert.equal(kindOfPath('Assets/a/Ball.fbx'), 'mesh');
  assert.equal(kindOfPath('Assets/a/notes.txt'), 'other');
});

test('KIND_RANK covers every kind, shader first and prefab last (C4 ordering)', () => {
  assert.deepEqual([...KINDS].sort(), Object.keys(KIND_RANK).sort());
  const order = Object.entries(KIND_RANK).sort((a, b) => a[1] - b[1]).map(([k]) => k);
  assert.equal(order[0], 'shader');
  assert.equal(order[order.length - 1], 'prefab');
});

test('reroot: replaces only the Assets/VFXCloud/<pack> prefix, per the fixture table (C4)', () => {
  const cases = fixture('reroot-cases.json') as Array<{ target_path: string; root: string | null; expected: string }>;
  assert.ok(cases.length >= 8);
  for (const c of cases) {
    assert.equal(reroot(c.target_path, c.root), c.expected, `${c.target_path} @ ${String(c.root)}`);
  }
});

test('error envelope: code must be one of the contracted codes (C5)', () => {
  assert.equal(ErrorEnvelopeSchema.safeParse({ error: 'bad hash', code: 'invalid', details: { actual: SHA } }).success, true);
  assert.equal(ErrorEnvelopeSchema.safeParse({ error: 'too big', code: 'too_large' }).success, true);
  assert.equal(ErrorEnvelopeSchema.safeParse({ error: 'no', code: 'teapot' }).success, false);
});

test('render failure file: C9 cause enums are enforced per state', () => {
  const ok = {
    version: 1,
    runId: '2026-10-28T10:00:00Z',
    items: {
      'fire-burst': { state: 'ok', cause: null, detail: null, shaders: [], renderedAt: '2026-10-28T10:00:01Z' },
      'smoke-wisp': { state: 'failed', cause: 'magenta-pixel', detail: 'ErrorShader', shaders: ['Hidden/Error'], renderedAt: '2026-10-28T10:00:02Z' },
      'ball-hit': { state: 'skipped', cause: 'no-prefab', detail: null, shaders: [], renderedAt: '2026-10-28T10:00:03Z' },
    },
  };
  assert.equal(RenderFailureFileSchema.safeParse(ok).success, true);
  const invented = structuredClone(ok) as typeof ok;
  invented.items['smoke-wisp'].cause = 'looks-wrong';
  assert.equal(RenderFailureFileSchema.safeParse(invented).success, false, 'invented cause');
  const noCause = structuredClone(ok) as unknown as { items: Record<string, { cause: string | null }> };
  noCause.items['smoke-wisp'].cause = null;
  assert.equal(RenderFailureFileSchema.safeParse(noCause).success, false, 'failed without a cause');
  const wrongSkip = structuredClone(ok) as typeof ok;
  wrongSkip.items['ball-hit'].cause = 'magenta-pixel';
  assert.equal(RenderFailureFileSchema.safeParse(wrongSkip).success, false, 'skipped with a failure cause');
});

// ---------- DB: the CHECK constraints the contract relies on (scratch DB only) ----------

const { pool, migrate } = await import('./db.ts');
after(async () => {
  await pool.end();
});

async function withScratch<T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  assertScratchDb();
  await migrate();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

const blobInsert = `INSERT INTO asset_blob (sha256, bytes, stored_bytes, encoding, storage_uri)
  VALUES ($1, 10, 10, 'identity', 'blobs/aa/aa/' || $1)`;
const fileInsert = `INSERT INTO asset_file (guid, variant, kind, path, asset_sha256, pack, license, visibility, ai_training)
  VALUES ($1, 'original', 'prefab', 'Assets/a.prefab', $2, 'p', 'studio-internal', $3, $4)`;

test('migration 010 widened both visibility CHECKs (resource, asset) to include studio-only', async () => {
  await withScratch(async (c) => {
    const r = await c.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname IN ('resource_visibility_check','asset_visibility_check')`,
    );
    assert.equal(r.rowCount, 2, 'both constraint names exist');
    for (const row of r.rows) assert.match(row.def, /studio-only/, row.conname);
  });
});

test('asset_file: a row can never be global, ai_training is never true, guid and sha shapes are enforced', async () => {
  await withScratch(async (c) => {
    await c.query(blobInsert, [SHA]);
    await c.query('SAVEPOINT s1');
    await assert.rejects(c.query(fileInsert, [GUID, SHA, 'global', false]), /asset_file_visibility_check|check constraint/);
    await c.query('ROLLBACK TO SAVEPOINT s1');
    await c.query('SAVEPOINT s2');
    await assert.rejects(c.query(fileInsert, [GUID, SHA, 'studio-only', true]), /asset_file_ai_training_check|check constraint/);
    await c.query('ROLLBACK TO SAVEPOINT s2');
    await c.query('SAVEPOINT s3');
    await assert.rejects(c.query(fileInsert, ['G'.repeat(32), SHA, 'studio-only', false]), /check constraint/);
    await c.query('ROLLBACK TO SAVEPOINT s3');
    const ok = await c.query(fileInsert, [GUID, SHA, 'studio-only', false]);
    assert.equal(ok.rowCount, 1, 'a studio-only, ai_training=false row is accepted');
  });
});

test('asset_blob: sha256 shape and the encoding enum are enforced', async () => {
  await withScratch(async (c) => {
    await c.query('SAVEPOINT b1');
    await assert.rejects(c.query(blobInsert, ['A'.repeat(64)]), /check constraint/);
    await c.query('ROLLBACK TO SAVEPOINT b1');
    await c.query('SAVEPOINT b2');
    await assert.rejects(
      c.query(`INSERT INTO asset_blob (sha256, bytes, stored_bytes, encoding, storage_uri) VALUES ($1, 1, 1, 'lz4', 'x')`, [SHA]),
      /check constraint/,
    );
    await c.query('ROLLBACK TO SAVEPOINT b2');
  });
});

test('preview_render: an invented cause is rejected; failed needs a cause (C9)', async () => {
  await withScratch(async (c) => {
    const ins = `INSERT INTO preview_render (slug, state, cause, run_id, rendered_at) VALUES ($1, $2, $3, 'r1', now())`;
    await c.query('SAVEPOINT p1');
    await assert.rejects(c.query(ins, ['x-1', 'failed', 'looks-wrong']), /check constraint/);
    await c.query('ROLLBACK TO SAVEPOINT p1');
    await c.query('SAVEPOINT p2');
    await assert.rejects(c.query(ins, ['x-2', 'failed', null]), /check constraint/);
    await c.query('ROLLBACK TO SAVEPOINT p2');
    const ok = await c.query(ins, ['x-3', 'failed', 'magenta-pixel']);
    assert.equal(ok.rowCount, 1);
  });
});
