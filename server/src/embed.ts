import { createHash } from 'node:crypto';
import { config } from './config.ts';

/**
 * EmbeddingProvider — V0 ship với hashing embedder offline (không cần API key),
 * đổi sang model thật chỉ bằng env EMBEDDER + cùng dim.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  embed(text: string): Promise<number[]>;
}

const STOP = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'with', 'is',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Feature hashing: unigram + bigram + ký tự 3-gram -> unit vector. */
class HashingEmbedder implements EmbeddingProvider {
  readonly name = 'hashing';
  readonly dim = config.embeddingDim;

  embed(text: string): Promise<number[]> {
    const v = new Array<number>(this.dim).fill(0);
    const toks = tokenize(text);
    const feats: string[] = [...toks];

    for (let i = 0; i + 1 < toks.length; i++) feats.push(`${toks[i]}_${toks[i + 1]}`);
    for (const t of toks) {
      if (t.length < 5) continue;
      for (let i = 0; i + 3 <= t.length; i++) feats.push(t.slice(i, i + 3));
    }

    for (const f of feats) {
      const h = createHash('sha256').update(f).digest();
      const idx = h.readUInt32BE(0) % this.dim;
      const sign = (h[4] & 1) === 0 ? 1 : -1;
      v[idx] += sign;
    }

    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return Promise.resolve(v.map((x) => x / norm));
  }
}

const providers: Record<string, () => EmbeddingProvider> = {
  hashing: () => new HashingEmbedder(),
};

export function getEmbedder(): EmbeddingProvider {
  const factory = providers[config.embedder];
  if (!factory) {
    throw new Error(
      `Unknown EMBEDDER "${config.embedder}" (available: ${Object.keys(providers).join(', ')})`,
    );
  }
  return factory();
}
