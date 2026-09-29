import { coreName } from '../../server/src/search-doc.ts';
import { singular, splitName } from '../../server/src/vocab.ts';
import { colourTerms } from './payload.ts';
import type { GraphRules } from './rules.ts';

export interface PairInput {
  uri: string;
  slug: string;
  name: string;
  pack: string;
}

export interface PairSet {
  key: string;
  members: Array<{ uri: string; role: string }>;
}

/** Role + stem + variant key of one prefab name, or undefined when the name carries no role word. */
export function pairKeyOf(name: string, r: GraphRules['pairs']): { role: string; stem: string; variant: string } | undefined {
  const raw = coreName(name);
  const versions = [...raw.matchAll(/(?:^|[^a-zA-Z])[vV](\d+)/g)].map((m) => `v${m[1]}`);
  const versionRe = new RegExp(r.versionTokenPattern);
  const colours = colourTerms();
  const suffix = new Set(r.suffixVariantWords);
  const tokens = splitName(raw).filter((t) => !versionRe.test(t));

  let role: string | undefined;
  const strip = new Set<string>();
  for (const [id, def] of Object.entries(r.roles)) {
    if (tokens.some((t) => def.terms.includes(singular(t)))) {
      role = id;
      def.terms.forEach((t) => strip.add(t));
      def.alsoStrip.forEach((t) => strip.add(t));
      break;
    }
  }
  if (!role) return undefined;

  const last = tokens[tokens.length - 1];
  const variant = [
    ...tokens.filter((t) => colours.has(t)),
    ...(last && suffix.has(last) && !colours.has(last) ? [last] : []),
    ...versions,
  ].sort();
  const stem = tokens
    .filter((t, i) => !colours.has(t) && !strip.has(singular(t)) && !(i === tokens.length - 1 && suffix.has(t)))
    .join('-');
  if (!stem) return undefined;
  return { role, stem, variant: variant.join('+') };
}

/** Deterministic sets: same pack + stem + variant, >= minRoles roles, <= maxSetSize members. */
export function buildPairSets(items: PairInput[], r: GraphRules['pairs']): { sets: PairSet[]; skippedTooLarge: number } {
  const groups = new Map<string, Array<{ uri: string; slug: string; role: string }>>();
  for (const it of items) {
    if (!r.packs.includes(it.pack)) continue;
    const k = pairKeyOf(it.name, r);
    if (!k) continue;
    const key = `${it.pack}:${k.stem}:${k.variant}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push({ uri: it.uri, slug: it.slug, role: k.role });
  }
  const sets: PairSet[] = [];
  let skippedTooLarge = 0;
  for (const [key, ms] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (new Set(ms.map((m) => m.role)).size < r.minRoles) continue;
    if (ms.length > r.maxSetSize) {
      skippedTooLarge++;
      continue;
    }
    ms.sort((a, b) => (a.slug < b.slug ? -1 : 1));
    sets.push({ key, members: ms.map((m) => ({ uri: m.uri, role: m.role })) });
  }
  return { sets, skippedTooLarge };
}
