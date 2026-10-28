import { config } from './config.ts';
import { pool } from './db.ts';
import { slugOfUri } from './previews.ts';

/**
 * Read side of the DB-backed animated GIF preview (`preview_gif`, migration 009). The write side — encoding a
 * rendered `<slug>.webm` and storing it — is preview-gif-encode.ts; this file is all the server needs at request
 * time, so the search / review / endpoint path never imports ffmpeg code.
 */

export const GIF_MIME = 'image/gif';

/** Row metadata, no bytes. */
export interface StoredGif {
  slug: string;
  width: number;
  height: number;
  frames: number;
  fps: number;
  bytes: number;
  sha256: string;
  sourceSha256: string;
  builder: string;
  encoder: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface GifRow extends StoredGif {
  gif: Buffer;
}

/** What a card carries: the URL plus the facts needed to size the element, so a grid never reflows. */
export interface CardGif {
  /** Absolute URL for agents and external viewers. */
  url: string;
  /** Same resource as a server-relative path: what the review page embeds, so it works from any host name. */
  path: string;
  width: number;
  height: number;
  frames: number;
  fps: number;
  bytes: number;
  sha256: string;
  /** true = the record has no GIF of its own; this is its variant family's canonical member (same fallback as the webm). */
  viaFamily: boolean;
}

const META_COLUMNS = `slug, width, height, frames, fps, bytes, sha256, source_sha256 AS "sourceSha256",
            builder, encoder, created_at AS "createdAt", updated_at AS "updatedAt"`;

/** `/previews/<slug>.gif` — the path a card, the review page and a human all use. */
export function gifPath(slug: string): string {
  return `/previews/${slug}.gif`;
}

/** Absolute URL, `PUBLIC_BASE_URL` first (same rule as store.absoluteUrl). */
export function gifUrl(slug: string): string {
  return `${config.publicBaseUrl || `http://127.0.0.1:${config.port}`}${gifPath(slug)}`;
}

/** Metadata for the given slugs in one query. A slug with no row is absent from the map. */
export async function gifMeta(slugs: string[]): Promise<Map<string, StoredGif>> {
  if (!slugs.length) return new Map();
  const r = await pool.query<StoredGif>(`SELECT ${META_COLUMNS} FROM preview_gif WHERE slug = ANY($1::text[])`, [slugs]);
  return new Map(r.rows.map((x) => [x.slug, x]));
}

/** The row INCLUDING bytes, for the serving endpoint. Null when the slug has no GIF. */
export async function gifBySlug(slug: string): Promise<GifRow | null> {
  const r = await pool.query<GifRow>(`SELECT gif, ${META_COLUMNS} FROM preview_gif WHERE slug = $1`, [slug]);
  return r.rows[0] ?? null;
}

/**
 * Card-level GIF per record uri: the record's own slug, else its variant family's canonical slug, else absent.
 * One query for the whole page of cards.
 */
export async function gifCards(pairs: Array<{ uri: string; canonicalSlug?: string }>): Promise<Map<string, CardGif>> {
  const wanted = new Set<string>();
  for (const p of pairs) {
    const own = slugOfUri(p.uri);
    if (own) wanted.add(own);
    if (p.canonicalSlug) wanted.add(p.canonicalSlug);
  }
  const meta = await gifMeta([...wanted]);
  const out = new Map<string, CardGif>();
  for (const p of pairs) {
    const own = slugOfUri(p.uri);
    const slug = own && meta.has(own) ? own : p.canonicalSlug && meta.has(p.canonicalSlug) ? p.canonicalSlug : null;
    const m = slug ? meta.get(slug) : undefined;
    if (!slug || !m) continue;
    out.set(p.uri, {
      url: gifUrl(slug),
      path: gifPath(slug),
      width: m.width,
      height: m.height,
      frames: m.frames,
      fps: m.fps,
      bytes: m.bytes,
      sha256: m.sha256,
      viaFamily: slug !== own,
    });
  }
  return out;
}
