import fs from 'node:fs';
import path from 'node:path';

/**
 * Loader + helpers over `vocab.json` (the synonym / Vietnamese-alias DATA file). No mapping is
 * hardcoded here: edit the JSON to change what a word means.
 */
export interface Concept {
  kind: 'element' | 'use' | 'weather';
  terms: string[];
  synonyms: string[];
  vi: string[];
}
export interface Vocab {
  concepts: Record<string, Concept>;
  colours: Record<string, { terms: string[]; vi: string[] }>;
  styles: Record<string, { terms: string[]; synonyms: string[]; vi: string[] }>;
}

let cached: Vocab | undefined;
export function getVocab(): Vocab {
  if (!cached) {
    const file = path.join(path.dirname(new URL(import.meta.url).pathname), 'vocab.json');
    cached = JSON.parse(fs.readFileSync(file, 'utf8')) as Vocab;
  }
  return cached;
}

/** Lowercase, strip Vietnamese diacritics (đ -> d) so "Nổ" and "no" can be compared loosely. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/** "Bubbles_Burst2" / "ExplosionFireballPink" / "FX_Rain_01" -> ["bubbles","burst","explosion","fireball","pink","fx","rain"]. */
export function splitName(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !/^\d+$/.test(t));
}

/** Singularise a trailing "s" so "bubbles" matches "bubble" (min length guards "glass", "bus"). */
export function singular(t: string): string {
  return t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t;
}

/** Concept ids whose `terms` contain any of the tokens. Keyed by kind, in vocab order. */
export function conceptsForTokens(tokens: string[]): { element: string[]; use: string[]; weather: string[] } {
  const v = getVocab();
  const set = new Set(tokens.flatMap((t) => [t, singular(t)]));
  const out = { element: [] as string[], use: [] as string[], weather: [] as string[] };
  for (const [id, c] of Object.entries(v.concepts)) {
    if (c.terms.some((t) => set.has(t))) out[c.kind].push(id);
  }
  return out;
}

export function coloursForTokens(tokens: string[]): string[] {
  const v = getVocab();
  const set = new Set(tokens);
  return Object.entries(v.colours)
    .filter(([, c]) => c.terms.some((t) => set.has(t)))
    .map(([id]) => id);
}

export interface ExpandedQuery {
  /** Original ASCII/unicode word tokens of the query. */
  original: string[];
  /** Extra words from matched concepts / colours / styles (English synonyms + canonical ids). */
  expansion: string[];
  /** Matched style ids (usable as an implicit hint; the caller decides whether to filter). */
  styles: string[];
  /** Text to embed: original + expansion. */
  text: string;
}

/** Query-side expansion: English synonyms and Vietnamese aliases -> the same vocabulary as the index. */
export function expandQuery(query: string): ExpandedQuery {
  const v = getVocab();
  let rest = ` ${fold(query).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const original = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);

  // Candidate aliases: [folded alias, extra words]; longest alias first so "hồi máu" beats "máu".
  const aliases: Array<{ alias: string; extra: string[]; style?: string }> = [];
  const wordsOf = (s: string): string[] => s.split(/\s+/).filter(Boolean);
  for (const [id, c] of Object.entries(v.concepts)) {
    const extra = [id, ...c.synonyms.flatMap(wordsOf)];
    for (const a of [...c.vi, ...c.synonyms, ...c.terms]) aliases.push({ alias: fold(a), extra });
  }
  for (const [id, c] of Object.entries(v.colours)) {
    for (const a of [...c.vi, ...c.terms]) aliases.push({ alias: fold(a), extra: [id, ...c.terms] });
  }
  for (const [id, c] of Object.entries(v.styles)) {
    for (const a of [...c.vi, ...c.synonyms, ...c.terms]) {
      aliases.push({ alias: fold(a), extra: [id, ...c.synonyms.flatMap(wordsOf)], style: id });
    }
  }
  aliases.sort((a, b) => b.alias.length - a.alias.length);

  const expansion = new Set<string>();
  const styles = new Set<string>();
  for (const a of aliases) {
    if (a.alias.length < 2) continue;
    const needle = ` ${a.alias.replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
    const singularNeedle = needle.replace(/s $/, ' ');
    const hit = rest.includes(needle) ? needle : rest.includes(singularNeedle) && singularNeedle.trim().length > 3 ? singularNeedle : '';
    if (!hit) continue;
    rest = rest.split(hit).join(' ');
    for (const w of a.extra) expansion.add(fold(w));
    if (a.style) styles.add(a.style);
  }
  const orig = new Set(original.map(fold));
  const extra = [...expansion].filter((w) => !orig.has(w));
  return { original, expansion: extra, styles: [...styles], text: [...original, ...extra].join(' ') };
}
