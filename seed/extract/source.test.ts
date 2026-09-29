import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { folderSource } from './source.ts';
import { extractPack, type PackConfig } from './pipeline.ts';
import { materialYaml, prefabYaml } from './test-helpers.ts';

const MAT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PREFAB = '11111111111111111111111111111111';
const meta = (guid: string): string => `fileFormatVersion: 2\nguid: ${guid}\n`;

async function tinyFolder(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-folder-'));
  await fs.mkdir(path.join(root, 'Fx', 'Prefabs'), { recursive: true });
  await fs.mkdir(path.join(root, 'Fx', 'Mat'));
  await fs.mkdir(path.join(root, '_Shared', 'Prefabs'), { recursive: true });
  await fs.writeFile(path.join(root, 'Fx.meta'), meta('f'.repeat(32))); // directory meta: not an asset
  await fs.writeFile(path.join(root, 'Fx', 'Prefabs', 'Boom.prefab'), prefabYaml());
  await fs.writeFile(path.join(root, 'Fx', 'Prefabs', 'Boom.prefab.meta'), meta(PREFAB));
  await fs.writeFile(path.join(root, 'Fx', 'Prefabs', 'Bin.prefab'), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(root, 'Fx', 'Prefabs', 'Bin.prefab.meta'), meta('22222222222222222222222222222222'));
  await fs.writeFile(path.join(root, 'Fx', 'Mat', 'Fire.mat'), materialYaml('b'.repeat(32), 'c'.repeat(32)));
  await fs.writeFile(path.join(root, 'Fx', 'Mat', 'Fire.mat.meta'), meta(MAT));
  await fs.writeFile(path.join(root, '_Shared', 'Prefabs', 'Env.prefab'), prefabYaml());
  await fs.writeFile(path.join(root, '_Shared', 'Prefabs', 'Env.prefab.meta'), meta('33333333333333333333333333333333'));
  return root;
}

test('folderSource indexes GUIDs from .meta, ignores directory metas, prefixes Unity paths', async () => {
  const root = await tinyFolder();
  try {
    const { paths, assetSizes } = await folderSource(root, 'Assets/Vendor').index();
    assert.equal(paths.get(PREFAB), 'Assets/Vendor/Fx/Prefabs/Boom.prefab');
    assert.equal(paths.get(MAT), 'Assets/Vendor/Fx/Mat/Fire.mat');
    assert.equal(paths.has('f'.repeat(32)), false);
    assert.ok((assetSizes.get(PREFAB) ?? 0) > 100);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('folder pack runs the shared pipeline: records, skips, roots, materials, licence refusal', async () => {
  const root = await tinyFolder();
  const out = path.join(root, '..', `out-${path.basename(root)}`);
  const pack: PackConfig = {
    slug: 'vendor-fx', name: 'Vendor FX', vendor: 'Vendor', license: 'asset-store-eula', style: ['stylized'], tags: ['v'],
    sourceType: 'folder', pathPrefix: 'Assets/Vendor', prefabRoots: ['Assets/Vendor/Fx/Prefabs/'],
  };
  try {
    const source = folderSource(root, 'Assets/Vendor');
    const s = await extractPack({ pack, source, outDir: out });
    assert.equal(s.eligible, 2); // Env.prefab is outside prefabRoots
    assert.deepEqual(s.excluded, { 'outside-prefab-roots': 1 });
    assert.equal(s.extracted, 1);
    assert.deepEqual(s.skipped.map((k) => [path.basename(k.prefabPath), k.code]), [['Bin.prefab', 'binary-serialization']]);
    const rec = JSON.parse(await fs.readFile(path.join(out, 'vendor-fx', `${s.records[0].slug}.json`), 'utf8'));
    assert.equal(rec.meta.source.prefabGuid, PREFAB);
    assert.equal(rec.meta.source.prefabPath, 'Assets/Vendor/Fx/Prefabs/Boom.prefab');
    assert.equal(rec.meta.license_class, 'proprietary-commercial');
    assert.match(rec.inline, /path: Assets\/Vendor\/Fx\/Mat\/Fire\.mat/); // material resolved through .meta guid
    await assert.rejects(extractPack({ pack: { ...pack, license: 'cc0' }, source, outDir: out }), /refusing to extract/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
  }
});
