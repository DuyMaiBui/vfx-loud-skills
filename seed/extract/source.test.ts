import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { folderSetSource, folderSource } from './source.ts';
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

async function gameRoot(files: Array<{ rel: string; guid: string; body: string | Buffer }>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-game-'));
  for (const f of files) {
    const abs = path.join(root, f.rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, f.body);
    await fs.writeFile(`${abs}.meta`, meta(f.guid));
  }
  return root;
}

const EMBER = '44444444444444444444444444444444';
const EPIC = '55555555555555555555555555555555';

test('folderSetSource: a guid in several games is one asset, first game wins, gamesOf lists every game', async () => {
  const gameA = await tinyFolder();
  const gameB = await gameRoot([
    { rel: 'Other/Prefabs/Copy.prefab', guid: PREFAB, body: 'LOSING-COPY-BYTES' },
    { rel: 'Other/Prefabs/Ember.prefab', guid: EMBER, body: prefabYaml({ name: 'Ember' }) },
  ]);
  try {
    const src = folderSetSource([{ game: 'A', root: gameA }, { game: 'B', root: gameB }], 'Assets');
    const { paths } = await src.index();
    assert.equal(paths.get(PREFAB), 'Assets/Fx/Prefabs/Boom.prefab', 'first root wins the path');
    assert.equal(paths.get(EMBER), 'Assets/Other/Prefabs/Ember.prefab');
    assert.equal(paths.size, 5); // Boom, Bin, Env, Fire.mat, Ember (Copy collapsed into Boom)
    assert.deepEqual(src.gamesOf?.(PREFAB), ['A', 'B']);
    assert.deepEqual(src.gamesOf?.(EMBER), ['B']);
    assert.deepEqual(src.gamesOf?.('9'.repeat(32)), []);
    const bytes = new Map<string, Buffer>();
    for await (const e of src.assets((g) => g === PREFAB)) bytes.set(e.guid, e.data);
    assert.equal(bytes.get(PREFAB)?.toString('utf8'), prefabYaml(), 'bytes come from the winning root only');
  } finally {
    await fs.rm(gameA, { recursive: true, force: true });
    await fs.rm(gameB, { recursive: true, force: true });
  }
});

test('folder-set pack: third-party prefabs skipped, duplicates collapsed, every game recorded in meta', async () => {
  const gameA = await tinyFolder();
  const gameB = await gameRoot([
    { rel: 'Other/Prefabs/Copy.prefab', guid: PREFAB, body: 'LOSING-COPY-BYTES' },
    { rel: 'Other/Prefabs/Ember.prefab', guid: EMBER, body: prefabYaml({ name: 'Ember' }) },
    { rel: 'Epic Toon FX/Prefabs/Fire.prefab', guid: EPIC, body: prefabYaml({ name: 'Fire' }) },
  ]);
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-set-out-'));
  const pack: PackConfig = {
    slug: 'studio-set', name: 'Studio Set', vendor: 'The1Studio', license: 'studio-internal',
    style: ['stylized'], tags: ['studio'], sourceType: 'folder-set', pathPrefix: 'Assets',
    excludePathPrefixes: ['Assets/Epic Toon FX/'],
  };
  try {
    const source = folderSetSource([{ game: 'A', root: gameA }, { game: 'B', root: gameB }], 'Assets');
    const s = await extractPack({ pack, source, outDir: out });
    assert.deepEqual(s.excluded, { 'third-party-pack': 1 });
    assert.equal(s.duplicatesCollapsed, 1);
    assert.equal(s.eligible, 4); // Boom, Bin, Env, Ember
    assert.equal(s.extracted, 3);
    assert.deepEqual(s.skipped.map((k) => [path.basename(k.prefabPath), k.code]), [['Bin.prefab', 'binary-serialization']]);
    assert.ok(s.records.every((r) => !r.prefabPath.includes('Epic Toon')));
    const boom = s.records.find((r) => r.prefabGuid === PREFAB) as (typeof s.records)[number];
    const rec = JSON.parse(await fs.readFile(path.join(out, 'studio-set', `${boom.slug}.json`), 'utf8'));
    assert.deepEqual(rec.meta.source.games, ['A', 'B']);
    assert.equal(rec.meta.source.prefabPath, 'Assets/Fx/Prefabs/Boom.prefab');
    assert.equal(rec.license, 'studio-internal');
    assert.equal(rec.meta.license_class, 'studio-internal');
    assert.equal(rec.meta.ai_training, false);
    assert.equal(rec.visibility, 'project');
  } finally {
    await fs.rm(gameA, { recursive: true, force: true });
    await fs.rm(gameB, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
  }
});

test('folder-set: a non-prefab duplicate guid keeps the first file; a duplicate on a prefab is refused', async () => {
  const anims = await gameRoot([
    { rel: 'A/Anim/One.anim', guid: MAT, body: 'x' },
    { rel: 'B/Anim/Two.anim', guid: MAT, body: 'y' },
  ]);
  const prefabs = await gameRoot([
    { rel: 'P/Prefabs/One.prefab', guid: PREFAB, body: prefabYaml() },
    { rel: 'P/Prefabs/Two.prefab', guid: PREFAB, body: prefabYaml() },
  ]);
  try {
    const { paths } = await folderSetSource([{ game: 'G', root: anims }], 'Assets').index();
    assert.equal(paths.get(MAT), 'Assets/A/Anim/One.anim');
    await assert.rejects(folderSetSource([{ game: 'G', root: prefabs }], 'Assets').index(), /duplicate guid on a prefab/);
    await assert.rejects(folderSource(prefabs, 'Assets').index(), /duplicate guid/);
  } finally {
    await fs.rm(anims, { recursive: true, force: true });
    await fs.rm(prefabs, { recursive: true, force: true });
  }
});
