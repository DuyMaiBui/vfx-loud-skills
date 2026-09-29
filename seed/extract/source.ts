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
      for await (const meta of walk(root)) {
        if (!meta.endsWith('.meta')) continue;
        const file = meta.slice(0, -'.meta'.length);
        const st = await fs.stat(file).catch(() => null);
        if (!st || !st.isFile()) continue; // folder metas describe directories, not assets
        const m = /^guid:\s*([0-9a-f]{32})\s*$/m.exec(await fs.readFile(meta, 'utf8'));
        if (!m) throw new Error(`no guid in ${meta}`);
        const guid = m[1];
        if (paths.has(guid)) throw new Error(`duplicate guid ${guid}: ${file}`);
        paths.set(guid, `${pathPrefix}/${path.relative(root, file).split(path.sep).join('/')}`);
        assetSizes.set(guid, st.size);
        files.set(guid, file);
      }
      return { paths, assetSizes };
    },
    async *assets(want) {
      for (const [guid, file] of files) {
        const size = (await fs.stat(file)).size;
        if (want(guid, size)) yield { guid, data: await fs.readFile(file) };
      }
    },
  };
}
