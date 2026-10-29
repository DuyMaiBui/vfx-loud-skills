import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tarEntries, openUnityPackage } from './tar.ts';

/**
 * Where a pack's assets come from. Every implementation exposes the same guid -> {path, asset} view, so
 * everything downstream (selection, extraction, skips, licence gate) is shared. Sources are read-only:
 * nothing here ever writes to the source.
 */

/** One asset with its `.meta` (the guid lives in the meta; installing the pair keeps the GUID, C6). */
export interface SourceFile {
  guid: string;
  /** Unity path (`Assets/...`) of the winning copy. */
  path: string;
  data: Buffer;
  /** The byte-exact `.meta`, or null when the source has none. */
  meta: Buffer | null;
}

/** One source that carried a guid, with the sha256 of the bytes it carried (D16). */
export interface CopyRef {
  origin: string;
  sha256: string;
}

export interface PackageSource {
  /** guid -> source path (Unity `Assets/...` form) and guid -> asset byte size. */
  index(): Promise<{ paths: Map<string, string>; assetSizes: Map<string, number> }>;
  /** Yields only assets for which `want(guid, size)` is true (data always set). */
  assets(want: (guid: string, size: number) => boolean): AsyncGenerator<{ guid: string; data: Buffer }>;
  /** Like `assets`, plus the `.meta` bytes (uploader + bundle: a file ships as the pair). */
  files(want: (guid: string, size: number) => boolean): AsyncGenerator<SourceFile>;
  /** Every source copy of this guid with its sha256, winner first (D16). [] when the guid is unknown. */
  copiesOf(guid: string): Promise<CopyRef[]>;
  /** Multi-root sources only: every game label that carries this guid, in configured order. Call after index(). */
  gamesOf?(guid: string): string[];
}

const guidOfEntry = (n: string): string => n.slice(0, n.indexOf('/'));
const sha256 = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');
/** Entries of a `.unitypackage` that make one asset: `<guid>/asset`, `<guid>/asset.meta`, `<guid>/pathname`. */
const PACKAGE_FILE_ENTRY = /\/(asset|asset\.meta|pathname)$/;

/** `.unitypackage` = gzip'd tar of <guid>/{asset,asset.meta,pathname}. */
export function tarSource(file: string): PackageSource {
  const origin = path.basename(file);

  const index = async () => {
    const paths = new Map<string, string>();
    const assetSizes = new Map<string, number>();
    for await (const e of tarEntries(openUnityPackage(file), (n, size) => {
      if (n.endsWith('/asset')) assetSizes.set(guidOfEntry(n), size);
      return n.endsWith('/pathname');
    })) {
      paths.set(guidOfEntry(e.name), e.data.toString('utf8').split('\n')[0].trim());
    }
    return { paths, assetSizes };
  };

  async function* assets(want: (guid: string, size: number) => boolean) {
    for await (const e of tarEntries(openUnityPackage(file), (n, size) => n.endsWith('/asset') && want(guidOfEntry(n), size))) {
      yield { guid: guidOfEntry(e.name), data: e.data };
    }
  }

  async function* files(want: (guid: string, size: number) => boolean): AsyncGenerator<SourceFile> {
    const { assetSizes } = await index();
    const wanted = new Set([...assetSizes].filter(([g, s]) => want(g, s)).map(([g]) => g));
    if (!wanted.size) return;
    const pending = new Map<string, { path?: string; data?: Buffer; meta?: Buffer }>();
    for await (const e of tarEntries(openUnityPackage(file), (n) => wanted.has(guidOfEntry(n)) && PACKAGE_FILE_ENTRY.test(n))) {
      const guid = guidOfEntry(e.name);
      const p = pending.get(guid) ?? {};
      pending.set(guid, p);
      if (e.name.endsWith('/asset')) p.data = e.data;
      else if (e.name.endsWith('/asset.meta')) p.meta = e.data;
      else p.path = e.data.toString('utf8').split('\n')[0].trim();
      // Yield as soon as the three entries are in; a `.meta` that never arrives is flushed at the end.
      if (p.path !== undefined && p.data !== undefined && p.meta !== undefined) {
        yield { guid, path: p.path, data: p.data, meta: p.meta };
        pending.delete(guid);
      }
    }
    for (const [guid, p] of pending) {
      if (p.path !== undefined && p.data !== undefined) yield { guid, path: p.path, data: p.data, meta: p.meta ?? null };
    }
  }

  return {
    index,
    assets,
    files,
    async copiesOf(guid) {
      const out: CopyRef[] = [];
      for await (const e of assets((g) => g === guid)) out.push({ origin, sha256: sha256(e.data) });
      return out;
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

/** A resolved folder asset: the winning absolute file, its Unity path and its size. */
interface Entry {
  file: string;
  path: string;
  size: number;
}

/** Yields the bytes of the entries for which `want(guid, size)` holds. Shared by both folder sources. */
async function* readFolderAssets(
  entries: Map<string, Entry>,
  want: (guid: string, size: number) => boolean,
): AsyncGenerator<{ guid: string; data: Buffer }> {
  for (const [guid, e] of entries) {
    if (want(guid, e.size)) yield { guid, data: await fs.readFile(e.file) };
  }
}

/** Like readFolderAssets, plus the `<file>.meta` bytes. */
async function* readFolderFiles(
  entries: Map<string, Entry>,
  want: (guid: string, size: number) => boolean,
): AsyncGenerator<SourceFile> {
  for (const [guid, e] of entries) {
    if (!want(guid, e.size)) continue;
    yield { guid, path: e.path, data: await fs.readFile(e.file), meta: await fs.readFile(`${e.file}.meta`) };
  }
}

/**
 * A loose, already-imported Unity folder: GUIDs come from each `<file>.meta`. `pathPrefix` is the
 * Unity path of `root` (e.g. "Assets/NamuFX") so paths match the `Assets/...` form of a package.
 */
export function folderSource(root: string, pathPrefix: string): PackageSource {
  const origin = path.basename(root);
  const entries = new Map<string, Entry>();
  let scanned: Promise<void> | null = null;

  const prepare = (): Promise<void> =>
    (scanned ??= (async () => {
      const result = await scanFolder(root, pathPrefix);
      if (result.duplicates.length) {
        const d = result.duplicates[0];
        throw new Error(`duplicate guid ${d.guid}: ${d.files.join(' , ')}`);
      }
      for (const a of result.assets) entries.set(a.guid, { file: a.file, path: a.path, size: a.size });
    })());

  return {
    async index() {
      await prepare();
      const paths = new Map<string, string>();
      const assetSizes = new Map<string, number>();
      for (const [guid, e] of entries) {
        paths.set(guid, e.path);
        assetSizes.set(guid, e.size);
      }
      return { paths, assetSizes };
    },
    async *assets(want) {
      await prepare();
      yield* readFolderAssets(entries, want);
    },
    async *files(want) {
      await prepare();
      yield* readFolderFiles(entries, want);
    },
    async copiesOf(guid) {
      await prepare();
      const e = entries.get(guid);
      return e ? [{ origin, sha256: sha256(await fs.readFile(e.file)) }] : [];
    },
  };
}

/** A game label and the root of its imported `Assets/` folder. */
export interface SourceRoot {
  game: string;
  root: string;
}

export interface FolderSetOptions {
  /**
   * Winner choice for a guid carried by several roots (D8): the FIRST copy for which this returns true
   * wins, else the first copy in configured order. Only consulted for guids with more than one copy.
   * Absent: first copy wins (the default, unchanged).
   */
  preferCopy?: (guid: string, bytes: Buffer) => boolean | Promise<boolean>;
}

/** One copy of a guid in one root (within-root non-prefab duplicates keep the first file, as scanFolder does). */
interface Copy extends Entry {
  game: string;
}

/**
 * Several loose Unity `Assets/` folders read as ONE pack (e.g. the seven studio game projects).
 * A guid present in more than one root is one asset: one copy wins its path and bytes (see
 * `preferCopy`); `gamesOf(guid)` still lists every root that carries it, in configured order, so the
 * record says where it lives. `copiesOf(guid)` lists every copy's sha256 (D16). Sources are read-only.
 */
export function folderSetSource(roots: SourceRoot[], pathPrefix: string, opts: FolderSetOptions = {}): PackageSource {
  if (!roots.length) throw new Error('folder set needs at least one root');
  const copies = new Map<string, Copy[]>(); // guid -> one copy per root that carries it, configured order
  const games = new Map<string, string[]>(); // guid -> game labels, configured order
  const winners = new Map<string, Entry>(); // guid -> winning copy
  let scanned: Promise<void> | null = null;

  const scanAll = async (): Promise<void> => {
    for (const { game, root } of roots) {
      const result = await scanFolder(root, pathPrefix);
      // A duplicate guid is fatal only when a prefab is involved: that prefab has no single identity.
      // Non-prefab duplicates (e.g. two .anim files sharing a guid) keep the first file in walk order.
      const prefabDupe = result.duplicates.find((d) => d.files.some((f) => f.endsWith('.prefab')));
      if (prefabDupe) {
        throw new Error(`game "${game}": duplicate guid on a prefab ${prefabDupe.guid}: ${prefabDupe.files.join(' , ')}`);
      }
      for (const a of result.assets) {
        const list = copies.get(a.guid) ?? [];
        list.push({ game, file: a.file, path: a.path, size: a.size });
        copies.set(a.guid, list);
        const seenIn = games.get(a.guid) ?? [];
        if (!seenIn.includes(game)) seenIn.push(game);
        games.set(a.guid, seenIn);
      }
    }
    for (const [guid, list] of copies) {
      let winner: Copy = list[0];
      if (opts.preferCopy && list.length > 1) {
        for (const c of list) {
          if (await opts.preferCopy(guid, await fs.readFile(c.file))) {
            winner = c;
            break;
          }
        }
      }
      winners.set(guid, winner);
    }
  };
  const prepare = (): Promise<void> => (scanned ??= scanAll());

  return {
    async index() {
      await prepare();
      const paths = new Map<string, string>();
      const assetSizes = new Map<string, number>();
      for (const [guid, e] of winners) {
        paths.set(guid, e.path);
        assetSizes.set(guid, e.size);
      }
      return { paths, assetSizes };
    },
    async *assets(want) {
      await prepare();
      yield* readFolderAssets(winners, want);
    },
    async *files(want) {
      await prepare();
      yield* readFolderFiles(winners, want);
    },
    async copiesOf(guid) {
      await prepare();
      const out: CopyRef[] = [];
      for (const c of copies.get(guid) ?? []) out.push({ origin: c.game, sha256: sha256(await fs.readFile(c.file)) });
      // Winner first (D16 ordering promise in the interface doc); the others follow in configured order.
      const winner = winners.get(guid);
      const i = out.findIndex((o, idx) => (copies.get(guid) ?? [])[idx].file === winner?.file);
      if (i > 0) out.unshift(...out.splice(i, 1));
      return out;
    },
    gamesOf: (guid) => games.get(guid) ?? [],
  };
}
