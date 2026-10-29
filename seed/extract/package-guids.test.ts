import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyGuid, loadPackageGuids, PACKAGE_GUID_MAP_PATH } from '../../server/src/unity-refs.ts';
import { folderSetSource, folderSource } from './source.ts';
import { ALWAYS_INCLUDE, buildMap, specsFromPacks, writePackageGuidMap } from './package-guids.ts';
import { indexPackageCache, scanReferences, type SourceSpec } from './package-guids-scan.ts';

// Fixture GUIDs (32 lower-case hex). Names say what the fixture makes of them.
const PREFAB = '11111111111111111111111111111111'; // game VFX prefab (has a ParticleSystem)
const GAME_MAT = '22222222222222222222222222222222'; // game material used by the prefab
const GAME_SHARED_FX = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // defined in the game AND in package acme-fx
const ACME_RANGE = 'dddddddddddddddddddddddddddddddd'; // in acme-fx 1.0.0 and 2.1.0: highest wins
const ACME_UNUSED = 'ffffffffffffffffffffffffffffffff'; // in acme-fx 2.1.0, referenced by nothing
const UNKNOWN = 'cccccccccccccccccccccccccccccccc'; // nowhere: unresolved
const BUILTIN = '0000000000000000f000000000000000'; // Unity builtin (pattern)
const PLAIN_UNKNOWN = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; // referenced only by a non-VFX prefab
const URP_UNLIT = '0406db5a14f94604a8c57ccfbc9f3b46';
const URP_LIT = '933532a4fcc9baf4fa0491de14d08ed7';

const meta = (guid: string): string => `fileFormatVersion: 2\nguid: ${guid}\n`;

async function write(file: string, body: string, guid?: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
  if (guid) await fs.writeFile(`${file}.meta`, meta(guid));
}

interface Fixture {
  dir: string;
  assets: string;
  cache: string;
}

/** A game `Assets/` folder and a `Library/PackageCache` with URP, a two-version acme-fx package and a builtin-referencing material. */
async function makeFixture(): Promise<Fixture> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-pkgguid-'));
  const assets = path.join(dir, 'Game', 'Assets');
  const cache = path.join(dir, 'Game', 'Library', 'PackageCache');

  // Game: a VFX prefab, its material (refs URP Unlit, ACME_RANGE, UNKNOWN, BUILTIN, GAME_SHARED_FX), a shared
  // material that is ALSO defined by acme-fx, and a non-VFX prefab whose refs must never be scanned.
  await write(
    path.join(assets, 'VFX', 'Burst.prefab'),
    `%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!1 &100\nGameObject:\n  m_Name: Burst\n--- !u!198 &200\nParticleSystem:\n  m_Renderer:\n    m_Material: {fileID: 2100000, guid: ${GAME_MAT}, type: 2}\n`,
    PREFAB,
  );
  await write(
    path.join(assets, 'VFX', 'Burst.mat'),
    `%YAML 1.1\n--- !u!21 &2100000\nMaterial:\n  m_Name: Burst\n  m_Shader: {fileID: 4800000, guid: ${URP_UNLIT}, type: 3}\n  m_SavedProperties:\n    m_Textures:\n    - _Tex: {m_Texture: {fileID: 2800000, guid: ${UNKNOWN}, type: 3}}\n    - _Other: {m_Texture: {fileID: 2800000, guid: ${ACME_RANGE}, type: 3}}\n    - _Builtin: {m_Texture: {fileID: 10400, guid: ${BUILTIN}, type: 0}}\n    - _Shared: {m_Texture: {fileID: 2100000, guid: ${GAME_SHARED_FX}, type: 2}}\n`,
    GAME_MAT,
  );
  await write(path.join(assets, 'Shared', 'Shared.mat'), `%YAML 1.1\n--- !u!21 &2100000\nMaterial:\n  m_Name: Shared\n  m_Shader: {fileID: 4800000, guid: ${URP_LIT}, type: 3}\n`, GAME_SHARED_FX);
  await write(path.join(assets, 'Plain', 'Plain.prefab'), `%YAML 1.1\n--- !u!1 &100\nGameObject:\n  m_Name: Plain\n  m_Ref: {guid: ${PLAIN_UNKNOWN}}\n`, '99999999999999999999999999999999');

  // PackageCache: URP (Unlit + Lit), acme-fx 2.1.0 (Range, Unused, Shared-clash) and acme-fx 1.0.0 (older Range).
  await write(path.join(cache, 'com.unity.render-pipelines.universal@17.0.4', 'Shaders', 'Particles', 'Unlit.shader'), 'Shader "Universal Render Pipeline/Particles/Unlit" {\n}\n', URP_UNLIT);
  await write(path.join(cache, 'com.unity.render-pipelines.universal@17.0.4', 'Shaders', 'Lit.shader'), 'Shader "Universal Render Pipeline/Lit" {\n}\n', URP_LIT);
  await write(path.join(cache, 'com.acme.fx@2.1.0', 'Range.mat'), 'Material:\n  m_Name: Range\n', ACME_RANGE);
  await write(path.join(cache, 'com.acme.fx@2.1.0', 'Unused.mat'), 'Material:\n  m_Name: Unused\n', ACME_UNUSED);
  await write(path.join(cache, 'com.acme.fx@2.1.0', 'Shared.mat'), 'Material:\n  m_Name: Shared\n', GAME_SHARED_FX);
  await write(path.join(cache, 'com.acme.fx@1.0.0', 'Range.mat'), 'Material:\n  m_Name: Range\n', ACME_RANGE);

  return { dir, assets, cache };
}

const selectVfx = { prefabSelect: 'vfx-components' as const, excludePathPrefixes: [] as string[] };

function gameSpec(f: Fixture): SourceSpec {
  return { origin: 'Game', source: folderSetSource([{ game: 'Game', root: f.assets }], 'Assets'), select: selectVfx };
}

test('scan roots are the VFX prefabs only; references from a non-VFX prefab are never scanned', async () => {
  const f = await makeFixture();
  try {
    const scan = await scanReferences([gameSpec(f)]);
    assert.deepEqual(scan.roots.map((r) => r.guid), [PREFAB]);
    assert.equal(scan.outside.has(PLAIN_UNKNOWN), false, 'a non-VFX prefab must not contribute references');
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('a guid defined by a game folder is never classified as a package, even when a package carries it', async () => {
  const f = await makeFixture();
  try {
    const scan = await scanReferences([gameSpec(f)]);
    assert.equal(scan.defined.has(GAME_SHARED_FX), true);
    assert.equal(scan.outside.has(GAME_SHARED_FX), false, 'a defined guid is not outside');
    const { entries } = await buildMap([gameSpec(f)], [f.cache], { full: true });
    assert.equal(entries.has(GAME_SHARED_FX), false, 'game-defined guid leaked into the package map');
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('builtin references are builtin, never outside and never in the JSON', async () => {
  const f = await makeFixture();
  try {
    const scan = await scanReferences([gameSpec(f)]);
    assert.equal(scan.builtin.has(BUILTIN), true);
    assert.equal(scan.outside.has(BUILTIN), false);
    const { entries } = await buildMap([gameSpec(f)], [f.cache], { full: true });
    assert.equal(entries.has(BUILTIN), false);
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('a package-mapped guid gets its UPM package, version and asset name from the PackageCache', async () => {
  const f = await makeFixture();
  try {
    const { entries } = await buildMap([gameSpec(f)], [f.cache], { full: false });
    assert.deepEqual(entries.get(URP_UNLIT), {
      kind: 'package',
      name: 'Universal Render Pipeline/Particles/Unlit',
      package: 'com.unity.render-pipelines.universal',
      version: '17.0.4',
    });
    assert.equal(entries.get(ACME_RANGE)?.name, 'Range');
    assert.equal(entries.get(ACME_RANGE)?.version, '2.1.0', 'several versions: the highest wins');
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('an unmapped guid is reported unresolved with its referencing asset and stays out of the map', async () => {
  const f = await makeFixture();
  try {
    const built = await buildMap([gameSpec(f)], [f.cache], { full: false });
    const u = built.summary.unresolved.list.find((x) => x.guid === UNKNOWN);
    assert.ok(u, 'UNKNOWN must be reported unresolved');
    assert.deepEqual(u.referenced_by, [GAME_MAT]);
    assert.deepEqual(u.paths, ['Assets/VFX/Burst.mat']);
    assert.equal(built.entries.has(UNKNOWN), false, 'an unmapped guid must never get an invented entry');
    assert.equal(built.summary.unresolved.list.some((x) => x.guid === PLAIN_UNKNOWN), false);
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('referenced mode omits unreferenced PackageCache guids; full mode lists them', async () => {
  const f = await makeFixture();
  try {
    const referenced = await buildMap([gameSpec(f)], [f.cache], { full: false });
    const full = await buildMap([gameSpec(f)], [f.cache], { full: true });
    assert.equal(referenced.entries.has(ACME_UNUSED), false, 'referenced mode must not list an unreferenced guid');
    assert.equal(full.entries.get(ACME_UNUSED)?.kind, 'package', 'full mode lists every PackageCache guid');
    assert.equal(full.entries.has(GAME_SHARED_FX), false, 'full mode still never lists a game-defined guid');
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('the URP always-included shaders are present even when no VFX references them', async () => {
  const f = await makeFixture();
  try {
    const { entries } = await buildMap([gameSpec(f)], [f.cache], { full: false });
    for (const g of ALWAYS_INCLUDE) assert.equal(entries.get(g)?.kind, 'package', `always-included ${g}`);
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('a missing always-included guid fails loudly instead of shipping an incomplete map', async () => {
  const f = await makeFixture();
  try {
    await assert.rejects(buildMap([gameSpec(f)], [f.cache], { full: false, always: [PLAIN_UNKNOWN] }), /not in any PackageCache/);
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('the written map validates against the server loader and classifies the guids the server will see', async () => {
  const f = await makeFixture();
  try {
    const built = await buildMap([gameSpec(f)], [f.cache], { full: false });
    const out = path.join(f.dir, 'unity-package-guids.json');
    await writePackageGuidMap(out, built.entries);
    const map = loadPackageGuids(out);
    assert.deepEqual([...map.keys()].sort(), [...built.entries.keys()].sort());
    assert.equal(map.has(UNKNOWN), false);
    assert.equal(map.has(GAME_SHARED_FX), false);
    assert.equal(classifyGuid(URP_UNLIT, map).kind, 'package');
    assert.equal(classifyGuid(UNKNOWN, map).kind, 'unresolved');
    assert.equal(classifyGuid(BUILTIN, map).kind, 'builtin');
    assert.equal(await fs.readFile(out, 'utf8').then((t) => t.includes(UNKNOWN)), false);
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('a folder source with no VFX prefab yields no roots and no outside guids', async () => {
  const f = await makeFixture();
  try {
    const plainOnly: SourceSpec = { origin: 'Plain', source: folderSource(path.join(f.assets, 'Plain'), 'Assets/Plain'), select: { prefabSelect: 'prefabs-folder' } };
    const scan = await scanReferences([plainOnly]);
    assert.equal(scan.roots.length, 0);
    assert.equal(scan.outside.size, 0);
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('indexPackageCache reads name@version folders and ignores missing roots', async () => {
  const f = await makeFixture();
  try {
    const idx = await indexPackageCache([f.cache, path.join(f.dir, 'nope')]);
    assert.equal(idx.get(ACME_RANGE)?.length, 2, 'both versions are indexed');
    assert.equal(idx.get(URP_LIT)?.[0].package, 'com.unity.render-pipelines.universal');
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('the committed server map loads through the server schema and carries the URP always-included shaders', () => {
  const map = loadPackageGuids(PACKAGE_GUID_MAP_PATH);
  for (const g of ALWAYS_INCLUDE) assert.equal(map.get(g)?.kind, 'package');
});

test('a hash-named PackageCache folder reports the package.json version, never the hash', async () => {
  const f = await makeFixture();
  try {
    const dir = path.join(f.cache, 'com.acme.hashed@0123456789ab');
    await write(path.join(dir, 'package.json'), JSON.stringify({ name: 'com.acme.hashed', version: '3.4.5' }));
    await write(path.join(dir, 'Thing.mat'), 'Material:\n  m_Name: Thing\n', '77777777777777777777777777777777');
    const nopkg = path.join(f.cache, 'com.acme.nojson@abcdef012345');
    await write(path.join(nopkg, 'Other.mat'), 'Material:\n  m_Name: Other\n', '88888777777777777777777777777777');
    const idx = await indexPackageCache([f.cache]);
    assert.equal(idx.get('77777777777777777777777777777777')?.[0].version, '3.4.5');
    assert.equal(idx.get('88888777777777777777777777777777')?.[0].version, null, 'a hash suffix is not a version');
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('an unresolved guid names the root VFX prefab(s) that reach it through intermediate assets', async () => {
  const f = await makeFixture();
  try {
    const { summary } = await buildMap([gameSpec(f)], [f.cache], { full: false });
    const u = summary.unresolved.list.find((x) => x.guid === UNKNOWN);
    assert.ok(u, 'fixture must leave UNKNOWN unresolved');
    assert.ok(u.root_prefab_count >= 1);
    assert.ok(u.root_prefabs.every((p) => p.endsWith('.prefab')), 'roots are prefab paths, not the referencing material');
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('a ref held in a .asset file is followed and its package guid is mapped (not left unresolved)', async () => {
  const f = await makeFixture();
  try {
    const ASSET_GUID = '77777777777777777777777777777777'; // a game .asset (VolumeProfile-like)
    const ASSET_PKG_GUID = '88888888888888888888888888888888'; // package script the .asset references
    await write(path.join(f.assets, 'VFX', 'Profile.asset'), `%YAML 1.1\n--- !u!114 &11400000\nMonoBehaviour:\n  m_Script: {fileID: 11500000, guid: ${ASSET_PKG_GUID}, type: 3}\n`, ASSET_GUID);
    await write(
      path.join(f.assets, 'VFX', 'Burst.prefab'),
      `%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!1 &100\nGameObject:\n  m_Name: Burst\n--- !u!198 &200\nParticleSystem:\n  m_Renderer:\n    m_Material: {fileID: 2100000, guid: ${GAME_MAT}, type: 2}\n    m_Profile: {fileID: 11400000, guid: ${ASSET_GUID}, type: 2}\n`,
      PREFAB,
    );
    // a BuiltInPackages-style root: the package folder has NO @version, the version comes from package.json
    const builtIn = path.join(f.dir, 'BuiltInPackages');
    await write(path.join(builtIn, 'com.unity.hdrp', 'Editor', 'AssetVersion.cs'), 'class AssetVersion {}\n', ASSET_PKG_GUID);
    await fs.writeFile(path.join(builtIn, 'com.unity.hdrp', 'package.json'), JSON.stringify({ name: 'com.unity.hdrp', version: '17.3.0' }));
    const scan = await scanReferences([gameSpec(f)]);
    assert.equal(scan.outside.has(ASSET_PKG_GUID), true, 'the .asset must be read');
    const { entries, summary } = await buildMap([gameSpec(f)], [f.cache, builtIn], { full: false });
    assert.deepEqual(entries.get(ASSET_PKG_GUID), { kind: 'package', name: 'AssetVersion', package: 'com.unity.hdrp', version: '17.3.0' });
    assert.equal(summary.unresolved.list.some((u) => u.guid === ASSET_PKG_GUID), false);
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('specsFromPacks adds the project Packages folder and the Editor BuiltInPackages as package roots', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-specs-'));
  try {
    const proj = path.join(dir, 'Game');
    await fs.mkdir(path.join(proj, 'Assets'), { recursive: true });
    await fs.mkdir(path.join(proj, 'Packages', 'com.theone.gdk.core'), { recursive: true });
    await fs.mkdir(path.join(proj, 'Library', 'PackageCache'), { recursive: true });
    const builtIn = path.join(dir, 'BuiltInPackages');
    await fs.mkdir(builtIn, { recursive: true });
    const packs = path.join(dir, 'packs.json');
    await fs.writeFile(packs, JSON.stringify({ packs: [{ slug: 'g', sourceType: 'folder-set', pathPrefix: 'Assets', sourceRoots: [{ game: 'Game', path: path.join(proj, 'Assets') }] }] }));
    const r = await specsFromPacks(packs, dir, builtIn);
    assert.deepEqual(r.cacheRoots, [path.join(proj, 'Library', 'PackageCache'), path.join(proj, 'Packages'), builtIn]);
    const missing = await specsFromPacks(packs, dir, path.join(dir, 'nope'));
    assert.ok(missing.missingCaches.includes(path.join(dir, 'nope')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
