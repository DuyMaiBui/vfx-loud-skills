import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from './config.ts';
import { pool } from './db.ts';
import { buildHttp } from './http.ts';
import { assertScratchDb } from './test-fixtures/scratch-db.ts';
import * as blobs from './blob-store.ts';

assertScratchDb();

const KEY = 'blob-test-key';
const orig = { apiKey: config.apiKey, authDisabled: config.authDisabled, allowAnon: config.blobAllowAnon, max: config.blobMaxBytes };
config.apiKey = KEY;
config.authDisabled = false;
config.blobAllowAnon = false;
const H = { 'x-vfx-key': KEY };

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const OCT = { 'content-type': 'application/octet-stream' };
const guidOf = (s: string): string => sha(s).slice(0, 32);

after(async () => {
  Object.assign(config, { apiKey: orig.apiKey, authDisabled: orig.authDisabled, blobAllowAnon: orig.allowAnon, blobMaxBytes: orig.max });
  await pool.end();
});

/** Register one asset_file so a stored blob becomes servable (C1). */
async function register(app: Awaited<ReturnType<typeof buildHttp>>, name: string, asset: string, meta: string | null, kind = 'material'): Promise<void> {
  const res = await app.inject({
    method: 'POST', url: '/v1/asset-file/batch', headers: H,
    payload: {
      files: [{
        guid: guidOf(name), variant: 'original', kind, path: `Assets/T/${name}`, asset_sha256: asset, meta_sha256: meta,
        pack: 'blob-test', license: 'studio-internal', visibility: 'studio-only', source: { game: null, origin: 'test' },
      }],
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().results[0].status, 'created', res.body);
}

test('PUT/GET round trip: gzip-at-rest text served as gzip or as plain bytes, binary as is', async () => {
  const app = await buildHttp();
  const text = Buffer.from('%YAML 1.1\nMaterial:\n  m_Name: rt\n'.repeat(40));
  const bin = Buffer.concat([Buffer.from([0x89, 0x50, 0x00, 0x01]), Buffer.alloc(300, 7)]);
  const metaText = Buffer.from('fileFormatVersion: 2\nguid: ' + guidOf('rt.mat') + '\n');

  const p1 = await app.inject({ method: 'PUT', url: `/v1/blob/${sha(text)}`, headers: { ...H, ...OCT, 'x-vfx-kind': 'material' }, payload: text });
  assert.equal(p1.statusCode, 201, p1.body);
  assert.deepEqual(p1.json(), { sha256: sha(text), bytes: text.length, created: true });
  const p2 = await app.inject({ method: 'PUT', url: `/v1/blob/${sha(text)}`, headers: { ...H, ...OCT, 'x-vfx-kind': 'material' }, payload: text });
  assert.equal(p2.statusCode, 200);
  assert.equal(p2.json().created, false, 'second put of the same sha is a no-op');
  assert.equal((await app.inject({ method: 'PUT', url: `/v1/blob/${sha(bin)}`, headers: { ...H, ...OCT, 'x-vfx-kind': 'texture' }, payload: bin })).statusCode, 201);
  assert.equal((await app.inject({ method: 'PUT', url: `/v1/blob/${sha(metaText)}`, headers: { ...H, ...OCT, 'x-vfx-kind': 'meta' }, payload: metaText })).statusCode, 201);

  const encRows = await pool.query<{ sha256: string; encoding: string }>('SELECT sha256, encoding FROM asset_blob WHERE sha256 = ANY($1)', [[sha(text), sha(bin)]]);
  const enc = Object.fromEntries(encRows.rows.map((r) => [r.sha256, r.encoding]));
  assert.equal(encRows.rowCount, 2);
  assert.equal(enc[sha(text)], 'gzip');
  assert.equal(enc[sha(bin)], 'identity');
  const onDisk = path.join(config.blobDir, sha(text).slice(0, 2), sha(text).slice(2, 4), sha(text));
  assert.ok(fs.statSync(onDisk).size < text.length, 'text kind is gzipped at rest');

  await register(app, 'rt.mat', sha(text), sha(metaText));
  await register(app, 'rt.png', sha(bin), null, 'texture');

  const gz = await app.inject({ method: 'GET', url: `/v1/blob/${sha(text)}`, headers: { ...H, 'accept-encoding': 'gzip' } });
  assert.equal(gz.statusCode, 200);
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.deepEqual(zlib.gunzipSync(gz.rawPayload), text);
  assert.equal(gz.headers.etag, `"${sha(text)}"`);
  assert.equal(gz.headers['x-vfx-sha256'], sha(text));
  assert.match(String(gz.headers['cache-control']), /private.*immutable/);

  const plain = await app.inject({ method: 'GET', url: `/v1/blob/${sha(text)}`, headers: H });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(plain.rawPayload, text, 'a client without gzip gets the decompressed bytes');

  const binGet = await app.inject({ method: 'GET', url: `/v1/blob/${sha(bin)}`, headers: { ...H, 'accept-encoding': 'gzip' } });
  assert.equal(binGet.headers['content-encoding'], undefined, 'binary kinds are never gzip-encoded');
  assert.deepEqual(binGet.rawPayload, bin);

  const meta = await app.inject({ method: 'GET', url: `/v1/blob/${sha(metaText)}`, headers: H });
  assert.equal(meta.statusCode, 200, 'a .meta blob (meta_sha256 only) is served');
  assert.deepEqual(meta.rawPayload, metaText);

  const nm = await app.inject({ method: 'GET', url: `/v1/blob/${sha(text)}`, headers: { ...H, 'if-none-match': `"${sha(text)}"` } });
  assert.equal(nm.statusCode, 304);
  const head = await app.inject({ method: 'HEAD', url: `/v1/blob/${sha(bin)}`, headers: H });
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers['content-length'], String(bin.length));
  assert.equal(head.rawPayload.length, 0);
  await app.close();
});

test('a body whose hash differs from :sha256 is 400 invalid with details.actual and leaves nothing behind', async () => {
  const app = await buildHttp();
  const body = Buffer.from('actual bytes');
  const claimed = sha('something else');
  const res = await app.inject({ method: 'PUT', url: `/v1/blob/${claimed}`, headers: { ...H, ...OCT }, payload: body });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().code, 'invalid');
  assert.equal(res.json().details.actual, sha(body));
  assert.equal((await pool.query('SELECT 1 FROM asset_blob WHERE sha256 = $1', [claimed])).rowCount, 0);
  assert.ok(!fs.existsSync(path.join(config.blobDir, claimed.slice(0, 2), claimed.slice(2, 4), claimed)));
  assert.deepEqual(fs.readdirSync(path.join(config.blobDir, 'tmp')), [], 'temp file removed');
  const bad = await app.inject({ method: 'PUT', url: '/v1/blob/NOT-A-HASH', headers: { ...H, ...OCT }, payload: body });
  assert.equal(bad.statusCode, 400);
  const kind = await app.inject({ method: 'PUT', url: `/v1/blob/${sha(body)}`, headers: { ...H, ...OCT, 'x-vfx-kind': 'bogus' }, payload: body });
  assert.equal(kind.statusCode, 400);
  await app.close();
});

test('VFX_BLOB_MAX_BYTES: a blob above the limit is 413 too_large and removes its temp file', async () => {
  config.blobMaxBytes = 64;
  try {
    const app = await buildHttp();
    const big = Buffer.alloc(65, 1);
    const res = await app.inject({ method: 'PUT', url: `/v1/blob/${sha(big)}`, headers: { ...H, ...OCT }, payload: big });
    assert.equal(res.statusCode, 413, res.body);
    assert.equal(res.json().code, 'too_large');
    const ok = Buffer.alloc(64, 2);
    assert.equal((await app.inject({ method: 'PUT', url: `/v1/blob/${sha(ok)}`, headers: { ...H, ...OCT }, payload: ok })).statusCode, 201);
    // the store enforces the same limit itself (no HTTP bodyLimit involved)
    await assert.rejects(blobs.putBlob(Buffer.alloc(65, 3), sha(Buffer.alloc(65, 3))), (e: { code?: string }) => e.code === 'too_large');
    assert.deepEqual(fs.readdirSync(path.join(config.blobDir, 'tmp')), []);
    await app.close();
  } finally {
    config.blobMaxBytes = orig.max;
  }
});

test('an orphan blob (no asset_file row) is 404, even though it is stored', async () => {
  const app = await buildHttp();
  const body = Buffer.from('orphan bytes, referenced by nothing');
  assert.equal((await app.inject({ method: 'PUT', url: `/v1/blob/${sha(body)}`, headers: { ...H, ...OCT }, payload: body })).statusCode, 201);
  const res = await app.inject({ method: 'GET', url: `/v1/blob/${sha(body)}`, headers: H });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, 'not_found');
  assert.equal(await blobs.isReferenced(sha(body)), false);
  await register(app, 'orphan-no-more.mat', sha(body), null);
  assert.equal(await blobs.isReferenced(sha(body)), true);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/blob/${sha(body)}`, headers: H })).statusCode, 200);
  await app.close();
});

test('POST /v1/blob/missing: subset, input order, deduplicated; bad hash and >5000 are 400', async () => {
  const app = await buildHttp();
  const have = Buffer.from('have this one');
  await app.inject({ method: 'PUT', url: `/v1/blob/${sha(have)}`, headers: { ...H, ...OCT }, payload: have });
  const a = sha('absent a');
  const b = sha('absent b');
  const res = await app.inject({ method: 'POST', url: '/v1/blob/missing', headers: H, payload: { sha256: [b, sha(have), a, b] } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { missing: [b, a] });
  assert.equal((await app.inject({ method: 'POST', url: '/v1/blob/missing', headers: H, payload: { sha256: ['xyz'] } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/blob/missing', headers: H, payload: { sha256: Array.from({ length: 5001 }, () => a) } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/blob/missing', headers: H, payload: {} })).json().code, 'invalid');
  await app.close();
});

test('auth matrix: blob routes need the key even under AUTH_DISABLED=1; no configured key is 403; opt-in opens them', async () => {
  const app = await buildHttp();
  const url = `/v1/blob/${sha('auth probe')}`;
  const get = (headers: Record<string, string>) => app.inject({ method: 'GET', url, headers });
  try {
    config.authDisabled = false;
    assert.equal((await get({})).statusCode, 401, 'no key');
    assert.equal((await get({ 'x-vfx-key': 'wrong' })).statusCode, 401, 'wrong key');
    assert.equal((await get(H)).statusCode, 404, 'right key reaches the route (blob unknown)');

    config.authDisabled = true;
    assert.equal((await get({})).statusCode, 401, 'AUTH_DISABLED=1 does NOT open blob routes');
    assert.equal((await get({ 'x-vfx-key': 'wrong' })).statusCode, 401);
    assert.equal((await get(H)).statusCode, 404);
    for (const u of ['/v1/asset-file/' + guidOf('x'), '/v1/closure/recipe/none/1']) {
      assert.equal((await app.inject({ method: 'GET', url: u })).statusCode, 401, u);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/v1/asset-file/batch', payload: { files: [] } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/blob/missing', payload: { sha256: [] } })).statusCode, 401);
    assert.notEqual((await app.inject({ method: 'GET', url: '/v1/related?uri=vfx://x/y/1' })).statusCode, 401, 'other /v1 routes keep AUTH_DISABLED behaviour');

    config.apiKey = '';
    const noKey = await get({});
    assert.equal(noKey.statusCode, 403, 'no VFX_API_KEY and no opt-in: never open by accident');
    assert.equal(noKey.json().code, 'forbidden');

    config.blobAllowAnon = true;
    assert.equal((await get({})).statusCode, 404, 'explicit opt-in + AUTH_DISABLED=1: anonymous reaches the route');
  } finally {
    config.apiKey = KEY;
    config.authDisabled = false;
    config.blobAllowAnon = false;
    await app.close();
  }
});
