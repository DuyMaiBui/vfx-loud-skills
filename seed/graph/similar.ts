export interface SimilarEdge {
  src: number;
  dst: number;
  jaccard: number;
}

export interface SimilarOptions {
  maxAssetFanout: number;
  minJaccard: number;
  topK: number;
}

/**
 * Top-K Jaccard neighbours per recipe over shared assets. `assetsOf`: recipe id -> asset keys.
 * Assets used by more than maxAssetFanout recipes are skipped (no signal). Out-degree is capped at topK;
 * ties break on slug so the result is deterministic. `sameFamily` pairs are excluded.
 */
export function topSimilar(
  assetsOf: Map<number, Set<string>>,
  slugOf: (id: number) => string,
  sameFamily: (a: number, b: number) => boolean,
  o: SimilarOptions,
): SimilarEdge[] {
  const postings = new Map<string, number[]>();
  for (const [id, set] of assetsOf) for (const a of set) (postings.get(a) ?? postings.set(a, []).get(a)!).push(id);
  const usable = (a: string): boolean => (postings.get(a)?.length ?? 0) <= o.maxAssetFanout;
  const eligible = new Map<number, string[]>();
  for (const [id, set] of assetsOf) eligible.set(id, [...set].filter(usable));

  const out: SimilarEdge[] = [];
  for (const [id, mine] of [...eligible].sort((a, b) => a[0] - b[0])) {
    if (!mine.length) continue;
    const counts = new Map<number, number>();
    for (const a of mine) for (const other of postings.get(a) ?? []) if (other !== id) counts.set(other, (counts.get(other) ?? 0) + 1);
    const scored: SimilarEdge[] = [];
    for (const [other, inter] of counts) {
      if (sameFamily(id, other)) continue;
      const j = inter / (mine.length + (eligible.get(other)?.length ?? 0) - inter);
      if (j >= o.minJaccard) scored.push({ src: id, dst: other, jaccard: Math.round(j * 1000) / 1000 });
    }
    scored.sort((a, b) => b.jaccard - a.jaccard || (slugOf(a.dst) < slugOf(b.dst) ? -1 : 1));
    out.push(...scored.slice(0, o.topK));
  }
  return out;
}
