#!/usr/bin/env node
// Invariant: a `preview_gif` row exists iff the slug's latest render (`preview_render`) is `ok`.
//   npm run previews:consistency            # table + exit 1 on any violation
//   npm run previews:consistency -- --json  # one-line machine-readable summary
// Violations: an ok slug with no GIF (okWithoutGif), a non-ok slug that still holds one (nonOkWithGif, e.g. a stale GIF from an
// earlier run), a GIF with no render row at all (gifWithoutRender). Exit 0 consistent, 1 violated.

export interface Consistency { okWithoutGif: string[]; nonOkWithGif: string[]; gifWithoutRender: string[] }

export function checkConsistency(renders: { slug: string; state: string }[], gifSlugs: string[]): Consistency {
  const gifs = new Set(gifSlugs);
  const state = new Map(renders.map((r) => [r.slug, r.state]));
  return {
    okWithoutGif: renders.filter((r) => r.state === 'ok' && !gifs.has(r.slug)).map((r) => r.slug).sort(),
    nonOkWithGif: renders.filter((r) => r.state !== 'ok' && gifs.has(r.slug)).map((r) => r.slug).sort(),
    gifWithoutRender: gifSlugs.filter((s) => !state.has(s)).sort(),
  };
}

if (import.meta.main) {
  const { pool } = await import('../server/src/db.ts');
  try {
    const renders = (await pool.query<{ slug: string; state: string }>('SELECT slug, state FROM preview_render')).rows;
    const gifSlugs = (await pool.query<{ slug: string }>('SELECT slug FROM preview_gif')).rows.map((r) => r.slug);
    const c = checkConsistency(renders, gifSlugs);
    const bad = c.okWithoutGif.length + c.nonOkWithGif.length + c.gifWithoutRender.length;
    if (process.argv.includes('--json')) console.log(JSON.stringify({ renders: renders.length, gifs: gifSlugs.length, ...c, consistent: bad === 0 }));
    else if (bad === 0) console.log(`previews consistent: ${renders.length} renders, ${gifSlugs.length} gifs`);
    else for (const [k, v] of Object.entries(c)) if (v.length) console.log(`${k} (${v.length}):\n  ${v.join('\n  ')}`);
    process.exitCode = bad === 0 ? 0 : 1;
  } finally {
    await pool.end();
  }
}
