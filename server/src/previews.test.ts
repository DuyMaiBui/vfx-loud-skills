import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vfx-previews-'));
const dir = path.join(tmp, 'previews');
fs.mkdirSync(dir);
process.env.DATA_DIR = tmp;
process.env.AUTH_DISABLED = '1';

const { parseRange, previewPath, previewFor, loadIndex, slugOfUri } = await import('./previews.ts');
const { buildHttp } = await import('./http.ts');
const { pool } = await import('./db.ts');

after(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  await pool.end().catch(() => undefined);
});

const BYTES = Buffer.from('0123456789abcdefghij'); // 20 bytes
fs.writeFileSync(path.join(dir, 'fake-fx.webm'), BYTES);
fs.writeFileSync(path.join(dir, 'fake-fx.webp'), 'poster');

test('parseRange: forms, clamping, 416 and ignorable headers', () => {
  assert.deepEqual(parseRange(undefined, 20), { kind: 'full' });
  assert.deepEqual(parseRange('bytes=0-4', 20), { kind: 'partial', start: 0, end: 4 });
  assert.deepEqual(parseRange('bytes=5-', 20), { kind: 'partial', start: 5, end: 19 });
  assert.deepEqual(parseRange('bytes=-6', 20), { kind: 'partial', start: 14, end: 19 });
  assert.deepEqual(parseRange('bytes=-99', 20), { kind: 'partial', start: 0, end: 19 });
  assert.deepEqual(parseRange('bytes=10-999', 20), { kind: 'partial', start: 10, end: 19 });
  assert.deepEqual(parseRange('bytes=20-30', 20), { kind: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=-0', 20), { kind: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=9-3', 20), { kind: 'full' });
  assert.deepEqual(parseRange('bytes=0-1,4-5', 20), { kind: 'full' });
  assert.deepEqual(parseRange('items=0-1', 20), { kind: 'full' });
});

test('previewPath: only flat <slug>.webm|webp resolves', () => {
  assert.equal(previewPath('fake-fx.webm', dir), path.join(dir, 'fake-fx.webm'));
  for (const bad of ['../secret.webm', '..%2Fsecret.webm', 'a/b.webm', '/etc/passwd', 'index.json', 'fake-fx.webm\0.png', 'FAKE.webm', '.webm', 'a..webm', 'x.mp4', '']) {
    assert.equal(previewPath(bad, dir), null, bad);
  }
});

test('GET /previews: 200 full, MIME, cache headers, Accept-Ranges', async () => {
  const app = await buildHttp();
  const res = await app.inject({ method: 'GET', url: '/previews/fake-fx.webm' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'video/webm');
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.match(String(res.headers['cache-control']), /max-age=\d+/);
  assert.equal(res.headers['content-length'], '20');
  assert.equal(res.rawPayload.toString(), BYTES.toString());
  const poster = await app.inject({ method: 'GET', url: '/previews/fake-fx.webp' });
  assert.equal(poster.headers['content-type'], 'image/webp');
  const etag = String(res.headers.etag);
  const cached = await app.inject({ method: 'GET', url: '/previews/fake-fx.webm', headers: { 'if-none-match': etag } });
  assert.equal(cached.statusCode, 304);
  await app.close();
});

test('GET /previews: Range gives 206 + Content-Range; past EOF gives 416', async () => {
  const app = await buildHttp();
  const r = await app.inject({ method: 'GET', url: '/previews/fake-fx.webm', headers: { range: 'bytes=2-5' } });
  assert.equal(r.statusCode, 206);
  assert.equal(r.headers['content-range'], 'bytes 2-5/20');
  assert.equal(r.headers['content-length'], '4');
  assert.equal(r.rawPayload.toString(), '2345');
  const tail = await app.inject({ method: 'GET', url: '/previews/fake-fx.webm', headers: { range: 'bytes=-3' } });
  assert.equal(tail.statusCode, 206);
  assert.equal(tail.rawPayload.toString(), 'hij');
  const bad = await app.inject({ method: 'GET', url: '/previews/fake-fx.webm', headers: { range: 'bytes=50-' } });
  assert.equal(bad.statusCode, 416);
  assert.equal(bad.headers['content-range'], 'bytes */20');
  await app.close();
});

test('GET /previews: traversal, index.json, unknown and wrong extension are 404', async () => {
  fs.writeFileSync(path.join(tmp, 'secret.webm'), 'top secret');
  fs.writeFileSync(path.join(dir, 'index.json'), '{}');
  const app = await buildHttp();
  for (const url of ['/previews/..%2Fsecret.webm', '/previews/%2e%2e%2fsecret.webm', '/previews/../secret.webm', '/previews/index.json', '/previews/nope.webm', '/previews/fake-fx.mp4']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 404, url);
    assert.ok(!res.body.includes('top secret'), url);
  }
  await app.close();
});

const idx = (items: Record<string, unknown>): string => JSON.stringify({ version: 1, items });
const entry = (slug: string) => ({ webm: `${slug}.webm`, poster: `${slug}.webp`, bytes: 20, fps: 24, frames: 12, size: 256, renderedAt: '2026-09-29T00:00:00.000Z' });

test('index reloads on mtime change, no restart; broken index = no previews', () => {
  const index = path.join(dir, 'index.json');
  fs.writeFileSync(index, idx({}));
  assert.equal(loadIndex(dir).size, 0);
  assert.equal(previewFor('fake-fx', undefined, dir), null);

  fs.writeFileSync(index, idx({ 'fake-fx': entry('fake-fx') }));
  fs.utimesSync(index, new Date(), new Date(Date.now() + 5000)); // deterministic mtime bump
  assert.equal(loadIndex(dir).size, 1);
  const p = previewFor('fake-fx', undefined, dir);
  assert.deepEqual(p && { video: p.video, poster: p.poster, viaFamily: p.viaFamily }, { video: '/previews/fake-fx.webm', poster: '/previews/fake-fx.webp', viaFamily: false });

  fs.writeFileSync(index, '{ not json');
  fs.utimesSync(index, new Date(), new Date(Date.now() + 10000));
  assert.equal(loadIndex(dir).size, 0);

  fs.unlinkSync(index);
  assert.equal(previewFor('fake-fx', undefined, dir), null);
});

test('a variant without its own entry uses the family canonical member; an entry with no file gives nothing', () => {
  const index = path.join(dir, 'index.json');
  fs.writeFileSync(index, idx({ 'fake-fx': entry('fake-fx'), ghost: entry('ghost') }));
  fs.utimesSync(index, new Date(), new Date(Date.now() + 20000));
  const v = previewFor('fake-fx-red', 'fake-fx', dir);
  assert.equal(v?.viaFamily, true);
  assert.equal(v?.slug, 'fake-fx');
  assert.equal(previewFor('fake-fx-red', undefined, dir), null); // no family, no entry
  assert.equal(previewFor('ghost', undefined, dir), null); // indexed but files absent
  assert.equal(previewFor('lonely', 'ghost', dir), null);
});

test('slugOfUri', () => {
  assert.equal(slugOfUri('vfx://recipe/a-b-c/1'), 'a-b-c');
  assert.equal(slugOfUri('vfx://recipe/../1'), null);
  assert.equal(slugOfUri('not a uri'), null);
});
