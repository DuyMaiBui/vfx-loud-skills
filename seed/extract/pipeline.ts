import fs from 'node:fs/promises';
import path from 'node:path';
import { extractedLicenseProblem, licenseClassOf, aiTrainingAllowed } from '../../server/src/license.ts';
import { SLUG_RE } from '../../server/src/slug.ts';
import { tarEntries, openUnityPackage } from './tar.ts';
import { buildRecipe, SkipError, type PackInfo } from './recipe.ts';

export interface PackConfig extends PackInfo {
  slug: string;
  file: string;
  license: string;
  style: string[];
  tags: string[];
  /** When set, only prefabs under one of these path prefixes are eligible. */
  prefabRoots?: string[];
}

export interface ExtractOptions {
  pack: PackConfig;
  packageFile: string;
  outDir: string;
  limit?: number;
  /** Prefab assets above this many bytes are skipped with a logged reason. */
  maxPrefabBytes?: number;
  log?: (line: string) => void;
}

export interface SkipEntry {
  pack: string;
  prefabPath: string;
  prefabGuid: string;
  code: string;
  reason: string;
}

export interface RecordSummary {
  slug: string;
  prefabPath: string;
  prefabGuid: string;
  particleNodes: number;
  gameObjects: number;
  yamlBytes: number;
  ms: number;
}

export interface PackSummary {
  pack: string;
  packSlug: string;
  license: string;
  eligible: number;
  eligibleBytes: number;
  excluded: Record<string, number>;
  selected: number;
  extracted: number;
  skipped: SkipEntry[];
  records: RecordSummary[];
  timingsMs: { index: number; materials: number; prefabs: number; total: number };
}

const DEFAULT_MAX_PREFAB_BYTES = 32 * 1024 * 1024;

/* ---------------------------------------------------------------- selection */

export type Exclusion = 'not-a-prefab' | 'not-in-prefabs-folder' | 'demo' | 'outside-prefab-roots';

/** Why a package path is NOT an extraction candidate, or null when it is. */
export function classifyPath(p: string, pack: Pick<PackConfig, 'prefabRoots'>): Exclusion | null {
  if (!p.endsWith('.prefab')) return 'not-a-prefab';
  const segs = p.split('/');
  if (segs.some((s) => /demo/i.test(s))) return 'demo';
  if (!segs.slice(0, -1).includes('Prefabs')) return 'not-in-prefabs-folder';
  if (pack.prefabRoots && !pack.prefabRoots.some((r) => p.startsWith(r))) return 'outside-prefab-roots';
  return null;
}

export function slugify(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Deterministic slugs for a whole eligible set: `<pack>-<prefab>`, guid suffix only on collision. */
export function assignSlugs(
  packSlug: string,
  items: Array<{ path: string; guid: string }>,
): Map<string, string> {
  const base = (i: { path: string }): string =>
    `${packSlug}-${slugify(path.posix.basename(i.path, '.prefab')) || 'prefab'}`;
  const counts = new Map<string, number>();
  for (const i of items) counts.set(base(i), (counts.get(base(i)) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const i of items) {
    const b = base(i);
    const slug = (counts.get(b) ?? 0) > 1 ? `${b}-${i.guid.slice(0, 6)}` : b;
    if (!SLUG_RE.test(slug)) throw new Error(`generated invalid slug "${slug}" for ${i.path}`);
    out.set(i.guid, slug);
  }
  return out;
}

const STOP = new Set(['the', 'and', 'fx', 'vfx', 'prefab', 'prefabs']);

export function tagsFor(prefabPath: string, pack: PackConfig): string[] {
  const rel = prefabPath.split('/Prefabs/').slice(1).join('/Prefabs/') || prefabPath;
  const segs = rel.replace(/\.prefab$/, '').split('/');
  const tokens = segs
    .flatMap((s) => slugify(s).split('-'))
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
  return [...new Set([...tokens, ...pack.tags, 'extracted', 'particle'])].slice(0, 8);
}

/* ---------------------------------------------------------------- pipeline */

export async function extractPack(opts: ExtractOptions): Promise<PackSummary> {
  const { pack } = opts;
  const log = opts.log ?? (() => undefined);
  const t0 = performance.now();

  // Refuse before touching anything: no resolvable licence -> no records, never a default.
  const licenseProblem = extractedLicenseProblem(pack.license);
  if (licenseProblem) throw new Error(`pack "${pack.name}": ${licenseProblem} — refusing to extract`);
  const licenseClass = licenseClassOf(pack.license);

  // Pass 1 — path index (tiny `pathname` entries only) + asset sizes.
  const paths = new Map<string, string>();
  const assetSizes = new Map<string, number>();
  const guidOf = (n: string): string => n.slice(0, n.indexOf('/'));
  for await (const e of tarEntries(openUnityPackage(opts.packageFile), (n, size) => {
    if (n.endsWith('/asset')) assetSizes.set(guidOf(n), size);
    return n.endsWith('/pathname');
  })) {
    paths.set(guidOf(e.name), e.data.toString('utf8').split('\n')[0].trim());
  }
  const tIndex = performance.now();

  const excluded: Record<string, number> = {};
  const eligible: Array<{ path: string; guid: string }> = [];
  for (const [guid, p] of paths) {
    const why = classifyPath(p, pack);
    if (why === null) eligible.push({ path: p, guid });
    else if (why !== 'not-a-prefab') excluded[why] = (excluded[why] ?? 0) + 1;
  }
  eligible.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const slugs = assignSlugs(pack.slug, eligible);
  const selected = opts.limit === undefined ? eligible : eligible.slice(0, opts.limit);
  const selectedGuids = new Map(selected.map((s) => [s.guid, s.path]));
  const eligibleBytes = eligible.reduce((n, e) => n + (assetSizes.get(e.guid) ?? 0), 0);
  log(`[${pack.slug}] indexed ${paths.size} assets, eligible prefabs=${eligible.length}, selected=${selected.length}`);

  // Pass 2 — Material assets (small YAML) so material -> shader/texture GUIDs can be referenced.
  const materials = new Map<string, string>();
  for await (const e of tarEntries(openUnityPackage(opts.packageFile), (n) => {
    if (!n.endsWith('/asset')) return false;
    return (paths.get(guidOf(n)) ?? '').endsWith('.mat');
  })) {
    materials.set(guidOf(e.name), e.data.toString('utf8'));
  }
  const tMat = performance.now();

  // Pass 3 — the selected prefabs, one at a time (bounded memory).
  const maxBytes = opts.maxPrefabBytes ?? DEFAULT_MAX_PREFAB_BYTES;
  const skipped: SkipEntry[] = [];
  const records: RecordSummary[] = [];
  const outDir = path.join(opts.outDir, pack.slug);
  await fs.mkdir(outDir, { recursive: true });
  const ctx = {
    pathOf: (g: string): string | undefined => paths.get(g),
    materialText: (g: string): string | undefined => materials.get(g),
  };
  const seenGuids = new Set<string>();
  const skip = (guid: string, code: string, reason: string): void => {
    const prefabPath = selectedGuids.get(guid) ?? '';
    skipped.push({ pack: pack.name, prefabPath, prefabGuid: guid, code, reason });
    log(`  SKIP ${prefabPath} [${code}] ${reason}`);
  };

  const expected = selected.filter((s) => {
    const size = assetSizes.get(s.guid);
    return size !== undefined && size <= maxBytes;
  }).length;
  const wantAsset = (n: string): boolean => n.endsWith('/asset') && selectedGuids.has(guidOf(n));
  // Oversized prefabs are never read into memory.
  for await (const e of tarEntries(openUnityPackage(opts.packageFile), (n, size) => wantAsset(n) && size <= maxBytes)) {
    const guid = guidOf(e.name);
    seenGuids.add(guid);
    const prefabPath = selectedGuids.get(guid) as string;
    const started = performance.now();
    try {
      const built = buildRecipe(e.data.toString('utf8'), pack, { path: prefabPath, guid }, ctx);
      const slug = slugs.get(guid) as string;
      const record = {
        type: 'recipe',
        slug,
        name: `${built.prefabName} (${pack.name})`,
        description:
          `Extracted particle recipe of ${pack.vendor} "${pack.name}" prefab ${built.prefabName}: ` +
          `${built.particleNodeCount} particle node(s), duration ${built.summary.durationMax}s, ` +
          `${built.summary.loops ? 'looping' : 'one-shot'}. Parameters only; textures, materials and shaders are guid + path references.`,
        tags: tagsFor(prefabPath, pack),
        style: pack.style,
        category: 'recipe',
        license: pack.license,
        visibility: 'project',
        fileName: `${slug}.yaml`,
        meta: {
          source: { pack: pack.name, vendor: pack.vendor, prefabPath, prefabGuid: guid },
          extracted: true,
          extractor: 'unitypackage-recipe/1',
          pack: pack.slug,
          license_class: licenseClass,
          ai_training: aiTrainingAllowed(pack.license),
          particle_nodes: built.particleNodeCount,
        },
        inline: built.yaml,
      };
      // Complete record or nothing: temp file then rename, so a crash never leaves a partial.
      const base = path.join(outDir, slug);
      await fs.writeFile(`${base}.yaml.tmp`, built.yaml);
      await fs.writeFile(`${base}.json.tmp`, `${JSON.stringify(record, null, 2)}\n`);
      await fs.rename(`${base}.yaml.tmp`, `${base}.yaml`);
      await fs.rename(`${base}.json.tmp`, `${base}.json`);
      const ms = Math.round(performance.now() - started);
      records.push({
        slug,
        prefabPath,
        prefabGuid: guid,
        particleNodes: built.particleNodeCount,
        gameObjects: built.nodeCount,
        yamlBytes: Buffer.byteLength(built.yaml),
        ms,
      });
      log(`  OK   ${prefabPath} nodes=${built.particleNodeCount} ${ms}ms`);
    } catch (err) {
      if (err instanceof SkipError) skip(guid, err.code, err.message);
      else skip(guid, 'unexpected-error', (err as Error).message);
    }
    if (seenGuids.size >= expected) break; // everything wanted has been read; stop scanning the tar
  }
  records.sort((a, b) => (a.prefabPath < b.prefabPath ? -1 : 1));
  skipped.sort((a, b) => (a.prefabPath < b.prefabPath ? -1 : 1));
  // Selected prefabs never yielded: oversized (header seen in pass 1) or no asset body at all.
  for (const [guid] of selectedGuids) {
    if (seenGuids.has(guid)) continue;
    const size = assetSizes.get(guid);
    if (size === undefined) skip(guid, 'missing-asset', 'pathname present but no asset entry in package');
    else skip(guid, 'asset-too-large', `${size} bytes > ${maxBytes}`);
  }

  await fs.writeFile(
    path.join(outDir, 'skipped.jsonl'),
    skipped.map((s) => JSON.stringify(s)).join('\n') + (skipped.length ? '\n' : ''),
  );
  const tEnd = performance.now();
  const summary: PackSummary = {
    pack: pack.name,
    packSlug: pack.slug,
    license: pack.license,
    eligible: eligible.length,
    eligibleBytes,
    excluded,
    selected: selected.length,
    extracted: records.length,
    skipped,
    records,
    timingsMs: {
      index: Math.round(tIndex - t0),
      materials: Math.round(tMat - tIndex),
      prefabs: Math.round(tEnd - tMat),
      total: Math.round(tEnd - t0),
    },
  };
  await fs.writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}
