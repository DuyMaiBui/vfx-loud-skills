#!/usr/bin/env node
// vfx-fetch-bundle.mjs: install a whole `vfx-bundle/1` closure into a Unity project (plan.md C4, C6, C7).
// Dependency-free on purpose: copy this single file next to a game repo and it still works.
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SCHEMA = 'vfx-bundle/1';
const KINDS = new Set(['prefab', 'material', 'texture', 'shader', 'mesh', 'animation', 'controller', 'script', 'asmdef', 'audio', 'other']);
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const GUID_LINE = /^guid:\s*([0-9a-f]{32})/m;

export const HELP = `usage: vfx-fetch.sh <vfx://type/slug/version> [project_root]

Install the whole closure (shaders, textures, materials, meshes, prefab ...) of a vfx:// resource into a
Unity project with every .meta GUID preserved. project_root defaults to $VFX_PROJECT, then the cwd.
The last stdout line is a JSON summary: {"uri","variant","written","unchanged","reused","skipped","requires_missing","complete", ...}.

Environment:
  VFX_SERVER            server base URL (default http://127.0.0.1:8787)
  VFX_API_KEY           sent as the x-vfx-key header (blob and bundle routes always need it)
  VFX_VARIANT           urp (default) | original
  VFX_ON_CONFLICT       refuse (default) | skip | overwrite   (GUID or path collisions; never deletes)
  VFX_ROOT              re-root Assets/VFXCloud/<pack>/... to <VFX_ROOT>/...
  VFX_DRY_RUN=1         print the install plan, write nothing
  VFX_ALLOW_INCOMPLETE=1  install even when the bundle is complete:false
  VFX_STRICT_REQUIRES=1   exit 6 when a required UPM package is missing from Packages/manifest.json
  VFX_FETCH_LEGACY=1    old per-resource path (handled by vfx-fetch.sh)

Exit codes:
  0 ok   1 network/server/bundle/install error   2 usage   3 conflict refused
  4 sha256 mismatch   5 bundle incomplete   6 required package missing (strict)   7 .meta guid changed after the move`;

class Fail extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Replace ONLY the `Assets/VFXCloud/<pack>` prefix of target_path with root (plan.md C4). Pure. */
export function reroot(targetPath, root) {
  if (root == null) return targetPath;
  const r = String(root).replace(/\/+$/, '');
  if (r === '') return targetPath;
  const m = /^Assets\/VFXCloud\/[^/]+\/(.+)$/.exec(targetPath);
  return m ? `${r}/${m[1]}` : targetPath;
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function guidOfMeta(p) {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, 4096, 0);
      return GUID_LINE.exec(buf.toString('utf8', 0, n))?.[1] ?? null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function safeRel(p, what) {
  if (typeof p !== 'string' || p === '' || p.includes('\0') || p.includes('\\') || p.startsWith('/') || /^[A-Za-z]:/.test(p)
    || p.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new Fail(1, `unsafe ${what}: ${JSON.stringify(p)}`);
  return p;
}

function validate(b) {
  const bad = (m) => new Fail(1, `invalid bundle: ${m}`);
  if (!b || typeof b !== 'object') throw bad('not an object');
  if (b.schema !== SCHEMA) throw new Fail(1, `unsupported bundle schema ${JSON.stringify(b?.schema)} (this client accepts only ${SCHEMA})`);
  if (typeof b.uri !== 'string') throw bad('uri');
  if (typeof b.complete !== 'boolean') throw bad('complete');
  for (const k of ['files', 'requires', 'unresolved', 'cycles']) if (!Array.isArray(b[k])) throw bad(k);
  const seen = new Set();
  for (const f of b.files) {
    if (!f || typeof f !== 'object') throw bad('file entry');
    const id = f.target_path;
    if (!KINDS.has(f.kind)) throw bad(`kind of ${id}`);
    if (f.guid !== null && !HEX32.test(f.guid ?? '')) throw bad(`guid of ${id}`);
    if (!HEX64.test(f.sha256 ?? '')) throw bad(`sha256 of ${id}`);
    if (typeof f.download_url !== 'string' || !/^https?:\/\//.test(f.download_url)) throw bad(`download_url of ${id}`);
    if ((f.meta_sha256 === null) !== (f.meta_download_url === null)) throw bad(`meta fields of ${id}`);
    if (f.meta_sha256 !== null && (!HEX64.test(f.meta_sha256) || !/^https?:\/\//.test(f.meta_download_url))) throw bad(`meta of ${id}`);
    safeRel(f.target_path, 'target_path');
    if (seen.has(f.target_path)) throw bad(`duplicate target_path ${f.target_path}`);
    seen.add(f.target_path);
  }
  return b;
}

async function httpGet(url, key, timeoutMs) {
  let res;
  try {
    res = await fetch(url, { headers: { 'accept-encoding': 'gzip', ...(key ? { 'x-vfx-key': key } : {}) }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Fail(1, `cannot reach ${url}: ${e?.cause?.code ?? e?.message ?? e}`);
  }
  if (!res.ok) {
    let env = '';
    try { env = (await res.text()).slice(0, 500); } catch { /* ignore */ }
    const hint = res.status === 401 || res.status === 403 ? ' (set VFX_API_KEY to the studio key)' : '';
    throw new Fail(1, `${url} answered ${res.status}: ${env}${hint}`);
  }
  return res;
}

function buildIndex(project, roots) {
  const idx = new Map(); // guid -> [asset abs path]
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name.endsWith('~')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.meta')) {
        const g = guidOfMeta(p);
        if (g) (idx.get(g) ?? idx.set(g, []).get(g)).push(p.slice(0, -5));
      }
    }
  };
  for (const r of roots) walk(path.join(project, r));
  return idx;
}

/** C6 pre-flight over the whole bundle; nothing is written. */
function preflight(files, index, onConflict) {
  const plan = [];
  for (const f of files) {
    const it = { f, action: 'install', conflict: null, keepMeta: false, dst: f.abs, expectGuid: f.guid };
    const metaG = isFile(f.abs + '.meta') ? guidOfMeta(f.abs + '.meta') : null;
    const here = isFile(f.abs);
    const sameBytes = (p) => sha256File(p) === f.sha256;
    if (here || exists(f.abs + '.meta')) {
      if (here && (f.guid === null ? true : metaG === f.guid)) {
        if (sameBytes(f.abs)) it.action = 'unchanged';
        else it.conflict = { type: 'content_differs', detail: 'same path and guid, different bytes' };
        it.keepMeta = true;
      } else if (!here && f.guid !== null && metaG === f.guid) {
        // orphan .meta with the same guid: complete the pair
      } else if (here || (f.guid !== null && metaG !== f.guid && metaG !== null)) {
        it.conflict = { type: 'path_guid_mismatch', detail: `path holds guid ${metaG ?? 'none'} (bundle ${f.guid})` };
        it.keepMeta = metaG !== null;
        it.expectGuid = metaG ?? f.guid;
      }
    } else if (f.guid !== null) {
      const home = (index.get(f.guid) ?? []).find((h) => h !== f.abs);
      if (home) {
        if (isFile(home) && sameBytes(home)) it.action = 'reused';
        else { it.conflict = { type: 'guid_elsewhere', detail: `guid already at ${home}` }; it.home = home; }
      }
    }
    if (it.conflict) {
      if (onConflict === 'skip') it.action = 'skip';
      else if (onConflict === 'overwrite') {
        if (it.conflict.type === 'guid_elsewhere') {
          if (isFile(it.home)) { it.action = 'overwrite'; it.dst = it.home; it.keepMeta = true; it.expectGuid = f.guid; } else it.action = 'skip';
        } else it.action = 'overwrite';
      } else it.action = 'conflict';
    }
    plan.push(it);
  }
  return plan;
}

async function download(blobs, tmp, key, concurrency = 4) {
  const queue = [...blobs.entries()];
  let failure = null;
  const worker = async () => {
    while (!failure) {
      const next = queue.shift();
      if (!next) return;
      const [sha, { url, what }] = next;
      try {
        const res = await httpGet(url, key, 600_000);
        const h = createHash('sha256');
        const out = fs.createWriteStream(path.join(tmp, sha));
        for await (const chunk of Readable.fromWeb(res.body)) { h.update(chunk); if (!out.write(chunk)) await once(out, 'drain'); }
        out.end(); await once(out, 'finish');
        const actual = h.digest('hex');
        if (actual !== sha) throw new Fail(4, `sha256 mismatch for ${what}: expected ${sha}, got ${actual}`);
      } catch (e) {
        failure ??= e instanceof Fail ? e : new Fail(1, `download failed for ${what}: ${e?.message ?? e}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) || 1 }, worker));
  if (failure) throw failure;
}

class Mover {
  constructor(tmp, journalPath, uri) {
    this.tmp = tmp; this.journalPath = journalPath; this.entries = []; this.dirs = []; this.n = 0;
    this.journal = { version: 1, uri, startedAt: new Date().toISOString(), entries: this.entries, dirs: this.dirs };
  }
  save() { fs.writeFileSync(this.journalPath, JSON.stringify(this.journal)); }
  mkdirs(dir) {
    const missing = [];
    for (let d = dir; !exists(d); d = path.dirname(d)) missing.push(d);
    for (const d of missing.reverse()) { fs.mkdirSync(d); this.dirs.push(d); }
  }
  place(sha, dst, consume) {
    this.mkdirs(path.dirname(dst));
    const src = path.join(this.tmp, sha);
    const hidden = path.join(path.dirname(dst), `.${path.basename(dst)}.vfx-${randomBytes(4).toString('hex')}`);
    if (isFile(dst)) {
      const backup = path.join(this.tmp, `backup-${this.n++}`);
      fs.copyFileSync(dst, backup);
      this.entries.push({ path: dst, action: 'replaced', backup });
    } else this.entries.push({ path: dst, action: 'created' });
    if (this.entries.length % 25 === 0) this.save();
    try {
      if (consume) {
        try { fs.renameSync(src, hidden); } catch (e) { if (e.code !== 'EXDEV') throw e; fs.copyFileSync(src, hidden); }
      } else fs.copyFileSync(src, hidden);
      fs.renameSync(hidden, dst);
    } catch (e) { try { fs.unlinkSync(hidden); } catch { /* none */ } throw e; }
  }
  undo() {
    let ok = true;
    for (const e of [...this.entries].reverse()) {
      try {
        if (e.action === 'created') { try { fs.unlinkSync(e.path); } catch (x) { if (x.code !== 'ENOENT' && x.code !== 'ENOTDIR') throw x; } }
        else { const h = `${e.path}.vfx-undo`; fs.copyFileSync(e.backup, h); fs.renameSync(h, e.path); }
      } catch { ok = false; }
    }
    for (const d of [...this.dirs].reverse()) { try { fs.rmdirSync(d); } catch { /* not empty or gone */ } }
    return ok;
  }
}

function missingPackages(project, requires) {
  const pkgs = [...new Set(requires.filter((r) => r.kind === 'package' && r.package).map((r) => r.package))];
  if (!pkgs.length) return [];
  let deps = {};
  try { deps = JSON.parse(fs.readFileSync(path.join(project, 'Packages', 'manifest.json'), 'utf8')).dependencies ?? {}; } catch { /* absent manifest: all missing */ }
  return pkgs.filter((p) => !(p in deps));
}

export async function run(argv, env, out = console.log, err = (m) => console.error(m)) {
  const summary = { uri: null, variant: null, written: 0, unchanged: 0, reused: 0, skipped: 0, requires_missing: [], complete: null };
  let tmp = null; let createdTemp = false; let tempDir = null; let journalPath = null;
  try {
    if (argv[0] === '--help' || argv[0] === '-h') { out(HELP); return 0; }
    const uri = argv[0];
    summary.uri = uri ?? null;
    const m = /^vfx:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri ?? '');
    if (!m) throw new Fail(2, 'usage: vfx-fetch.sh vfx://<type>/<slug>/<version> [project_root] (see --help)');
    const variant = env.VFX_VARIANT || 'urp';
    const onConflict = env.VFX_ON_CONFLICT || 'refuse';
    if (!['urp', 'original'].includes(variant)) throw new Fail(2, `VFX_VARIANT must be urp|original (got ${variant})`);
    if (!['refuse', 'skip', 'overwrite'].includes(onConflict)) throw new Fail(2, `VFX_ON_CONFLICT must be refuse|skip|overwrite (got ${onConflict})`);
    summary.variant = variant;
    const project = path.resolve(argv[1] || env.VFX_PROJECT || process.cwd());
    if (!fs.existsSync(path.join(project, 'Assets'))) throw new Fail(2, `${project} has no Assets/ folder (not a Unity project root)`);
    const root = env.VFX_ROOT ? env.VFX_ROOT.replace(/\\/g, '/') : '';
    if (root) safeRel(root.replace(/\/+$/, ''), 'VFX_ROOT');
    const server = (env.VFX_SERVER || 'http://127.0.0.1:8787').replace(/\/+$/, '');
    const key = env.VFX_API_KEY || '';

    const res = await httpGet(`${server}/v1/closure/${m[1]}/${m[2]}/${m[3]}?variant=${variant}`, key, 120_000);
    let bundle;
    try { bundle = await res.json(); } catch { throw new Fail(1, 'closure response is not JSON'); }
    validate(bundle);
    summary.variant = bundle.variant ?? variant;
    summary.complete = bundle.complete;

    if (!bundle.complete) {
      const why = `bundle is incomplete: ${bundle.reason ?? 'unresolved references'} (${bundle.unresolved.map((u) => u.guid).join(', ')})`;
      if (env.VFX_ALLOW_INCOMPLETE !== '1') throw new Fail(5, `${why}; set VFX_ALLOW_INCOMPLETE=1 to install anyway`);
      err(`warning: ${why}`);
    }
    summary.requires_missing = missingPackages(project, bundle.requires);
    if (summary.requires_missing.length) {
      const msg = `required package(s) missing from Packages/manifest.json: ${summary.requires_missing.join(', ')}`;
      if (env.VFX_STRICT_REQUIRES === '1') throw new Fail(6, msg);
      err(`warning: ${msg}`);
    }
    if (exists(path.join(project, 'Temp', 'UnityLockfile'))) err('warning: Temp/UnityLockfile exists, an open Unity Editor can import between the .meta and asset renames; the .meta guids are re-checked after the move');

    const files = bundle.files.map((f) => ({ ...f, abs: path.join(project, ...reroot(f.target_path, root).split('/')) }));
    for (const f of files) if (path.relative(project, f.abs).startsWith('..')) throw new Fail(1, `target escapes the project: ${f.target_path}`);
    const tops = new Set(files.map((f) => path.relative(project, f.abs).split(path.sep)[0]));
    tops.add('Assets');
    const plan = preflight(files, buildIndex(project, tops), onConflict);

    const rel = (p) => path.relative(project, p).split(path.sep).join('/');
    const conflicts = plan.filter((p) => p.conflict);
    for (const p of plan) out(`plan ${p.action} ${rel(p.dst)}${p.conflict ? `  [${p.conflict.type}: ${p.conflict.detail}]` : ''}`);
    if (onConflict === 'refuse' && conflicts.length) throw new Fail(3, `${conflicts.length} conflict(s), nothing written (VFX_ON_CONFLICT=skip|overwrite to proceed)`);
    for (const p of plan) {
      if (p.action === 'unchanged') summary.unchanged++;
      else if (p.action === 'reused') summary.reused++;
      else if (p.action === 'skip') summary.skipped++;
    }
    const work = plan.filter((p) => p.action === 'install' || p.action === 'overwrite');
    if (env.VFX_DRY_RUN === '1') {
      summary.dry_run = true; summary.would_write = work.length;
      out(JSON.stringify({ ...summary, ok: true, exit_code: 0 }));
      return 0;
    }

    if (work.length) {
      // Verify phase: every blob into Temp/vfx-cloud-<rand>/, hashed, before anything touches Assets/.
      tempDir = path.join(project, 'Temp');
      createdTemp = !exists(tempDir);
      tmp = path.join(tempDir, `vfx-cloud-${randomBytes(4).toString('hex')}`);
      journalPath = path.join(tempDir, 'vfx-cloud-journal.json');
      fs.mkdirSync(tmp, { recursive: true });
      const blobs = new Map(); const uses = new Map();
      const need = (sha, url, what) => { if (!blobs.has(sha)) blobs.set(sha, { url, what }); uses.set(sha, (uses.get(sha) ?? 0) + 1); };
      const ops = [];
      for (const p of work) {
        if (!p.keepMeta && p.f.meta_sha256) { need(p.f.meta_sha256, p.f.meta_download_url, `${p.f.target_path}.meta`); ops.push({ sha: p.f.meta_sha256, dst: p.dst + '.meta', p, meta: true }); }
        need(p.f.sha256, p.f.download_url, p.f.target_path); ops.push({ sha: p.f.sha256, dst: p.dst, p });
      }
      await download(blobs, tmp, key);
      for (const o of ops) if (o.meta && guidOfMeta(path.join(tmp, o.sha)) !== o.p.f.guid) throw new Fail(4, `${o.p.f.target_path}.meta does not carry guid ${o.p.f.guid}`);

      // Move phase, journaled: .meta first, then the asset, dependencies first.
      const mover = new Mover(tmp, journalPath, uri);
      try {
        for (const o of ops) {
          const left = uses.get(o.sha) - 1; uses.set(o.sha, left);
          mover.place(o.sha, o.dst, left === 0);
          out(`${o.meta ? 'meta' : 'file'} ${rel(o.dst)}`);
        }
        mover.save();
      } catch (e) {
        const undone = mover.undo();
        if (undone) fs.rmSync(journalPath, { force: true }); else mover.save();
        throw new Fail(1, `install failed (${e?.message ?? e}); ${undone ? 'rolled back' : `rollback incomplete, see ${journalPath}`}`);
      }
      summary.written = work.length;

      if (env.VFX_FETCH_HOOK_AFTER_MOVE) execFileSync(process.execPath, [env.VFX_FETCH_HOOK_AFTER_MOVE, project], { stdio: 'inherit' }); // test seam: simulates the Editor race
      const changed = [];
      for (const p of work) {
        const mp = p.dst + '.meta';
        if (p.f.guid === null || !isFile(mp)) continue;
        const g = guidOfMeta(mp);
        if (g !== p.expectGuid) changed.push(`${rel(mp)} (${g ?? 'none'} != ${p.expectGuid})`);
      }
      if (changed.length) throw new Fail(7, `guid_changed after the move: ${changed.join('; ')}`);
      fs.rmSync(journalPath, { force: true });
    }
    out(JSON.stringify({ ...summary, ok: true, exit_code: 0 }));
    return 0;
  } catch (e) {
    const code = e instanceof Fail ? e.code : 1;
    err(`vfx-fetch: ${e?.message ?? e}`);
    out(JSON.stringify({ ...summary, ok: false, exit_code: code, error: String(e?.message ?? e) }));
    return code;
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    if (createdTemp && tempDir && !(journalPath && exists(journalPath))) { try { fs.rmdirSync(tempDir); } catch { /* not empty */ } }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
