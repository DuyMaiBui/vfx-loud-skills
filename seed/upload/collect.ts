/**
 * Closure collector for the bulk uploader (plan.md phase 3, D12, D16). Pure over PackageSource: given root
 * GUIDs it walks `scanRefs` breadth-first through the vendor sources and returns, per file, the hashes,
 * refs and provenance the uploader registers. Original bytes come ONLY from vendor sources, never from
 * `ImportedPacks` (already rewritten in place by MaterialConverter).
 */
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { kindOfPath, KINDS, TEXT_KINDS, type Kind } from '../../server/src/bundle-contract.ts';
import { classifyGuid, scanRefs, type PackageEntry } from '../../server/src/unity-refs.ts';
import { folderSetSource, folderSource, tarSource, type PackageSource } from '../extract/source.ts';
import { hasVfxComponent, type PackConfig } from '../extract/pipeline.ts';

export const sha256 = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');

/** packs.json entry plus the phase-1 byte-policy `bytes` flag (`visibility` is declared by `PackConfig`). */
export interface UploadPack extends PackConfig {
  bytes?: boolean;
}

export interface PackSource {
  pack: UploadPack;
  source: PackageSource;
}

export interface Root {
  guid: string;
  pack?: string;
}

export interface FileRecord {
  guid: string;
  kind: Kind;
  path: string;
  pack: string;
  license: string;
  visibility: string;
  /** Pack slug the bytes came from (`source.origin`). */
  origin: string;
  /** Winning game label for a folder-set pack, else null (`source.game`). */
  game: string | null;
  /** Other sources that carried this guid with DIFFERENT bytes (D16). */
  copies: Array<{ origin: string; sha256: string }>;
  assetSha: string;
  assetBytes: number;
  /** `x-vfx-kind` storage hint for the asset blob (text kinds gzip at rest). */
  assetHint: string | undefined;
  metaSha: string | null;
  metaBytes: number;
  refs: string[];
  sourceIndex: number;
}

export interface Closure {
  files: FileRecord[];
  /** Non-shipped GUIDs (builtin / UPM package) with who referenced them. */
  requires: Map<string, { name: string; kind: 'builtin' | 'package'; package: string | null; referencedBy: Set<string> }>;
  unresolved: Map<string, Set<string>>;
  /** Files skipped by --skip-kinds. */
  skipped: Array<{ guid: string; kind: Kind; path: string }>;
  /** Roots no source carries. */
  rootsMissing: string[];
}

const SCAN_EXT = new Set(['.prefab', '.mat', '.anim', '.controller', '.asset', '.asmdef', '.asmref', '.shadergraph', '.shadersubgraph']);

/** True for the text files whose GUID references are followed (Shader Graph included, per scanRefs P3). */
export function isRefScanned(unityPath: string): boolean {
  return SCAN_EXT.has(path.posix.extname(unityPath).toLowerCase());
}

const looksBinary = (b: Buffer): boolean => b.subarray(0, 8000).includes(0);

/** Storage hint for the asset blob: the kind for text kinds, `other-text` for an unmapped text file. */
export function storageHint(kind: Kind, data: Buffer): string | undefined {
  if ((TEXT_KINDS as readonly string[]).includes(kind)) return kind;
  if (kind === 'other' && !looksBinary(data)) return 'other-text';
  return undefined;
}

export function parseSkipKinds(csv: string | undefined): Set<Kind> {
  const out = new Set<Kind>();
  for (const k of (csv ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!(KINDS as readonly string[]).includes(k)) throw new Error(`--skip-kinds: unknown kind "${k}" (${KINDS.join(', ')})`);
    out.add(k as Kind);
  }
  return out;
}

/** Hard error for a source under `ImportedPacks`: those materials were rewritten in place (C8). */
export function assertNotImportedPacks(p: string, what: string): void {
  if (path.resolve(p).split(path.sep).includes('ImportedPacks')) {
    throw new Error(`refusing ${what} "${p}": a path under ImportedPacks holds already-converted bytes; originals come only from the vendor source`);
  }
}

/** Builds one PackageSource per pack with `bytes !== false`, in configured order (D16 priority). */
export async function buildSources(packs: UploadPack[], packageDir: string): Promise<PackSource[]> {
  const out: PackSource[] = [];
  for (const pack of packs) {
    if (pack.bytes === false) continue;
    let source: PackageSource;
    if (pack.sourceType === 'folder-set') {
      if (!pack.sourceRoots?.length || !pack.pathPrefix) throw new Error(`pack "${pack.slug}": folder-set needs sourceRoots and pathPrefix`);
      for (const r of pack.sourceRoots) {
        assertNotImportedPacks(r.path, `source root of "${pack.slug}"`);
        await fs.access(r.path);
      }
      // D8: among differing copies prefer the first one that carries a ParticleSystem / VisualEffect.
      source = folderSetSource(
        pack.sourceRoots.map((r) => ({ game: r.game, root: r.path })),
        pack.pathPrefix,
        { preferCopy: (_g, bytes) => hasVfxComponent(bytes.toString('utf8')) },
      );
    } else if (pack.sourceType === 'folder') {
      if (!pack.sourcePath || !pack.pathPrefix) throw new Error(`pack "${pack.slug}": folder source needs sourcePath and pathPrefix`);
      assertNotImportedPacks(pack.sourcePath, `source of "${pack.slug}"`);
      await fs.access(pack.sourcePath);
      source = folderSource(pack.sourcePath, pack.pathPrefix);
    } else {
      if (!pack.file) throw new Error(`pack "${pack.slug}" has no file`);
      const file = path.join(packageDir, pack.file);
      assertNotImportedPacks(file, `package of "${pack.slug}"`);
      await fs.access(file);
      source = tarSource(file);
    }
    out.push({ pack, source });
  }
  return out;
}

export interface CollectOptions {
  skipKinds?: Set<Kind>;
  packageGuids: Map<string, PackageEntry>;
  log?: (line: string) => void;
}

/** Nearest `.asmdef` guid in the same source above a script path (D12), or null. */
function nearestAsmdef(scriptPath: string, byDir: Map<string, string>): string | null {
  let dir = path.posix.dirname(scriptPath);
  for (;;) {
    const hit = byDir.get(dir);
    if (hit) return hit;
    if (dir === '.' || dir === '/' || !dir.includes('/')) return null;
    dir = path.posix.dirname(dir);
  }
}

export async function collectClosure(sources: PackSource[], roots: Root[], opts: CollectOptions): Promise<Closure> {
  const log = opts.log ?? (() => undefined);
  const skipKinds = opts.skipKinds ?? new Set<Kind>();
  const indices = [];
  for (const s of sources) indices.push(await s.source.index());
  // guid -> source indices that carry it, configured order (the first is the winner, D16).
  const carriers = new Map<string, number[]>();
  const asmdefByDir = sources.map(() => new Map<string, string>());
  indices.forEach((ix, i) => {
    for (const guid of ix.assetSizes.keys()) {
      const l = carriers.get(guid) ?? [];
      l.push(i);
      carriers.set(guid, l);
      const p = ix.paths.get(guid) ?? '';
      if (p.toLowerCase().endsWith('.asmdef')) asmdefByDir[i].set(path.posix.dirname(p), guid);
    }
  });

  const closure: Closure = { files: [], requires: new Map(), unresolved: new Map(), skipped: [], rootsMissing: [] };
  const seen = new Set<string>();
  let level: string[] = [];
  const enqueue = (guid: string): void => {
    if (seen.has(guid)) return;
    seen.add(guid);
    level.push(guid);
  };
  const note = (guid: string, referencedBy: string): boolean => {
    // Builtin / package GUIDs are never shipped (D7); unknown ones are unresolved.
    const cls = classifyGuid(guid, opts.packageGuids);
    if (cls.kind === 'builtin' || cls.kind === 'package') {
      const r = closure.requires.get(guid) ?? { name: cls.name, kind: cls.kind, package: cls.package, referencedBy: new Set<string>() };
      r.referencedBy.add(referencedBy);
      closure.requires.set(guid, r);
      return true;
    }
    if (!carriers.has(guid)) {
      const u = closure.unresolved.get(guid) ?? new Set<string>();
      u.add(referencedBy);
      closure.unresolved.set(guid, u);
      return true;
    }
    return false;
  };

  for (const r of roots) {
    if (!carriers.has(r.guid)) closure.rootsMissing.push(r.guid);
    else enqueue(r.guid);
  }

  while (level.length) {
    const current = level;
    level = [];
    const bySource = new Map<number, Set<string>>();
    const others = new Map<number, Set<string>>();
    for (const g of current) {
      const [win, ...rest] = carriers.get(g) as number[];
      (bySource.get(win) ?? bySource.set(win, new Set()).get(win)!).add(g);
      for (const j of rest) (others.get(j) ?? others.set(j, new Set()).get(j)!).add(g);
    }
    const loaded = new Map<string, FileRecord>();
    const loserSha = new Map<string, Array<{ origin: string; sha256: string }>>();
    for (const [i, want] of bySource) {
      const { pack, source } = sources[i];
      for await (const f of source.files((g) => want.has(g))) {
        const kind = kindOfPath(f.path);
        const base: FileRecord = {
          guid: f.guid,
          kind,
          path: f.path,
          pack: pack.slug,
          license: pack.license,
          visibility: pack.visibility ?? 'studio-only',
          origin: pack.slug,
          game: null,
          copies: [],
          assetSha: sha256(f.data),
          assetBytes: f.data.length,
          assetHint: storageHint(kind, f.data),
          metaSha: f.meta ? sha256(f.meta) : null,
          metaBytes: f.meta?.length ?? 0,
          refs: isRefScanned(f.path) ? scanRefs(f.data, f.guid) : [],
          sourceIndex: i,
        };
        if (pack.sourceType === 'folder-set' && source.gamesOf) {
          const games = source.gamesOf(f.guid);
          const copies = games.length > 1 ? await source.copiesOf(f.guid) : [];
          base.game = copies.length ? copies[0].origin : (games[0] ?? null);
          for (const c of copies.slice(1)) if (c.sha256 !== base.assetSha) base.copies.push({ origin: c.origin, sha256: c.sha256 });
        }
        loaded.set(f.guid, base);
      }
    }
    for (const [j, want] of others) {
      for await (const f of sources[j].source.files((g) => want.has(g))) {
        const l = loserSha.get(f.guid) ?? [];
        l.push({ origin: sources[j].pack.slug, sha256: sha256(f.data) });
        loserSha.set(f.guid, l);
      }
    }
    for (const g of current) {
      const rec = loaded.get(g);
      if (!rec) {
        // The index promised the asset; the source did not deliver it: loud, not silent (never a fallback).
        throw new Error(`source "${sources[(carriers.get(g) as number[])[0]].pack.slug}" indexed ${g} but did not yield it`);
      }
      for (const c of loserSha.get(g) ?? []) if (c.sha256 !== rec.assetSha) rec.copies.push(c);
      if (skipKinds.has(rec.kind)) {
        closure.skipped.push({ guid: rec.guid, kind: rec.kind, path: rec.path });
        continue;
      }
      closure.files.push(rec);
      for (const ref of rec.refs) if (!note(ref, rec.guid)) enqueue(ref);
      if (rec.kind === 'script') {
        const asm = nearestAsmdef(rec.path, asmdefByDir[rec.sourceIndex]);
        if (asm && asm !== rec.guid) enqueue(asm);
      }
    }
    log(`closure: level of ${current.length}, total ${closure.files.length} files`);
  }
  return closure;
}
