/**
 * Bulk uploader core (plan.md phase 3): collect the closure, write the plan, upload missing blobs, register
 * `asset_file` rows. Idempotent by sha256; safe to re-run. The CLI wrapper is `seed/upload-blobs.ts`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { blobLicenseProblem } from '../../server/src/license.ts';
import type { AssetFileInput, Kind } from '../../server/src/bundle-contract.ts';
import type { PackageEntry } from '../../server/src/unity-refs.ts';
import type { SourceFile } from '../extract/source.ts';
import { createClient, ServerUnavailableError, type VfxClient } from './client.ts';
import { collectClosure, sha256, type Closure, type FileRecord, type PackSource, type Root } from './collect.ts';
import { loadUrpExport } from './urp.ts';

export const MISSING_BATCH = 1000;
export const REGISTER_BATCH = 200;
export const DEFAULT_CONCURRENCY = 8;

interface BlobRef {
  bytes: number;
  hint: string | undefined;
}

interface Item {
  input: AssetFileInput;
  assetSha: string;
  metaSha: string | null;
}

export interface Failure {
  guid?: string;
  sha256?: string;
  stage: 'license' | 'read' | 'put' | 'register';
  message: string;
}

export interface UploadOptions {
  sources: PackSource[];
  roots: Root[];
  packageGuids: Map<string, PackageEntry>;
  server: string;
  apiKey?: string;
  outDir: string;
  yes: boolean;
  limit?: number;
  skipKinds?: Set<Kind>;
  /** Restrict roots to those whose recorded pack is this one. */
  pack?: string;
  resume?: boolean;
  variant?: 'original' | 'urp';
  urpDir?: string;
  concurrency?: number;
  retryBackoffMs?: number;
  log?: (line: string) => void;
}

export interface Summary {
  mode: 'dry-run' | 'upload';
  variant: 'original' | 'urp';
  files: number;
  files_in_closure: number;
  blobs: number;
  bytes: number;
  by_kind: Record<string, { files: number; bytes: number }>;
  by_pack: Record<string, { files: number; bytes: number }>;
  requires: number;
  unresolved: number;
  skipped: number;
  roots_missing: number;
  copies_differing: number;
  urp_rejected: number;
  blobs_missing?: number;
  blobs_uploaded?: number;
  bytes_uploaded?: number;
  created?: number;
  unchanged?: number;
  replaced?: number;
  rejected?: number;
  failed: number;
  failures: Failure[];
  avg_put_ms?: number;
  eta_full_s?: number;
  ms: number;
}

interface State {
  version: 1;
  uploaded: string[];
  registered: string[];
}

const keyOf = (i: Item): string => `${i.input.guid}|${i.input.variant}|${i.assetSha}|${i.metaSha ?? ''}`;

function toItem(r: FileRecord): Item {
  const input: AssetFileInput = {
    guid: r.guid,
    variant: 'original',
    kind: r.kind,
    path: r.path,
    asset_sha256: r.assetSha,
    meta_sha256: r.metaSha,
    pack: r.pack,
    license: r.license,
    visibility: r.visibility as AssetFileInput['visibility'],
    source: { game: r.game, origin: r.origin, ...(r.copies.length ? { copies: r.copies } : {}) },
  };
  return { input, assetSha: r.assetSha, metaSha: r.metaSha };
}

function tally(files: Array<{ kind: string; pack: string; bytes: number }>): Pick<Summary, 'by_kind' | 'by_pack'> {
  const by_kind: Summary['by_kind'] = {};
  const by_pack: Summary['by_pack'] = {};
  for (const f of files) {
    for (const [m, k] of [[by_kind, f.kind], [by_pack, f.pack]] as const) {
      const e = (m[k] ??= { files: 0, bytes: 0 });
      e.files += 1;
      e.bytes += f.bytes;
    }
  }
  return { by_kind, by_pack };
}

/** Human table of the plan: files / bytes by kind and by pack. */
export function formatPlan(s: Summary): string {
  const rows = (title: string, m: Summary['by_kind']): string[] => [
    title,
    ...Object.entries(m)
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([k, v]) => `  ${k.padEnd(28)} ${String(v.files).padStart(7)} files ${String(v.bytes).padStart(13)} bytes`),
  ];
  return [
    ...rows('by kind', s.by_kind),
    ...rows('by pack', s.by_pack),
    `files ${s.files} (closure ${s.files_in_closure}) blobs ${s.blobs} bytes ${s.bytes}`,
    `requires ${s.requires} unresolved ${s.unresolved} skipped ${s.skipped} roots-missing ${s.roots_missing} differing-copies ${s.copies_differing}`,
  ].join('\n');
}

async function loadState(file: string, resume: boolean): Promise<State> {
  const empty: State = { version: 1, uploaded: [], registered: [] };
  if (!resume) return empty;
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as State;
  } catch {
    return empty;
  }
}

type Supply = (needed: Set<string>) => AsyncGenerator<{ sha: string; data: Buffer }>;

interface PutStats {
  missing: number;
  uploaded: number;
  bytes: number;
  putMs: number;
}

/** Uploads every blob of `blobs` the server lacks; failures are collected, a dead server throws. */
async function uploadMissing(
  client: VfxClient,
  blobs: Map<string, BlobRef>,
  supply: Supply,
  state: State,
  concurrency: number,
  failures: Failure[],
  log: (l: string) => void,
): Promise<{ stats: PutStats; failedShas: Set<string> }> {
  const stats: PutStats = { missing: 0, uploaded: 0, bytes: 0, putMs: 0 };
  const failedShas = new Set<string>();
  const known = new Set(state.uploaded);
  const candidates = [...blobs.keys()].filter((s) => !known.has(s));
  const needed = new Set<string>();
  for (let i = 0; i < candidates.length; i += MISSING_BATCH) {
    for (const s of await client.missing(candidates.slice(i, i + MISSING_BATCH))) needed.add(s);
  }
  stats.missing = needed.size;
  for (const s of candidates) if (!needed.has(s)) state.uploaded.push(s); // already on the server
  if (!needed.size) return { stats, failedShas };

  const inflight = new Set<Promise<void>>();
  let fatal: Error | null = null;
  const done = new Set<string>();
  const schedule = async (fn: () => Promise<void>): Promise<void> => {
    while (inflight.size >= concurrency) await Promise.race(inflight);
    const p: Promise<void> = fn().finally(() => inflight.delete(p));
    inflight.add(p);
  };
  for await (const { sha, data } of supply(needed)) {
    if (fatal) break;
    if (!needed.has(sha) || done.has(sha)) continue;
    done.add(sha);
    if (sha256(data) !== sha) {
      failedShas.add(sha);
      failures.push({ sha256: sha, stage: 'read', message: 'source bytes changed since the closure was collected' });
      continue;
    }
    const ref = blobs.get(sha) as BlobRef;
    await schedule(async () => {
      const t0 = performance.now();
      try {
        await client.putBlob(sha, data, ref.hint);
        stats.uploaded += 1;
        stats.bytes += data.length;
        state.uploaded.push(sha);
      } catch (err) {
        if (err instanceof ServerUnavailableError) fatal = err;
        else {
          failedShas.add(sha);
          failures.push({ sha256: sha, stage: 'put', message: (err as Error).message });
        }
      } finally {
        stats.putMs += performance.now() - t0;
      }
    });
  }
  await Promise.all(inflight);
  if (fatal) throw fatal;
  for (const s of needed) {
    if (!done.has(s)) {
      failedShas.add(s);
      failures.push({ sha256: s, stage: 'read', message: 'no source yielded this blob' });
    }
  }
  log(`blobs: ${stats.uploaded}/${stats.missing} uploaded, ${stats.bytes} bytes`);
  return { stats, failedShas };
}

async function register(
  client: VfxClient,
  items: Item[],
  failedShas: Set<string>,
  state: State,
  failures: Failure[],
  persist: () => Promise<void>,
): Promise<{ created: number; unchanged: number; replaced: number; rejected: number }> {
  const out = { created: 0, unchanged: 0, replaced: 0, rejected: 0 };
  const todo = items.filter((i) => {
    if (failedShas.has(i.assetSha) || (i.metaSha && failedShas.has(i.metaSha))) {
      failures.push({ guid: i.input.guid, stage: 'register', message: 'skipped: a blob failed to upload' });
      return false;
    }
    return true;
  });
  for (let i = 0; i < todo.length; i += REGISTER_BATCH) {
    const batch = todo.slice(i, i + REGISTER_BATCH);
    const res = await client.registerBatch(batch.map((b) => b.input));
    res.results.forEach((r, n) => {
      if (r.status === 'rejected') {
        out.rejected += 1;
        failures.push({ guid: r.guid, stage: 'register', message: `${r.code ?? 'rejected'}: ${r.error ?? ''}`.trim() });
      } else {
        out[r.status] += 1;
        state.registered.push(keyOf(batch[n]));
      }
    });
    await persist();
  }
  return out;
}

type PlanFile = { kind: string; pack: string; bytes: number; guid: string; path: string; asset_sha256: string; meta_sha256: string | null };

export async function runUpload(opts: UploadOptions): Promise<{ exitCode: number; summary: Summary }> {
  const t0 = performance.now();
  const log = opts.log ?? (() => undefined);
  const variant = opts.variant ?? 'original';
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  await fs.mkdir(opts.outDir, { recursive: true });
  const statePath = path.join(opts.outDir, 'state.json');
  const state = await loadState(statePath, opts.resume ?? false);
  const persist = (): Promise<void> => fs.writeFile(statePath, JSON.stringify(state));
  const failures: Failure[] = [];

  let items: Item[] = [];
  const blobs = new Map<string, BlobRef>();
  let supply: Supply;
  let closure: Closure | null = null;
  let closureFiles = 0;
  let urpRejected = 0;
  let planFiles: PlanFile[] = [];

  if (variant === 'original') {
    let roots = opts.roots;
    if (opts.pack) roots = roots.filter((r) => r.pack === opts.pack);
    closure = await collectClosure(opts.sources, roots, { skipKinds: opts.skipKinds, packageGuids: opts.packageGuids, log });
    closureFiles = closure.files.length;
    const files = opts.limit ? closure.files.slice(0, opts.limit) : closure.files;
    const keptRecs: FileRecord[] = [];
    for (const r of files) {
      const why = blobLicenseProblem(r.license, r.visibility, false);
      if (why) {
        failures.push({ guid: r.guid, stage: 'license', message: why });
        continue;
      }
      keptRecs.push(r);
      items.push(toItem(r));
      blobs.set(r.assetSha, { bytes: r.assetBytes, hint: r.assetHint });
      if (r.metaSha) blobs.set(r.metaSha, { bytes: r.metaBytes, hint: 'meta' });
    }
    planFiles = keptRecs.map((r) => ({
      guid: r.guid, kind: r.kind, pack: r.pack, bytes: r.assetBytes, path: r.path, asset_sha256: r.assetSha, meta_sha256: r.metaSha,
    }));
    const byGuid = new Map(keptRecs.map((r) => [r.guid, r]));
    supply = async function* (needed) {
      const bySource = new Map<number, Set<string>>();
      for (const r of byGuid.values()) {
        if (needed.has(r.assetSha) || (r.metaSha && needed.has(r.metaSha))) {
          (bySource.get(r.sourceIndex) ?? bySource.set(r.sourceIndex, new Set()).get(r.sourceIndex)!).add(r.guid);
        }
      }
      for (const [i, want] of bySource) {
        for await (const f of opts.sources[i].source.files((g) => want.has(g))) {
          const r = byGuid.get(f.guid) as FileRecord;
          // sha comes from the record: uploadMissing re-hashes `data` and fails the blob if it differs.
          if (needed.has(r.assetSha)) yield { sha: r.assetSha, data: f.data };
          if (f.meta && r.metaSha && needed.has(r.metaSha)) yield { sha: r.metaSha, data: f.meta };
        }
      }
    };
  } else {
    if (!opts.urpDir) throw new Error('--variant urp needs --urp-dir');
    const { accepted, rejected } = await loadUrpExport(opts.urpDir, opts.packageGuids);
    urpRejected = rejected.length;
    for (const r of rejected) log(`urp rejected ${r.guid}: ${r.reason}`);
    // Originals supply path, pack, licence and the .meta blob (SAME .meta as the original, C8).
    const wantGuids = new Set(accepted.map((a) => a.item.guid));
    const ixs = await Promise.all(opts.sources.map((s) => s.source.index()));
    const found = new Map<string, { file: SourceFile; ps: PackSource }>();
    for (let i = 0; i < opts.sources.length; i++) {
      const want = new Set([...wantGuids].filter((g) => !found.has(g) && ixs[i].assetSizes.has(g)));
      if (!want.size) continue;
      for await (const f of opts.sources[i].source.files((g) => want.has(g))) found.set(f.guid, { file: f, ps: opts.sources[i] });
    }
    const mem = new Map<string, Buffer>(); // blob bytes by sha (a few thousand small .mat/.meta)
    for (const a of accepted) {
      const orig = found.get(a.item.guid);
      if (!orig || !orig.file.meta) {
        failures.push({ guid: a.item.guid, stage: 'read', message: orig ? 'original has no .meta' : 'original not found in any source' });
        continue;
      }
      const pk = orig.ps.pack;
      const vis = pk.visibility ?? 'studio-only';
      const why = blobLicenseProblem(pk.license, vis, false);
      if (why) {
        failures.push({ guid: a.item.guid, stage: 'license', message: why });
        continue;
      }
      const metaSha = sha256(orig.file.meta);
      const input: AssetFileInput = {
        guid: a.item.guid,
        variant: 'urp',
        kind: 'material',
        path: orig.file.path,
        asset_sha256: a.item.sha256,
        meta_sha256: metaSha,
        pack: pk.slug,
        license: pk.license,
        visibility: vis as AssetFileInput['visibility'],
        source: { game: null, origin: pk.slug },
        urp: { rule: a.item.rule, glow_cap: null, shader_guid: a.item.shader_guid },
      };
      items.push({ input, assetSha: a.item.sha256, metaSha });
    }
    closureFiles = accepted.length;
    if (opts.limit) items = items.slice(0, opts.limit);
    const dataByGuid = new Map(accepted.map((a) => [a.item.guid, a.data]));
    for (const i of items) {
      const orig = found.get(i.input.guid) as { file: SourceFile };
      const d = dataByGuid.get(i.input.guid) as Buffer;
      mem.set(i.assetSha, d);
      mem.set(i.metaSha as string, orig.file.meta as Buffer);
      blobs.set(i.assetSha, { bytes: d.length, hint: 'material' });
      blobs.set(i.metaSha as string, { bytes: (orig.file.meta as Buffer).length, hint: 'meta' });
    }
    planFiles = items.map((i) => ({
      guid: i.input.guid, kind: 'material', pack: i.input.pack, bytes: blobs.get(i.assetSha)?.bytes ?? 0,
      path: i.input.path, asset_sha256: i.assetSha, meta_sha256: i.metaSha,
    }));
    supply = async function* (needed) {
      for (const sha of needed) {
        const d = mem.get(sha);
        if (d) yield { sha, data: d };
      }
    };
  }

  const totalBytes = [...blobs.values()].reduce((n, b) => n + b.bytes, 0);
  const summary: Summary = {
    mode: opts.yes ? 'upload' : 'dry-run',
    variant,
    files: items.length,
    files_in_closure: closureFiles,
    blobs: blobs.size,
    bytes: totalBytes,
    ...tally(planFiles),
    requires: closure?.requires.size ?? 0,
    unresolved: closure?.unresolved.size ?? 0,
    skipped: closure?.skipped.length ?? 0,
    roots_missing: closure?.rootsMissing.length ?? 0,
    copies_differing: closure ? closure.files.filter((f) => f.copies.length).length : 0,
    urp_rejected: urpRejected,
    failed: 0,
    failures,
    ms: 0,
  };

  const plan = {
    variant,
    totals: { files: summary.files, blobs: summary.blobs, bytes: summary.bytes },
    by_kind: summary.by_kind,
    by_pack: summary.by_pack,
    unresolved: [...(closure?.unresolved ?? [])].map(([guid, by]) => ({ guid, referenced_by: [...by].sort() })),
    requires: [...(closure?.requires ?? [])].map(([guid, r]) => ({ guid, name: r.name, kind: r.kind, package: r.package, referenced_by: [...r.referencedBy].sort() })),
    roots_missing: closure?.rootsMissing ?? [],
    skipped: closure?.skipped ?? [],
    copies: (closure?.files ?? []).filter((f) => f.copies.length).map((f) => ({ guid: f.guid, path: f.path, winner: { origin: f.game ?? f.origin, sha256: f.assetSha }, copies: f.copies })),
    files: planFiles,
  };
  await fs.writeFile(path.join(opts.outDir, variant === 'urp' ? 'plan-urp.json' : 'plan.json'), JSON.stringify(plan, null, 2));

  const finish = (exitCode: number): { exitCode: number; summary: Summary } => {
    summary.failed = failures.length;
    summary.ms = Math.round(performance.now() - t0);
    return { exitCode: exitCode === 0 && failures.length ? 1 : exitCode, summary };
  };
  if (!opts.yes) return finish(0);

  const client = createClient({ server: opts.server, apiKey: opts.apiKey, backoffMs: opts.retryBackoffMs });
  try {
    const registeredKeys = new Set(state.registered);
    const pending = opts.resume ? items.filter((i) => !registeredKeys.has(keyOf(i))) : items;
    const pendingBlobs = new Map<string, BlobRef>();
    for (const i of pending) {
      pendingBlobs.set(i.assetSha, blobs.get(i.assetSha) as BlobRef);
      if (i.metaSha) pendingBlobs.set(i.metaSha, blobs.get(i.metaSha) as BlobRef);
    }
    const { stats, failedShas } = await uploadMissing(client, pendingBlobs, supply, state, concurrency, failures, log);
    await persist();
    const reg = await register(client, pending, failedShas, state, failures, persist);
    Object.assign(summary, {
      blobs_missing: stats.missing,
      blobs_uploaded: stats.uploaded,
      bytes_uploaded: stats.bytes,
      created: reg.created,
      unchanged: reg.unchanged,
      replaced: reg.replaced,
      rejected: reg.rejected,
    });
    if (stats.uploaded) {
      summary.avg_put_ms = Math.round(stats.putMs / stats.uploaded);
      // Rough full-run ETA: every closure file ships an asset blob and (mostly) a .meta blob.
      summary.eta_full_s = Math.round(((stats.putMs / stats.uploaded) * closureFiles * 2) / concurrency / 1000);
    }
  } catch (err) {
    if (err instanceof ServerUnavailableError) {
      failures.push({ stage: 'put', message: err.message });
      return finish(75);
    }
    throw err;
  }
  return finish(0);
}
