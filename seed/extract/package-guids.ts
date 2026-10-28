import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackageGuidMapSchema, type PackageEntry } from '../../server/src/unity-refs.ts';
import { folderSetSource, folderSource, tarSource, type PackageSource } from './source.ts';
import { assetName, indexPackageCache, rootPrefabsOf, scanReferences, type CacheEntry, type Select, type SourceSpec } from './package-guids-scan.ts';

/**
 * Unity package GUID map (phase 5, `server/src/unity-package-guids.json`). Classifies every GUID the game
 * VFX reference that no game folder or vendor pack defines: a `package` entry names the UPM package and
 * version the GUID lives in (read from the games' `Library/PackageCache`); everything else is reported
 * `unresolved` and never written (the owner's decision: report first, do not guess a source).
 * Builtins are not listed here (classified by pattern in `unity-refs.ts`).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_GUID_MAP_OUT = path.resolve(here, '../../server/src/unity-package-guids.json');
export const PACKS_FILE = path.join(here, 'packs.json');
/**
 * The Unity Editor's own packages (HDRP, URP overrides, core, ugui...): the GUIDs a game's `PackageCache` lacks when
 * the asset is only referenced from the Editor install. Package folders have no `@version`: the version is in package.json.
 */
export const BUILTIN_PACKAGES_DIR =
  process.env.VFX_UNITY_BUILTIN_PACKAGES ?? path.join(process.env.HOME ?? '', 'Unity/Hub/Editor/6000.3.15f1/Editor/Data/Resources/PackageManager/BuiltInPackages');
export const UNITYPACKAGE_DIR = process.env.VFX_UNITYPACKAGE_DIR ?? '/home/mike/Downloads/UnityPackages';

/** URP shaders the C8 URP criterion needs (`Particles/Unlit`, `Lit`), listed even when no VFX references them. */
export const ALWAYS_INCLUDE = ['0406db5a14f94604a8c57ccfbc9f3b46', '933532a4fcc9baf4fa0491de14d08ed7'];

export interface Unresolved {
  guid: string;
  /** Referencing guids, sorted. */
  referenced_by: string[];
  /** Asset paths of the referencing files (first few), for the report. */
  paths: string[];
  /** Root VFX prefabs that reach this guid: count and the first few paths (the owner's "which prefab" answer). */
  root_prefab_count: number;
  root_prefabs: string[];
}

export interface Built {
  entries: Map<string, PackageEntry>;
  summary: BuildSummary;
}

export interface BuildSummary {
  mode: 'referenced' | 'full';
  roots: { total: number; byOrigin: Record<string, number> };
  textAssetsRead: number;
  rounds: number;
  definedGuids: number;
  outside: number;
  builtin: number;
  package: { total: number; byPackage: Record<string, number> };
  unresolved: { total: number; list: Unresolved[] };
  ambiguous: Array<{ guid: string; chosen: string; others: string[] }>;
  alwaysIncluded: string[];
  entries: number;
  missingCaches: string[];
}

const versionParts = (v: string | null): number[] => (v ?? '').split(/[^0-9]+/).filter(Boolean).map(Number);

/** Highest version first (numeric parts, then the string); `null` sorts last. */
function compareVersionsDesc(a: string | null, b: string | null): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? -1) - (pa[i] ?? -1);
    if (d !== 0) return d;
  }
  return (b ?? '').localeCompare(a ?? '');
}

/**
 * Builds the map from a scan and a PackageCache index. Pure given its inputs (the name reads are the only I/O).
 * `full` also lists every PackageCache guid the games' defined set does not own (`--full`).
 */
export async function buildMap(
  specs: SourceSpec[],
  cacheRoots: string[],
  opts: { full: boolean; always?: string[]; missingCaches?: string[] },
): Promise<Built> {
  const scan = await scanReferences(specs);
  const cache = await indexPackageCache(cacheRoots);
  const always = opts.always ?? ALWAYS_INCLUDE;
  const entries = new Map<string, PackageEntry>();
  const ambiguous: BuildSummary['ambiguous'] = [];

  const pick = (guid: string): CacheEntry | null => {
    const list = cache.get(guid);
    if (!list?.length) return null;
    const sorted = [...list].sort((a, b) => compareVersionsDesc(a.version, b.version) || a.package.localeCompare(b.package));
    const distinct = sorted.filter((c) => c.package !== sorted[0].package || c.version !== sorted[0].version);
    if (distinct.length) ambiguous.push({ guid, chosen: `${sorted[0].package}@${sorted[0].version}`, others: distinct.map((c) => `${c.package}@${c.version}`) });
    return sorted[0];
  };
  const toEntry = async (c: CacheEntry): Promise<PackageEntry> => ({ kind: 'package', name: await assetName(c.file), package: c.package, version: c.version });

  const pathOf = (g: string): string => scan.defined.get(g)?.path ?? g;
  const unresolved: Unresolved[] = [];
  const referencedMapped = new Set<string>();
  for (const guid of [...scan.outside.keys()].sort()) {
    const c = pick(guid);
    if (!c) {
      const by = [...(scan.outside.get(guid) ?? [])].sort();
      const roots = rootPrefabsOf(scan, guid);
      unresolved.push({ guid, referenced_by: by, paths: by.slice(0, 3).map(pathOf), root_prefab_count: roots.length, root_prefabs: roots.slice(0, 5) });
      continue;
    }
    entries.set(guid, await toEntry(c));
    referencedMapped.add(guid);
  }

  for (const guid of always) {
    if (scan.defined.has(guid)) throw new Error(`package-guids: always-included ${guid} is defined by ${scan.defined.get(guid)?.path} (a game or pack asset, not a package)`);
    const c = pick(guid);
    if (!c) throw new Error(`package-guids: always-included ${guid} is not in any PackageCache (${cacheRoots.join(', ') || 'no roots'})`);
    if (!entries.has(guid)) entries.set(guid, await toEntry(c));
  }

  if (opts.full) {
    for (const guid of [...cache.keys()].sort()) {
      if (entries.has(guid) || scan.defined.has(guid)) continue;
      const c = pick(guid);
      if (c) entries.set(guid, await toEntry(c));
    }
  }

  const byPackage: Record<string, number> = {};
  for (const g of referencedMapped) {
    const e = entries.get(g);
    if (e?.kind === 'package') byPackage[`${e.package}@${e.version}`] = (byPackage[`${e.package}@${e.version}`] ?? 0) + 1;
  }
  const byOrigin: Record<string, number> = {};
  for (const r of scan.roots) byOrigin[r.origin] = (byOrigin[r.origin] ?? 0) + 1;
  unresolved.sort((a, b) => b.referenced_by.length - a.referenced_by.length || (a.guid < b.guid ? -1 : 1));

  return {
    entries,
    summary: {
      mode: opts.full ? 'full' : 'referenced',
      roots: { total: scan.roots.length, byOrigin },
      textAssetsRead: scan.visited,
      rounds: scan.rounds,
      definedGuids: scan.defined.size,
      outside: scan.outside.size,
      builtin: scan.builtin.size,
      package: { total: referencedMapped.size, byPackage },
      unresolved: { total: unresolved.length, list: unresolved },
      ambiguous,
      alwaysIncluded: always,
      entries: entries.size,
      missingCaches: opts.missingCaches ?? [],
    },
  };
}

/** Writes the map sorted by guid, validated against the server's schema first (a bad map never lands). */
export async function writePackageGuidMap(file: string, entries: Map<string, PackageEntry>): Promise<void> {
  const sorted = Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const parsed = PackageGuidMapSchema.parse({ version: 1, entries: sorted });
  await fs.writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`);
}

type PackJson = Select & {
  slug: string;
  file?: string;
  sourceType?: string;
  sourcePath?: string;
  pathPrefix?: string;
  sourceRoots?: Array<{ game: string; path: string }>;
};

/** The sources and PackageCache roots the production run reads, from `packs.json` (in configured order). */
export async function specsFromPacks(packsFile: string, unitypackageDir: string, builtInPackagesDir: string = BUILTIN_PACKAGES_DIR): Promise<{ specs: SourceSpec[]; cacheRoots: string[]; missingCaches: string[] }> {
  const packs = (JSON.parse(await fs.readFile(packsFile, 'utf8')) as { packs: PackJson[] }).packs;
  const specs: SourceSpec[] = [];
  const cacheRoots: string[] = [];
  const missingCaches: string[] = [];
  const addRoot = async (dir: string): Promise<void> => {
    if (await fs.stat(dir).then((s) => s.isDirectory(), () => false)) cacheRoots.push(dir);
    else missingCaches.push(dir);
  };
  // `Library/PackageCache` (resolved registry/git packages) and `Packages` (embedded packages, e.g. com.theone.gdk.core)
  const addCache = async (projectDir: string): Promise<void> => {
    await addRoot(path.join(projectDir, 'Library', 'PackageCache'));
    await addRoot(path.join(projectDir, 'Packages'));
  };
  for (const p of packs) {
    let source: PackageSource;
    if (p.sourceType === 'folder-set') {
      if (!p.sourceRoots?.length || !p.pathPrefix) throw new Error(`package-guids: ${p.slug} folder-set needs sourceRoots and pathPrefix`);
      source = folderSetSource(p.sourceRoots.map((r) => ({ game: r.game, root: r.path })), p.pathPrefix);
      for (const r of p.sourceRoots) await addCache(path.dirname(r.path));
    } else if (p.sourceType === 'folder') {
      if (!p.sourcePath || !p.pathPrefix) throw new Error(`package-guids: ${p.slug} folder source needs sourcePath and pathPrefix`);
      source = folderSource(p.sourcePath, p.pathPrefix);
    } else {
      if (!p.file) throw new Error(`package-guids: ${p.slug} has neither a file nor a folder source`);
      const file = path.join(unitypackageDir, p.file);
      if (!(await fs.stat(file).then((s) => s.isFile(), () => false))) throw new Error(`package-guids: missing unitypackage ${file} (set VFX_UNITYPACKAGE_DIR)`);
      source = tarSource(file);
    }
    specs.push({ origin: p.slug, source, select: { prefabRoots: p.prefabRoots, excludePathPrefixes: p.excludePathPrefixes, prefabSelect: p.prefabSelect } });
  }
  await addRoot(builtInPackagesDir);
  return { specs, cacheRoots, missingCaches };
}

interface Args {
  json: boolean;
  full: boolean;
  out: string | null;
  packs: string;
  unitypackages: string;
  help: boolean;
}

const HELP = `Usage: node seed/extract/package-guids.ts [--json] [--full] [--out <file>] [--packs <file>] [--unitypackages <dir>]

Builds server/src/unity-package-guids.json: the package and builtin GUIDs the game VFX reference but no
game folder or vendor pack defines. Unmapped GUIDs are reported 'unresolved' (never written).

  --json              print the classification counts as one JSON object on stdout
  --full              write EVERY GUID in the games' PackageCache (not just the referenced subset);
                      requires --out so the committed referenced map is never overwritten by accident
  --out <file>        output file (default: server/src/unity-package-guids.json)
  --packs <file>      packs.json (default: seed/extract/packs.json)
  --unitypackages <dir>  folder of the vendor .unitypackage files (default: $VFX_UNITYPACKAGE_DIR or ~/Downloads/UnityPackages)
  --help              this text
`;

export function parseArgs(argv: string[]): Args {
  const a: Args = { json: false, full: false, out: null, packs: PACKS_FILE, unitypackages: UNITYPACKAGE_DIR, help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${t} needs a value`);
      return v;
    };
    if (t === '--json') a.json = true;
    else if (t === '--full') a.full = true;
    else if (t === '--out') a.out = next();
    else if (t === '--packs') a.packs = next();
    else if (t === '--unitypackages') a.unitypackages = next();
    else if (t === '--help' || t === '-h') a.help = true;
    else throw new UsageError(`unknown argument ${t}`);
  }
  if (a.full && a.out === null) throw new UsageError('--full writes every PackageCache guid: pass --out <file>');
  return a;
}

class UsageError extends Error {}

function humanReport(s: BuildSummary, out: string | null): string {
  const lines = [
    `mode: ${s.mode}  entries written: ${s.entries}${out ? `  -> ${out}` : ''}`,
    `roots (VFX prefabs): ${s.roots.total} ${JSON.stringify(s.roots.byOrigin)}`,
    `text assets read: ${s.textAssetsRead} in ${s.rounds} round(s); defined guids: ${s.definedGuids}`,
    `outside guids: ${s.outside}  builtin: ${s.builtin}  package: ${s.package.total}  unresolved: ${s.unresolved.total}`,
  ];
  for (const [k, v] of Object.entries(s.package.byPackage).sort()) lines.push(`  package ${k}: ${v}`);
  if (s.missingCaches.length) lines.push(`missing PackageCache roots (skipped): ${s.missingCaches.join(', ')}`);
  if (s.ambiguous.length) lines.push(`ambiguous (several versions, highest chosen): ${s.ambiguous.length}`);
  if (s.unresolved.total) {
    lines.push('UNRESOLVED (top 15 by reference count):');
    for (const u of s.unresolved.list.slice(0, 15)) lines.push(`  ${u.guid} x${u.referenced_by.length} assets, ${u.root_prefab_count} prefabs: ${u.root_prefabs.slice(0, 2).join(' , ')}`);
  }
  return lines.join('\n');
}

async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`package-guids: ${e.message}\n\n${HELP}`);
      return 2;
    }
    throw e;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const { specs, cacheRoots, missingCaches } = await specsFromPacks(args.packs, args.unitypackages);
  const built = await buildMap(specs, cacheRoots, { full: args.full, missingCaches });
  const out = args.out ?? PACKAGE_GUID_MAP_OUT;
  await writePackageGuidMap(out, built.entries);
  if (args.json) process.stdout.write(`${JSON.stringify(built.summary)}\n`);
  else process.stdout.write(`${humanReport(built.summary, out)}\n`);
  return 0;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`package-guids: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
