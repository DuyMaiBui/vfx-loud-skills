import { fold, getVocab, splitName } from './vocab.ts';

export interface SearchDocInput {
  name: string;
  description: string;
  category: string;
  tags: string[];
  keywords: string[];
}

export interface SearchDoc {
  /** Text fed to the embedder. */
  embedText: string;
  /** Text stored in `search_text` (indexed as weight B in `search_tsv`). */
  searchText: string;
}

/** The prefab/asset name without the trailing " (Pack Name)" decoration. */
export function coreName(name: string): string {
  return name.replace(/ \([^()]*\)$/, ''); // same rule as the search_tsv migration
}

/**
 * ONE definition of "what is searchable about a record", used by publish() and the re-index command
 * so a new row and a re-indexed row are identical. Name tokens are split (underscore / camelCase /
 * digits); concept keywords are expanded with their English synonyms and Vietnamese aliases (from
 * vocab.json) so a query in either language hits the same words.
 */
export function searchDocument(i: SearchDocInput): SearchDoc {
  const v = getVocab();
  const nameTokens = splitName(coreName(i.name));
  const syn: string[] = [];
  const vi: string[] = [];
  for (const k of i.keywords) {
    const c = v.concepts[k];
    if (c) {
      syn.push(...c.synonyms);
      vi.push(...c.vi, ...c.vi.map(fold));
    }
    const col = v.colours[k];
    if (col) vi.push(...col.vi, ...col.vi.map(fold));
    const st = v.styles[k];
    if (st) {
      syn.push(...st.synonyms);
      vi.push(...st.vi, ...st.vi.map(fold));
    }
  }
  const uniq = (xs: string[]): string[] => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  return {
    searchText: uniq([...i.tags, ...i.keywords, ...nameTokens, ...syn, ...vi]).join(' '),
    embedText: uniq([...nameTokens, ...i.keywords, ...syn, ...i.tags]).join(' ') + ' ' + i.description,
  };
}
