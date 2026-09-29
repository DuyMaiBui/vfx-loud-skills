/**
 * Knowledge-graph build. ONE idempotent command:  npm run graph:build [-- --dry-run] [--dump out.json]
 *
 * Derives, deterministically and only from data in the DB + seed/graph/*.json:
 *   variant_of  recipe -> canonical member of its colour/version family   (+ meta.family on every member)
 *   recolorable family verdict (recolorable.ts, same as recolor:validate) -> meta.recolorable / meta.recolorReason
 *               on every member of a family; a lone recipe gets neither
 *   pairs_with  muzzle / projectile / impact of one weapon set             (+ meta.pairRole, meta.pairSet)
 *   uses        recipe -> asset (material / texture / shader / mesh by GUID), asset table
 *   similar_to  recipe -> top-K recipes sharing materials/textures (Jaccard, weight)
 *   applies_to  technique / component / shader / code record -> recipes it applies to
 *
 * It computes the full desired state and applies only the DIFF, so a re-run changes nothing. It never
 * touches payload files, sha256, version, name, description, tags, search text or embedding of a record;
 * the only record column written is `meta` (family / pairRole / pairSet / recolorable / recolorReason keys).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { PoolClient } from 'pg';
import { config } from '../../server/src/config.ts';
import { migrate, pool } from '../../server/src/db.ts';
import { parsePayload } from '../extract/enrich.ts';
import { buildFamilies, type FamilyInput } from './family.ts';
import { pickTargets, type LinkableRecipe } from './knowledge.ts';
import { buildPairSets } from './pairs.ts';
import { evaluateFamily, recolorFlag, type FamilyMember, type Verdict } from './recolorable.ts';
import { analysePayload, type AssetRef } from './payload.ts';
import { loadKnowledgeLinks, loadRules } from './rules.ts';
import { topSimilar } from './similar.ts';

interface RecipeRow {
  id: number;
  uri: string;
  slug: string;
  name: string;
  storage_uri: string;
  license: string;
  meta: Record<string, unknown> & { extracted?: boolean; pack?: string; source?: { prefabPath?: string }; facets?: Record<string, unknown>; keywords?: string[]; family?: string };
}
interface KnowledgeRow {
  id: number;
  uri: string;
  type: string;
  slug: string;
}

const OWNED_RELS = ['variant_of', 'pairs_with', 'similar_to', 'applies_to'] as const;
const META_KEYS = ['family', 'pairRole', 'pairSet', 'recolorable', 'recolorReason'] as const;

interface Delta {
  inserted: number;
  deleted: number;
  updated: number;
}
const zero = (): Delta => ({ inserted: 0, deleted: 0, updated: 0 });

/** Key-sorted JSON, so jsonb round-trips compare equal. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

interface DesiredAsset {
  guid: string;
  kind: string;
  name: string;
  path: string | null;
  pack: string;
  license: string;
  external: boolean;
  meta: Record<string, unknown>;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, dump: { type: 'string' } }, strict: true });
  const rules = loadRules();
  await migrate();

  // Records made by the recolor transform (meta.derived) are outputs, not corpus: they carry a derived_from
  // edge of their own and must not be pulled into families, similarity or knowledge links.
  const recipes = (await pool.query<RecipeRow>("SELECT id, uri, slug, name, storage_uri, license, meta FROM resource WHERE type = 'recipe' AND NOT (meta ? 'derived') ORDER BY id")).rows;
  const byUri = new Map(recipes.map((r) => [r.uri, r]));
  const extracted = recipes.filter((r) => r.meta.extracted === true && r.meta.source?.prefabPath && r.meta.pack);

  /* ---- 1. analyse payloads once ---- */
  const facts = new Map<number, ReturnType<typeof analysePayload>>();
  for (const r of extracted) {
    const yaml = await fs.readFile(path.join(config.dataDir, r.storage_uri), 'utf8');
    facts.set(r.id, analysePayload(yaml, { assets: rules.assets, versionTokenPattern: rules.family.versionTokenPattern }));
  }

  /* ---- 2. families ---- */
  const famInputs: FamilyInput[] = extracted.map((r) => ({
    uri: r.uri,
    slug: r.slug,
    name: r.name,
    pack: String(r.meta.pack),
    prefabPath: String(r.meta.source?.prefabPath),
    nodeCount: facts.get(r.id)!.nodeCount,
    signature: facts.get(r.id)!.signature,
  }));
  const { families, stats: familyStats } = buildFamilies(famInputs, rules.family);
  const familyOf = new Map<string, string>(); // uri -> family key
  const canonicalOf = new Map<string, string>();
  for (const f of families) for (const u of f.members) (familyOf.set(u, f.key), canonicalOf.set(u, f.canonical));

  /* ---- 3. pairs ---- */
  const { sets, skippedTooLarge } = buildPairSets(
    extracted.map((r) => ({ uri: r.uri, slug: r.slug, name: r.name, pack: String(r.meta.pack) })),
    rules.pairs,
  );
  const pairRole = new Map<string, { role: string; set: string }>();
  const pairEdges: Array<[string, string]> = [];
  for (const s of sets) {
    for (const m of s.members) pairRole.set(m.uri, { role: m.role, set: s.key });
    for (let i = 0; i < s.members.length; i++) {
      for (let j = i + 1; j < s.members.length; j++) if (s.members[i].role !== s.members[j].role) pairEdges.push([s.members[i].uri, s.members[j].uri]);
    }
  }

  /* ---- 4. assets ---- */
  const builtin = new RegExp(rules.assets.builtinGuidPattern);
  const desiredAssets = new Map<string, DesiredAsset>();
  const recipeAssets = new Map<string, Set<string>>(); // uri -> asset keys
  for (const r of extracted) {
    const set = new Set<string>();
    for (const a of facts.get(r.id)!.assets) {
      const key = `${a.kind}:${a.guid}`;
      set.add(key);
      const have = desiredAssets.get(key);
      if (!have) desiredAssets.set(key, toAsset(a, String(r.meta.pack), r.license, builtin));
      else if (have.path === null && a.path) Object.assign(have, { path: a.path, external: false, name: nameOf(a) });
    }
    recipeAssets.set(r.uri, set);
  }

  /* ---- 5. similar_to (ids of recipes) ---- */
  const idOf = new Map(recipes.map((r) => [r.uri, r.id]));
  const uriOfId = new Map(recipes.map((r) => [r.id, r.uri]));
  const simSets = new Map<number, Set<string>>();
  for (const [uri, set] of recipeAssets) {
    const keep = new Set([...set].filter((k) => rules.similarity.kinds.includes(k.split(':')[0]) && !desiredAssets.get(k)!.meta.builtin && !desiredAssets.get(k)!.external));
    if (keep.size) simSets.set(idOf.get(uri)!, keep);
  }
  const similar = topSimilar(
    simSets,
    (id) => byUri.get(uriOfId.get(id)!)!.slug,
    (a, b) => {
      const fa = familyOf.get(uriOfId.get(a)!);
      return fa !== undefined && fa === familyOf.get(uriOfId.get(b)!);
    },
    rules.similarity,
  );

  /* ---- 6. applies_to ---- */
  const knowledge = (
    await pool.query<KnowledgeRow>(
      `SELECT DISTINCT ON (type, slug) id, uri, type, slug FROM resource
        WHERE type IN ('technique','component','shader','code') ORDER BY type, slug, version DESC`,
    )
  ).rows;
  const linkable: LinkableRecipe[] = recipes.map((r) => ({
    uri: r.uri,
    slug: r.slug,
    pack: String(r.meta.pack ?? ''),
    handWritten: r.meta.extracted !== true,
    family: familyOf.get(r.uri) ?? null,
    canonical: canonicalOf.get(r.uri) === r.uri,
    facets: r.meta.facets ?? {},
    keywords: Array.isArray(r.meta.keywords) ? r.meta.keywords : [],
  }));
  const appliesTo: Array<[string, string]> = [];
  const unresolved: string[] = [];
  for (const link of loadKnowledgeLinks()) {
    const k = knowledge.find((x) => `${x.type}/${x.slug}` === link.ref);
    if (!k) {
      unresolved.push(link.ref);
      continue;
    }
    for (const target of pickTargets(linkable, link, rules.knowledge.maxPerKnowledge)) appliesTo.push([k.uri, target]);
  }
  const allIds = new Map([...idOf, ...knowledge.map((k) => [k.uri, k.id] as const)]);

  /* ---- desired edges: key "src|dst|rel" -> weight ---- */
  const desiredEdges = new Map<string, number | null>();
  const addEdge = (srcUri: string, dstUri: string, rel: string, w: number | null): void => {
    desiredEdges.set(`${allIds.get(srcUri)}|${allIds.get(dstUri)}|${rel}`, w);
  };
  for (const f of families) for (const u of f.members) if (u !== f.canonical) addEdge(u, f.canonical, 'variant_of', 1);
  for (const [a, b] of pairEdges) {
    const [x, y] = allIds.get(a)! < allIds.get(b)! ? [a, b] : [b, a];
    addEdge(x, y, 'pairs_with', 1);
  }
  for (const s of similar) desiredEdges.set(`${s.src}|${s.dst}|similar_to`, s.jaccard);
  for (const [k, r] of appliesTo) addEdge(k, r, 'applies_to', null);

  /* ---- recolour verdict per family (shared with recolor:validate) ---- */
  const byUriExtracted = new Map(extracted.map((r) => [r.uri, r]));
  const loadMember = async (uri: string): Promise<FamilyMember> => {
    const r = byUriExtracted.get(uri)!;
    const yaml = await fs.readFile(path.join(config.dataDir, r.storage_uri), 'utf8');
    return { uri, parsed: parsePayload(yaml), facts: facts.get(r.id)! };
  };
  const recolorOf = new Map<string, { recolorable: boolean; recolorReason: string }>(); // family key -> flag
  const verdicts: Record<Verdict, number> = { good: 0, partial: 0, poor: 0, unmeasured: 0 };
  for (const f of families) {
    // canonical is the lowest slug, and members[0] — the same base the study recolours.
    const [base, ...rest] = await Promise.all(f.members.map(loadMember));
    const { family } = evaluateFamily(f.key, base, rest);
    verdicts[family.verdict]++;
    recolorOf.set(f.key, recolorFlag(family));
  }

  /* ---- desired meta patches ---- */
  const desiredMeta = new Map<number, Record<string, string | boolean>>();
  for (const r of extracted) {
    const p: Record<string, string | boolean> = {};
    const fam = familyOf.get(r.uri);
    if (fam) Object.assign(p, { family: fam }, recolorOf.get(fam));
    const pr = pairRole.get(r.uri);
    if (pr) Object.assign(p, { pairRole: pr.role, pairSet: pr.set });
    desiredMeta.set(r.id, p);
  }

  /* ---- apply the diff ---- */
  const before = await edgeCounts();
  const delta = { assets: zero(), resourceAsset: zero(), edges: zero(), meta: zero() };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyAssets(client, desiredAssets, delta.assets);
    const assetIds = new Map((await client.query<{ id: number; guid: string; kind: string }>('SELECT id, guid, kind FROM asset')).rows.map((a) => [`${a.kind}:${a.guid}`, a.id]));
    await applyResourceAssets(client, recipeAssets, idOf, assetIds, delta.resourceAsset);
    await applyEdges(client, desiredEdges, delta.edges);
    await applyMeta(client, recipes, desiredMeta, delta.meta);
    if (values['dry-run']) await client.query('ROLLBACK');
    else await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const after = await edgeCounts();

  if (values.dump) {
    await fs.writeFile(values.dump, JSON.stringify({ families, sets }, null, 1));
  }
  const totalChanges = Object.values(delta).reduce((s, d) => s + d.inserted + d.deleted + d.updated, 0);
  const assetKinds: Record<string, number> = {};
  for (const a of desiredAssets.values()) assetKinds[a.kind] = (assetKinds[a.kind] ?? 0) + 1;
  console.log(
    JSON.stringify(
      {
        mode: values['dry-run'] ? 'dry-run (rolled back)' : 'applied',
        derived: {
          families: families.length,
          familyCandidates: familyStats,
          familyMembers: families.reduce((s, f) => s + f.members.length, 0),
          recolorVerdicts: verdicts,
          pairSets: sets.length,
          pairSetsSkippedTooLarge: skippedTooLarge,
          assets: desiredAssets.size,
          assetsByKind: assetKinds,
          assetsExternal: [...desiredAssets.values()].filter((a) => a.external).length,
          recipeAssetLinks: [...recipeAssets.values()].reduce((s, x) => s + x.size, 0),
          similarEdges: similar.length,
          appliesToEdges: appliesTo.length,
          unresolvedKnowledgeRefs: unresolved,
        },
        delta,
        edgesBefore: before,
        edgesAfter: after,
        totalChanges,
      },
      null,
      1,
    ),
  );
  console.log(totalChanges === 0 ? 'graph:build no-op (0 changes)' : `graph:build changed ${totalChanges} rows`);
  await pool.end();
}

function nameOf(a: AssetRef): string {
  return a.path ? (a.path.split('/').pop() as string).replace(/\.[^.]+$/, '') : `external-${a.guid.slice(0, 8)}`;
}

function toAsset(a: AssetRef, pack: string, license: string, builtin: RegExp): DesiredAsset {
  const meta: Record<string, unknown> = { builtin: builtin.test(a.guid) };
  if (a.shader) meta.shader = a.shader;
  if (a.textures) meta.textures = a.textures;
  return { guid: a.guid, kind: a.kind, name: nameOf(a), path: a.path, pack, license, external: a.external, meta };
}

async function edgeCounts(): Promise<Record<string, number>> {
  const r = await pool.query<{ rel: string; n: string }>('SELECT rel, COUNT(*) AS n FROM resource_edge GROUP BY rel ORDER BY rel');
  const out: Record<string, number> = Object.fromEntries(r.rows.map((x) => [x.rel, Number(x.n)]));
  const ra = await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM resource_asset');
  const a = await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM asset');
  return { ...out, 'recipe->asset uses (resource_asset)': Number(ra.rows[0].n), 'asset rows': Number(a.rows[0].n) };
}

async function applyAssets(c: PoolClient, desired: Map<string, DesiredAsset>, d: Delta): Promise<void> {
  const cur = new Map(
    (await c.query<DesiredAsset & { id: number }>('SELECT id, guid, kind, name, path, pack, license, external, meta FROM asset')).rows.map((a) => [`${a.kind}:${a.guid}`, a]),
  );
  const ins: DesiredAsset[] = [];
  for (const [k, a] of desired) {
    const have = cur.get(k);
    if (!have) ins.push(a);
    else if (have.name !== a.name || have.path !== a.path || have.pack !== a.pack || have.license !== a.license || have.external !== a.external || stable(have.meta) !== stable(a.meta)) {
      await c.query('UPDATE asset SET name=$2, path=$3, pack=$4, license=$5, external=$6, meta=$7::jsonb WHERE id=$1', [have.id, a.name, a.path, a.pack, a.license, a.external, JSON.stringify(a.meta)]);
      d.updated++;
    }
  }
  const stale = [...cur].filter(([k]) => !desired.has(k)).map(([, a]) => a.id);
  if (stale.length) {
    await c.query('DELETE FROM asset WHERE id = ANY($1::bigint[])', [stale]);
    d.deleted += stale.length;
  }
  for (let i = 0; i < ins.length; i += 2000) {
    const part = ins.slice(i, i + 2000);
    await c.query(
      `INSERT INTO asset (guid, kind, name, path, pack, license, external, meta)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::boolean[], $8::jsonb[])`,
      [part.map((a) => a.guid), part.map((a) => a.kind), part.map((a) => a.name), part.map((a) => a.path), part.map((a) => a.pack), part.map((a) => a.license), part.map((a) => a.external), part.map((a) => JSON.stringify(a.meta))],
    );
    d.inserted += part.length;
  }
}

async function applyResourceAssets(c: PoolClient, recipeAssets: Map<string, Set<string>>, idOf: Map<string, number>, assetIds: Map<string, number>, d: Delta): Promise<void> {
  const want = new Set<string>();
  for (const [uri, keys] of recipeAssets) for (const k of keys) want.add(`${idOf.get(uri)}|${assetIds.get(k)}`);
  const cur = new Set((await c.query<{ k: string }>("SELECT resource_id || '|' || asset_id AS k FROM resource_asset")).rows.map((r) => r.k));
  const ins = [...want].filter((k) => !cur.has(k)).map((k) => k.split('|').map(Number));
  const del = [...cur].filter((k) => !want.has(k)).map((k) => k.split('|').map(Number));
  for (let i = 0; i < ins.length; i += 5000) {
    const p = ins.slice(i, i + 5000);
    await c.query('INSERT INTO resource_asset (resource_id, asset_id) SELECT * FROM unnest($1::bigint[], $2::bigint[])', [p.map((x) => x[0]), p.map((x) => x[1])]);
  }
  for (let i = 0; i < del.length; i += 5000) {
    const p = del.slice(i, i + 5000);
    await c.query('DELETE FROM resource_asset ra USING unnest($1::bigint[], $2::bigint[]) AS v(r, a) WHERE ra.resource_id = v.r AND ra.asset_id = v.a', [p.map((x) => x[0]), p.map((x) => x[1])]);
  }
  d.inserted += ins.length;
  d.deleted += del.length;
}

async function applyEdges(c: PoolClient, desired: Map<string, number | null>, d: Delta): Promise<void> {
  const cur = new Map(
    (await c.query<{ k: string; weight: number | null }>("SELECT src || '|' || dst || '|' || rel AS k, weight FROM resource_edge WHERE rel = ANY($1::text[])", [[...OWNED_RELS]])).rows.map((r) => [r.k, r.weight]),
  );
  const rows = (keys: string[]): { s: number[]; t: number[]; r: string[]; w: Array<number | null> } => ({
    s: keys.map((k) => Number(k.split('|')[0])),
    t: keys.map((k) => Number(k.split('|')[1])),
    r: keys.map((k) => k.split('|')[2]),
    w: keys.map((k) => desired.get(k) ?? null),
  });
  const differs = (a: number | null | undefined, b: number | null): boolean => (a === null || a === undefined || b === null ? (a ?? null) !== b : Math.abs(a - b) > 1e-6);
  const ins = [...desired.keys()].filter((k) => !cur.has(k));
  const upd = [...desired.keys()].filter((k) => cur.has(k) && differs(cur.get(k), desired.get(k) ?? null));
  const del = [...cur.keys()].filter((k) => !desired.has(k));
  for (const keys of [ins, upd]) {
    for (let i = 0; i < keys.length; i += 5000) {
      const p = rows(keys.slice(i, i + 5000));
      await c.query(
        `INSERT INTO resource_edge (src, dst, rel, weight) SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::real[])
         ON CONFLICT (src, dst, rel) DO UPDATE SET weight = EXCLUDED.weight`,
        [p.s, p.t, p.r, p.w],
      );
    }
  }
  for (let i = 0; i < del.length; i += 5000) {
    const p = rows(del.slice(i, i + 5000));
    await c.query('DELETE FROM resource_edge e USING unnest($1::bigint[], $2::bigint[], $3::text[]) AS v(s, t, r) WHERE e.src = v.s AND e.dst = v.t AND e.rel = v.r', [p.s, p.t, p.r]);
  }
  d.inserted += ins.length;
  d.updated += upd.length;
  d.deleted += del.length;
}

async function applyMeta(c: PoolClient, recipes: RecipeRow[], desired: Map<number, Record<string, string | boolean>>, d: Delta): Promise<void> {
  const ids: number[] = [];
  const patches: string[] = [];
  for (const r of recipes) {
    const want = desired.get(r.id);
    if (!want) continue;
    const have = Object.fromEntries(META_KEYS.filter((k) => r.meta[k] !== undefined).map((k) => [k, r.meta[k]]));
    if (stable(have) === stable(want)) continue;
    ids.push(r.id);
    patches.push(JSON.stringify(want));
  }
  for (let i = 0; i < ids.length; i += 1000) {
    await c.query(
      `UPDATE resource r SET meta = (r.meta - 'family' - 'pairRole' - 'pairSet' - 'recolorable' - 'recolorReason') || v.patch
         FROM unnest($1::bigint[], $2::jsonb[]) AS v(id, patch) WHERE r.id = v.id`,
      [ids.slice(i, i + 1000), patches.slice(i, i + 1000)],
    );
  }
  d.updated += ids.length;
}

main().catch((e) => {
  console.error(`error: ${(e as Error).stack ?? e}`);
  process.exitCode = 1;
});
