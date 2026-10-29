import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BundleSchema, type Variant } from './bundle-contract.ts';
import { config } from './config.ts';
import { pool } from './db.ts';
import { buildHttp } from './http.ts';
import { buildBundle } from './bundle-builder.ts';
import { registerFiles } from './blob-store-register.ts';
import { putBlob } from './blob-store.ts';
import { assertScratchDb } from './test-fixtures/scratch-db.ts';
import * as store from './store.ts';
import type { DanglingEntry, PackageEntry } from './unity-refs.ts';

assertScratchDb();

const KEY = 'bundle-test-key';
const orig = { apiKey: config.apiKey, authDisabled: config.authDisabled, allowAnon: config.blobAllowAnon };
config.apiKey = KEY;
config.authDisabled = false;
config.blobAllowAnon = false;
const H = { 'x-vfx-key': KEY };
after(async () => {
  Object.assign(config, { apiKey: orig.apiKey, authDisabled: orig.authDisabled, blobAllowAnon: orig.allowAnon });
  await pool.end();
});

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
// disjoint from blob-store.test.ts: this file's guids all start with "bb"
const g = (n: string): string => ('bb' + sha('bundle-builder:' + n)).slice(0, 32);
const PKG_SHADER = '0406db5a14f94604a8c57ccfbc9f3b46';
const BUILTIN = '0000000000000000f000000000000000';
const UNRESOLVED = g('nowhere');
const pkgMap = new Map<string, PackageEntry>([[PKG_SHADER, { kind: 'package', name: 'Particles/Unlit', package: 'com.unity.render-pipelines.universal', version: null }]]);

const ref = (guid: string): string => `  m_Ref: {fileID: 2100000, guid: ${guid}, type: 2}\n`;
const yaml = (...guids: string[]): Buffer => Buffer.from('%YAML 1.1\n' + guids.map(ref).join(''));
const metaOf = (guid: string): Buffer => Buffer.from(`fileFormatVersion: 2\nguid: ${guid}\n`);

interface F { name: string; kind: string; body: Buffer; variant?: Variant; pack?: string }
async function upload(f: F, guid: string): Promise<Record<string, unknown>> {
  const meta = metaOf(guid);
  const textKind = f.kind !== 'texture';
  await putBlob(f.body, sha(f.body), textKind ? f.kind : 'texture');
  await putBlob(meta, sha(meta), 'meta');
  return {
    guid, variant: f.variant ?? 'original', kind: f.kind, path: `Assets/Fx/${f.name}`, asset_sha256: sha(f.body), meta_sha256: sha(meta),
    pack: f.pack ?? 'bb-pack', license: 'studio-internal', visibility: 'studio-only', source: { game: null, origin: 'test' },
    ...(f.variant === 'urp' ? { urp: { rule: 'builtin-particle-to-urp-unlit', glow_cap: null, shader_guid: PKG_SHADER } } : {}),
  };
}

const P = g('prefab'), M1 = g('mat1'), M2 = g('mat2'), T = g('tex'), S = g('shader');

async function seed(): Promise<void> {
  const tex = Buffer.concat([Buffer.from([0x89, 0x50, 0x00]), Buffer.alloc(100, 5)]);
  const items = [
    await upload({ name: 'Fire.shader', kind: 'shader', body: Buffer.from('Shader "Fx/Fire" {}\n') }, S),
    await upload({ name: 'Fire.png', kind: 'texture', body: tex }, T),
    await upload({ name: 'M1.mat', kind: 'material', body: yaml(S, T) }, M1),
    await upload({ name: 'M1.mat', kind: 'material', body: yaml(T, PKG_SHADER), variant: 'urp' }, M1),
    // M2 closes a cycle back to the prefab
    await upload({ name: 'M2.mat', kind: 'material', body: yaml(T, P) }, M2),
    await upload({ name: 'Boom.prefab', kind: 'prefab', body: yaml(M1, M2, BUILTIN, UNRESOLVED) }, P),
  ];
  const { results } = await registerFiles(items);
  assert.deepEqual(results.map((r) => r.status), Array(6).fill('created'), JSON.stringify(results));
}

async function recipe(slug: string, source?: Record<string, unknown>, deps?: string[]): Promise<string> {
  const r = await store.publish({
    type: 'recipe', slug, name: slug, license: 'studio-internal', visibility: 'studio-only', b64: Buffer.from('{"recipe":true}').toString('base64'),
    fileName: `${slug}.json`, dependencies: deps, meta: source ? { source } : {},
  });
  return r.uri;
}

const names = (b: { files: { path: string; variant: string }[] }): string[] => b.files.map((f) => `${f.path.split('/').pop()}:${f.variant}`);

test('bundle for the fixture graph (variant=urp): dependency-first order, urp material, requires, unresolved, cycle', async () => {
  await seed();
  const uri = await recipe('bb-recipe-main', { prefabGuid: P });
  const b = await buildBundle(uri, 'urp', pkgMap);
  assert.equal(BundleSchema.safeParse(b).success, true, JSON.stringify(BundleSchema.safeParse(b)));
  // shader is NOT shipped: only M1's original referenced it, and M1 is replaced by its urp row
  assert.deepEqual(names(b), ['Fire.png:original', 'M1.mat:urp', 'M2.mat:original', 'Boom.prefab:original']);
  assert.equal(b.files.at(-1)!.guid, P, 'root file is last');
  assert.equal(b.root_guid, P);
  const m1 = b.files.find((f) => f.guid === M1)!;
  assert.equal(m1.urp_converted, true);
  assert.equal(m1.urp_rule, 'builtin-particle-to-urp-unlit');
  assert.equal(m1.target_path, 'Assets/VFXCloud/bb-pack/Fx/M1.mat');
  assert.equal(m1.download_url, `http://127.0.0.1:${config.port}/v1/blob/${m1.sha256}`);
  assert.deepEqual(b.requires.map((r) => [r.guid, r.kind, r.name, r.package]), [
    [BUILTIN, 'builtin', 'Unity default resources', null],
    [PKG_SHADER, 'package', 'Particles/Unlit', 'com.unity.render-pipelines.universal'],
  ].sort((x, y) => (x[0]! < y[0]! ? -1 : 1)));
  assert.deepEqual(b.requires.find((r) => r.guid === PKG_SHADER)!.referenced_by, [M1]);
  assert.deepEqual(b.unresolved, [{ guid: UNRESOLVED, referenced_by: [P] }]);
  assert.equal(b.complete, false);
  assert.deepEqual(b.cycles, [[P, M2]]);
  assert.equal(b.file_count, 4);
  assert.equal(b.total_bytes, b.files.reduce((s, f) => s + f.bytes + f.meta_bytes, 0));
});

test('variant=original returns vendor bytes and keeps the pack shader its material references', async () => {
  const b = await buildBundle(await recipe('bb-recipe-orig', { prefabGuid: P }), 'original', pkgMap);
  assert.deepEqual(names(b), ['Fire.shader:original', 'Fire.png:original', 'M1.mat:original', 'M2.mat:original', 'Boom.prefab:original']);
  assert.ok(b.files.every((f) => !f.urp_converted));
  assert.equal(b.requires.some((r) => r.guid === PKG_SHADER), false);
});

test('a prefab whose whole closure resolves is complete', async () => {
  const lone = g('lone-prefab');
  const { results } = await registerFiles([await upload({ name: 'Lone.prefab', kind: 'prefab', body: yaml(T, BUILTIN) }, lone)]);
  assert.equal(results[0].status, 'created');
  const b = await buildBundle(await recipe('bb-recipe-complete', { prefabGuid: lone }), 'urp', pkgMap);
  assert.equal(b.complete, true);
  assert.deepEqual(names(b), ['Fire.png:original', 'Lone.prefab:original']);
  assert.deepEqual(b.unresolved, []);
  assert.deepEqual(b.cycles, []);
});

test('recipe with no prefab: a well-formed bundle with files [] and reason no_prefab, not an error (route too)', async () => {
  const uri = await recipe('bb-recipe-noprefab');
  const b = await buildBundle(uri, 'urp', pkgMap);
  assert.equal(BundleSchema.safeParse(b).success, true);
  assert.deepEqual([b.reason, b.files, b.complete, b.root_guid, b.file_count, b.total_bytes], ['no_prefab', [], false, null, 0, 0]);
  const app = await buildHttp();
  const res = await app.inject({ method: 'GET', url: '/v1/closure/recipe/bb-recipe-noprefab/1', headers: H });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().reason, 'no_prefab');
  assert.deepEqual(res.json().files, []);
  await app.close();
});

test('prefab guid known but never uploaded: reason bytes_not_uploaded, files []', async () => {
  const b = await buildBundle(await recipe('bb-recipe-nobytes', { prefabGuid: g('never-uploaded') }), 'urp', pkgMap);
  assert.deepEqual([b.reason, b.files, b.complete, b.root_guid], ['bytes_not_uploaded', [], false, g('never-uploaded')]);
  assert.equal(BundleSchema.safeParse(b).success, true);
});

test('legacy resource closure items appear as origin "resource" files ahead of the prefab files', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x00]), Buffer.alloc(40, 9)]);
  const tex = await store.publish({ type: 'texture', slug: 'bb-legacy-tex', name: 'bb tex', license: 'cc0', b64: png.toString('base64'), fileName: 'bb-legacy-tex.png' });
  const lone = g('lone-prefab');
  const uri = await recipe('bb-recipe-res', { prefabGuid: lone }, [tex.uri]);
  const b = await buildBundle(uri, 'urp', pkgMap);
  assert.equal(BundleSchema.safeParse(b).success, true, JSON.stringify(BundleSchema.safeParse(b)));
  assert.equal(b.files[0].origin, 'resource');
  assert.equal(b.files[0].kind, 'texture');
  assert.equal(b.files[0].guid, null);
  assert.equal(b.files[0].meta_download_url, null);
  assert.equal(b.files[0].target_path, 'Assets/VFXCloud/texture/bb-legacy-tex/bb-legacy-tex.png');
  assert.equal(b.files[0].sha256, sha(png));
  assert.equal(b.files.at(-1)!.guid, lone);

  const root = await buildBundle(tex.uri, 'urp', pkgMap);
  assert.deepEqual(root.files.map((f) => [f.origin, f.kind]), [['resource', 'texture']], 'a non-recipe root ships itself');
  assert.equal(root.complete, true);
});

test('unknown record is 404; bad variant is 400; asset-file route returns one BundleFile', async () => {
  const app = await buildHttp();
  const nf = await app.inject({ method: 'GET', url: '/v1/closure/recipe/bb-nope/1', headers: H });
  assert.equal(nf.statusCode, 404);
  assert.equal(nf.json().code, 'not_found');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/closure/recipe/bb-recipe-main/1?variant=bogus', headers: H })).statusCode, 400);
  const urp = await app.inject({ method: 'GET', url: `/v1/asset-file/${M1}?variant=urp`, headers: H });
  assert.equal(urp.statusCode, 200, urp.body);
  assert.equal(urp.json().variant, 'urp');
  assert.equal((await app.inject({ method: 'GET', url: `/v1/asset-file/${M1}`, headers: H })).json().variant, 'original');
  assert.equal((await app.inject({ method: 'GET', url: `/v1/asset-file/${g('absent')}`, headers: H })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/asset-file/zzz', headers: H })).statusCode, 400);
  await app.close();
});

test('bundle over VFX_BUNDLE_MAX_FILES is 400 invalid with details.file_count', async () => {
  const prior = config.bundleMaxFiles;
  config.bundleMaxFiles = 2;
  try {
    const app = await buildHttp();
    const res = await app.inject({ method: 'GET', url: '/v1/closure/recipe/bb-recipe-main/1', headers: H });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().code, 'invalid');
    assert.ok(res.json().details.file_count > 2);
    await app.close();
  } finally {
    config.bundleMaxFiles = prior;
  }
});

test('batch register: created / unchanged / replaced / rejected (conflict, forbidden, invalid, missing blob)', async () => {
  const app = await buildHttp();
  const g1 = g('reg1');
  const base = await upload({ name: 'Reg1.mat', kind: 'material', body: yaml(T) }, g1);
  const post = async (files: unknown[]) => (await app.inject({ method: 'POST', url: '/v1/asset-file/batch', headers: H, payload: { files } })).json();

  assert.equal((await post([base])).results[0].status, 'created');
  assert.equal((await post([base])).results[0].status, 'unchanged');

  const other = await upload({ name: 'Reg1.mat', kind: 'material', body: yaml(T, S) }, g1);
  const conflict = (await post([other])).results[0];
  assert.deepEqual([conflict.status, conflict.code], ['rejected', 'conflict']);
  const replaced = (await post([{ ...other, replace: true }])).results[0];
  assert.equal(replaced.status, 'replaced');
  const refs = await pool.query<{ refs: string[] }>('SELECT refs FROM asset_file WHERE guid = $1 AND variant = $2', [g1, 'original']);
  assert.deepEqual([...refs.rows[0].refs].sort(), [S, T].sort(), 'refs are computed server-side from the stored bytes');

  const forbidden = (await post([{ ...base, guid: g('f1'), license: 'unknown' }, { ...base, guid: g('f2'), visibility: 'global' }])).results;
  assert.deepEqual(forbidden.map((r: { code: string }) => r.code), ['forbidden', 'forbidden']);

  const ghost = sha('never uploaded');
  const miss = (await post([{ ...base, guid: g('m1'), asset_sha256: ghost }])).results[0];
  assert.deepEqual([miss.status, miss.code, miss.details.missing], ['rejected', 'conflict', [ghost]]);

  const bad = (await post([{ ...base, guid: g('b1'), path: 'Assets/../evil.mat' }, { ...base, guid: g('b2'), variant: 'urp' }, { nonsense: true }])).results;
  assert.deepEqual(bad.map((r: { code: string }) => r.code), ['invalid', 'invalid', 'invalid']);

  const counts = (await post([base, other])).counts;
  assert.equal(counts.created + counts.unchanged + counts.replaced + counts.rejected, 2);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/asset-file/batch', headers: H, payload: { files: Array.from({ length: 501 }, () => base) } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/asset-file/batch', headers: H, payload: {} })).json().code, 'invalid');
  await app.close();
});

const DANGLE = g('defined-nowhere');
const danglingMap = (packs: string[]): Map<string, DanglingEntry> => new Map([[DANGLE, { packs }]]);

test('a ref defined nowhere in a complete pack is dangling: complete stays true, unresolved is empty', async () => {
  const d = g('dangle-prefab');
  const dmat = g('dangle-mat');
  const { results } = await registerFiles([
    await upload({ name: 'D.mat', kind: 'material', body: yaml(T, DANGLE) }, dmat),
    await upload({ name: 'D.prefab', kind: 'prefab', body: yaml(dmat, BUILTIN) }, d),
  ]);
  assert.deepEqual(results.map((r) => r.status), ['created', 'created']);
  const b = await buildBundle(await recipe('bb-recipe-dangling', { prefabGuid: d }), 'urp', pkgMap, danglingMap(['bb-pack']));
  assert.equal(BundleSchema.safeParse(b).success, true, JSON.stringify(BundleSchema.safeParse(b)));
  assert.deepEqual(b.dangling, [{ guid: DANGLE, referenced_by: [dmat] }]);
  assert.deepEqual(b.unresolved, []);
  assert.equal(b.complete, true);
  assert.equal(b.reason, null);
  assert.equal(b.requires.some((r) => r.guid === DANGLE), false);
});

test('the same guid from a pack the dangling map does not name (partial folder source) stays unresolved', async () => {
  const b = await buildBundle(await recipe('bb-recipe-dangling-partial', { prefabGuid: g('dangle-prefab') }), 'urp', pkgMap, danglingMap(['some-other-pack']));
  assert.deepEqual(b.dangling, []);
  assert.deepEqual(b.unresolved, [{ guid: DANGLE, referenced_by: [g('dangle-mat')] }]);
  assert.equal(b.complete, false);
});

test('a dangling-map guid that is a ROOT stays an error (bytes_not_uploaded), never dangling', async () => {
  const b = await buildBundle(await recipe('bb-recipe-dangling-root', { prefabGuid: DANGLE }), 'urp', pkgMap, danglingMap(['bb-pack']));
  assert.equal(b.reason, 'bytes_not_uploaded');
  assert.equal(b.complete, false);
  assert.deepEqual(b.dangling, []);
});

test('every bundle shape carries a dangling array (empty by default)', async () => {
  const b = await buildBundle(await recipe('bb-recipe-nodangling', { prefabGuid: P }), 'urp', pkgMap);
  assert.deepEqual(b.dangling, []);
  const none = await buildBundle(await recipe('bb-recipe-nodangling-nopref'), 'urp', pkgMap);
  assert.deepEqual(none.dangling, []);
});

const GAME_CS = g('game-script');
const strippedMap = (packs: string[]): Map<string, DanglingEntry> => new Map([[GAME_CS, { packs, stripped: true }]]);

test('a stripped game script is not shipped even though its row exists: dangling, complete stays true', async () => {
  const p = g('stripped-prefab');
  const { results } = await registerFiles([
    await upload({ name: 'Game.cs', kind: 'script', body: Buffer.from('class GameView {}\n') }, GAME_CS),
    await upload({ name: 'Stripped.prefab', kind: 'prefab', body: yaml(GAME_CS, BUILTIN) }, p),
  ]);
  assert.deepEqual(results.map((r) => r.status), ['created', 'created']);
  const uri = await recipe('bb-recipe-stripped', { prefabGuid: p });
  // without the flag the script ships like any other file (the map entry is what strips it)
  const shipped = await buildBundle(uri, 'urp', pkgMap, new Map([[GAME_CS, { packs: ['bb-pack'] }]]));
  assert.equal(shipped.files.some((f) => f.guid === GAME_CS), true);
  const b = await buildBundle(uri, 'urp', pkgMap, strippedMap(['bb-pack']));
  assert.equal(BundleSchema.safeParse(b).success, true, JSON.stringify(BundleSchema.safeParse(b)));
  assert.equal(b.files.some((f) => f.kind === 'script'), false);
  assert.equal(b.files.some((f) => f.guid === p), true);
  assert.deepEqual(b.dangling, [{ guid: GAME_CS, referenced_by: [p] }]);
  assert.deepEqual(b.unresolved, []);
  assert.equal(b.complete, true);
  assert.equal(b.reason, null);
  // an entry naming another pack never strips this pack's script
  const other = await buildBundle(uri, 'urp', pkgMap, strippedMap(['some-other-pack']));
  assert.equal(other.files.some((f) => f.guid === GAME_CS), true);
});
