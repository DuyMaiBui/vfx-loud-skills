// Self-test of with-corpus-clone.sh on SCRATCH DBs only (a dump of a scratch DB stands in for the live dump, so the live
// DB is never reached): the restored clone must carry the source marker row, be migrated, copy only payload dirs, and be dropped after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, '../..');
const sh = (args: string[]) => spawnSync('bash', args, { cwd: repo, encoding: 'utf8' });
const container = process.env.VFX_PG_CONTAINER ?? 'vfx-pg';
const psql = (db: string, sql: string) => spawnSync('podman', ['exec', container, 'psql', '-U', 'vfx', '-d', db, '-Atc', sql], { encoding: 'utf8' });

test('with-corpus-clone: restores the dump into a migrated scratch clone, copies payload dirs only, drops it after', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccclone-'));
  const dump = path.join(tmp, 'src.dump');
  const src = path.join(tmp, 'data');
  for (const d of ['recipe', 'blobs']) fs.mkdirSync(path.join(src, d), { recursive: true });
  fs.writeFileSync(path.join(src, 'recipe', 'x.json'), '{}');
  fs.writeFileSync(path.join(src, 'blobs', 'big.bin'), 'x');
  try {
    // a migrated scratch source with one marker row, dumped like the live DB would be
    const mk = sh(['scripts/accept/with-testdb.sh', 'ccsrc', 'bash', '-c',
      `podman exec ${container} psql -U vfx -d "$VFX_TESTDB_NAME" -Atc "INSERT INTO resource (uri,type,slug,name,license,storage_uri) VALUES ('vfx://recipe/ccmarker/1','recipe','ccmarker','m','cc0','x')" && podman exec ${container} pg_dump -U vfx -Fc "$VFX_TESTDB_NAME" > ${dump}`]);
    assert.equal(mk.status, 0, mk.stderr);
    const r = sh(['scripts/accept/with-corpus-clone.sh', '--lane', 'ccclone', '--dump', dump, '--data-src', src, '--', 'bash', '-c',
      `echo DB=$VFX_TESTDB_NAME; podman exec ${container} psql -U vfx -d "$VFX_TESTDB_NAME" -Atc "SELECT slug FROM resource; SELECT name FROM schema_migrations WHERE name LIKE '010%'"; ls "$DATA_DIR"`]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DB=vfxcloud_test_ccclone/);
    assert.match(r.stdout, /^ccmarker$/m, 'marker row restored');
    assert.match(r.stdout, /^010_asset_blobs\.sql$/m, 'clone is migrated');
    assert.match(r.stdout, /^recipe$/m, 'payload dir copied');
    assert.doesNotMatch(r.stdout, /^blobs$/m, 'blobs are NOT copied');
    assert.equal(psql('postgres', "SELECT count(*) FROM pg_database WHERE datname='vfxcloud_test_ccclone'").stdout.trim(), '0', 'clone dropped after the run');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('with-corpus-clone: refuses an empty dump and a lane that would not carry the _test_ marker (exit 2)', () => {
  const empty = path.join(os.tmpdir(), `ccempty-${process.pid}.dump`);
  fs.writeFileSync(empty, '');
  try {
    assert.equal(sh(['scripts/accept/with-corpus-clone.sh', '--dump', empty, '--', 'true']).status, 2);
    const nonEmpty = `${empty}.x`;
    fs.writeFileSync(nonEmpty, 'x');
    try {
      assert.equal(sh(['scripts/accept/with-corpus-clone.sh', '--lane', 'Bad_Lane', '--dump', nonEmpty, '--', 'true']).status, 2);
    } finally {
      fs.rmSync(nonEmpty, { force: true });
    }
  } finally {
    fs.rmSync(empty, { force: true });
  }
});
