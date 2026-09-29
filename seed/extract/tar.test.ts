import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openUnityPackage, tarEntries } from './tar.ts';
import { makeTarGz } from './test-helpers.ts';

async function withPkg<T>(buf: Buffer, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-tar-'));
  const file = path.join(dir, 'p.unitypackage');
  await fs.writeFile(file, buf);
  try {
    return await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('reads only wanted entries, incl. GNU long names, and skips others without data', async () => {
  const longName = `${'g'.repeat(32)}/${'x'.repeat(120)}`; // > 100 chars -> GNU 'L' record
  const buf = makeTarGz([
    { name: 'aaa/asset', data: 'hello' },
    { name: 'aaa/pathname', data: 'Assets/a.prefab\n00' },
    { name: longName, data: 'long!' },
    { name: 'big/asset', data: Buffer.alloc(5000, 7) },
  ]);
  await withPkg(buf, async (file) => {
    const got: Record<string, string> = {};
    for await (const e of tarEntries(openUnityPackage(file), (n) => n !== 'big/asset')) {
      got[e.name] = e.data.toString();
    }
    assert.deepEqual(Object.keys(got).sort(), ['aaa/asset', 'aaa/pathname', longName].sort());
    assert.equal(got['aaa/asset'], 'hello');
    assert.equal(got[longName], 'long!');
  });
});

test('early break releases the stream (no hang, no leak)', async () => {
  const buf = makeTarGz(Array.from({ length: 50 }, (_, i) => ({ name: `g${i}/asset`, data: `d${i}` })));
  await withPkg(buf, async (file) => {
    let n = 0;
    for await (const e of tarEntries(openUnityPackage(file), () => true)) {
      void e;
      if (++n === 3) break;
    }
    assert.equal(n, 3);
  });
});

test('truncated archive is an error, not a silent short read', async () => {
  const full = makeTarGz([{ name: 'a/asset', data: Buffer.alloc(4000, 1) }]);
  const zlib = await import('node:zlib');
  const raw = zlib.gunzipSync(full).subarray(0, 700); // cut inside the body
  await withPkg(zlib.gzipSync(raw), async (file) => {
    await assert.rejects(async () => {
      for await (const e of tarEntries(openUnityPackage(file), () => true)) void e;
    }, /truncated/);
  });
});
