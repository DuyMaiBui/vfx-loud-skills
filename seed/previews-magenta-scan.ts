#!/usr/bin/env node
// Scan every GIF stored in `preview_gif` for the Unity missing-shader colour (flat magenta) and list the slugs
// that are broken. Read-only unless --purge. The rule lives in server/src/magenta.ts.
//
//   npm run previews:magenta                       # table of magenta slugs, exit 1 when there is any
//   npm run previews:magenta -- --json             # one-line machine-readable summary
//   npm run previews:magenta -- --out slugs.txt    # also write the magenta slugs (one per line), e.g. for tools/preview/run.json `only`
//   npm run previews:magenta -- --only a,b         # a subset
//   npm run previews:magenta -- --no-allow        # ignore tools/preview/magenta-allow.txt (slugs verified as really magenta)
//   npm run previews:magenta -- --purge            # delete the magenta rows: a missing preview (404) beats a pink one
//
// Exit 0 when nothing is magenta, 1 when at least one GIF is, 2 when a GIF could not be analysed.
import fs from 'node:fs';
import { migrate, pool } from '../server/src/db.ts';
import { analyzeMedia, loadMagentaAllowlist, type MagentaVerdict } from '../server/src/magenta.ts';

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? '') : undefined;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const only = flag('only')?.split(',').map((s) => s.trim()).filter(Boolean);
const out = flag('out');
const CONCURRENCY = 6;

await migrate();
const { rows } = await pool.query<{ slug: string; gif: Buffer }>(
  only?.length ? 'SELECT slug, gif FROM preview_gif WHERE slug = ANY($1::text[]) ORDER BY slug' : 'SELECT slug, gif FROM preview_gif ORDER BY slug',
  only?.length ? [only] : [],
);

interface Row { slug: string; verdict?: MagentaVerdict; error?: string }
const results: Row[] = new Array(rows.length);
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < rows.length) {
      const i = next++;
      const { slug, gif } = rows[i];
      try {
        results[i] = { slug, verdict: await analyzeMedia(gif) };
      } catch (e) {
        results[i] = { slug, error: e instanceof Error ? e.message : String(e) };
      }
    }
  }),
);

const allow = has('no-allow') ? new Set<string>() : loadMagentaAllowlist();
const bad = results.filter((r) => r.verdict?.magenta && !allow.has(r.slug));
const waived = results.filter((r) => r.verdict?.magenta && allow.has(r.slug));
const errors = results.filter((r) => r.error);
if (out !== undefined && out !== '') fs.writeFileSync(out, bad.map((r) => r.slug).join('\n') + (bad.length ? '\n' : ''));
let purged = 0;
if (has('purge') && bad.length) {
  purged = (await pool.query('DELETE FROM preview_gif WHERE slug = ANY($1::text[])', [bad.map((r) => r.slug)])).rowCount ?? 0;
}

if (has('json')) {
  console.log(JSON.stringify({ scanned: results.length, magenta: bad.length, waived: waived.map((r) => r.slug), errors: errors.length, purged, slugs: bad.map((r) => r.slug) }));
} else {
  for (const r of bad) console.log(`  magenta  ${r.slug.padEnd(64)} ${r.verdict!.reason}`);
  for (const r of waived) console.log(`  allowed  ${r.slug.padEnd(64)} ${r.verdict!.reason} (magenta-allow.txt)`);
  for (const r of errors) console.log(`  error    ${r.slug.padEnd(64)} ${r.error}`);
  console.log(`\nscanned=${results.length} magenta=${bad.length} errors=${errors.length}${has('purge') ? ` purged=${purged}` : ''}`);
}

await pool.end();
process.exitCode = errors.length ? 2 : bad.length ? 1 : 0;
