/**
 * Deterministic extractor: Unity VFX prefabs inside purchased `.unitypackage` files -> "extracted
 * recipe" records (type=recipe, meta.extracted=true). Reads the tarball directly, never imports into
 * Unity, never modifies the source, never copies texture/mesh/material/shader/audio/prefab bytes.
 * Output goes to --out as <pack>/<slug>.{json,yaml}; nothing is ingested into the database
 * (that is a separate, user-approved step — see seed/run.ts).
 *
 *   node seed/extract-unitypackage.ts --pack epic-toon-vfx-2 --limit 2 --out /tmp/vfx-smoke
 *   node seed/extract-unitypackage.ts --list-packs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { extractPack, type PackConfig } from './extract/pipeline.ts';
import { folderSource, tarSource, type PackageSource } from './extract/source.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE_DIR = process.env.VFX_UNITYPACKAGE_DIR ?? '/home/mike/Downloads/UnityPackages';

async function loadPacks(): Promise<PackConfig[]> {
  const raw = await fs.readFile(path.join(here, 'extract', 'packs.json'), 'utf8');
  return (JSON.parse(raw) as { packs: PackConfig[] }).packs;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      pack: { type: 'string' },
      limit: { type: 'string' },
      out: { type: 'string' },
      'source-dir': { type: 'string' },
      'source-path': { type: 'string' },
      'list-packs': { type: 'boolean' },
      'only-guids-from': { type: 'string' },
    },
    strict: true,
  });
  const packs = await loadPacks();

  if (values['list-packs']) {
    for (const p of packs) console.log(`${p.slug}\t${p.license}\t${p.vendor}\t${p.name}`);
    return;
  }
  const usage = 'usage: extract-unitypackage.ts --pack <slug> --out <dir> [--limit N] [--source-dir <dir> | --source-path <folder>] | --list-packs';
  if (!values.pack || !values.out) throw new Error(usage);
  const pack = packs.find((p) => p.slug === values.pack);
  if (!pack) throw new Error(`unknown pack "${values.pack}"; try --list-packs`);

  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive integer, got "${values.limit}"`);
  }
  let source: PackageSource;
  if (pack.sourceType === 'folder') {
    const root = values['source-path'] ?? pack.sourcePath;
    if (!root || !pack.pathPrefix) throw new Error(`pack "${pack.slug}" is a folder source: needs sourcePath (or --source-path) and pathPrefix`);
    await fs.access(root);
    source = folderSource(root, pack.pathPrefix);
  } else {
    if (!pack.file) throw new Error(`pack "${pack.slug}" has no file`);
    const packageFile = path.join(values['source-dir'] ?? DEFAULT_SOURCE_DIR, pack.file);
    await fs.access(packageFile); // fail loudly on a missing package
    source = tarSource(packageFile);
  }
  let onlyGuids: Set<string> | undefined;
  if (values['only-guids-from']) {
    const lines = (await fs.readFile(values['only-guids-from'], 'utf8')).split('\n').filter(Boolean);
    onlyGuids = new Set(lines.map((l) => (JSON.parse(l) as { prefabGuid: string }).prefabGuid));
  }
  const summary = await extractPack({
    onlyGuids,
    pack,
    source,
    outDir: path.resolve(values.out),
    limit,
    log: (l) => console.error(l),
  });
  console.log(
    `${summary.pack}: eligible=${summary.eligible} selected=${summary.selected} extracted=${summary.extracted} ` +
      `skipped=${summary.skipped.length} excluded=${JSON.stringify(summary.excluded)} ` +
      `total=${summary.timingsMs.total}ms (index ${summary.timingsMs.index} / materials ${summary.timingsMs.materials} / prefabs ${summary.timingsMs.prefabs})`,
  );
  // A skip is logged, never fatal: exit 0. A refused licence / bad args throws above -> exit 1.
}

main().catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exitCode = 1;
});
