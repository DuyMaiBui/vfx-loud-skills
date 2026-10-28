import fs from 'node:fs/promises';
import path from 'node:path';
import { tarEntries, openUnityPackage } from './tar.ts';

/**
 * Where a pack's assets come from. Both implementations expose the same guid -> {path, asset}
 * view, so everything downstream (selection, extraction, skips, licence gate) is shared.
 * Sources are read-only: nothing here ever writes to the source.
 */
export interface PackageSource {
  /** guid -> source path (Unity `Assets/...` form) and guid -> asset byte size. */
  index(): Promise<{ paths: Map<string, string>; assetSizes: Map<string, number> }>;
  /** Yields only assets for which `want(guid, size)` is true (data always set). */
  assets(want: (guid: string, size: number) => boolean): AsyncGenerator<{ guid: string; data: Buffer }>;
  /** Multi-root sources only: every game label that carries this guid, in configured order (first = winner). */
  gamesOf?(guid: string): string[];
}

const guidOfEntry = (n: string): string => n.slice(0, n.indexOf('/'));

/** `.unitypackage` = gzip'd tar of <guid>/{asset,asset.meta,pathname}. */
export function tarSource(file: string): PackageSource {
  return {
    async index() {
      const paths = new Map<string, string>();
      const assetSizes = new Map<string, number>();
      for await (const e of tarEntries(openUnityPackage(file), (n, size) => {
        if (n.endsWith('/asset')) assetSizes.set(guidOfEntry(n), size);
        return n.endsWith('/pathname');
      })) {
        paths.set(guidOfEntry(e.name), e.data.toString('utf8').split('\n')[0].trim());
      }
      return { paths, assetSizes };
    },
    async *assets(want) {
      for await (const e of tarEntries(openUnityPackage(file), (n, size) => n.endsWith('/asset') && want(guidOfEntry(n), size))) {
        yield { guid: guidOfEntry(e.name), data: e.data };
      }
    },
  };
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const d of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) yield* walk(p);
    else yield p;
  }
}

interface FolderAsset {
  guid: string;
  path: string;
  file: string;
  size: number;
}

interface ScannedFolder {
  assets: FolderAsset[];
  /** guid -> every Unity path carrying it, when more than one file in this root shares it. */
  duplicates: Array<{ guid: string; files: string[] }>;
}

/**
 * Every asset (file with a sibling .meta) under `root`, in walk order. A guid already seen in this root is
 * reported in `duplicates` and NOT returned again: the first file in walk order keeps it.
 */
async function scanFolder(root: string, pathPrefix: string): Promise<ScannedFolder> {
  const out: FolderAsset[] = [];
  const dupes = new Map<string, string[]>();
  const seen = new Map<string, string>(); // guid -> first Unity path
  for await (const meta of walk(root)) {
    if (!meta.endsWith('.meta')) continue;
    const file = meta.slice(0, -'.meta'.length);
    const st = await fs.stat(file).catch(() => null);
    if (!st || !st.isFile()) continue; // folder metas describe directories, not assets
    const m = /^guid:\s*([0-9a-f]{32})\s*$/m.exec(await fs.readFile(meta, 'utf8'));
    if (!m) throw new Error(`no guid in ${meta}`);
    const guid = m[1];
    const unityPath = `${pathPrefix}/${path.relative(root, file).split(path.sep).join('/')}`;
    const first = seen.get(guid);
    if (first !== undefined) {
      dupes.set(guid, [...(dupes.get(guid) ?? [first]), unityPath]);
      continue;
    }
    seen.set(guid, unityPath);
    out.push({ guid, path: unityPath, file, size: st.size });
  }
  return { assets: out, duplicates: [...dupes].map(([guid, files]) => ({ guid, files })) };
}

/** Yields the bytes of the indexed files for which `want(guid, size)` holds. Shared by both folder sources. */
async function* readFolderAssets(
  files: Map<string, string>,
  want: (guid: string, size: number) => boolean,
): AsyncGenerator<{ guid: string; data: Buffer }> {
  for (const [guid, file] of files) {
    const size = (await fs.stat(file)).size;
    if (want(guid, size)) yield { guid, data: await fs.readFile(file) };
  }
}

/**
 * A loose, already-imported Unity folder: GUIDs come from each `<file>.meta`. `pathPrefix` is the
 * Unity path of `root` (e.g. "Assets/NamuFX") so paths match the `Assets/...` form of a package.
 */
export function folderSource(root: string, pathPrefix: string): PackageSource {
  const files = new Map<string, string>(); // guid -> absolute file
  return {
    async index() {
      const paths = new Map<string, string>();
      const assetSizes = new Map<string, number>();
      const scanned = await scanFolder(root, pathPrefix);
      if (scanned.duplicates.length) {
        const d = scanned.duplicates[0];
        throw new Error(`duplicate guid ${d.guid}: ${d.files.join(' , ')}`);
      }
      for (const a of scanned.assets) {
        paths.set(a.guid, a.path);
        assetSizes.set(a.guid, a.size);
        files.set(a.guid, a.file);
      }
      return { paths, assetSizes };
    },
    assets: (want) => readFolderAssets(files, want),
  };
}

/** A game label and the root of its imported `Assets/` folder. */
export interface SourceRoot {
  game: string;
  root: string;
}

/**
 * Several loose Unity `Assets/` folders read as ONE pack (e.g. the seven studio game projects).
 * A guid present in more than one root is one asset: the first root in configured order wins its
 * path and bytes; `gamesOf(guid)` still lists every root that carries it, so the record says where
 * it lives. Sources are read-only.
 */
export function folderSetSource(roots: SourceRoot[], pathPrefix: string): PackageSource {
  if (!roots.length) throw new Error('folder set needs at least one root');
  const files = new Map<string, string>(); // guid -> absolute file (winning root)
  const games = new Map<string, string[]>(); // guid -> game labels, configured order
  return {
    async index() {
      const paths = new Map<string, string>();
      const assetSizes = new Map<string, number>();
      for (const { game, root } of roots) {
        const scanned = await scanFolder(root, pathPrefix);
        // A duplicate guid is fatal only when a prefab is involved: that prefab has no single identity.
        // Non-prefab duplicates (e.g. two .anim files sharing a guid) keep the first file in walk order.
        const prefabDupe = scanned.duplicates.find((d) => d.files.some((f) => f.endsWith('.prefab')));
        if (prefabDupe) {
          throw new Error(`game "${game}": duplicate guid on a prefab ${prefabDupe.guid}: ${prefabDupe.files.join(' , ')}`);
        }
        for (const a of scanned.assets) {
          const seenIn = games.get(a.guid);
          if (seenIn) {
            if (!seenIn.includes(game)) seenIn.push(game);
            continue;
          }
          games.set(a.guid, [game]);
          paths.set(a.guid, a.path);
          assetSizes.set(a.guid, a.size);
          files.set(a.guid, a.file);
        }
      }
      return { paths, assetSizes };
    },
    gamesOf: (guid) => games.get(guid) ?? [],
    assets: (want) => readFolderAssets(files, want),
  };
}
