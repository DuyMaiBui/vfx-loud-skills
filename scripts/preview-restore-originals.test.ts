import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { restore } from './preview-restore-originals.ts';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const G = { a: 'a'.repeat(32), b: 'b'.repeat(32), c: 'c'.repeat(32), d: 'd'.repeat(32) };
const ORIGINAL = { [G.a]: 'ORIGINAL-A', [G.b]: 'ORIGINAL-B', [G.d]: 'ORIGINAL-D' } as Record<string, string>;
const TAMPERED = new Set([G.d]); // the blob served for d does not match the advertised sha256
let seenKey = '';

const server = http.createServer((req, res) => {
  seenKey = String(req.headers['x-vfx-key'] ?? '');
  const u = new URL(req.url ?? '/', 'http://x');
  const af = /^\/v1\/asset-file\/([0-9a-f]{32})$/.exec(u.pathname);
  if (af && ORIGINAL[af[1]!] !== undefined) {
    const guid = af[1]!;
    res.setHeader('content-type', 'application/json');
    return void res.end(JSON.stringify({ sha256: sha(ORIGINAL[guid]!), download_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/blob/${guid}` }));
  }
  const bl = /^\/v1\/blob\/([0-9a-f]{32})$/.exec(u.pathname);
  if (bl) return void res.end(TAMPERED.has(bl[1]!) ? 'TAMPERED' : ORIGINAL[bl[1]!]);
  res.statusCode = 404; res.end('{}');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-'));
  const dir = path.join(root, 'Assets', 'ImportedPacks', 'p1');
  fs.mkdirSync(dir, { recursive: true });
  const mat = (name: string, guid: string, body: string): void => {
    fs.writeFileSync(path.join(dir, `${name}.mat`), body);
    fs.writeFileSync(path.join(dir, `${name}.mat.meta`), `fileFormatVersion: 2\nguid: ${guid}\n`);
  };
  mat('a', G.a, 'CONVERTED-A');   // converted in place: must be restored
  mat('b', G.b, 'ORIGINAL-B');    // already original: unchanged
  mat('c', G.c, 'WHATEVER');      // unknown to the cloud: missing, left alone
  mat('d', G.d, 'CONVERTED-D');   // blob fails verification: failed, left alone
  return root;
}
const opts = (root: string, extra: object = {}) => ({ root, server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, key: 'k1', dryRun: false, log: () => {}, ...extra });
const read = (root: string, n: string): string => fs.readFileSync(path.join(root, 'Assets', 'ImportedPacks', 'p1', `${n}.mat`), 'utf8');

test('restores a converted material from the vendor bytes and keeps its .meta', async () => {
  const root = project();
  const s = await restore(opts(root));
  assert.equal(read(root, 'a'), 'ORIGINAL-A');
  assert.match(fs.readFileSync(path.join(root, 'Assets/ImportedPacks/p1/a.mat.meta'), 'utf8'), new RegExp(`guid: ${G.a}`));
  assert.deepEqual({ checked: s.checked, changed: s.changed, unchanged: s.unchanged, missing: s.missing, failed: s.failed }, { checked: 4, changed: 1, unchanged: 1, missing: 1, failed: 1 });
  assert.equal(seenKey, 'k1');
});

test('a blob whose sha256 does not verify is never written', async () => {
  const root = project();
  await restore(opts(root));
  assert.equal(read(root, 'd'), 'CONVERTED-D');
});

test('--dry-run reports the change and writes nothing', async () => {
  const root = project();
  const s = await restore(opts(root, { dryRun: true }));
  assert.equal(read(root, 'a'), 'CONVERTED-A');
  assert.equal(s.changed, 2); // a and d both differ from the original
  assert.equal(s.dryRun, true);
});
