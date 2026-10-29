#!/usr/bin/env node
// Persist the Unity render outcome (data/previews/_failures.json, plan.md C9) into `preview_render`.
// Latest run wins per slug. Does NOT migrate: the table comes from migration 010 and this refuses a DB without it.
//
//   node seed/preview-failures-ingest.ts [--file <path>] [--dry-run] [--pack <slug-prefix>] [--json]
//
// stdout last line with --json (and also without): one JSON summary
//   {"runId","total","ok","failed","skipped","written","stale","dryRun"}
// Exit 0 ingested (failed renders are DATA, not an error), 1 file/DB error, 2 usage.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/src/config.ts';
import { ingestFailures, parseFailures, summarize } from './preview-failures.ts';

const HELP = `usage: node seed/preview-failures-ingest.ts [--file <_failures.json>] [--dry-run] [--pack <slug-prefix>] [--json]
  --file     default data/previews/_failures.json
  --dry-run  parse, validate and count; write nothing
  --pack     only slugs starting with this prefix (recipe slugs are <pack>-...)
  --json     accepted for symmetry with the other ingests; the one-line JSON summary is always printed
exit: 0 ok, 1 error, 2 usage`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const known = new Set(['--file', '--dry-run', '--pack', '--json']);
const bad = argv.filter((a, i) => a.startsWith('--') && !known.has(a));
if (bad.length > 0 || (argv.includes('--file') && !flag('file')) || (argv.includes('--pack') && !flag('pack'))) {
  console.error(HELP);
  process.exit(2);
}

const file = flag('file') ?? path.join(config.dataDir, 'previews', '_failures.json');
const dryRun = argv.includes('--dry-run');
const pack = flag('pack');

try {
  const parsed = parseFailures(fs.readFileSync(file, 'utf8'));
  if (pack) parsed.items = Object.fromEntries(Object.entries(parsed.items).filter(([slug]) => slug.startsWith(pack)));
  let summary;
  if (dryRun) summary = summarize(parsed, 0);
  else {
    const { pool } = await import('../server/src/db.ts');
    try {
      summary = await ingestFailures(pool, parsed);
    } finally {
      await pool.end();
    }
  }
  console.log(JSON.stringify({ ...summary, dryRun }));
} catch (e) {
  console.error(`preview-failures-ingest: ${(e as Error).message}`);
  process.exitCode = 1;
}
