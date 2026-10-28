// Falsifiability test for phase-9.sh on a SCRATCH DB (VFX_LIVE_DB points at it; the live DB is never reached) with a stub
// blob server. The seven non-suite checks must PASS on a conforming fixture and each must go FAIL when its subject breaks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Own private scratch DB (never the suite's shared one: this test inserts recipes that would leak into sibling files).
const dbName = 'vfxcloud_test_p9t';
const container = process.env.VFX_PG_CONTAINER ?? 'vfx-pg';
const pg = (cmd: string, ...a: string[]) => spawnSync('podman', ['exec', container, cmd, '-U', 'vfx', ...a], { encoding: 'utf8' });
pg('dropdb', '--if-exists', dbName);
assert.equal(pg('createdb', dbName).status, 0, 'createdb');
process.env.DATABASE_URL = `postgres://vfx:${process.env.VFX_TEST_PG_PASSWORD ?? 'vfx'}@${process.env.VFX_TEST_PG_HOST ?? '127.0.0.1'}:${process.env.VFX_TEST_PG_PORT ?? '5432'}/${dbName}`;
const { pool, migrate } = await import('../../server/src/db.ts');
await migrate();
const SHA = 'a'.repeat(64);
let status = 403;
const stub = http.createServer((_q, r) => { r.statusCode = status; r.end(); });
const reports = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-'));
let port = 0;

before(async () => {
  await new Promise<void>((ok) => stub.listen(0, '127.0.0.1', ok));
  port = (stub.address() as { port: number }).port;
  fs.writeFileSync(path.join(reports, 'upload-original.json'), '{"files":1}');
  fs.writeFileSync(path.join(reports, 'closure-verify.json'), '{"checked":3,"sha_mismatch":[]}');
  await pool.query(`INSERT INTO asset_blob (sha256, bytes, stored_bytes, encoding, storage_uri) VALUES ($1, 1, 1, 'identity', 'x')`, [SHA]);
  await pool.query(`INSERT INTO asset_file (guid, variant, kind, path, asset_sha256, pack, license, visibility) VALUES ($1,'original','prefab','p',$2,'studio-game-vfx','studio-internal','studio-only')`, ['b'.repeat(32), SHA]);
  const r = `INSERT INTO resource (uri,type,slug,name,license,visibility,storage_uri,meta) VALUES ($1,'recipe',$2,'n',$3,$4,'x',$5)`;
  await pool.query(r, ['vfx://recipe/game1/1', 'game1', 'studio-internal', 'studio-only', { pack: 'studio-game-vfx', ai_training: false }]);
  await pool.query(r, ['vfx://recipe/old1/1', 'old1', 'cc0', 'project', {}]);
});
after(async () => { stub.close(); await pool.end(); pg('dropdb', '--if-exists', dbName); fs.rmSync(reports, { recursive: true, force: true }); });

/** Async spawn: the stub server lives in THIS event loop, a spawnSync would starve the curl inside phase-9.sh. */
function run(): Promise<{ code: number; out: Record<string, string> }> {
  return new Promise((resolve) => {
    const c = spawn('bash', ['scripts/accept/phase-9.sh'], {
      env: { ...process.env, VFX_LIVE_DB: dbName, VFX_SERVER: `http://127.0.0.1:${port}`, PHASE9_REPORTS: reports, PHASE9_PRE_RECIPES: '1', PHASE9_SKIP_SUITES: '1' },
    });
    let stdout = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.on('close', (code) => {
      const out: Record<string, string> = {};
      for (const l of stdout.split('\n')) { const m = /^CHECK (\S+) (PASS|FAIL|SKIP)/.exec(l); if (m) out[m[1]!] = m[2]!; }
      resolve({ code: code ?? -1, out });
    });
  });
}
const NON_SUITE = ['migration_010_once', 'asset_file_matches_upload', 'no_global_or_ai_training', 'game_recipes_studio_only', 'blob_403_without_key', 'closure_sha_mismatch_zero', 'preexisting_recipes_unchanged'];

test('phase-9: a conforming fixture passes every non-suite check; the skipped suites still make the exit non-zero (2)', async () => {
  const { code, out } = await run();
  for (const n of NON_SUITE) assert.equal(out[n], 'PASS', n);
  assert.equal(out.pinned_baseline_scratch_unseeded, 'SKIP');
  assert.equal(code, 2, 'exit code = failed + skipped');
});

test('phase-9: breaking each subject turns exactly its check FAIL', async () => {
  status = 200;
  assert.equal((await run()).out.blob_403_without_key, 'FAIL');
  status = 403;
  await pool.query(`UPDATE resource SET license='cc0' WHERE slug='game1'`);
  assert.equal((await run()).out.game_recipes_studio_only, 'FAIL');
  await pool.query(`UPDATE resource SET license='studio-internal' WHERE slug='game1'`);
  fs.writeFileSync(path.join(reports, 'closure-verify.json'), '{"checked":3,"sha_mismatch":["x"]}');
  assert.equal((await run()).out.closure_sha_mismatch_zero, 'FAIL');
  fs.writeFileSync(path.join(reports, 'closure-verify.json'), '{"checked":3,"sha_mismatch":[]}');
  await pool.query(`INSERT INTO resource (uri,type,slug,name,license,visibility,storage_uri) VALUES ('vfx://recipe/old2/1','recipe','old2','n','cc0','project','x')`);
  assert.equal((await run()).out.preexisting_recipes_unchanged, 'FAIL');
  await pool.query(`DELETE FROM resource WHERE slug='old2'`);
  fs.writeFileSync(path.join(reports, 'upload-original.json'), '{"files":2}');
  assert.equal((await run()).out.asset_file_matches_upload, 'FAIL');
  const ok = await run();
  fs.writeFileSync(path.join(reports, 'upload-original.json'), '{"files":1}');
  assert.equal(ok.out.migration_010_once, 'PASS');
});
