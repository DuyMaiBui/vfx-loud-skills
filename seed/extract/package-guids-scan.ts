import fs from 'node:fs/promises';
import path from 'node:path';
import { isBuiltinGuid, scanRefs } from '../../server/src/unity-refs.ts';
import { classifyPath, hasVfxComponent, type PackConfig } from './pipeline.ts';
import type { PackageSource } from './source.ts';

/**
 * Reference scan for the Unity package GUID map (phase 5). Reads the same sources the extractor reads
 * (`PackageSource`), starts from the VFX prefabs the extractor would select, and follows GUID references
 * through text assets (`.prefab .mat .anim .controller .asset`) transitively. Read-only.
 */

/** Text asset kinds whose bytes carry GUID references (the only files the scan reads). */
const REF_TEXT_EXT = ['.prefab', '.mat', '.anim', '.controller', '.asset'];
const isRefText = (p: string): boolean => REF_TEXT_EXT.some((e) => p.endsWith(e));

/** The fields `classifyPath` and the VFX check read: the selection a source is extracted with. */
export type Select = Pick<PackConfig, 'prefabRoots' | 'excludePathPrefixes' | 'prefabSelect'>;

export interface SourceSpec {
  origin: string;
  source: PackageSource;
  select: Select;
}

export interface Defined {
  path: string;
  origin: string;
  sourceIdx: number;
}

export interface RefRoot {
  guid: string;
  path: string;
  origin: string;
}

export interface ScanResult {
  /** The VFX prefabs the scan starts from (the extractor's selection). */
  roots: RefRoot[];
  /** Every guid any source defines; the first source in configured order wins. */
  defined: Map<string, Defined>;
  /** Referenced guids no source defines and that are not Unity builtins: guid -> referencing guids. */
  outside: Map<string, Set<string>>;
  /** Unity builtin references (`rules.assets.builtinGuidPattern`): guid -> referencing guids. */
  builtin: Map<string, Set<string>>;
  /** Defined text asset guid -> guids that reference it (for walking a reference back to its root prefabs). */
  parents: Map<string, Set<string>>;
  /** Text assets read (roots plus their transitive closure). */
  visited: number;
  /** Breadth-first rounds run (one pass over each source per round). */
  rounds: number;
}

function addRef(m: Map<string, Set<string>>, guid: string, by: string): void {
  const s = m.get(guid) ?? new Set<string>();
  s.add(by);
  m.set(guid, s);
}

/** One read pass per source for the guids it defines; keeps the bytes in memory for one round only. */
async function loadTexts(specs: SourceSpec[], want: Map<number, Set<string>>): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const [idx, guids] of want) {
    for await (const e of specs[idx].source.assets((g) => guids.has(g))) out.set(e.guid, e.data);
  }
  return out;
}

export async function scanReferences(specs: SourceSpec[]): Promise<ScanResult> {
  const defined = new Map<string, Defined>();
  const indexes: Map<string, string>[] = [];
  for (const [i, spec] of specs.entries()) {
    const { paths } = await spec.source.index();
    indexes.push(paths);
    for (const [guid, p] of paths) if (!defined.has(guid)) defined.set(guid, { path: p, origin: spec.origin, sourceIdx: i });
  }

  // Round 0: the extractor's VFX prefabs are the roots. Only candidate prefabs are read.
  const roots: RefRoot[] = [];
  const texts = new Map<string, Buffer>();
  for (const [i, spec] of specs.entries()) {
    const cand = new Set<string>();
    for (const [guid, p] of indexes[i]) if (classifyPath(p, spec.select) === null) cand.add(guid);
    if (!cand.size) continue;
    for await (const e of spec.source.assets((g) => cand.has(g))) {
      if (spec.select.prefabSelect === 'vfx-components' && !hasVfxComponent(e.data.toString('utf8'))) continue;
      roots.push({ guid: e.guid, path: indexes[i].get(e.guid) ?? '', origin: spec.origin });
      texts.set(e.guid, e.data);
    }
  }

  const visited = new Set<string>(roots.map((r) => r.guid));
  const outside = new Map<string, Set<string>>();
  const builtin = new Map<string, Set<string>>();
  const parents = new Map<string, Set<string>>();
  let pending = roots.map((r) => r.guid);
  let rounds = 0;
  while (pending.length) {
    rounds++;
    const next: string[] = [];
    for (const g of pending) {
      const bytes = texts.get(g);
      if (!bytes) throw new Error(`package-guids: no bytes read for ${g} (${defined.get(g)?.path ?? 'undefined'})`);
      for (const ref of scanRefs(bytes, g)) {
        if (isBuiltinGuid(ref)) {
          addRef(builtin, ref, g);
          continue;
        }
        const d = defined.get(ref);
        if (!d) {
          addRef(outside, ref, g);
          continue;
        }
        if (!isRefText(d.path)) continue;
        addRef(parents, ref, g);
        if (visited.has(ref)) continue;
        visited.add(ref);
        next.push(ref);
      }
    }
    texts.clear();
    const want = new Map<number, Set<string>>();
    for (const ref of next) {
      const idx = defined.get(ref)?.sourceIdx ?? -1;
      const set = want.get(idx) ?? new Set<string>();
      set.add(ref);
      want.set(idx, set);
    }
    for (const [guid, data] of await loadTexts(specs, want)) texts.set(guid, data);
    for (const ref of next) {
      if (!texts.has(ref)) throw new Error(`package-guids: defined guid ${ref} (${defined.get(ref)?.path}) yielded no bytes`);
    }
    pending = next;
  }

  return { roots, defined, outside, builtin, parents, visited: visited.size, rounds };
}

/** A version of a package that carries a guid, read from a `Library/PackageCache/<name>@<version>` folder. */
export interface CacheEntry {
  guid: string;
  package: string;
  version: string | null;
  /** Absolute path of the asset the `.meta` belongs to. */
  file: string;
}

async function walkMetas(dir: string, out: string[]): Promise<void> {
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) await walkMetas(p, out);
    else if (d.name.endsWith('.meta')) out.push(p);
  }
}

/** Every guid in the given PackageCache roots (`<project>/Library/PackageCache`). Missing roots are ignored. */
export async function indexPackageCache(cacheRoots: string[]): Promise<Map<string, CacheEntry[]>> {
  const out = new Map<string, CacheEntry[]>();
  for (const root of cacheRoots) {
    const pkgDirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const d of pkgDirs) {
      if (!d.isDirectory()) continue;
      const at = d.name.lastIndexOf('@');
      let pkg = at > 0 ? d.name.slice(0, at) : d.name;
      // The real version lives in package.json; a folder suffix is a version only when it looks like one
      // (git/custom-registry packages are `<name>@<12-hex hash>`: that is never reported as a version).
      let version: string | null = at > 0 && /^\d+(\.\d+)*([-+][0-9A-Za-z.-]+)?$/.test(d.name.slice(at + 1)) ? d.name.slice(at + 1) : null;
      try {
        const j = JSON.parse(await fs.readFile(path.join(root, d.name, 'package.json'), 'utf8')) as { name?: string; version?: string };
        if (j.name) pkg = j.name;
        if (j.version) version = j.version;
      } catch {
        /* no package.json: keep the folder-derived values */
      }
      const metas: string[] = [];
      await walkMetas(path.join(root, d.name), metas);
      for (const meta of metas) {
        const file = meta.slice(0, -'.meta'.length);
        const st = await fs.stat(file).catch(() => null);
        if (!st?.isFile()) continue;
        const m = /^guid:\s*([0-9a-f]{32})\s*$/m.exec(await fs.readFile(meta, 'utf8'));
        if (!m) continue;
        const list = out.get(m[1]) ?? [];
        list.push({ guid: m[1], package: pkg, version, file });
        out.set(m[1], list);
      }
    }
  }
  return out;
}

/** Display name for a package asset: the shader's `Shader "..."` name, a material's `m_Name`, else the file stem. */
export async function assetName(file: string): Promise<string> {
  const stem = path.basename(file).replace(/\.[^.]+$/, '');
  if (file.endsWith('.shader')) {
    const head = (await fs.readFile(file, 'utf8')).slice(0, 4096);
    const m = /^\s*Shader\s+"([^"]+)"/m.exec(head);
    if (m) return m[1];
  }
  if (file.endsWith('.mat')) {
    const head = (await fs.readFile(file, 'utf8')).slice(0, 4096);
    const m = /^\s*m_Name:\s*(.*?)\s*$/m.exec(head);
    if (m && m[1]) return m[1];
  }
  return stem;
}

/** The root VFX prefabs (paths, sorted) that reach `guid` through the reference graph, walking referrers upward. */
export function rootPrefabsOf(scan: ScanResult, guid: string): string[] {
  const rootPaths = new Map(scan.roots.map((r) => [r.guid, r.path]));
  const seen = new Set<string>();
  const stack = [...(scan.outside.get(guid) ?? [])];
  const found = new Set<string>();
  while (stack.length) {
    const g = stack.pop() as string;
    if (seen.has(g)) continue;
    seen.add(g);
    const rp = rootPaths.get(g);
    if (rp !== undefined) found.add(rp);
    for (const up of scan.parents.get(g) ?? []) stack.push(up);
  }
  return [...found].sort();
}
