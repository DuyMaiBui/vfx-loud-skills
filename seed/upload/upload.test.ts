import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSources, collectClosure, sha256 } from './collect.ts';
import { runUpload, type UploadOptions } from './run.ts';
import { loadDanglingGuids } from '../../server/src/unity-refs.ts';
import { loadUrpExport, urpRejection } from './urp.ts';
import { makeUnityPackage } from '../extract/test-helpers.ts';
import { GUID, MAT_BYTES, PACKAGE_GUIDS, makeFixture, pkgAssets, startStub, type Fixture } from './test-support.ts';
import './verify.test.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOTS = [{ guid: GUID.prefab, pack: 'retro-arsenal' }];

async function opts(fx: Fixture, server: string, over: Partial<UploadOptions> = {}): Promise<UploadOptions> {
  return {
    sources: await buildSources(fx.packs, fx.dir),
    roots: ROOTS,
    packageGuids: PACKAGE_GUIDS,
    server,
    outDir: await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-upload-out-')),
    yes: true,
    retryBackoffMs: 1,
    ...over,
  };
}

test('closure: dependency order, kinds, asmdef ancestor, requires and unresolved', async () => {
  const fx = await makeFixture();
  try {
    const c = await collectClosure(await buildSources(fx.packs, fx.dir), ROOTS, { packageGuids: PACKAGE_GUIDS });
    assert.deepEqual(
      c.files.map((f) => f.guid),
      [GUID.prefab, GUID.mat, GUID.script, GUID.audio, GUID.tex, GUID.asm, GUID.asm2],
    );
    assert.deepEqual(c.files.map((f) => f.kind), ['prefab', 'material', 'script', 'audio', 'texture', 'asmdef', 'asmdef']);
    // D12: the script's nearest ancestor .asmdef (referenced by nobody) and the asmdef it references by GUID.
    assert.ok(c.files.some((f) => f.guid === GUID.asm) && c.files.some((f) => f.guid === GUID.asm2));
    assert.deepEqual([...c.requires.keys()].sort(), [GUID.builtin, GUID.urpShader].sort());
    // oldShader is in no source and no package map: unresolved, with who referenced it.
    assert.deepEqual([...c.unresolved.get(GUID.unresolved)!], [GUID.prefab]);
    assert.deepEqual([...c.unresolved.get(GUID.oldShader)!], [GUID.mat]);
  } finally {
    await fx.cleanup();
  }
});

const complete = (fx: Fixture): Fixture => ({ ...fx, packs: fx.packs.map((p) => ({ ...p, completeSource: true })) });

test('dangling: a ref defined nowhere in a pack flagged completeSource is dangling, not unresolved', async () => {
  const fx = await makeFixture();
  try {
    const c = await collectClosure(await buildSources(complete(fx).packs, fx.dir), ROOTS, { packageGuids: PACKAGE_GUIDS });
    assert.equal(c.unresolved.size, 0);
    assert.deepEqual([...c.dangling.keys()].sort(), [GUID.oldShader, GUID.unresolved].sort());
    assert.deepEqual([...c.dangling.get(GUID.unresolved)!.referencedBy], [GUID.prefab]);
    assert.deepEqual([...c.dangling.get(GUID.unresolved)!.packs], ['retro-arsenal']);
  } finally {
    await fx.cleanup();
  }
});

test('dangling: a partial source (completeSource not set) keeps the ref unresolved', async () => {
  const fx = await makeFixture();
  try {
    const c = await collectClosure(await buildSources(fx.packs, fx.dir), ROOTS, { packageGuids: PACKAGE_GUIDS });
    assert.equal(c.dangling.size, 0);
    assert.equal(c.unresolved.size, 2);
  } finally {
    await fx.cleanup();
  }
});

test('dangling: a guid that is also a ROOT stays unresolved (never dangling)', async () => {
  const fx = await makeFixture();
  try {
    const c = await collectClosure(await buildSources(complete(fx).packs, fx.dir), [...ROOTS, { guid: GUID.unresolved }], { packageGuids: PACKAGE_GUIDS });
    assert.deepEqual([...c.unresolved.keys()], [GUID.unresolved]);
    assert.deepEqual(c.rootsMissing, [GUID.unresolved]);
    assert.deepEqual([...c.dangling.keys()], [GUID.oldShader]);
  } finally {
    await fx.cleanup();
  }
});

test('dangling: a guid referenced by a complete pack AND a partial pack stays unresolved', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-dmix-'));
  try {
    const X = 'e'.repeat(32), PREFAB = 'd'.repeat(32), MAT = 'f'.repeat(32);
    const r = (guid: string): string => `{fileID: 1, guid: ${guid}, type: 2}`;
    await fs.writeFile(path.join(dir, 'a.unitypackage'), makeUnityPackage([{ guid: PREFAB, path: 'Assets/A/P.prefab', asset: `GameObject:\n  m: ${r(MAT)}\n  x: ${r(X)}\n` }]));
    await fs.writeFile(path.join(dir, 'b.unitypackage'), makeUnityPackage([{ guid: MAT, path: 'Assets/B/M.mat', asset: `Material:\n  x: ${r(X)}\n` }]));
    const base = { name: 'x', vendor: 'v', style: [] as string[], tags: [] as string[], license: 'asset-store-eula' };
    const packs = [{ ...base, slug: 'a', file: 'a.unitypackage', completeSource: true }, { ...base, slug: 'b', file: 'b.unitypackage' }];
    const c = await collectClosure(await buildSources(packs, dir), [{ guid: PREFAB }], { packageGuids: PACKAGE_GUIDS });
    assert.deepEqual([...c.unresolved.keys()], [X]);
    assert.equal(c.dangling.size, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('dangling: the plan carries the list and counter; --dangling-map writes the server map', async () => {
  const fx = await makeFixture();
  const stub = await startStub();
  try {
    const mapOut = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-dmap-')), 'dangling-guids.json');
    const o = await opts(complete(fx), stub.url, { yes: false, danglingMapOut: mapOut });
    const r = await runUpload(o);
    assert.equal(r.summary.dangling, 2);
    assert.equal(r.summary.unresolved, 0);
    const plan = JSON.parse(await fs.readFile(path.join(o.outDir, 'plan.json'), 'utf8'));
    assert.deepEqual(plan.unresolved, []);
    assert.deepEqual(plan.dangling.map((d: { guid: string }) => d.guid).sort(), [GUID.oldShader, GUID.unresolved].sort());
    const map = JSON.parse(await fs.readFile(mapOut, 'utf8'));
    assert.deepEqual(map, { version: 1, entries: { [GUID.unresolved]: { packs: ['retro-arsenal'] }, [GUID.oldShader]: { packs: ['retro-arsenal'] } } });
    assert.equal(loadDanglingGuids(mapOut).size, 2);
    // a dangling-only closure is a clean run (no failure, exit 0)
    assert.equal(r.exitCode, 0);
  } finally {
    await stub.close();
    await fx.cleanup();
  }
});

test('--skip-kinds audio drops the clip', async () => {
  const fx = await makeFixture();
  try {
    const c = await collectClosure(await buildSources(fx.packs, fx.dir), ROOTS, { packageGuids: PACKAGE_GUIDS, skipKinds: new Set(['audio']) });
    assert.equal(c.files.some((f) => f.kind === 'audio'), false);
    assert.equal(c.skipped.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test('a source under ImportedPacks is a hard error (originals come only from the vendor source)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-imp-'));
  try {
    const retro = path.join(dir, 'ImportedPacks', 'retro');
    await fs.mkdir(retro, { recursive: true });
    await fs.writeFile(path.join(retro, 'Fire.mat'), MAT_BYTES);
    await fs.writeFile(path.join(retro, 'Fire.mat.meta'), `fileFormatVersion: 2\nguid: ${GUID.mat}\n`);
    const pack = { slug: 'retro-arsenal', name: 'x', vendor: 'v', style: [], tags: [], license: 'asset-store-eula', sourceType: 'folder' as const, sourcePath: retro, pathPrefix: 'Assets/Retro' };
    await assert.rejects(buildSources([pack], dir), /ImportedPacks/);
    await assert.rejects(buildSources([{ ...pack, file: 'a.unitypackage', sourceType: 'unitypackage' }], path.join(dir, 'ImportedPacks')), /ImportedPacks/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('D16: first source wins, differing copies are recorded, a later change is a conflict (exit 1), never replaced', async () => {
  const fx = await makeFixture({ matText: 'Material:\n  other: 1\n' });
  const stub = await startStub();
  try {
    const c = await collectClosure(await buildSources(fx.packs, fx.dir), ROOTS, { packageGuids: PACKAGE_GUIDS });
    const mat = c.files.find((f) => f.guid === GUID.mat)!;
    assert.equal(mat.pack, 'retro-arsenal');
    assert.equal(mat.assetSha, sha256(Buffer.from(MAT_BYTES)));
    assert.deepEqual(mat.copies, [{ origin: 'sci-fi-arsenal', sha256: sha256(Buffer.from('Material:\n  other: 1\n')) }]);

    const first = await runUpload(await opts(fx, stub.url));
    assert.equal(first.exitCode, 0, JSON.stringify(first.summary.failures));
    assert.deepEqual(stub.files.get(`${GUID.mat}|original`)!.source.copies, mat.copies);

    // The vendor bytes change: the registration is a conflict and the stored row is untouched.
    const before = stub.files.get(`${GUID.mat}|original`)!.asset_sha256;
    await fs.writeFile(path.join(fx.dir, 'retro.unitypackage'), makeUnityPackage(pkgAssets(MAT_BYTES + '# edited\n')));
    const second = await runUpload(await opts(fx, stub.url));
    assert.equal(second.exitCode, 1);
    assert.equal(second.summary.rejected, 1);
    assert.equal(stub.files.get(`${GUID.mat}|original`)!.asset_sha256, before);
  } finally {
    await stub.close();
    await fx.cleanup();
  }
});

test('--limit N uploads the first N files of the closure', async () => {
  const fx = await makeFixture();
  const stub = await startStub();
  try {
    const r = await runUpload(await opts(fx, stub.url, { limit: 3 }));
    assert.equal(r.exitCode, 0);
    assert.equal(r.summary.files, 3);
    assert.equal(r.summary.files_in_closure, 7);
    assert.deepEqual([...stub.files.values()].map((f) => f.guid), [GUID.prefab, GUID.mat, GUID.script]);
  } finally {
    await stub.close();
    await fx.cleanup();
  }
});

test('idempotent: the second run uploads 0 bytes and registers everything unchanged', async () => {
  const fx = await makeFixture();
  const stub = await startStub({ apiKey: 'k' });
  try {
    const o = await opts(fx, stub.url, { apiKey: 'k' });
    const a = await runUpload(o);
    assert.equal(a.exitCode, 0, JSON.stringify(a.summary.failures));
    assert.equal(a.summary.created, 7);
    const putsAfterFirst = stub.counts.puts;
    assert.ok(putsAfterFirst >= 7);
    const b = await runUpload({ ...o, outDir: await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-upload-out-')) });
    assert.equal(b.exitCode, 0);
    assert.equal(stub.counts.puts, putsAfterFirst);
    assert.equal(b.summary.bytes_uploaded, 0);
    assert.equal(b.summary.unchanged, 7);
    assert.equal(b.summary.created, 0);
  } finally {
    await stub.close();
    await fx.cleanup();
  }
});

test('dry run sends nothing and writes plan.json with by-kind totals', async () => {
  const fx = await makeFixture();
  const stub = await startStub();
  try {
    const o = await opts(fx, stub.url, { yes: false });
    const r = await runUpload(o);
    assert.equal(r.exitCode, 0);
    assert.equal(stub.counts.requests, 0);
    const plan = JSON.parse(await fs.readFile(path.join(o.outDir, 'plan.json'), 'utf8'));
    assert.equal(plan.by_kind.asmdef.files, 2);
    assert.equal(plan.unresolved.length, 2);
  } finally {
    await stub.close();
    await fx.cleanup();
  }
});

test('a blob the server rejects (sha mismatch injected) fails the run with exit 1 and registers nothing for it', async () => {
  const fx = await makeFixture();
  const bad = sha256(Buffer.from(MAT_BYTES));
  const stub = await startStub({ rejectPutSha: new Set([bad]) });
  try {
    const r = await runUpload(await opts(fx, stub.url));
    assert.equal(r.exitCode, 1);
    assert.ok(r.summary.failures.some((f) => f.stage === 'put' && f.sha256 === bad));
    assert.equal(stub.files.has(`${GUID.mat}|original`), false);
  } finally {
    await stub.close();
    await fx.cleanup();
  }
});

test('retries 5xx with backoff, and a dead server is exit 75', async () => {
  const fx = await makeFixture();
  const flaky = await startStub({ failFirstPuts: 2 });
  const dead = await startStub({ down: true });
  try {
    assert.equal((await runUpload(await opts(fx, flaky.url))).exitCode, 0);
    assert.equal((await runUpload(await opts(fx, dead.url))).exitCode, 75);
  } finally {
    await flaky.close();
    await dead.close();
    await fx.cleanup();
  }
});

test('--resume skips files already registered', async () => {
  const fx = await makeFixture();
  const stub = await startStub();
  try {
    const o = await opts(fx, stub.url);
    await runUpload(o);
    const reqs = stub.counts.requests;
    const r = await runUpload({ ...o, resume: true });
    assert.equal(r.exitCode, 0);
    assert.equal(stub.counts.requests, reqs); // everything registered already: not a single request
  } finally {
    await stub.close();
    await fx.cleanup();
  }
});

test('URP criterion (C8): known package shader that differs is accepted; same shader or unknown shader is rejected', async () => {
  const mk = (shader_guid: string, original_shader_guid = GUID.oldShader) => ({ guid: GUID.mat, path: 'p', rule: 'r', sha256: 'a'.repeat(64), original_shader_guid, shader_guid });
  assert.equal(urpRejection(mk(GUID.urpShader), PACKAGE_GUIDS), null);
  assert.match(urpRejection(mk(GUID.oldShader), PACKAGE_GUIDS)!, /not a known package shader/); // still on the pack shader
  assert.match(urpRejection(mk(GUID.urpShader, GUID.urpShader), PACKAGE_GUIDS)!, /did not change/);
  assert.match(urpRejection(mk(GUID.pkgOnly), PACKAGE_GUIDS)!, /not a known package shader/);
});

test('--variant urp registers accepted items with the original .meta sha, glow_cap null; rejects the rest', async () => {
  const fx = await makeFixture();
  const stub = await startStub();
  const exp = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-urp-'));
  try {
    const good = Buffer.from('Material:\n  m_Shader: {fileID: 1, guid: ' + GUID.urpShader + ', type: 3}\n');
    const bad = Buffer.from('Material:\n  still pack shader\n');
    await fs.writeFile(path.join(exp, `${GUID.mat}.mat`), good);
    await fs.writeFile(path.join(exp, `${GUID.mat2}.mat`), bad);
    await fs.writeFile(
      path.join(exp, 'index.json'),
      JSON.stringify({
        version: 1,
        items: [
          { guid: GUID.mat, path: 'x', rule: 'builtin-particle-to-urp-unlit', sha256: sha256(good), original_shader_guid: GUID.oldShader, shader_guid: GUID.urpShader },
          { guid: GUID.mat2, path: 'x', rule: 'noop', sha256: sha256(bad), original_shader_guid: GUID.oldShader, shader_guid: GUID.oldShader },
        ],
      }),
    );
    const loaded = await loadUrpExport(exp, PACKAGE_GUIDS);
    assert.equal(loaded.accepted.length, 1);
    assert.equal(loaded.rejected.length, 1);
    const o = await opts(fx, stub.url, { variant: 'urp', urpDir: exp, roots: [] });
    const r = await runUpload(o);
    assert.equal(r.exitCode, 0, JSON.stringify(r.summary.failures));
    assert.equal(r.summary.urp_rejected, 1);
    const row = stub.files.get(`${GUID.mat}|urp`)!;
    assert.equal(row.urp?.glow_cap, null);
    assert.equal(row.path, 'Assets/Retro/Materials/Fire.mat');
    assert.equal(row.meta_sha256, sha256(Buffer.from(`fileFormatVersion: 2\nguid: ${GUID.mat}\n`)));
    assert.equal(stub.files.has(`${GUID.mat2}|urp`), false);
  } finally {
    await stub.close();
    await fx.cleanup();
    await fs.rm(exp, { recursive: true, force: true });
  }
});

test('CLI: --help lists the exit codes; usage errors exit 2', () => {
  const run = (...a: string[]) => spawnSync('node', ['seed/upload-blobs.ts', ...a], { cwd: repoRoot, encoding: 'utf8' });
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /75 server unavailable/);
  assert.equal(run('--bogus').status, 2);
  assert.equal(run('--yes', '--dry-run').status, 2);
  assert.equal(run('--variant', 'urp').status, 2);
  assert.equal(run('--skip-kinds', 'nope').status, 2);
});

test('stripScripts: a game script of the pack is not shipped, its asmdefs are not pulled in, the guid is dangling + stripped', async () => {
  const fx = await makeFixture();
  const stub = await startStub();
  try {
    const packs = fx.packs.map((p) => ({ ...p, stripScripts: true }));
    const c = await collectClosure(await buildSources(packs, fx.dir), ROOTS, { packageGuids: PACKAGE_GUIDS });
    assert.deepEqual(c.files.map((f) => f.kind), ['prefab', 'material', 'audio', 'texture']);
    assert.equal(c.files.some((f) => f.guid === GUID.script || f.guid === GUID.asm || f.guid === GUID.asm2), false);
    assert.equal(c.unresolved.has(GUID.script), false, 'a stripped script is never unresolved');
    assert.deepEqual([...c.dangling.keys()], [GUID.script]);
    assert.deepEqual([...c.dangling.get(GUID.script)!.referencedBy], [GUID.prefab]);
    assert.deepEqual([...c.dangling.get(GUID.script)!.packs], ['retro-arsenal']);
    assert.equal(c.dangling.get(GUID.script)!.stripped, true);
    // without the flag the script and both asmdefs ship (existing behaviour)
    const plain = await collectClosure(await buildSources(fx.packs, fx.dir), ROOTS, { packageGuids: PACKAGE_GUIDS });
    assert.equal(plain.files.some((f) => f.guid === GUID.script), true);
    // the plan and the server map record it
    const mapOut = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-dmap-')), 'dangling-guids.json');
    const o = await opts({ ...fx, packs }, stub.url, { yes: false, danglingMapOut: mapOut });
    await runUpload(o);
    const plan = JSON.parse(await fs.readFile(path.join(o.outDir, 'plan.json'), 'utf8'));
    assert.deepEqual(plan.files.filter((f: { guid: string }) => f.guid === GUID.script), []);
    const map = JSON.parse(await fs.readFile(mapOut, 'utf8'));
    assert.deepEqual(map.entries[GUID.script], { packs: ['retro-arsenal'], stripped: true });
    assert.equal(loadDanglingGuids(mapOut).get(GUID.script)?.stripped, true);
  } finally {
    await stub.close();
    await fx.cleanup();
  }
});
