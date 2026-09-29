import type { KnowledgeLink } from './rules.ts';

export interface LinkableRecipe {
  uri: string;
  slug: string;
  pack: string;
  handWritten: boolean;
  family: string | null;
  canonical: boolean;
  facets: Record<string, unknown>;
  keywords: string[];
}

/** Values within a facet OR, facets AND (same semantics as /v1/search `filters`). */
export function matches(r: LinkableRecipe, match: Record<string, string[]>): boolean {
  return Object.entries(match).every(([name, vals]) => {
    if (name === 'keywords') return r.keywords.some((k) => vals.includes(k));
    const v = r.facets[name];
    const have = Array.isArray(v) ? (v as string[]) : typeof v === 'string' ? [v] : [];
    return have.some((x) => vals.includes(x));
  });
}

/** Hand-written first, then family canonicals / singletons, round-robin across packs, capped. */
export function pickTargets(all: LinkableRecipe[], link: KnowledgeLink, cap: number): string[] {
  const hit = all.filter((r) => matches(r, link.match) && (r.handWritten || r.family === null || r.canonical));
  const hand = hit.filter((r) => r.handWritten).sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const byPack = new Map<string, LinkableRecipe[]>();
  for (const r of hit.filter((x) => !x.handWritten).sort((a, b) => (a.slug < b.slug ? -1 : 1))) {
    (byPack.get(r.pack) ?? byPack.set(r.pack, []).get(r.pack)!).push(r);
  }
  const lanes = [...byPack].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, xs]) => xs);
  const out = hand.map((r) => r.uri);
  for (let i = 0; out.length < cap && lanes.some((l) => i < l.length); i++) {
    for (const l of lanes) if (i < l.length && out.length < cap) out.push(l[i].uri);
  }
  return out.slice(0, cap);
}
