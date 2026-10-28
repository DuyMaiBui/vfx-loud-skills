import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAGENTA_RULE, analyzeMedia, frameStats, isMagentaFrame, isMagentaPixel, judgeFrames, loadMagentaAllowlist, parseAllowlist, type FrameStats } from './magenta.ts';

process.env.AUTH_DISABLED = '1';
const { pool, migrate } = await import('./db.ts');
const { ingestPreviews } = await import('./preview-gif-encode.ts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vfx-magenta-test-'));
const SLUGS = ['zz-magenta-test-bad', 'zz-magenta-test-clean', 'zz-magenta-test-allowed', 'zz-magenta-test-stale'];

after(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  await pool.query('DELETE FROM preview_gif WHERE slug = ANY($1::text[])', [SLUGS]).catch(() => undefined);
  await pool.end().catch(() => undefined);
});

/** `n` RGB24 pixels of one colour, as bytes. */
const solid = (n: number, [r, g, b]: readonly number[]): Uint8Array => {
  const a = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) a.set([r, g, b], i * 3);
  return a;
};
const BG = MAGENTA_RULE.bg;

// Shared vectors with unity/VFXPreview/Assets/Editor/VfxPreview/MagentaMath.cs (tools/preview/framing-tests/Program.cs asserts the same table).
const PIXELS: Array<[string, [number, number, number], boolean]> = [
  ['the error shader (255,0,255)', [255, 0, 255], true],
  ['error shader after codec/palette smear', [240, 10, 235], true],
  ['an additive magenta glow keeps the background green', [255, 31, 255], false],
  ['hot pink (255,0,128)', [255, 0, 128], false],
  ['pink (255,105,180)', [255, 105, 180], false],
  ['dim magenta (200,0,200)', [200, 0, 200], false],
  ['the background', [28, 31, 36], false],
  ['pure red', [255, 0, 0], false],
  ['pure blue', [0, 0, 255], false],
];
for (const [name, px, want] of PIXELS) test(`isMagentaPixel: ${name}`, () => assert.equal(isMagentaPixel(...px), want));

test('isMagentaFrame: 0.5% of the pixels is the threshold', () => {
  const f = (m: number): FrameStats => ({ pixels: 1000, magenta: m, visible: m });
  assert.equal(isMagentaFrame(f(4)), false);
  assert.equal(isMagentaFrame(f(5)), true);
  assert.equal(isMagentaFrame({ pixels: 0, magenta: 0, visible: 0 }), false, 'an empty frame is not magenta');
});

test('frameStats: counts magenta and non-background pixels separately', () => {
  const rgb = new Uint8Array([...solid(6, BG), ...solid(3, [255, 0, 255]), ...solid(1, [255, 100, 100])]);
  assert.deepEqual(frameStats(rgb), { pixels: 10, magenta: 3, visible: 4 });
});

test('judgeFrames: one magenta frame breaks the clip (a slash is a one-frame effect); a clean clip and an empty one do not', () => {
  const clean: FrameStats = { pixels: 1000, magenta: 0, visible: 50 };
  const bad: FrameStats = { pixels: 1000, magenta: 100, visible: 100 };
  const v = judgeFrames([clean, bad, clean]);
  assert.equal(v.magenta, true);
  assert.equal(v.magentaFrames, 1);
  assert.equal(v.peakShare, 0.1);
  assert.match(v.reason ?? '', /1\/3 frames/);
  assert.equal(judgeFrames([clean, clean]).magenta, false);
  assert.equal(judgeFrames([]).magenta, false, 'no frames: nothing to judge, not a verdict');
});

test('judgeFrames: a blank (all background) clip is not magenta', () => {
  assert.equal(judgeFrames([{ pixels: 1000, magenta: 0, visible: 0 }]).magenta, false);
});

test('parseAllowlist: comments, blanks and trailing notes', () => {
  assert.deepEqual([...parseAllowlist('# header\n\na-b\nc-d  # note\n   \n')], ['a-b', 'c-d']);
});

test('loadMagentaAllowlist: a missing file is an empty list; the shipped file lists heart-poof', () => {
  assert.equal(loadMagentaAllowlist(path.join(tmp, 'nope.txt')).size, 0);
  assert.ok(loadMagentaAllowlist().has('epic-toon-fx-heart-poof'));
});

function ffmpeg(args: string[]): void {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
const clip = (file: string, vf: string): void =>
  ffmpeg(['-f', 'lavfi', '-i', `color=c=0x1c1f24:s=256x256:r=12:d=1`, '-vf', vf, '-c:v', 'libvpx-vp9', '-b:v', '300k', '-pix_fmt', 'yuv420p', file]);
// A magenta square covering ~6% of the frame on the preview background; and a pink/purple one that must NOT count.
const MAGENTA_SQUARE = 'drawbox=x=100:y=100:w=64:h=64:color=0xff00ff:t=fill';
const PINK_SQUARE = 'drawbox=x=100:y=100:w=64:h=64:color=0xff69b4:t=fill';
const GLOW_SQUARE = 'drawbox=x=100:y=100:w=64:h=64:color=0xff1fff:t=fill'; // additive glow over the bg: green stays at the bg's 31

test('analyzeMedia: a webm with a flat magenta block is magenta; pink and the bg-green glow are not', async () => {
  const bad = path.join(tmp, 'bad.webm');
  const pink = path.join(tmp, 'pink.webm');
  const glow = path.join(tmp, 'glow.webm');
  const blank = path.join(tmp, 'blank.webm');
  clip(bad, MAGENTA_SQUARE);
  clip(pink, PINK_SQUARE);
  clip(glow, GLOW_SQUARE);
  clip(blank, 'null');
  const v = await analyzeMedia(bad);
  assert.equal(v.magenta, true, JSON.stringify(v));
  assert.equal(v.magentaFrames, v.frames);
  assert.ok(v.peakShare > 0.03 && v.peakShare < 0.08, `peak ${v.peakShare}`);
  assert.equal((await analyzeMedia(pink)).magenta, false);
  assert.equal((await analyzeMedia(glow)).magenta, false);
  assert.equal((await analyzeMedia(blank)).magenta, false);
});

test('analyzeMedia: reads a GIF from bytes', async () => {
  const gif = path.join(tmp, 'bad.gif');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x1c1f24:s=128x128:r=12:d=1', '-vf', `${MAGENTA_SQUARE.replace('x=100:y=100:w=64:h=64', 'x=40:y=40:w=40:h=40')},split[a][b];[a]palettegen[p];[b][p]paletteuse`, gif]);
  const v = await analyzeMedia(fs.readFileSync(gif));
  assert.equal(v.magenta, true, JSON.stringify(v));
});

test('analyzeMedia: garbage input rejects instead of reporting clean', async () => {
  await assert.rejects(() => analyzeMedia(Buffer.from('not a video')), /ffmpeg/);
});

function writeIndex(dir: string, slugs: string[]): void {
  const items = Object.fromEntries(slugs.map((s) => [s, { webm: `${s}.webm`, poster: `${s}.webp`, fps: 12, frames: 12, size: 256 }]));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, items }));
}

test('ingestPreviews: a magenta render is never stored, deletes the stale row, and the allowlist waives it', async () => {
  await migrate();
  const dir = path.join(tmp, 'ingest');
  fs.mkdirSync(dir);
  clip(path.join(dir, 'zz-magenta-test-bad.webm'), MAGENTA_SQUARE);
  clip(path.join(dir, 'zz-magenta-test-allowed.webm'), MAGENTA_SQUARE);
  clip(path.join(dir, 'zz-magenta-test-clean.webm'), PINK_SQUARE);
  clip(path.join(dir, 'zz-magenta-test-stale.webm'), MAGENTA_SQUARE);
  writeIndex(dir, ['zz-magenta-test-bad', 'zz-magenta-test-clean', 'zz-magenta-test-allowed']);
  // A stale row from an older (also broken) render of the same slug.
  await pool.query(
    `INSERT INTO preview_gif (slug, gif, width, height, frames, fps, bytes, sha256, source_sha256, builder, encoder)
     VALUES ('zz-magenta-test-bad', $1, 1, 1, 1, 12, 3, 'x', 'old-source', 'v1', 'old')`,
    [Buffer.from('abc')],
  );

  const s = await ingestPreviews({ dir, magentaAllow: new Set(['zz-magenta-test-allowed']) });
  const by = Object.fromEntries(s.results.map((r) => [r.slug, r]));
  assert.equal(by['zz-magenta-test-bad'].status, 'failed');
  assert.match(by['zz-magenta-test-bad'].reason ?? '', /magenta/);
  assert.equal(by['zz-magenta-test-clean'].status, 'stored');
  assert.equal(by['zz-magenta-test-allowed'].status, 'stored');
  const rows = (await pool.query<{ slug: string }>('SELECT slug FROM preview_gif WHERE slug = ANY($1::text[])', [SLUGS])).rows.map((r) => r.slug).sort();
  assert.deepEqual(rows, ['zz-magenta-test-allowed', 'zz-magenta-test-clean'], 'the broken slug has no row (stale one deleted), the others are stored');
});
