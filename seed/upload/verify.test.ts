import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BundleSchema, type Bundle } from '../../server/src/bundle-contract.ts';
import { main as verifyMain } from '../verify-closure.ts';
import { createClient } from './client.ts';
import { buildSources } from './collect.ts';
import { runUpload } from './run.ts';
import { verifyClosures } from './verify.ts';
import { GUID, PACKAGE_GUIDS, makeFixture, startStub, type Stub } from './test-support.ts';

const FIXTURE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'server', 'src', 'test-fixtures', 'bundle-sample.json');

/** Bundle for slug "boom" built from what the uploader registered on the stub (real shas, dependency first). */
function bundleOf(stub: Stub, base: string, drop: string[] = []): Bundle {
  const order = [GUID.audio, GUID.tex, GUID.asm2, GUID.asm, GUID.script, GUID.mat, GUID.prefab].filter((x) => !drop.includes(x));
  const files = order.map((guid) => {
    const f = stub.files.get(`${guid}|original`)!;
    const asset = stub.blobs.get(f.asset_sha256)!;
    const meta = stub.blobs.get(f.meta_sha256!)!;
    return {
      guid, origin: 'asset_file' as const, kind: f.kind, variant: 'original' as const, urp_converted: false, urp_rule: null,
      path: f.path, target_path: `Assets/VFXCloud/retro-arsenal/${f.path.slice('Assets/'.length)}`, pack: f.pack, license: f.license,
      sha256: f.asset_sha256, bytes: asset.length, download_url: `${base}/v1/blob/${f.asset_sha256}`,
      meta_sha256: f.meta_sha256, meta_bytes: meta.length, meta_download_url: `${base}/v1/blob/${f.meta_sha256}`,
    };
  });
  const bundle: Bundle = {
    schema: 'vfx-bundle/1', uri: 'vfx://recipe/boom/1', variant: 'original', root_guid: GUID.prefab, complete: true, reason: null, files,
    requires: [
      { guid: GUID.builtin, kind: 'builtin', name: 'Unity default resources', package: null, version: null, referenced_by: [GUID.prefab] },
      { guid: GUID.urpShader, kind: 'package', name: 'Particles/Unlit', package: 'com.unity.render-pipelines.universal', version: null, referenced_by: [GUID.mat] },
      // the two guids no source carries are declared as required here so only the mutation tests move them
      { guid: GUID.unresolved, kind: 'package', name: 'Third party', package: 'com.x.y', version: null, referenced_by: [GUID.prefab] },
      { guid: GUID.oldShader, kind: 'package', name: 'Old shader', package: 'com.x.y', version: null, referenced_by: [GUID.mat] },
    ],
    unresolved: [], cycles: [], file_count: files.length, total_bytes: files.reduce((n, f) => n + f.bytes, 0),
  };
  assert.ok(BundleSchema.safeParse(bundle).success, 'test bundle must satisfy the vfx-bundle/1 contract');
  return bundle;
}

async function uploaded(extra: ConstructorParameters<typeof Object>[0] = {}) {
  const fx = await makeFixture();
  const holder: { stub?: Stub } = {};
  const stub = await startStub({
    ...(extra as object),
    bundles: new Map([
      ['boom', (b: string) => bundleOf(holder.stub!, b)],
      ['boom-no-tex', (b: string) => bundleOf(holder.stub!, b, [GUID.tex])],
    ]),
  });
  holder.stub = stub;
  const r = await runUpload({
    sources: await buildSources(fx.packs, fx.dir), roots: [{ guid: GUID.prefab }], packageGuids: PACKAGE_GUIDS, server: stub.url, yes: true,
    outDir: await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-vout-')), retryBackoffMs: 1,
  });
  assert.equal(r.exitCode, 0, JSON.stringify(r.summary.failures));
  return { fx, stub };
}

test('verify: a complete stored closure verifies clean', async () => {
  const { fx, stub } = await uploaded();
  try {
    const rep = await verifyClosures(createClient({ server: stub.url, backoffMs: 1 }), [{ slug: 'boom', version: 1 }], 'original');
    assert.deepEqual({ c: rep.checked, ok: rep.complete, inc: rep.incomplete, mm: rep.sha_mismatch, er: rep.errors }, { c: 1, ok: 1, inc: [], mm: [], er: [] });
  } finally {
    await stub.close();
    await fx.cleanup();
  }
});

test('verify: a ref missing from the bundle is reported (verifier compares re-scanned refs to files/requires)', async () => {
  const { fx, stub } = await uploaded();
  try {
    const rep = await verifyClosures(createClient({ server: stub.url, backoffMs: 1 }), [{ slug: 'boom-no-tex', version: 1 }], 'original');
    assert.equal(rep.complete, 0);
    assert.equal(rep.incomplete.length, 1);
    assert.equal(rep.incomplete[0].reason, 'ref-missing-from-bundle');
    assert.deepEqual(rep.incomplete[0].unresolved, [GUID.tex]);
    assert.equal(rep.incomplete[0].has_prefab, true);
  } finally {
    await stub.close();
    await fx.cleanup();
  }
});

test('verify: a corrupted blob is a sha mismatch and the CLI exits 1; a clean run writes the report and exits 0', async () => {
  const { fx, stub } = await uploaded();
  const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-vrep-')), 'closure-verify.json');
  try {
    const env = { VFX_SERVER: stub.url } as NodeJS.ProcessEnv;
    assert.equal(await verifyMain(['--slugs', 'boom@1', '--variant', 'original', '--out', out, '--json'], env), 0);
    assert.equal(JSON.parse(await fs.readFile(out, 'utf8')).checked, 1);
    const bad = stub.files.get(`${GUID.tex}|original`)!.asset_sha256;
    const corrupt = await startStubSharing(stub, bad);
    try {
      assert.equal(await verifyMain(['--slugs', 'boom@1', '--variant', 'original', '--out', out, '--json'], { VFX_SERVER: corrupt.url } as NodeJS.ProcessEnv), 1);
      const rep = JSON.parse(await fs.readFile(out, 'utf8'));
      assert.equal(rep.sha_mismatch[0].expected, bad);
    } finally {
      await corrupt.close();
    }
    assert.equal(await verifyMain([], {} as NodeJS.ProcessEnv), 2);
  } finally {
    await stub.close();
    await fx.cleanup();
  }
});

/** A second stub serving the same blobs and bundle, but altering one blob on GET. */
async function startStubSharing(src: Stub, corruptSha: string): Promise<Stub> {
  const holder: { s?: Stub } = {};
  const s = await startStub({ corruptGet: new Set([corruptSha]), bundles: new Map([['boom', (b: string) => bundleOf(src, b)]]) });
  holder.s = s;
  for (const [k, v] of src.blobs) s.blobs.set(k, v);
  return s;
}

test('verify: the phase-1 bundle fixture parses and, with its blobs absent, is reported as an error not a pass', async () => {
  const raw = await fs.readFile(FIXTURE, 'utf8');
  const stub = await startStub({ bundles: new Map([['archanor-boom', (b: string) => JSON.parse(raw.replaceAll('http://127.0.0.1:8787', b))]]) });
  try {
    assert.ok(BundleSchema.safeParse(JSON.parse(raw)).success);
    const rep = await verifyClosures(createClient({ server: stub.url, backoffMs: 1 }), [{ slug: 'archanor-boom', version: 1 }, { slug: 'nope', version: 1 }], 'urp');
    assert.equal(rep.complete, 0);
    assert.equal(rep.errors.length, 2);
  } finally {
    await stub.close();
  }
});
