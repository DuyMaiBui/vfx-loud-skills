import { spawn } from 'node:child_process';
import fs from 'node:fs';

/**
 * Magenta detector for rendered previews.
 *
 * Unity draws a material it cannot render (missing / unsupported shader under URP, e.g. a built-in-RP surface
 * shader) with the error shader: a flat, unlit, opaque (255,0,255). A preview of such an effect is worthless and
 * must never be stored or served. This module is the ONE definition of "that frame is magenta"; the render lane has
 * the same rule in `unity/VFXPreview/Assets/Editor/VfxPreview/MagentaMath.cs` (keep the two in step: the shared
 * vectors are pinned by `magenta.test.ts` and `tools/preview/framing-tests`).
 *
 * Why the rule is strict (and flat-magenta only): the preview background is (28,31,36) and effects are alpha or
 * additive blended on it, so a legitimate pink / purple glow keeps its green at or above ~31 (additive) or is a
 * gradient (alpha). Only an OPAQUE error-shader pixel reaches g ~ 0 with r and b saturated. The codec and the GIF
 * palette smear it a little, hence the tolerances rather than an exact match. A single magenta frame is enough:
 * a brief slash or flash is exactly the kind of effect whose whole body is the unrenderable material.
 */
export const MAGENTA_RULE = {
  /** Red and blue at least this high ... */
  minRB: 225,
  /** ... green at most this high (additive glows over the bg keep g >= 31, so they never get here) ... */
  maxG: 20,
  /** ... and red/blue within this of each other (a hot pink (255,0,128) is not the error colour). */
  maxRBGap: 30,
  /** A frame counts as magenta when magenta pixels are at least this share of ALL its pixels. */
  minFrameShare: 0.005,
  /** A clip is broken when at least this many frames are magenta. */
  minFrames: 1,
  /** Preview background (PreviewCell.Bg); a pixel within `bgTolerance` (sum of |dr|+|dg|+|db|) of it is background. */
  bg: [28, 31, 36] as const,
  bgTolerance: 30,
} as const;

export const isMagentaPixel = (r: number, g: number, b: number): boolean =>
  r >= MAGENTA_RULE.minRB && b >= MAGENTA_RULE.minRB && g <= MAGENTA_RULE.maxG && Math.abs(r - b) <= MAGENTA_RULE.maxRBGap;

export interface FrameStats {
  /** Pixels in the frame. */
  pixels: number;
  /** Pixels that are the error colour. */
  magenta: number;
  /** Pixels that are not the background. */
  visible: number;
}

/** Tally one RGB24 frame (3 bytes per pixel). */
export function frameStats(rgb: Uint8Array): FrameStats {
  const [br, bg, bb] = MAGENTA_RULE.bg;
  const pixels = Math.floor(rgb.length / 3);
  let magenta = 0;
  let visible = 0;
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    if (Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb) > MAGENTA_RULE.bgTolerance) visible++;
    if (isMagentaPixel(r, g, b)) magenta++;
  }
  return { pixels, magenta, visible };
}

export const isMagentaFrame = (f: FrameStats): boolean => f.pixels > 0 && f.magenta / f.pixels >= MAGENTA_RULE.minFrameShare;

export interface MagentaVerdict {
  /** true = the clip is a missing-shader render: do not ingest. */
  magenta: boolean;
  frames: number;
  magentaFrames: number;
  /** Largest magenta share of a single frame's pixels. */
  peakShare: number;
  /** Human-readable cause, set when `magenta`. */
  reason?: string;
}

/** Judge a clip from its per-frame tallies. */
export function judgeFrames(frames: readonly FrameStats[]): MagentaVerdict {
  let magentaFrames = 0;
  let peakShare = 0;
  for (const f of frames) {
    if (isMagentaFrame(f)) magentaFrames++;
    if (f.pixels > 0) peakShare = Math.max(peakShare, f.magenta / f.pixels);
  }
  const magenta = frames.length > 0 && magentaFrames >= MAGENTA_RULE.minFrames;
  const v: MagentaVerdict = { magenta, frames: frames.length, magentaFrames, peakShare: Math.round(peakShare * 1e4) / 1e4 };
  if (magenta) {
    v.reason = `magenta (missing-shader colour): ${magentaFrames}/${frames.length} frames, peak ${(peakShare * 100).toFixed(1)}% of the frame`;
  }
  return v;
}

/** Decode a GIF / webm (bytes or a path) to RGB24 frames with ffmpeg and judge it. `size` scales the longest side for speed. */
export function analyzeMedia(input: Buffer | string, opts: { size?: number; timeoutMs?: number } = {}): Promise<MagentaVerdict> {
  const size = opts.size ?? 128;
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-i', typeof input === 'string' ? input : 'pipe:0', '-vf', `scale=${size}:${size}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'];
    const child = spawn('ffmpeg', args, { stdio: [typeof input === 'string' ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const frameBytes = size * size * 3;
    const stats: FrameStats[] = [];
    let carry: Buffer = Buffer.alloc(0);
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${opts.timeoutMs ?? 60_000} ms`));
    }, opts.timeoutMs ?? 60_000);
    child.stdout!.on('data', (d: Buffer) => {
      carry = carry.length ? Buffer.concat([carry, d]) : d;
      while (carry.length >= frameBytes) {
        stats.push(frameStats(carry.subarray(0, frameBytes)));
        carry = carry.subarray(frameBytes);
      }
    });
    child.stderr!.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-2048);
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? 'ffmpeg is not installed' : e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || stats.length === 0) reject(new Error(`ffmpeg exit ${code}, ${stats.length} frames: ${err.trim().split('\n').slice(-2).join(' | ')}`));
      else resolve(judgeFrames(stats));
    });
    if (typeof input !== 'string') {
      child.stdin!.on('error', () => undefined); // ffmpeg may close early on a bad input; the close handler reports it
      child.stdin!.end(input);
    }
  });
}

/** Slugs whose effect IS magenta (verified by eye): `tools/preview/magenta-allow.txt`, one slug per line, '#' starts a comment. */
export const MAGENTA_ALLOW_FILE = new URL('../../tools/preview/magenta-allow.txt', import.meta.url);

/** Parse the allowlist text. */
export function parseAllowlist(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0].trim();
    if (line) out.add(line);
  }
  return out;
}

/** The allowlist file; a missing file is an empty list (nothing waived), any other read error is thrown. */
export function loadMagentaAllowlist(file: URL | string = MAGENTA_ALLOW_FILE): Set<string> {
  try {
    return parseAllowlist(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw e;
  }
}
