import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pool } from './db.ts';
import { GIF_MIME } from './preview-gif.ts';
import { PREVIEW_FILE_RE, previewDir } from './previews.ts';

/**
 * Write side of the DB GIF preview: encode a rendered `<slug>.webm` to a looping GIF with ffmpeg
 * (palettegen / paletteuse) and store the bytes in `preview_gif`.
 *
 * Size budget: a set review puts 24-48 GIFs on one page, so **each GIF is capped at 130 KB** and most are far
 * smaller. The cap is a ceiling, not a target: the ladder starts at 192 px / 12 fps / 96 colours and steps down
 * only when an encode is over the cap. Measured on the 14 rendered previews (256 px, 24 fps, 48 frames source):
 * rung 1 gives 1.9 KB min, 13.5 KB median, 127.1 KB max (confetti-falling); the last rung gives 43.1 KB for the
 * same worst case.
 */

/** Encoder generation: bump when the ladder or the ffmpeg graph changes, so the next ingest re-encodes. */
export const GIF_BUILDER = 'v1';

/** Ceiling per GIF, in bytes. */
export const GIF_MAX_BYTES = 130 * 1024;

const FFMPEG_TIMEOUT_MS = 60_000;

export interface GifRung {
  /** Output width in px; height follows the source aspect ratio (the lane renders 1:1). */
  size: number;
  fps: number;
  /** Palette size for palettegen. */
  colors: number;
}

/** Finest first. The last rung is a legible thumbnail; each step was chosen by measuring the worst case above. */
export const GIF_LADDER: readonly GifRung[] = [
  { size: 192, fps: 12, colors: 96 },
  { size: 160, fps: 12, colors: 64 },
  { size: 144, fps: 10, colors: 48 },
  { size: 128, fps: 10, colors: 32 },
];

export class GifError extends Error {}

export const rungLabel = (r: GifRung): string => `${r.size}px@${r.fps}fps/${r.colors}c`;

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** One palette from the whole clip, then the frames dithered onto it. */
export function gifFilter(r: GifRung): string {
  return (
    `fps=${r.fps},scale=${r.size}:-1:flags=lanczos,split[a][b];` +
    `[a]palettegen=max_colors=${r.colors}:stats_mode=diff[p];` +
    `[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`
  );
}

/** Run ffmpeg; reject on a non-zero exit, a missing binary or the timeout. */
function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new GifError(`ffmpeg timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-4096); // keep the tail: ffmpeg's real error is last
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new GifError(e.code === 'ENOENT' ? 'ffmpeg is not installed' : e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new GifError(`ffmpeg exit ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

export interface Encoded {
  buffer: Buffer;
  rung: GifRung;
  /** true = even the last rung is over the cap; the smallest encode is returned anyway. */
  overBudget: boolean;
}

/**
 * Encode one webm. Walks the ladder from the top; the first rung at or under `maxBytes` wins. If every rung is
 * over, the SMALLEST encode is returned flagged `overBudget` (a big preview still beats none).
 */
export async function encodeGif(
  webm: string,
  opts: { ladder?: readonly GifRung[]; maxBytes?: number; timeoutMs?: number } = {},
): Promise<Encoded> {
  const ladder = opts.ladder ?? GIF_LADDER;
  const maxBytes = opts.maxBytes ?? GIF_MAX_BYTES;
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-gif-'));
  try {
    let smallest: Encoded | null = null;
    for (const rung of ladder) {
      const out = path.join(work, 'out.gif');
      await runFfmpeg(['-y', '-v', 'error', '-i', webm, '-vf', gifFilter(rung), '-loop', '0', '-f', 'gif', out], opts.timeoutMs ?? FFMPEG_TIMEOUT_MS);
      const buffer = await fs.readFile(out);
      if (buffer.length <= maxBytes) return { buffer, rung, overBudget: false };
      if (!smallest || buffer.length < smallest.buffer.length) smallest = { buffer, rung, overBudget: true };
    }
    if (!smallest) throw new GifError('empty ladder: nothing to encode with');
    return smallest;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** Logical screen size and frame count read from the GIF bytes (no ffprobe on the encode path). */
export function gifFacts(buf: Buffer): { width: number; height: number; frames: number } {
  if (buf.length < 13 || buf.toString('ascii', 0, 3) !== 'GIF') throw new GifError('not a GIF');
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (!width || !height) throw new GifError('GIF has no logical screen size');
  const skipBlocks = (i: number): number => {
    while (i < buf.length && buf[i] !== 0) i += buf[i] + 1; // data sub-blocks
    return i + 1; // block terminator
  };
  const packed = buf[10];
  let i = 13 + (packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0); // header + global colour table
  let frames = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b === 0x2c) {
      // image descriptor: 9 bytes, optional local colour table, LZW min code size, data sub-blocks
      frames++;
      const lf = buf[i + 9];
      i += 10 + (lf & 0x80 ? 3 * (1 << ((lf & 0x07) + 1)) : 0) + 1;
      i = skipBlocks(i);
    } else if (b === 0x21) {
      i = skipBlocks(i + 2); // extension introducer + label, then sub-blocks
    } else if (b === 0x3b) {
      break; // trailer
    } else {
      throw new GifError(`corrupt GIF: unexpected byte 0x${b.toString(16)} at ${i}`);
    }
  }
  if (frames === 0) throw new GifError('GIF has no frames');
  return { width, height, frames };
}

/* ------------------------------------------------------------------ ingest */

export interface IngestResult {
  slug: string;
  status: 'stored' | 'unchanged' | 'skipped' | 'failed';
  bytes?: number;
  sourceBytes?: number;
  sha256?: string;
  width?: number;
  height?: number;
  frames?: number;
  fps?: number;
  encoder?: string;
  overBudget?: boolean;
  reason?: string;
}

export interface IngestSummary {
  scanned: number;
  stored: number;
  unchanged: number;
  skipped: number;
  failed: number;
  results: IngestResult[];
}

export interface IngestOptions {
  /** Encoder generation; a row built by another one is re-encoded even if the source hash matches. */
  builder?: string;
  /** Encode even when the row is already current. */
  force?: boolean;
  /** Only these slugs. */
  only?: string[];
  ladder?: readonly GifRung[];
  maxBytes?: number;
  /** Directory holding index.json and the webm files; defaults to data/previews. */
  dir?: string;
}

/**
 * Encode every rendered preview listed in `index.json` into the DB. Idempotent by (source sha256, builder):
 * an unchanged webm under the same builder is `unchanged` and writes nothing; a re-rendered webm replaces its
 * row in place. A missing index or webm is `skipped`, never an error. One bad webm is `failed` without stopping
 * the rest.
 */
export async function ingestPreviews(opts: IngestOptions = {}): Promise<IngestSummary> {
  const dir = opts.dir ?? previewDir();
  const builder = opts.builder ?? GIF_BUILDER;
  const only = opts.only?.length ? new Set(opts.only) : null;
  const summary: IngestSummary = { scanned: 0, stored: 0, unchanged: 0, skipped: 0, failed: 0, results: [] };

  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, 'index.json'), 'utf8');
  } catch {
    return summary; // no render yet: nothing to ingest
  }
  let items: Record<string, { webm?: unknown }>;
  try {
    items = (JSON.parse(raw) as { items?: Record<string, { webm?: unknown }> }).items ?? {};
  } catch (e) {
    throw new GifError(`${path.join(dir, 'index.json')} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  const have = new Map(
    (await pool.query<{ slug: string; source_sha256: string; builder: string; sha256: string }>('SELECT slug, source_sha256, builder, sha256 FROM preview_gif')).rows.map((r) => [r.slug, r]),
  );
  const note = (r: IngestResult): void => {
    summary[r.status]++;
    summary.results.push(r);
  };

  for (const [slug, entry] of Object.entries(items)) {
    if (only && !only.has(slug)) continue;
    summary.scanned++;
    const name = typeof entry?.webm === 'string' ? entry.webm : '';
    if (!PREVIEW_FILE_RE.test(name) || !name.endsWith('.webm')) {
      note({ slug, status: 'skipped', reason: 'index entry has no servable webm name' });
      continue;
    }
    let source: Buffer;
    try {
      source = await fs.readFile(path.join(dir, name));
    } catch {
      note({ slug, status: 'skipped', reason: `missing ${name}` });
      continue;
    }
    const sourceSha256 = sha256Hex(source);
    const prev = have.get(slug);
    if (!opts.force && prev?.source_sha256 === sourceSha256 && prev.builder === builder) {
      note({ slug, status: 'unchanged', sourceBytes: source.length, sha256: prev.sha256 });
      continue;
    }
    try {
      const { buffer, rung, overBudget } = await encodeGif(path.join(dir, name), opts);
      const facts = gifFacts(buffer);
      const hash = sha256Hex(buffer);
      const encoder = rungLabel(rung);
      await pool.query(
        `INSERT INTO preview_gif (slug, gif, width, height, frames, fps, bytes, sha256, source_sha256, builder, encoder)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (slug) DO UPDATE
                SET gif = EXCLUDED.gif, width = EXCLUDED.width, height = EXCLUDED.height, frames = EXCLUDED.frames,
                    fps = EXCLUDED.fps, bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256,
                    source_sha256 = EXCLUDED.source_sha256, builder = EXCLUDED.builder, encoder = EXCLUDED.encoder,
                    updated_at = now()`,
        [slug, buffer, facts.width, facts.height, facts.frames, rung.fps, buffer.length, hash, sourceSha256, builder, encoder],
      );
      note({ slug, status: 'stored', bytes: buffer.length, sourceBytes: source.length, sha256: hash, ...facts, fps: rung.fps, encoder, ...(overBudget ? { overBudget } : {}) });
    } catch (e) {
      note({ slug, status: 'failed', reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return summary;
}
