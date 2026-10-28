// Tests for scripts/vfx-fetch-bundle.mjs against a stub HTTP server and a temp project dir (never the real server).
// Run: node scripts/vfx-fetch-bundle.test.mjs   (VFX_FETCH_CLIENT=<path> points the suite at a mutated copy for RED proofs)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const CLIENT = process.env.VFX_FETCH_CLIENT || path.join(here, 'vfx-fetch-bundle.mjs');
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(repo, 'server/src/test-fixtures', n), 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const KEY = 'test-key';

let server; let base; let blobs; let bundle; let mode; let hits;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vfx-fetch-test-'));

/** Fixture bundle with real bytes: every file gets generated content and a .meta carrying its guid. */
function makeBundle() {
  const b = fixture('bundle-sample.json');
  blobs = new Map();
  const put = (buf) => { const h = sha(buf); blobs.set(h, buf); return h; };
  for (const f of b.files) {
    const body = Buffer.from(`asset ${f.guid} ${f.kind}\n`.repeat(8));
    const meta = Buffer.from(`fileFormatVersion: 2\nguid: ${f.guid}\n`);
    f.sha256 = put(body); f.bytes = body.length;
    f.meta_sha256 = put(meta); f.meta_bytes = meta.length;
    f.download_url = `${base}/v1/blob/${f.sha256}`;
    f.meta_download_url = `${base}/v1/blob/${f.meta_sha256}`;
  }
  b.file_count = b.files.length;
  return b;
}

before(async () => {
  server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const u = new URL(req.url, base);
    const keyed = u.pathname.startsWith('/v1/closure/') || u.pathname.startsWith('/v1/blob/');
    if (keyed && req.headers['x-vfx-key'] !== KEY) return json(403, { error: 'api key required', code: 'forbidden' });
    if (u.pathname.startsWith('/v1/closure/')) return u.pathname === '/v1/closure/recipe/archanor-boom/1' ? json(200, bundle) : json(404, { error: 'unknown record', code: 'not_found' });
    const m = /^\/v1\/blob\/([0-9a-f]{64})$/.exec(u.pathname);
    if (m && blobs.has(m[1])) {
      let body = blobs.get(m[1]);
      if (mode.corrupt === m[1]) body = Buffer.concat([body, Buffer.from('X')]);
      if (mode.gzip) { res.writeHead(200, { 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(body)); }
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(body);
    }
    if (u.pathname === '/v1/resource/texture/smoke-01/1') return json(200, { file_name: 'smoke.png', sha256: sha('smoke'), bytes: 5, download_url: `${base}/legacy/smoke.png`, license: 'cc0', dependencies: [] });
    if (u.pathname === '/legacy/smoke.png') { res.writeHead(200); return res.end('smoke'); }
    return json(404, { error: 'not found', code: 'not_found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

let seq = 0;
function freshProject() {
  const p = path.join(tmpRoot, `proj${seq++}`);
  fs.mkdirSync(path.join(p, 'Assets'), { recursive: true });
  fs.mkdirSync(path.join(p, 'Packages'));
  fs.writeFileSync(path.join(p, 'Packages/manifest.json'), JSON.stringify({ dependencies: { 'com.unity.render-pipelines.universal': '17.0.0' } }));
  return p;
}
function treeHash(dir) {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      h.update(`${path.relative(dir, p)}${e.isDirectory() ? '/' : ''}\n`);
      if (e.isDirectory()) walk(p); else h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}
function fetchClient(project, env = {}, args = ['vfx://recipe/archanor-boom/1']) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLIENT, ...args, project], { env: { ...process.env, VFX_SERVER: base, VFX_API_KEY: KEY, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      const lines = stdout.trim().split('\n');
      let summary = null; try { summary = JSON.parse(lines.at(-1)); } catch { /* not json */ }
      resolve({ code, stdout, stderr, lines, summary });
    });
  });
}
const target = (f) => f.target_path.split('/');
const reset = () => { bundle = makeBundle(); mode = {}; hits = []; };

test('reroot matches the shared fixture', async () => {
  const { reroot } = await import(pathToFileURL(CLIENT).href);
  for (const c of fixture('reroot-cases.json')) assert.equal(reroot(c.target_path, c.root), c.expected, JSON.stringify(c));
});

test('happy path: N pairs, .meta byte-exact and first, dependencies first, JSON summary last', async () => {
  reset();
  const p = freshProject();
  const r = await fetchClient(p);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual({ ...r.summary }, { uri: 'vfx://recipe/archanor-boom/1', variant: 'urp', written: 5, unchanged: 0, reused: 0, skipped: 0, requires_missing: [], dangling: 0, complete: true, ok: true, exit_code: 0 });
  const installed = r.lines.filter((l) => /^(meta|file) /.test(l));
  const expected = bundle.files.flatMap((f) => [`meta ${f.target_path}.meta`, `file ${f.target_path}`]);
  assert.deepEqual(installed, expected);
  for (const f of bundle.files) {
    assert.equal(sha(fs.readFileSync(path.join(p, ...target(f)))), f.sha256);
    assert.equal(fs.readFileSync(path.join(p, ...target(f)) + '.meta', 'utf8'), `fileFormatVersion: 2\nguid: ${f.guid}\n`);
  }
  assert.deepEqual(fs.readdirSync(p).sort(), ['Assets', 'Packages'], 'Temp scratch dir is cleaned up');
  assert.ok(hits.every((h) => !h.includes('/v1/resource/')), 'new path never uses the legacy route');
});

test('second run reports unchanged and writes nothing', async () => {
  reset();
  const p = freshProject();
  assert.equal((await fetchClient(p)).code, 0);
  const before = treeHash(p);
  const r = await fetchClient(p);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.summary.unchanged, 5); assert.equal(r.summary.written, 0);
  assert.equal(treeHash(p), before);
});

test('gzip and identity responses both verify', async () => {
  reset(); mode = { gzip: true };
  const p = freshProject();
  const r = await fetchClient(p);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.summary.written, 5);
});

test('GUID collision with different bytes: exit 3, tree untouched', async () => {
  reset();
  const p = freshProject();
  const f = bundle.files[1];
  const other = path.join(p, 'Assets/Elsewhere/tex.png');
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, 'different bytes'); fs.writeFileSync(other + '.meta', `fileFormatVersion: 2\nguid: ${f.guid}\n`);
  const before = treeHash(p);
  const r = await fetchClient(p);
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stderr, /conflict/);
  assert.equal(treeHash(p), before, 'nothing written, not even Temp');
  assert.equal(hits.filter((h) => h.includes('/v1/blob/')).length, 0, 'conflict is seen before any download');
});

test('path held by another guid: exit 3; skip installs the rest; overwrite keeps the existing .meta', async () => {
  reset();
  const f = bundle.files[0];
  const plant = (p) => {
    const t = path.join(p, ...target(f));
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, 'squatter'); fs.writeFileSync(t + '.meta', 'fileFormatVersion: 2\nguid: ffffffffffffffffffffffffffffffff\n');
    return t;
  };
  let p = freshProject(); plant(p);
  const before = treeHash(p);
  assert.equal((await fetchClient(p)).code, 3);
  assert.equal(treeHash(p), before);

  p = freshProject(); let t = plant(p);
  let r = await fetchClient(p, { VFX_ON_CONFLICT: 'skip' });
  assert.equal(r.code, 0, r.stderr); assert.equal(r.summary.skipped, 1); assert.equal(r.summary.written, 4);
  assert.equal(fs.readFileSync(t, 'utf8'), 'squatter');

  p = freshProject(); t = plant(p);
  r = await fetchClient(p, { VFX_ON_CONFLICT: 'overwrite' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sha(fs.readFileSync(t)), f.sha256);
  assert.match(fs.readFileSync(t + '.meta', 'utf8'), /ffffffffffffffffffffffffffffffff/, 'existing .meta kept');
});

test('same guid already installed elsewhere with same bytes is reused, not rewritten', async () => {
  reset();
  const p = freshProject();
  const f = bundle.files[1];
  const other = path.join(p, 'Assets/Elsewhere/tex.png');
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, blobs.get(f.sha256)); fs.writeFileSync(other + '.meta', `fileFormatVersion: 2\nguid: ${f.guid}\n`);
  const r = await fetchClient(p);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.summary.reused, 1); assert.equal(r.summary.written, 4);
  assert.equal(fs.existsSync(path.join(p, ...target(f))), false);
});

test('corrupt blob: exit 4 and the project is byte-identical', async () => {
  reset();
  const p = freshProject();
  mode = { corrupt: bundle.files[2].sha256 };
  const before = treeHash(p);
  const r = await fetchClient(p);
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /sha256 mismatch/);
  assert.equal(treeHash(p), before);
});

test('complete:false exits 5 unless VFX_ALLOW_INCOMPLETE=1', async () => {
  reset();
  bundle.complete = false; bundle.reason = 'unresolved references'; bundle.unresolved = [{ guid: 'a'.repeat(32), referenced_by: [] }];
  const p = freshProject();
  const before = treeHash(p);
  const r = await fetchClient(p);
  assert.equal(r.code, 5, r.stderr);
  assert.equal(treeHash(p), before);
  const ok = await fetchClient(p, { VFX_ALLOW_INCOMPLETE: '1' });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.summary.complete, false);
});

test('dangling GUIDs install normally (complete stays true, exit 0): the summary counts them and stderr warns with the referencing file', async () => {
  reset();
  const ghost = 'd'.repeat(32);
  bundle.dangling = [{ guid: ghost, referenced_by: [bundle.files[2].guid] }];
  const p = freshProject();
  const r = await fetchClient(p);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.summary.complete, true);
  assert.equal(r.summary.dangling, 1);
  assert.match(r.stderr, new RegExp(`warning: 1 dangling GUID.*${ghost}.*${bundle.files[2].target_path.split('/').pop()}`));
});

test('a bundle from an older server without a dangling key still installs and reports dangling 0', async () => {
  reset();
  delete bundle.dangling;
  const p = freshProject();
  const r = await fetchClient(p);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.summary.dangling, 0);
  assert.doesNotMatch(r.stderr, /dangling/);
});

test('a malformed dangling entry is an invalid bundle (exit 1)', async () => {
  reset();
  bundle.dangling = [{ guid: 'nope', referenced_by: [] }];
  const r = await fetchClient(freshProject());
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /invalid bundle: dangling/);
});

test('a .meta guid rewritten after the move (Editor race) exits 7 and names the file', async () => {
  reset();
  const p = freshProject();
  const hook = path.join(tmpRoot, 'editor-race.mjs');
  const victim = path.join(...target(bundle.files[2])) + '.meta';
  fs.writeFileSync(hook, `import fs from 'node:fs'; import path from 'node:path';
const f = path.join(process.argv[2], ${JSON.stringify(victim)}); fs.writeFileSync(f, 'fileFormatVersion: 2\\nguid: 99999999999999999999999999999999\\n');`);
  const r = await fetchClient(p, { VFX_FETCH_HOOK_AFTER_MOVE: hook });
  assert.equal(r.code, 7, r.stderr);
  assert.match(r.stderr, /guid_changed/);
  assert.match(r.stderr, /Fire\.mat\.meta/);
});

test('VFX_ROOT re-roots the pack folder; dry run writes nothing', async () => {
  reset();
  const p = freshProject();
  const dry = await fetchClient(p, { VFX_ROOT: 'Assets/Game/VFX', VFX_DRY_RUN: '1' });
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(dry.summary.dry_run, true); assert.equal(dry.summary.would_write, 5);
  assert.deepEqual(fs.readdirSync(p).sort(), ['Assets', 'Packages']);
  assert.deepEqual(fs.readdirSync(path.join(p, 'Assets')), []);
  const r = await fetchClient(p, { VFX_ROOT: 'Assets/Game/VFX' });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(p, 'Assets/Game/VFX/Archanor VFX/Prefabs/Boom.prefab')));
  assert.ok(fs.existsSync(path.join(p, 'Assets/Game/VFX/Archanor VFX/Prefabs/Boom.prefab.meta')));
});

test('missing key: exit 1 with the 403 envelope shown', async () => {
  reset();
  const p = freshProject();
  const r = await fetchClient(p, { VFX_API_KEY: '' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /403/);
  assert.match(r.stderr, /"code":"forbidden"/);
  assert.match(r.stderr, /VFX_API_KEY/);
});

test('unknown schema and unknown record exit 1', async () => {
  reset(); bundle.schema = 'vfx-bundle/2';
  const p = freshProject();
  let r = await fetchClient(p);
  assert.equal(r.code, 1); assert.match(r.stderr, /schema/);
  reset();
  r = await fetchClient(p, {}, ['vfx://recipe/nope/1']);
  assert.equal(r.code, 1); assert.match(r.stderr, /404/);
});

test('required package missing: warning, or exit 6 with VFX_STRICT_REQUIRES=1', async () => {
  reset();
  const p = freshProject();
  fs.writeFileSync(path.join(p, 'Packages/manifest.json'), JSON.stringify({ dependencies: {} }));
  const strict = await fetchClient(p, { VFX_STRICT_REQUIRES: '1' });
  assert.equal(strict.code, 6, strict.stderr);
  assert.equal(fs.readdirSync(path.join(p, 'Assets')).length, 0);
  const lax = await fetchClient(p);
  assert.equal(lax.code, 0, lax.stderr);
  assert.deepEqual(lax.summary.requires_missing, ['com.unity.render-pipelines.universal']);
  assert.match(lax.stderr, /warning: required package/);
});

test('move failure rolls the journal back to a byte-identical tree', async () => {
  reset();
  const p = freshProject();
  // A regular file where the Textures directory must go: the shader lands, then the texture move fails.
  const blocker = path.join(p, ...target(bundle.files[1])).replace(/\/[^/]+$/, '');
  fs.mkdirSync(path.dirname(blocker), { recursive: true }); fs.writeFileSync(blocker, 'i am a file');
  const before = treeHash(p);
  const r = await fetchClient(p);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /rolled back/);
  assert.equal(treeHash(p), before);
});

test('a target_path that climbs out of the project is rejected before anything is written', async () => {
  reset(); bundle.files[0].target_path = 'Assets/VFXCloud/retro-arsenal/../../../evil.cs';
  const p = freshProject();
  const before = treeHash(p);
  const r = await fetchClient(p);
  assert.equal(r.code, 1); assert.match(r.stderr, /unsafe target_path/);
  assert.equal(treeHash(p), before);
});

test('origin:resource files (no guid, no .meta) install without a .meta', async () => {
  reset();
  const body = Buffer.from('legacy prefab');
  blobs.set(sha(body), body);
  bundle.files.push({ guid: null, origin: 'resource', kind: 'prefab', variant: 'original', urp_converted: false, urp_rule: null, path: 'Assets/x.prefab', target_path: 'Assets/VFXCloud/legacy/x.prefab', pack: 'legacy', license: 'cc0', sha256: sha(body), bytes: body.length, download_url: `${base}/v1/blob/${sha(body)}`, meta_sha256: null, meta_bytes: 0, meta_download_url: null });
  const p = freshProject();
  const r = await fetchClient(p);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(p, 'Assets/VFXCloud/legacy/x.prefab'), 'utf8'), 'legacy prefab');
  assert.equal(fs.existsSync(path.join(p, 'Assets/VFXCloud/legacy/x.prefab.meta')), false);
});

test('vfx-fetch.sh: usage errors, --help, and VFX_FETCH_LEGACY=1 keeps the old per-resource path', async () => {
  reset();
  const sh = path.join(here, 'vfx-fetch.sh');
  const env = { ...process.env, VFX_SERVER: base, VFX_API_KEY: KEY };
  assert.equal(spawnSync('bash', [sh], { env }).status, 2);
  assert.equal(spawnSync('bash', [sh, 'http://x/y/z'], { env }).status, 2);
  const help = spawnSync('bash', [sh, '--help'], { env });
  assert.equal(help.status, 0);
  for (const w of ['VFX_SERVER', 'VFX_API_KEY', 'VFX_VARIANT', 'VFX_ON_CONFLICT', 'VFX_ROOT', 'VFX_DRY_RUN', 'VFX_FETCH_LEGACY', '0 ok', '7 .meta guid changed']) assert.ok(help.stdout.toString().includes(w), w);
  const p = freshProject();
  const legacy = await new Promise((resolve) => {
    const c = spawn('bash', [sh, 'vfx://texture/smoke-01/1', p], { env: { ...env, VFX_FETCH_LEGACY: '1' } });
    c.on('close', resolve);
  });
  assert.equal(legacy, 0);
  assert.equal(fs.readFileSync(path.join(p, 'Assets/VFXCloud/texture/smoke-01/smoke.png'), 'utf8'), 'smoke');
  assert.ok(hits.some((h) => h.includes('/v1/resource/texture/smoke-01/1')));
});
