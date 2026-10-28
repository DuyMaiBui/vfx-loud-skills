#!/usr/bin/env node
// Encode every rendered preview (data/previews/<slug>.webm) into a looping GIF stored in `preview_gif`, so an
// effect set or a search result can be previewed from the DB. Idempotent: an unchanged webm with the same
// encoder generation writes nothing.
//
//   npm run previews:gif                            # every slug in data/previews/index.json
//   npm run previews:gif -- --only a,b              # a subset
//   npm run previews:gif -- --force                 # re-encode even when the source hash matches
//   npm run previews:gif -- --json                  # one-line machine-readable summary
//
// Exit 0 when nothing failed, 1 when at least one slug failed to encode.
import { migrate, pool } from '../server/src/db.ts';
import { GIF_BUILDER as builder, ingestPreviews } from '../server/src/preview-gif-encode.ts';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? '') : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const json = has('json');
const only = flag('only')?.split(',').map((s) => s.trim()).filter(Boolean);

const started = Date.now();
await migrate();
const summary = await ingestPreviews({ force: has('force'), only });
const ms = Date.now() - started;

if (json) {
  console.log(JSON.stringify({ ...summary, builder, ms }));
} else {
  for (const r of summary.results) {
    const detail =
      r.status === 'stored'
        ? `${r.sourceBytes} B webm -> ${r.bytes} B gif ${r.width}x${r.height} ${r.frames}f @${r.fps} [${r.encoder}]${r.overBudget ? ' OVER BUDGET' : ''}`
        : r.status === 'unchanged'
          ? 'unchanged'
          : r.reason ?? '';
    console.log(`  ${r.status.padEnd(9)} ${r.slug}  ${detail}`);
  }
  console.log(
    `\nscanned=${summary.scanned} stored=${summary.stored} unchanged=${summary.unchanged} ` +
      `skipped=${summary.skipped} failed=${summary.failed} in ${(ms / 1000).toFixed(1)}s (builder=${builder})`,
  );
}

await pool.end();
// exitCode, not process.exit(): exit() truncates piped stdout at 64 KB (BatchEntry reads this JSON line over a pipe).
process.exitCode = summary.failed > 0 ? 1 : 0;
