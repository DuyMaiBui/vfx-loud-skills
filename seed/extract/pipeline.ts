import fs from 'node:fs/promises';
import path from 'node:path';
import { extractedLicenseProblem, licenseClassOf, aiTrainingAllowed, type Visibility } from '../../server/src/license.ts';
import { SLUG_RE } from '../../server/src/slug.ts';
import { folderSetSource, tarSource, type PackageSource } from './source.ts';
import { enrichExtracted } from './enrich.ts';
import { buildRecipe, SkipError, type PackInfo } from './recipe.ts';
import { buildNestedReport, isNestedOutcome, type NestedEntry } from './nested.ts';
import { unfixableScriptsFor, type UnfixableEntry } from './unfixable-scripts.ts';

export interface PackConfig extends PackInfo {
  slug: string;
  /** `.unitypackage` file name (default source type). */
  file?: string;
  /**
   * 'folder' = one loose imported Unity folder (sourcePath + pathPrefix).
   * 'folder-set' = several loose Unity Assets folders read as one pack (sourceRoots + pathPrefix), deduped by guid.
   */
  sourceType?: 'unitypackage' | 'folder' | 'folder-set';
  sourcePath?: string;
  /** folder-set only: one entry per game project, in dedupe-priority order (first wins). */
  sourceRoots?: Array<{ game: string; path: string }>;
  /** Unity path of the folder root, e.g. "Assets/NamuFX". */
  pathPrefix?: string;
  license: string;
  /** The source holds every asset the prefabs reference (read from packs.json, never hardcoded by slug). */
  completeSource?: boolean;
  style: string[];
  tags: string[];
  /** When set, only prefabs under one of these path prefixes are eligible. */
  prefabRoots?: string[];
  /**
   * 'prefabs-folder' (default): a prefab must sit in a `Prefabs/` folder. 'vfx-components': any prefab
   * (folder-agnostic) that carries a ParticleSystem or VisualEffect component.
   */
  prefabSelect?: 'prefabs-folder' | 'vfx-components';
  /**
   * Unity path prefixes whose prefabs belong to a third-party pack (already ingested or not ours): never
   * republished under this pack's licence.
   */
  excludePathPrefixes?: string[];
  /** Pack-level style words stored as meta.style (toon / retro / sci-fi / low-poly / stylized). */
  metaStyle?: string[];
  /** Visibility every record of this pack carries (default `project`; never `global`, the ingest refuses it). */
  visibility?: Visibility;
}

export interface ExtractOptions {
  pack: PackConfig;
  /** Either a `.unitypackage` file or an explicit source (e.g. a folder). */
  packageFile?: string;
  source?: PackageSource;
  outDir: string;
  limit?: number;
  /** When set, only these prefab GUIDs are considered (slugs are still computed over the full eligible set). */
  onlyGuids?: Set<string>;
  /** Prefab assets above this many bytes are skipped with a logged reason. */
  maxPrefabBytes?: number;
  /** Recipes to skip as `unfixable-script` (from `unfixable-scripts.json`); only entries of this pack apply. */
  unfixableScripts?: UnfixableEntry[];
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
  /** Extra copies folded away by guid dedupe across roots (games carrying an already-counted guid). */
  duplicatesCollapsed: number;
  skipped: SkipEntry[];
  /** Skip counts per reason (a `code:<detail>` is counted under `code`). */
  skippedByReason: Record<string, number>;
  /** Prefabs that were variants (flattened) or nested-prefab skips; empty when the pack has none. */
  nested: NestedEntry[];
  records: RecordSummary[];
  timingsMs: { index: number; materials: number; prefabs: number; total: number };
}

const DEFAULT_MAX_PREFAB_BYTES = 32 * 1024 * 1024;

/* ---------------------------------------------------------------- selection */

export type Exclusion =
  | 'not-a-prefab'
  | 'not-in-prefabs-folder'
  | 'demo'
  | 'third-party-pack'
  | 'outside-prefab-roots'
  | 'no-vfx-component'
  | 'variant-of-excluded-base';

/** True when a prefab's YAML carries a ParticleSystem (classID 198) or VisualEffect (VFX Graph) component. */
export function hasVfxComponent(prefabYaml: string): boolean {
  return /^--- !u!198 /m.test(prefabYaml) || /VisualEffect/.test(prefabYaml);
}

/** Why a package path is NOT an extraction candidate, or null when it is. */
export function classifyPath(
  p: string,
  pack: Pick<PackConfig, 'prefabRoots' | 'excludePathPrefixes' | 'prefabSelect'>,
): Exclusion | null {
  if (!p.endsWith('.prefab')) return 'not-a-prefab';
  const segs = p.split('/');
  if (segs.some((s) => /demo/i.test(s))) return 'demo';
  // vfx-components packs select by content (see extractPack), not by folder name.
  if (pack.prefabSelect !== 'vfx-components' && !segs.slice(0, -1).includes('Prefabs')) return 'not-in-prefabs-folder';
  if (pack.excludePathPrefixes?.some((x) => p.startsWith(x))) return 'third-party-pack';
  if (pack.prefabRoots && !pack.prefabRoots.some((r) => p.startsWith(r))) return 'outside-prefab-roots';
  return null;
}

/**
 * D8 winner choice for a guid carried by several game roots: the first copy that actually holds a
 * ParticleSystem / VisualEffect wins (a VFX-free copy of the same guid must not hide the real effect).
 */
export const preferVfxCopy = (_guid: string, bytes: Buffer): boolean => hasVfxComponent(bytes.toString('utf8'));

/** The multi-root source of a `folder-set` pack, wired with the D8 winner rule. */
export function folderSetSourceFor(pack: Pick<PackConfig, 'slug' | 'sourceRoots' | 'pathPrefix'>): PackageSource {
  if (!pack.sourceRoots?.length || !pack.pathPrefix) {
    throw new Error(`pack "${pack.slug}" is a folder-set source: needs sourceRoots and pathPrefix`);
  }
  return folderSetSource(
    pack.sourceRoots.map((r) => ({ game: r.game, root: r.path })),
    pack.pathPrefix,
    { preferCopy: preferVfxCopy },
  );
}

const PURE_VARIANT_BASE = /^--- !u!1001 [\s\S]*?m_SourcePrefab: \{fileID: \d+, guid: ([0-9a-f]{32})/m;

/** Base guid of a prefab that is only a variant (a PrefabInstance and no GameObject of its own), else undefined. */
export function pureVariantBase(prefabYaml: string): string | undefined {
  if (/^--- !u!1 /m.test(prefabYaml)) return undefined;
  return PURE_VARIANT_BASE.exec(prefabYaml)?.[1];
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

export function tagsFor(prefabPath: string, pack: PackConfig, kind: 'particle' | 'effect' = 'particle'): string[] {
  const rel = prefabPath.split('/Prefabs/').slice(1).join('/Prefabs/') || prefabPath;
  const segs = rel.replace(/\.prefab$/, '').split('/');
  const tokens = segs
    .flatMap((s) => slugify(s).split('-'))
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
  return [...new Set([...tokens, ...pack.tags, 'extracted', kind === 'effect' ? 'effect' : 'particle'])].slice(0, 8);
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

  const source = opts.source ?? (opts.packageFile ? tarSource(opts.packageFile) : undefined);
  if (!source) throw new Error(`pack "${pack.name}": no source (packageFile or source required)`);
  // Pass 1 — path index (paths + asset sizes only).
  const { paths, assetSizes } = await source.index();
  const tIndex = performance.now();

  const excluded: Record<string, number> = {};
  let eligible: Array<{ path: string; guid: string }> = [];
  const nestedBaseGuids = new Set<string>(); // bases of selected variants: their text is read for flattening
  for (const [guid, p] of paths) {
    const why = classifyPath(p, pack);
    if (why === null) eligible.push({ path: p, guid });
    else if (why !== 'not-a-prefab') excluded[why] = (excluded[why] ?? 0) + 1;
  }
  // vfx-components selection: a path-eligible prefab must carry a ParticleSystem / VisualEffect component.
  // Only candidate bodies are read (oversized ones are left to the size skip, never read here).
  if (pack.prefabSelect === 'vfx-components') {
    const maxBytes = opts.maxPrefabBytes ?? DEFAULT_MAX_PREFAB_BYTES;
    const candidate = new Set(eligible.map((e) => e.guid));
    const withVfx = new Set<string>();
    const variantBase = new Map<string, string>(); // pure variant guid -> base guid
    for await (const e of source.assets((g, size) => candidate.has(g) && size <= maxBytes)) {
      const text = e.data.toString('utf8');
      if (hasVfxComponent(text)) withVfx.add(e.guid);
      else {
        const base = pureVariantBase(text);
        if (base) variantBase.set(e.guid, base);
      }
    }
    // A variant carries no ParticleSystem itself: it is selected when its base is a selected VFX prefab (D9).
    const variants = [...variantBase].filter(([, base]) => withVfx.has(base));
    for (const [guid, base] of variants) {
      withVfx.add(guid);
      nestedBaseGuids.add(base);
    }
    // A variant of a VFX prefab that was itself excluded (third-party / demo) is named, not lumped with no-vfx.
    const outside = [...variantBase].filter(([, base]) => !withVfx.has(base) && !candidate.has(base) && paths.has(base));
    const outsideBases = new Set(outside.map(([, base]) => base));
    const vfxOutside = new Set<string>();
    if (outsideBases.size) {
      for await (const e of source.assets((g) => outsideBases.has(g))) {
        if (hasVfxComponent(e.data.toString('utf8'))) vfxOutside.add(e.guid);
      }
    }
    const variantOutside = outside.filter(([, base]) => vfxOutside.has(base)).length;
    const oversized = eligible.filter((e) => (assetSizes.get(e.guid) ?? 0) > maxBytes).length;
    const dropped = eligible.length - withVfx.size - oversized - variantOutside;
    if (dropped > 0) excluded['no-vfx-component'] = dropped;
    if (variantOutside > 0) excluded['variant-of-excluded-base'] = variantOutside;
    eligible = eligible.filter((e) => withVfx.has(e.guid) || (assetSizes.get(e.guid) ?? 0) > maxBytes);
  }
  const duplicatesCollapsed = source.gamesOf
    ? eligible.reduce((n, e) => n + Math.max(0, (source.gamesOf?.(e.guid).length ?? 1) - 1), 0)
    : 0;
  eligible.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const slugs = assignSlugs(pack.slug, eligible);
  const candidates = opts.onlyGuids ? eligible.filter((e) => opts.onlyGuids?.has(e.guid)) : eligible;
  const selected = opts.limit === undefined ? candidates : candidates.slice(0, opts.limit);
  const selectedGuids = new Map(selected.map((s) => [s.guid, s.path]));
  const eligibleBytes = eligible.reduce((n, e) => n + (assetSizes.get(e.guid) ?? 0), 0);
  log(`[${pack.slug}] indexed ${paths.size} assets, eligible prefabs=${eligible.length}, selected=${selected.length}`);

  // Pass 2 — Material assets (small YAML) so material -> shader/texture GUIDs can be referenced.
  const materials = new Map<string, string>();
  for await (const e of source.assets((g) => (paths.get(g) ?? '').endsWith('.mat'))) {
    materials.set(e.guid, e.data.toString('utf8'));
  }
  const tMat = performance.now();

  // Pass 3 — the selected prefabs, one at a time (bounded memory).
  const maxBytes = opts.maxPrefabBytes ?? DEFAULT_MAX_PREFAB_BYTES;
  const skipped: SkipEntry[] = [];
  const records: RecordSummary[] = [];
  const outDir = path.join(opts.outDir, pack.slug);
  await fs.mkdir(outDir, { recursive: true });
  const baseTexts = new Map<string, string>();
  if (nestedBaseGuids.size) {
    for await (const e of source.assets((g) => nestedBaseGuids.has(g))) baseTexts.set(e.guid, e.data.toString('utf8'));
  }
  const ctx = {
    pathOf: (g: string): string | undefined => paths.get(g),
    materialText: (g: string): string | undefined => materials.get(g),
    prefabText: (g: string): string | undefined => baseTexts.get(g),
  };
  const nestedEntries: NestedEntry[] = [];
  const seenGuids = new Set<string>();
  const unfixable = new Map((opts.unfixableScripts ?? []).filter((u) => u.pack === pack.slug).map((u) => [u.prefabGuid, u]));
  const skip = (guid: string, code: string, reason: string): void => {
    const prefabPath = selectedGuids.get(guid) ?? '';
    skipped.push({ pack: pack.name, prefabPath, prefabGuid: guid, code, reason });
    if (isNestedOutcome(code)) nestedEntries.push({ prefabPath, prefabGuid: guid, outcome: code });
    log(`  SKIP ${prefabPath} [${code}] ${reason}`);
  };

  const expected = selected.filter((s) => {
    const size = assetSizes.get(s.guid);
    return size !== undefined && size <= maxBytes;
  }).length;
  // Oversized prefabs are never read into memory.
  for await (const e of source.assets((g, size) => selectedGuids.has(g) && size <= maxBytes)) {
    const guid = e.guid;
    seenGuids.add(guid);
    const prefabPath = selectedGuids.get(guid) as string;
    const started = performance.now();
    try {
      const text = e.data.toString('utf8');
      const bad = unfixableScriptsFor(unfixable.get(guid), text);
      if (bad) {
        // A re-run must reproduce the skip: drop a record an earlier run wrote for this slug.
        const stale = path.join(outDir, slugs.get(guid) as string);
        for (const ext of ['.yaml', '.json']) await fs.rm(`${stale}${ext}`, { force: true });
        throw new SkipError(bad.cause, `prefab renders nothing because of script(s) the target cannot run (game code not shipped, or UIParticle-driven emitters): ${bad.scripts.map((s) => s.name).join(', ')}`);
      }
      const built = buildRecipe(text, pack, { path: prefabPath, guid }, ctx);
      const slug = slugs.get(guid) as string;
      const recordName = `${built.prefabName} (${pack.name})`;
      const en = enrichExtracted({
        name: recordName,
        prefabPath,
        packName: pack.name,
        vendor: pack.vendor,
        metaStyle: pack.metaStyle ?? pack.style,
        kind: built.kind,
        effectKinds: built.effectKinds,
        yaml: built.yaml,
        existingTags: tagsFor(prefabPath, pack, built.kind),
        bundleComplete: pack.completeSource === true,
      });
      // D8: when several game copies of this guid differ, say which bytes each carried.
      const gamesOfGuid = source.gamesOf?.(guid) ?? [];
      const copyRefs = gamesOfGuid.length > 1 ? await source.copiesOf(guid) : [];
      const copies = new Set(copyRefs.map((c) => c.sha256)).size > 1 ? copyRefs.map((c) => ({ game: c.origin, sha256: c.sha256 })) : [];
      if (built.nested) {
        nestedEntries.push({ prefabPath, prefabGuid: guid, outcome: 'flattened', baseGuid: built.nested.baseGuid, overrides: built.nested.overrides });
      }
      const record = {
        type: 'recipe',
        slug,
        name: recordName,
        description: en.description,
        tags: en.tags,
        style: en.style,
        category: 'recipe',
        license: pack.license,
        visibility: pack.visibility ?? 'project',
        fileName: `${slug}.yaml`,
        meta: {
          source: {
            pack: pack.name,
            vendor: pack.vendor,
            prefabPath,
            prefabGuid: guid,
            ...(source.gamesOf ? { games: source.gamesOf(guid) } : {}),
            ...(copies.length ? { copies } : {}),
            ...(built.nested ? { variantOf: built.nested.baseGuid, overrides: built.nested.overrides } : {}),
          },
          extracted: true,
          extractor: 'unitypackage-recipe/1',
          pack: pack.slug,
          style: en.style,
          keywords: en.keywords,
          facets: en.facets,
          ...(en.behavior ? { behavior: en.behavior } : {}),
          license_class: licenseClass,
          ai_training: aiTrainingAllowed(pack.license),
          ...(built.kind === 'effect'
            ? { effect_nodes: built.effectNodeCount, effectKinds: built.effectKinds }
            : { particle_nodes: built.particleNodeCount }),
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
  if (nestedEntries.length) {
    const report = buildNestedReport(nestedEntries);
    await fs.writeFile(path.join(opts.outDir, 'nested-report.json'), `${JSON.stringify({ pack: pack.slug, ...report }, null, 2)}\n`);
  }
  const skippedByReason: Record<string, number> = {};
  for (const s of skipped) skippedByReason[s.code.split(':')[0]] = (skippedByReason[s.code.split(':')[0]] ?? 0) + 1;
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
    duplicatesCollapsed,
    skipped,
    skippedByReason,
    nested: nestedEntries.sort((a, b) => (a.prefabPath < b.prefabPath ? -1 : 1)),
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
