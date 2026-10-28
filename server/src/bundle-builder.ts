/**
 * Bundle builder (vfx-bytes/1, C3 closure route, C4). Roots: the recipe's `meta.source.prefabGuid` (resolved
 * through `asset_file`) plus the legacy `resource_edge uses` closure (`origin:"resource"`). The reachable graph is
 * loaded breadth-first over `refs` (ONE scanner, unity-refs.ts, ran at registration), then emitted dependencies
 * first by a deterministic DFS post-order (C4 ordering), the root file last.
 */
import {
  KIND_RANK,
  kindOfPath,
  BUNDLE_SCHEMA,
  type Bundle,
  type BundleFile,
  type Kind,
  type Variant,
} from './bundle-contract.ts';
import { config } from './config.ts';
import { pool } from './db.ts';
import { VfxError } from './errors.ts';
import * as store from './store.ts';
import { classifyGuid, isDangling, loadDanglingGuids, loadPackageGuids, scanRefs, type DanglingEntry, type PackageEntry } from './unity-refs.ts';

const GUID_RE = /^[0-9a-f]{32}$/;

interface FileRow {
  guid: string;
  variant: Variant;
  kind: Kind;
  path: string;
  asset_sha256: string;
  meta_sha256: string | null;
  refs: string[];
  pack: string;
  license: string;
  urp: { rule?: string } | null;
  asset_bytes: string;
  meta_bytes: string | null;
}

const FILE_SQL = `SELECT f.guid, f.variant, f.kind, f.path, f.asset_sha256, f.meta_sha256, f.refs, f.pack, f.license, f.urp,
                         a.bytes AS asset_bytes, m.bytes AS meta_bytes
                    FROM asset_file f JOIN asset_blob a ON a.sha256 = f.asset_sha256
                    LEFT JOIN asset_blob m ON m.sha256 = f.meta_sha256`;

/** Install location of a pack file: the whole relative structure survives under the pack folder (C4). */
export function targetPathOf(pack: string, filePath: string): string {
  return `Assets/VFXCloud/${pack}/${filePath.replace(/^Assets\//, '')}`;
}

function toBundleFile(r: FileRow): BundleFile {
  const urpConverted = r.variant === 'urp';
  return {
    guid: r.guid,
    origin: 'asset_file',
    kind: r.kind,
    variant: r.variant,
    urp_converted: urpConverted,
    urp_rule: urpConverted ? (r.urp?.rule ?? 'urp') : null,
    path: r.path,
    target_path: targetPathOf(r.pack, r.path),
    pack: r.pack,
    license: r.license,
    sha256: r.asset_sha256,
    bytes: Number(r.asset_bytes),
    download_url: store.absoluteUrl(`/v1/blob/${r.asset_sha256}`),
    meta_sha256: r.meta_sha256,
    meta_bytes: r.meta_sha256 ? Number(r.meta_bytes ?? 0) : 0,
    meta_download_url: r.meta_sha256 ? store.absoluteUrl(`/v1/blob/${r.meta_sha256}`) : null,
  };
}

/** One registered file as a `BundleFile` (GET /v1/asset-file/:guid); null when that (guid, variant) is unknown. */
export async function assetFileBundleFile(guid: string, variant: Variant): Promise<BundleFile | null> {
  const r = await pool.query<FileRow>(`${FILE_SQL} WHERE f.guid = $1 AND f.variant = $2`, [guid, variant]);
  return r.rows[0] ? toBundleFile(r.rows[0]) : null;
}

/** A node of the in-memory graph: a shippable file and the guids it references. */
interface Node {
  key: string;
  guid: string | null;
  file: BundleFile;
  refs: string[];
}

function resourceNode(item: store.ClosureItem, refs: string[]): Node {
  const guid = item.unity?.guid && GUID_RE.test(item.unity.guid.toLowerCase()) ? item.unity.guid.toLowerCase() : null;
  const file: BundleFile = {
    guid,
    origin: 'resource',
    kind: kindOfPath(item.file_name),
    variant: 'original',
    urp_converted: false,
    urp_rule: null,
    path: item.unity?.path ?? item.target_hint,
    target_path: item.target_hint,
    pack: 'resource',
    license: item.license,
    sha256: item.sha256,
    bytes: item.bytes,
    download_url: item.download_url,
    meta_sha256: null,
    meta_bytes: 0,
    meta_download_url: null,
  };
  return { key: `resource:${item.uri}`, guid, file, refs };
}

/** Every key the output is always complete for: arrays never null (C4). */
function emptyBundle(uri: string, variant: Variant, rootGuid: string | null, reason: Bundle['reason']): Bundle {
  return {
    schema: BUNDLE_SCHEMA,
    uri,
    variant,
    root_guid: rootGuid,
    complete: false,
    reason,
    files: [],
    requires: [],
    unresolved: [],
    dangling: [],
    cycles: [],
    file_count: 0,
    total_bytes: 0,
  };
}

/** Per material guid the `urp` row wins under variant=urp; every other kind is `original` (C4). */
function chooseRows(rows: FileRow[], variant: Variant): Map<string, FileRow> {
  const originals = new Map(rows.filter((r) => r.variant === 'original').map((r) => [r.guid, r]));
  const chosen = new Map(originals);
  if (variant === 'urp') for (const r of rows) if (r.variant === 'urp' && r.kind === 'material') chosen.set(r.guid, r);
  return chosen;
}

/** Closure items of the resource graph as nodes, with refs scanned from their stored payload bytes. */
async function resourceNodes(uri: string, root: store.ResourceRow): Promise<Node[]> {
  const items = await store.closure(uri);
  if (root.type !== 'recipe') {
    // a non-recipe root IS the file the caller wants (texture, shader, ...): it ships as the last resource file
    const m = await store.resolve(uri);
    items.push({
      uri: m.uri, type: m.type, slug: m.slug, version: m.version, file_name: m.file_name, sha256: m.sha256, bytes: m.bytes,
      license: m.license, download_url: m.download_url, target_hint: store.targetHint(m),
      unity: m.meta.unity ? (m.meta.unity as store.ClosureItem['unity']) : null,
    });
  }
  const nodes: Node[] = [];
  for (const item of items) {
    const { buffer } = await store.readFile(item.uri);
    const own = item.unity?.guid?.toLowerCase();
    nodes.push(resourceNode(item, scanRefs(buffer, own)));
  }
  return nodes;
}

function prefabGuidOf(row: store.ResourceRow): string | null {
  const source = (row.meta as { source?: { prefabGuid?: unknown } } | null)?.source;
  const g = typeof source?.prefabGuid === 'string' ? source.prefabGuid.toLowerCase() : '';
  return GUID_RE.test(g) ? g : null;
}

/** Build the C4 `Bundle` for a record URI. `not_found` for an unknown record, `invalid` past `bundleMaxFiles`. */
export async function buildBundle(
  uri: string,
  variant: Variant,
  packageMap: Map<string, PackageEntry> = loadPackageGuids(),
  danglingMap: Map<string, DanglingEntry> = loadDanglingGuids(),
): Promise<Bundle> {
  const root = await store.getByUri(uri);
  const prefabGuid = prefabGuidOf(root);
  const resNodes = await resourceNodes(uri, root);

  // ---- load the reachable graph (BFS over refs of the CHOSEN rows) ----
  const byGuid = new Map<string, Node>();
  const referencedBy = new Map<string, Set<string>>(); // missing guid -> referencing file guids
  const seen = new Set<string>();
  let frontier: string[] = [];
  const schedule = (guid: string, from: string | null): void => {
    if (!seen.has(guid)) {
      seen.add(guid);
      frontier.push(guid);
      referencedBy.set(guid, new Set());
    }
    if (from) referencedBy.get(guid)!.add(from);
  };
  for (const n of resNodes) for (const g of n.refs) schedule(g, n.guid);
  if (prefabGuid) schedule(prefabGuid, null);

  const overflow = (count: number): VfxError =>
    new VfxError(`bundle exceeds ${config.bundleMaxFiles} files`, 'invalid', { file_count: count, max: config.bundleMaxFiles });

  while (frontier.length) {
    const wave = frontier;
    frontier = [];
    const r = await pool.query<FileRow>(`${FILE_SQL} WHERE f.guid = ANY($1)`, [wave]);
    const chosen = chooseRows(r.rows, variant);
    for (const [guid, row] of chosen) {
      byGuid.set(guid, { key: guid, guid, file: toBundleFile(row), refs: row.refs });
      if (byGuid.size + resNodes.length > config.bundleMaxFiles) throw overflow(byGuid.size + resNodes.length);
      for (const ref of row.refs) schedule(ref, guid);
    }
  }

  // ---- reasons: nothing shippable ----
  if (prefabGuid && !byGuid.has(prefabGuid)) return emptyBundle(uri, variant, prefabGuid, 'bytes_not_uploaded');
  if (!prefabGuid && resNodes.length === 0) return emptyBundle(uri, variant, null, 'no_prefab');

  // ---- classify guids that are not shipped ----
  const requires = new Map<string, Bundle['requires'][number]>();
  const unresolved = new Map<string, Set<string>>();
  const dangling = new Map<string, Set<string>>();
  for (const [guid, refSet] of referencedBy) {
    if (byGuid.has(guid)) continue;
    const cls = classifyGuid(guid, packageMap);
    const by = [...refSet].sort();
    if (cls.kind === 'unresolved') {
      // dangling only when every referrer is a shipped pack file; a root (resource file, the recipe prefab) is never a shipped pack file
      const referrers = [...refSet].map((g) => ({ pack: byGuid.get(g)?.file.pack ?? null }));
      (isDangling(guid, referrers, danglingMap) && guid !== prefabGuid ? dangling : unresolved).set(guid, refSet);
    }
    else requires.set(guid, { guid, kind: cls.kind, name: cls.name, package: cls.package, version: cls.version, referenced_by: by });
  }

  // ---- deterministic DFS post-order, dependencies first, root last ----
  // a resource file whose guid is also a registered asset_file is shipped once, as the asset_file
  const res = resNodes.filter((n) => !(n.guid && byGuid.has(n.guid)));
  const kidsOf = (node: Node): Node[] =>
    node.refs
      .filter((g) => byGuid.has(g))
      .map((g) => byGuid.get(g)!)
      .sort((a, b) => KIND_RANK[a.file.kind] - KIND_RANK[b.file.kind] || (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0));
  const order: Node[] = [];
  const cycles: string[][] = [];
  const cycleSeen = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (node: Node): void => {
    state.set(node.key, 1);
    stack.push(node.key);
    for (const kid of kidsOf(node)) {
      const s = state.get(kid.key);
      if (s === 2) continue;
      if (s === 1) {
        const cyc = stack.slice(stack.indexOf(kid.key));
        const id = [...cyc].sort().join('|');
        if (!cycleSeen.has(id)) {
          cycleSeen.add(id);
          cycles.push(cyc);
        }
        continue;
      }
      visit(kid);
    }
    stack.pop();
    state.set(node.key, 2);
    order.push(node);
  };
  for (const n of res) if (!state.has(n.key)) visit(n);
  if (prefabGuid && !state.has(prefabGuid)) visit(byGuid.get(prefabGuid)!);

  const files = order.map((n) => n.file);
  if (files.length > config.bundleMaxFiles) throw overflow(files.length);
  return {
    schema: BUNDLE_SCHEMA,
    uri,
    variant,
    root_guid: prefabGuid,
    complete: unresolved.size === 0,
    reason: null,
    files,
    requires: [...requires.values()].sort((a, b) => (a.guid < b.guid ? -1 : 1)),
    unresolved: [...unresolved].sort(([a], [b]) => (a < b ? -1 : 1)).map(([guid, by]) => ({ guid, referenced_by: [...by].sort() })),
    dangling: [...dangling].sort(([a], [b]) => (a < b ? -1 : 1)).map(([guid, by]) => ({ guid, referenced_by: [...by].sort() })),
    cycles,
    file_count: files.length,
    total_bytes: files.reduce((s, f) => s + f.bytes + f.meta_bytes, 0),
  };
}

