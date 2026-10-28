import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AUTH_DISABLED = '1';
const { pool } = await import('./db.ts');
const { config } = await import('./config.ts');
const { buildHttp } = await import('./http.ts');
const store = await import('./store.ts');
const { derivedLicenseProblem, parseModifications, parseUnityRef } = await import('./derived.ts');

const PREFIX = 'zz-pbk-';
const made: Array<{ type: string; slug: string }> = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vfx-pbk-'));
const b64 = (s: string) => Buffer.from(s).toString('base64');
const GUID = (n: number) => String(n).repeat(32).slice(0, 32);

after(async () => {
  for (const m of made) {
    await pool.query('DELETE FROM resource WHERE type = $1 AND slug = $2', [m.type, m.slug]).catch(() => undefined);
    fs.rmSync(path.join(config.dataDir, m.type, m.slug), { recursive: true, force: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  await pool.end().catch(() => undefined);
});

async function pub(args: Parameters<typeof store.publish>[0], viaPublic = false) {
  made.push({ type: args.type, slug: args.slug });
  return viaPublic ? store.publishPublic(args) : store.publish(args);
}

async function synty(): Promise<{ uri: string; license: string }> {
  const r = await pool.query<{ uri: string; license: string }>(`SELECT uri, license FROM resource WHERE type = 'recipe' AND license = 'synty-store-eula' ORDER BY slug LIMIT 1`);
  assert.ok(r.rows[0], 'need a Synty recipe in the corpus');
  return r.rows[0];
}

const MODS = [
  { op: 'remove-layer' as const, target: 'FX_LevelUp_Swirl_01' },
  { op: 'rescale' as const, target: 'root', from: 1, to: 0.16 },
];

test('derived.ts: modifications, unity ref and licence inheritance are validated', () => {
  assert.throws(() => parseModifications([]), /non-empty/);
  assert.throws(() => parseModifications([{ op: 'explode', target: 'x' }]), /not one of/);
  assert.throws(() => parseModifications([{ op: 'rescale' }]), /target is required/);
  assert.throws(() => parseModifications([{ op: 'other', target: 'x' }]), /needs a note/);
  assert.throws(() => parseModifications([{ op: 'rescale', target: 'x', to: {} }]), /string or a number/);
  assert.deepEqual(parseModifications([{ op: 'other', target: ' x ', note: 'n' }]), [{ op: 'other', target: 'x', note: 'n' }]);
  assert.throws(() => parseUnityRef({ path: '../x', guid: GUID(1) }), /under Assets/);
  assert.throws(() => parseUnityRef({ path: 'Assets/a/../../b', guid: GUID(1) }), /under Assets/);
  assert.throws(() => parseUnityRef({ path: 'Assets/a.prefab', guid: 'ABC' }), /32 lowercase hex/);
  assert.deepEqual(parseUnityRef({ path: 'Assets/a.prefab', guid: GUID(2) }), { path: 'Assets/a.prefab', guid: GUID(2) });

  const synty = [{ uri: 'vfx://recipe/a/1', license: 'synty-store-eula' }];
  const cc0 = [{ uri: 'vfx://texture/k/1', license: 'cc0' }];
  assert.equal(derivedLicenseProblem('synty-store-eula', synty), null);
  assert.match(derivedLicenseProblem('cc0', synty)!, /weaker/);
  assert.match(derivedLicenseProblem('asset-store-eula', synty)!, /re-label/);
  assert.equal(derivedLicenseProblem('cc0', cc0), null);
  assert.equal(derivedLicenseProblem('synty-store-eula', cc0), null); // stricter than the source is allowed
  assert.equal(derivedLicenseProblem('synty-store-eula', [...cc0, ...synty]), null); // composed: the strictest source wins
  assert.match(derivedLicenseProblem('cc0', [...cc0, ...synty])!, /weaker/);
  assert.match(derivedLicenseProblem('cc0', [{ uri: 'vfx://x/y/1', license: 'mystery' }])!, /weaker/); // unclassifiable never relaxes
});

test('publish refuses a bad derived record BEFORE writing anything', async () => {
  const src = await synty();
  const base = { type: 'recipe' as const, slug: `${PREFIX}refused`, name: 'refused', b64: b64('x: 1\n'), fileName: 'refused.yaml', derivedFrom: [src.uri], modifications: MODS };
  await assert.rejects(pub({ ...base, license: 'cc0' }), /weaker than the source licence/);
  await assert.rejects(pub({ ...base, license: 'asset-store-eula' }), /not the source licence/);
  await assert.rejects(pub({ ...base, license: src.license, derivedFrom: ['vfx://recipe/no-such-thing/1'] }), /derived_from not found/);
  await assert.rejects(pub({ ...base, license: src.license, derivedFrom: ['recipe/x'] }), /not a vfx:\/\/ URI/);
  await assert.rejects(pub({ ...base, license: src.license, modifications: [] }), /non-empty/);
  await assert.rejects(pub({ ...base, license: src.license, derivedFrom: undefined }), /need derived_from/);
  await assert.rejects(pub({ ...base, license: src.license, dependencies: ['vfx://vfx/never-published/1'] }), /dependencies not found/);
  await assert.rejects(pub({ ...base, license: src.license, unity: { path: 'Assets/x.prefab', guid: 'nope' } }), /32 lowercase hex/);
  const rows = await pool.query(`SELECT 1 FROM resource WHERE slug = $1`, [`${PREFIX}refused`]);
  assert.equal(rows.rowCount, 0);
  assert.ok(!fs.existsSync(path.join(config.dataDir, 'recipe', `${PREFIX}refused`)), 'no orphan payload file');

  // the public entry also demands the fields that make the record findable
  const ok = { ...base, license: src.license, category: 'buff', tags: ['levelup'] };
  await assert.rejects(pub(ok, true), /missing meta\.behavior/);
  await assert.rejects(pub({ ...ok, category: '', meta: { behavior: 'b' } }, true), /missing category/);
  await assert.rejects(pub({ ...ok, tags: [], meta: { behavior: 'b' } }, true), /missing tags/);
});

/** texture <- material <- prefab <- derived recipe. Returns the four uris. */
async function publishChain(sourceUri: string, license: string) {
  const tex = await pub({ type: 'texture', slug: `${PREFIX}tex`, name: 'pbk spark texture', license: 'cc0', b64: b64('PNGDATA'), fileName: 'pbk-spark.png', unity: { path: 'Assets/VFXCloud/texture/zz-pbk-tex/pbk-spark.png', guid: GUID(1) } });
  const mat = await pub({ type: 'vfx', slug: `${PREFIX}mat`, name: 'pbk spark material', license: 'cc0', b64: b64('Material: {}\n'), fileName: 'pbk-spark.mat', dependencies: [tex.uri], unity: { path: 'Assets/VFXCloud/vfx/zz-pbk-mat/pbk-spark.mat', guid: GUID(2) } });
  const prefab = await pub({ type: 'vfx', slug: `${PREFIX}prefab`, name: 'pbk level up prefab', license, b64: b64('%YAML 1.1\nPrefab: {}\n'), fileName: 'PbkLevelUp.prefab', dependencies: [mat.uri], unity: { path: 'Assets/VFXCloud/vfx/zz-pbk-prefab/PbkLevelUp.prefab', guid: GUID(3) }, derivedFrom: sourceUri });
  const recipe = await pub(
    {
      type: 'recipe',
      slug: `${PREFIX}recipe`,
      name: 'PBK level up without the ring',
      description: 'Level-up with the swirl layer removed, scaled for a small HUD slot',
      license,
      category: 'buff',
      tags: ['levelup', 'custom'],
      style: ['low-poly'],
      b64: b64('schema: vfx-extracted-recipe/1\nnotes: [derived]\n'),
      fileName: 'pbk-level-up.yaml',
      derivedFrom: [sourceUri],
      modifications: MODS,
      dependencies: [prefab.uri],
      meta: { behavior: 'A one-shot burst of orange power-up streaks rises and fades, without the outward ring.' },
    },
    true,
  );
  return { tex: tex.uri, mat: mat.uri, prefab: prefab.uri, recipe: recipe.uri };
}

test('derived recipe: provenance, modifications, derived_from edge, searchable, closure is whole and dependency-first', async () => {
  const src = await synty();
  const u = await publishChain(src.uri, src.license);

  const row = await store.getByUri(u.recipe);
  assert.equal(row.license, src.license);
  assert.equal(row.meta.license_class, 'proprietary-commercial');
  assert.equal(row.meta.ai_training, false);
  assert.deepEqual((row.meta.derived as any).from, [src.uri]);
  assert.deepEqual((row.meta.derived as any).modifications, MODS);
  const edges = await pool.query(`SELECT e.rel, d.uri FROM resource_edge e JOIN resource s ON s.id = e.src JOIN resource d ON d.id = e.dst WHERE s.uri = $1 ORDER BY e.rel`, [u.recipe]);
  assert.deepEqual(edges.rows, [{ rel: 'derived_from', uri: src.uri }, { rel: 'uses', uri: u.prefab }]);
  assert.deepEqual((await store.getByUri(u.prefab)).meta.unity, { path: 'Assets/VFXCloud/vfx/zz-pbk-prefab/PbkLevelUp.prefab', guid: GUID(3) });

  const found = await store.search({ query: 'PBK level up without the ring', type: 'recipe', limit: 10 });
  assert.ok(found.some((c) => c.uri === u.recipe), 'vfx_search finds the published recipe');

  const manifest = await store.resolve(u.recipe);
  assert.deepEqual(manifest.dependencies, [u.prefab]); // direct
  const closure = await store.closure(u.recipe);
  assert.deepEqual(closure.map((c) => c.uri), [u.tex, u.mat, u.prefab]); // transitive, deepest first, not itself, derived_from not followed
  assert.deepEqual(closure.map((c) => c.target_hint), [
    'Assets/VFXCloud/texture/zz-pbk-tex/zz-pbk-tex.png',
    'Assets/VFXCloud/vfx/zz-pbk-mat/zz-pbk-mat.mat',
    'Assets/VFXCloud/vfx/zz-pbk-prefab/zz-pbk-prefab.prefab',
  ]);
  assert.deepEqual(closure.map((c) => c.unity?.guid), [GUID(1), GUID(2), GUID(3)]);
  assert.ok(closure.every((c) => /^[0-9a-f]{64}$/.test(c.sha256)));
  assert.deepEqual(await store.closure(u.tex), []); // a leaf has an empty closure
  await assert.rejects(store.closure('vfx://recipe/nope-zz/1'), /Not found/);

  // a cycle (a dependency pointing back at its dependant) terminates and still lists each file once
  await pool.query(`INSERT INTO resource_edge (src, dst, rel) SELECT t.id, r.id, 'uses' FROM resource t, resource r WHERE t.uri = $1 AND r.uri = $2`, [u.tex, u.recipe]);
  assert.deepEqual((await store.closure(u.recipe)).map((c) => c.uri).sort(), [u.mat, u.prefab, u.tex].sort());
  await pool.query(`DELETE FROM resource_edge WHERE rel = 'uses' AND src = (SELECT id FROM resource WHERE uri = $1)`, [u.tex]);
});

test('vfx-fetch.sh fetches the whole closure (dependencies first); VFX_FETCH_DEPS=0 fetches only the file asked for', async () => {
  const uri = 'vfx://recipe/zz-pbk-recipe/1';
  assert.ok((await pool.query('SELECT 1 FROM resource WHERE uri = $1', [uri])).rowCount, 'previous test published it');
  const app = await buildHttp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  try {
    const script = path.join(config.repoRoot, 'scripts', 'vfx-fetch.sh');
    // ASYNC on purpose: the server under test lives in THIS process, so a blocking spawnSync would starve it of the event loop.
    const sh = (project: string, env: Record<string, string> = {}) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn('bash', [script, uri, project], { env: { PATH: process.env.PATH, VFX_SERVER: `http://127.0.0.1:${port}`, ...env } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });

    const whole = path.join(tmp, 'whole');
    const r = await sh(whole);
    assert.equal(r.status, 0, r.stderr);
    const wrote = [...r.stdout.matchAll(/^wrote (.+?) {2}/gm)].map((m) => path.relative(whole, m[1]));
    assert.deepEqual(wrote, [
      'Assets/VFXCloud/texture/zz-pbk-tex/zz-pbk-tex.png',
      'Assets/VFXCloud/vfx/zz-pbk-mat/zz-pbk-mat.mat',
      'Assets/VFXCloud/vfx/zz-pbk-prefab/zz-pbk-prefab.prefab',
      'Assets/VFXCloud/recipe/zz-pbk-recipe/zz-pbk-recipe.yaml',
    ]);
    for (const f of wrote) assert.ok(fs.existsSync(path.join(whole, f)), f);
    assert.ok(!fs.readdirSync(path.join(whole, 'Assets/VFXCloud/texture/zz-pbk-tex')).some((n) => n.endsWith('.meta')), 'never writes a .meta');

    const again = await sh(whole);
    assert.equal(again.status, 0, again.stderr);
    assert.equal((again.stdout.match(/^skip /gm) ?? []).length, 4, 'a second run changes nothing');

    const only = path.join(tmp, 'only');
    const o = await sh(only, { VFX_FETCH_DEPS: '0' });
    assert.equal(o.status, 0, o.stderr);
    assert.deepEqual(fs.readdirSync(path.join(only, 'Assets/VFXCloud')), ['recipe']);
  } finally {
    await app.close();
  }
});
