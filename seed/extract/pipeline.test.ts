import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assignSlugs, classifyPath, extractPack, type PackConfig } from './pipeline.ts';
import { makeUnityPackage, materialYaml, prefabYaml, type FakeAsset } from './test-helpers.ts';

const MAT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHADER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TEX = 'cccccccccccccccccccccccccccccccc';
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('SECRET-TEXTURE-PIXELS')]);

const PACK: PackConfig = {
  slug: 'test-pack',
  name: 'Test Pack',
  file: 'x.unitypackage',
  vendor: 'Test Vendor',
  license: 'asset-store-eula',
  style: ['stylized'],
  tags: ['test'],
};

function fixtureAssets(): FakeAsset[] {
  return [
    { guid: '11111111111111111111111111111111', path: 'Assets/T/Prefabs/Boom.prefab', asset: prefabYaml({ name: 'Boom' }) },
    { guid: '22222222222222222222222222222222', path: 'Assets/T/Prefabs/Fizz/Boom.prefab', asset: prefabYaml({ name: 'Boom2', withChild: false }) },
    { guid: '33333333333333333333333333333333', path: 'Assets/T/Prefabs/Binary.prefab', asset: Buffer.from([0, 1, 2, 3, 4]) },
    { guid: '44444444444444444444444444444444', path: 'Assets/T/Prefabs/NoPs.prefab', asset: prefabYaml({ psCount: 'none' }) },
    { guid: '55555555555555555555555555555555', path: 'Assets/T/Demo/Prefabs/DemoOnly.prefab', asset: prefabYaml() },
    { guid: '66666666666666666666666666666666', path: 'Assets/T/Other/Loose.prefab', asset: prefabYaml() },
    { guid: MAT, path: 'Assets/T/Mat/Fire.mat', asset: materialYaml(SHADER, TEX) },
    { guid: TEX, path: 'Assets/T/Tex/Fire.png', asset: PNG_BYTES },
    { guid: SHADER, path: 'Assets/T/Shaders/Fire.shader', asset: 'Shader "Fire" {}' },
  ];
}

async function withPackage<T>(assets: FakeAsset[], fn: (file: string, out: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-extract-'));
  const file = path.join(dir, 'x.unitypackage');
  await fs.writeFile(file, makeUnityPackage(assets));
  try {
    return await fn(file, path.join(dir, 'out'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('classifyPath: only Prefabs-folder, non-demo, in-root prefabs are candidates', () => {
  assert.equal(classifyPath('Assets/T/Prefabs/A.prefab', {}), null);
  assert.equal(classifyPath('Assets/T/Prefabs/A.mat', {}), 'not-a-prefab');
  assert.equal(classifyPath('Assets/T/Demo/Prefabs/A.prefab', {}), 'demo');
  assert.equal(classifyPath('Assets/T/InteractiveDemo/Demo Prefabs/A.prefab', {}), 'demo');
  assert.equal(classifyPath('Assets/T/Other/A.prefab', {}), 'not-in-prefabs-folder');
  const roots = { prefabRoots: ['Assets/Synty/PolygonParticleFX/'] };
  assert.equal(classifyPath('Assets/Synty/PolygonGeneric/Prefabs/A.prefab', roots), 'outside-prefab-roots');
  assert.equal(classifyPath('Assets/Synty/PolygonParticleFX/Prefabs/A.prefab', roots), null);
});

test('assignSlugs: valid, deterministic, guid suffix only on collision', () => {
  const m = assignSlugs('p', [
    { path: 'A/Prefabs/FX_Fire.prefab', guid: 'abcdef111' },
    { path: 'B/Prefabs/Fire.prefab', guid: 'ffffff222' },
    { path: 'A/Prefabs/Solo One.prefab', guid: '000000333' },
  ]);
  assert.equal(m.get('000000333'), 'p-solo-one');
  assert.equal(m.get('abcdef111'), 'p-fx-fire');
  assert.equal(m.get('ffffff222'), 'p-fire');
  const c = assignSlugs('p', [
    { path: 'A/Prefabs/Fire.prefab', guid: 'abcdef111' },
    { path: 'B/Prefabs/Fire.prefab', guid: 'ffffff222' },
  ]);
  assert.equal(c.get('abcdef111'), 'p-fire-abcdef');
  assert.equal(c.get('ffffff222'), 'p-fire-ffffff');
});

test('end-to-end: records, provenance meta, licence, skips, exclusions, no asset bytes', async () => {
  await withPackage(fixtureAssets(), async (file, out) => {
    const s = await extractPack({ pack: PACK, packageFile: file, outDir: out });
    assert.equal(s.eligible, 4); // Boom, Boom2, Binary, NoPs
    assert.deepEqual(s.excluded, { demo: 1, 'not-in-prefabs-folder': 1 }); // DemoOnly, Loose
    assert.equal(s.extracted, 2);
    assert.deepEqual(
      s.skipped.map((k) => [path.basename(k.prefabPath), k.code]),
      [['Binary.prefab', 'binary-serialization'], ['NoPs.prefab', 'no-effect-component']],
    );

    const dir = path.join(out, 'test-pack');
    const first = s.records.find((r) => r.prefabGuid.startsWith('1')) as (typeof s.records)[number];
    const rec = JSON.parse(await fs.readFile(path.join(dir, `${first.slug}.json`), 'utf8'));
    assert.equal(rec.type, 'recipe');
    assert.equal(rec.license, 'asset-store-eula');
    assert.equal(rec.visibility, 'project');
    assert.equal(rec.meta.extracted, true);
    assert.equal(rec.meta.license_class, 'proprietary-commercial');
    assert.equal(rec.meta.ai_training, false);
    assert.equal(rec.meta.source.pack, 'Test Pack');
    assert.equal(rec.meta.source.vendor, 'Test Vendor');
    assert.equal(rec.meta.source.prefabPath, 'Assets/T/Prefabs/Boom.prefab');
    assert.equal(rec.meta.source.prefabGuid, '11111111111111111111111111111111');
    assert.equal(first.particleNodes, 2);
    assert.equal(rec.fileName, `${rec.slug}.yaml`);
    assert.match(rec.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);

    // No asset bytes anywhere in the output tree.
    for (const n of await fs.readdir(dir)) {
      const bytes = await fs.readFile(path.join(dir, n));
      assert.equal(bytes.includes('SECRET-TEXTURE-PIXELS'), false, n);
      assert.equal(bytes.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])), false, n);
    }
    const skipLog = (await fs.readFile(path.join(dir, 'skipped.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(skipLog.length, 2);
    assert.ok(skipLog.every((k) => k.reason && k.code && k.prefabGuid));
  });
});

test('--limit takes the first N by path (skips count toward N); output is byte-identical across runs', async () => {
  await withPackage(fixtureAssets(), async (file, out) => {
    const a = await extractPack({ pack: PACK, packageFile: file, outDir: path.join(out, 'a'), limit: 2 });
    const b = await extractPack({ pack: PACK, packageFile: file, outDir: path.join(out, 'b'), limit: 2 });
    assert.equal(a.selected, 2);
    // sorted by path: Binary (skipped, binary) then Boom (extracted); the rest are never touched.
    assert.deepEqual(a.skipped.map((k) => path.basename(k.prefabPath)), ['Binary.prefab']);
    assert.deepEqual(a.records.map((r) => path.basename(r.prefabPath)), ['Boom.prefab']);
    const fa = (await fs.readdir(path.join(out, 'a', 'test-pack'))).filter((n) => n.endsWith('.yaml'));
    const fb = (await fs.readdir(path.join(out, 'b', 'test-pack'))).filter((n) => n.endsWith('.yaml'));
    assert.deepEqual(fa, fb);
    assert.equal(fa.length, 1);
    for (const n of fa) {
      assert.equal(
        await fs.readFile(path.join(out, 'a', 'test-pack', n), 'utf8'),
        await fs.readFile(path.join(out, 'b', 'test-pack', n), 'utf8'),
      );
    }
  });
});

test('effect-only prefab becomes an effect record: no "particle recipe" wording, effectKinds set, onlyGuids filter', async () => {
  const assets: FakeAsset[] = [
    { guid: '1'.repeat(32), path: 'Assets/T/Prefabs/Beam.prefab', asset: prefabYaml({ name: 'Beam', psCount: 'none', effect: true }) },
    { guid: '2'.repeat(32), path: 'Assets/T/Prefabs/Boom.prefab', asset: prefabYaml() },
    { guid: MAT, path: 'Assets/T/Mat/Fire.mat', asset: materialYaml(SHADER, TEX) },
  ];
  await withPackage(assets, async (file, out) => {
    const s = await extractPack({ pack: PACK, packageFile: file, outDir: out, onlyGuids: new Set(['1'.repeat(32)]) });
    assert.equal(s.selected, 1);
    assert.equal(s.extracted, 1);
    const rec = JSON.parse(await fs.readFile(path.join(out, 'test-pack', `${s.records[0].slug}.json`), 'utf8'));
    assert.deepEqual(rec.meta.effectKinds, ['line', 'script']);
    assert.equal(rec.meta.extracted, true);
    assert.equal(rec.meta.license_class, 'proprietary-commercial');
    assert.equal(rec.meta.ai_training, false);
    assert.equal(rec.visibility, 'project');
    assert.doesNotMatch(rec.description, /particle recipe/i);
    assert.match(rec.description, /beam effect/);
    assert.deepEqual(rec.meta.style, ['stylized']);
    assert.ok(rec.meta.keywords.includes('effect') && rec.meta.keywords.includes('line-effect'));
    assert.ok(rec.tags.includes('effect') && !rec.tags.includes('particle'));
  });
});

test('a pack with no resolvable store-EULA licence is refused before anything is written', async () => {
  await withPackage(fixtureAssets(), async (file, out) => {
    for (const license of ['cc0', 'unknown', '', 'mit']) {
      await assert.rejects(extractPack({ pack: { ...PACK, license }, packageFile: file, outDir: out }), /refusing to extract/);
    }
    await assert.rejects(fs.access(out)); // nothing created
  });
});

test('oversized prefab is skipped with a reason, never read into a record', async () => {
  await withPackage(fixtureAssets(), async (file, out) => {
    const s = await extractPack({ pack: PACK, packageFile: file, outDir: out, maxPrefabBytes: 4 });
    assert.equal(s.extracted, 0);
    assert.ok(s.skipped.length === 4 && s.skipped.every((k) => k.code === 'asset-too-large'));
  });
});

test('Synty-style prefabRoots keep PolygonGeneric out', async () => {
  const assets: FakeAsset[] = [
    { guid: 'a'.repeat(32), path: 'Assets/Synty/PolygonParticleFX/Prefabs/FX_Boom.prefab', asset: prefabYaml() },
    { guid: 'b'.repeat(32), path: 'Assets/Synty/PolygonGeneric/Prefabs/Props/Barrel.prefab', asset: prefabYaml() },
  ];
  await withPackage(assets, async (file, out) => {
    const pack: PackConfig = { ...PACK, slug: 'synty-x', license: 'synty-store-eula', prefabRoots: ['Assets/Synty/PolygonParticleFX/'] };
    const s = await extractPack({ pack, packageFile: file, outDir: out });
    assert.equal(s.extracted, 1);
    assert.deepEqual(s.excluded, { 'outside-prefab-roots': 1 });
    const rec = JSON.parse(await fs.readFile(path.join(out, 'synty-x', `${s.records[0].slug}.json`), 'utf8'));
    assert.equal(rec.license, 'synty-store-eula');
    assert.equal(rec.meta.license_class, 'proprietary-commercial');
  });
});
