import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

/**
 * Preview media (`data/previews/<slug>.webm|.webp` + `index.json`) produced by the Unity preview lane.
 * Read side only: nothing here writes. Everything works with the directory absent or empty.
 *
 * index.json = { version: 1, items: { "<slug>": { webm, poster, bytes, fps, frames, size, renderedAt } } }
 * slug = the `vfx://recipe/<slug>/<version>` segment.
 */
export interface PreviewEntry {
  webm: string;
  poster: string;
  bytes: number;
  fps: number;
  frames: number;
  size: number;
  renderedAt: string;
}

export interface CardPreview {
  /** URL of the video, when the file exists. */
  video: string | null;
  /** URL of the poster image, when the file exists. */
  poster: string | null;
  /** true = the record has no own entry; this is its variant family's canonical member. */
  viaFamily: boolean;
  /** slug the media belongs to. */
  slug: string;
}

/** Only flat `<slug>.webm|webp` names are ever served: the traversal guard is the grammar itself. */
export const PREVIEW_FILE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.(webm|webp)$/;

export const PREVIEW_MIME: Record<string, string> = { '.webm': 'video/webm', '.webp': 'image/webp' };

export function previewDir(): string {
  return path.resolve(config.dataDir, 'previews');
}

/** Absolute path of a servable preview file, or null when the name is not a plain `<slug>.webm|webp`. */
export function previewPath(name: string, dir: string = previewDir()): string | null {
  if (!PREVIEW_FILE_RE.test(name)) return null;
  const abs = path.resolve(dir, name);
  return path.dirname(abs) === dir ? abs : null;
}

/** slug segment of a `vfx://<type>/<slug>/<version>` URI, or null. */
export function slugOfUri(uri: string): string | null {
  const m = /^vfx:\/\/[a-z]+\/([a-z0-9]+(?:-[a-z0-9]+)*)\/\d+$/.exec(uri);
  return m ? m[1] : null;
}

/* ------------------------------------------------------------------- index */

interface IndexCache {
  file: string;
  mtimeMs: number;
  size: number;
  items: Map<string, PreviewEntry>;
}
let cache: IndexCache | null = null;
let warnedFor = '';

function warnOnce(key: string, msg: string): void {
  if (warnedFor === key) return;
  warnedFor = key;
  console.warn(`[previews] ${msg}`);
}

function parseIndex(text: string): Map<string, PreviewEntry> {
  const raw = JSON.parse(text) as { version?: unknown; items?: unknown };
  if (raw?.version !== 1) throw new Error(`unsupported index version ${String(raw?.version)} (want 1)`);
  if (!raw.items || typeof raw.items !== 'object' || Array.isArray(raw.items)) throw new Error('items must be an object');
  const out = new Map<string, PreviewEntry>();
  for (const [slug, v] of Object.entries(raw.items as Record<string, Partial<PreviewEntry>>)) {
    if (!v || typeof v !== 'object') continue;
    const webm = typeof v.webm === 'string' && PREVIEW_FILE_RE.test(v.webm) ? v.webm : '';
    const poster = typeof v.poster === 'string' && PREVIEW_FILE_RE.test(v.poster) ? v.poster : '';
    if (!webm && !poster) continue;
    out.set(slug, {
      webm,
      poster,
      bytes: Number(v.bytes) || 0,
      fps: Number(v.fps) || 0,
      frames: Number(v.frames) || 0,
      size: Number(v.size) || 0,
      renderedAt: typeof v.renderedAt === 'string' ? v.renderedAt : '',
    });
  }
  return out;
}

/** The index, re-read whenever the file's mtime/size changes (no restart). Missing or broken file = no previews. */
export function loadIndex(dir: string = previewDir()): Map<string, PreviewEntry> {
  const file = path.join(dir, 'index.json');
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    cache = null;
    return new Map();
  }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.items;
  try {
    const items = parseIndex(fs.readFileSync(file, 'utf8'));
    cache = { file, mtimeMs: st.mtimeMs, size: st.size, items };
    warnedFor = '';
    return items;
  } catch (e) {
    // A half-written or invalid index must not take the review page down, but it must not be silent either.
    cache = null;
    warnOnce(`${file}:${st.mtimeMs}`, `ignoring ${file}: ${e instanceof Error ? e.message : String(e)}`);
    return new Map();
  }
}

function existing(dir: string, name: string): string | null {
  if (!name) return null;
  try {
    return fs.statSync(path.join(dir, name)).isFile() ? `/previews/${name}` : null;
  } catch {
    return null;
  }
}

/**
 * Preview of one record. `canonicalSlug` = the canonical member of its variant family (graph.canonicalSlugs);
 * used when the record has no entry of its own.
 */
export function previewFor(slug: string, canonicalSlug: string | undefined, dir: string = previewDir()): CardPreview | null {
  const items = loadIndex(dir);
  if (!items.size) return null;
  const own = items.get(slug);
  const viaFamily = !own;
  const useSlug = own ? slug : canonicalSlug;
  const e = useSlug ? items.get(useSlug) : undefined;
  if (!e || !useSlug) return null;
  const video = existing(dir, e.webm);
  const poster = existing(dir, e.poster);
  if (!video && !poster) return null;
  return { video, poster, viaFamily, slug: useSlug };
}

/* ------------------------------------------------------------------- range */

export type RangeResult = { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' };

/**
 * RFC 9110 single-range parse for `bytes=`. No/unknown/multi-range header = full body (a valid response to any Range).
 * Start past EOF, or an empty suffix, = 416.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'full' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { kind: 'full' };
  const [, a, b] = m;
  if (a === '' && b === '') return { kind: 'full' };
  if (a === '') {
    const n = Number(b);
    if (n === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(size - n, 0), end: size - 1 };
  }
  const start = Number(a);
  if (start >= size) return { kind: 'unsatisfiable' };
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return { kind: 'full' }; // syntactically invalid last-pos < first-pos: ignore the header
  return { kind: 'partial', start, end };
}
