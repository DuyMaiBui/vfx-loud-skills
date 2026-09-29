import { createHash } from 'node:crypto';
import { coreName } from '../../server/src/search-doc.ts';
import { stemTokens } from './payload.ts';
import type { GraphRules } from './rules.ts';

export interface FamilyInput {
  uri: string;
  slug: string;
  name: string;
  pack: string;
  prefabPath: string;
  nodeCount: number;
  signature: string;
}

export interface Family {
  key: string;
  canonical: string; // uri of the lowest slug
  members: string[]; // uris, canonical first, then slug order
}

/** Folder of the prefab (below /Prefabs/), colour + version words dropped per segment: "Impact v3" -> "impact". */
export function folderKey(prefabPath: string, r: GraphRules['family']): string {
  const rel = prefabPath.split('/Prefabs/').slice(1).join('/Prefabs/') || prefabPath;
  return rel
    .split('/')
    .slice(0, -1)
    .map((seg) => stemTokens(seg, r.versionTokenPattern, r.stripTokens).join('-'))
    .filter(Boolean)
    .join('/');
}

export function stemOf(name: string, r: GraphRules['family']): string {
  return stemTokens(coreName(name), r.versionTokenPattern, r.stripTokens).join('-');
}

/**
 * Deterministic variant families: same pack + folder + name stem, confirmed by identical node count and
 * node signature. A candidate group whose members disagree structurally splits by signature; only
 * structurally identical sub-groups of >= minMembers become a family.
 */
export interface FamilyStats {
  /** name-stem groups with >= minMembers before the structural check */
  candidateGroups: number;
  candidateMembers: number;
  /** candidate groups the structural check split or shrank */
  groupsChangedByStructure: number;
}

export function buildFamilies(items: FamilyInput[], r: GraphRules['family']): { families: Family[]; stats: FamilyStats } {
  const groups = new Map<string, FamilyInput[]>();
  for (const it of items) {
    const stem = stemOf(it.name, r);
    if (!stem) continue;
    const base = `${it.pack}:${folderKey(it.prefabPath, r)}:${stem}`;
    (groups.get(base) ?? groups.set(base, []).get(base)!).push(it);
  }
  const out: Family[] = [];
  const stats: FamilyStats = { candidateGroups: 0, candidateMembers: 0, groupsChangedByStructure: 0 };
  for (const [base, members] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const bySig = new Map<string, FamilyInput[]>();
    for (const m of members) {
      const sig = `${m.nodeCount}#${m.signature}`;
      (bySig.get(sig) ?? bySig.set(sig, []).get(sig)!).push(m);
    }
    if (members.length >= r.minMembers) {
      stats.candidateGroups++;
      stats.candidateMembers += members.length;
      if (bySig.size > 1) stats.groupsChangedByStructure++;
    }
    const multi = bySig.size > 1;
    for (const [sig, ms] of bySig) {
      if (ms.length < r.minMembers || ms.length > r.maxMembers) continue;
      const sorted = [...ms].sort((a, b) => (a.slug < b.slug ? -1 : 1));
      const key = multi ? `${base}~${createHash('sha1').update(sig).digest('hex').slice(0, 6)}` : base;
      out.push({ key, canonical: sorted[0].uri, members: sorted.map((m) => m.uri) });
    }
  }
  return { families: out, stats };
}
