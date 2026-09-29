/**
 * Ingest an extractor --out dir into the lib DB via publish() (licence gate applies).
 *   node seed/ingest-extracted.ts --in <dir> [--limit N]
 * Idempotent: existing type+slug are skipped (same rule as seed/run.ts).
 */
import { parseArgs } from 'node:util';
import { publish, resourceExists } from '../server/src/store.ts';
import { pool } from '../server/src/db.ts';
import { ingestExtracted } from './extract/ingest.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { in: { type: 'string' }, limit: { type: 'string' } }, strict: true });
  if (!values.in) throw new Error('usage: ingest-extracted.ts --in <dir> [--limit N]');
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit must be a positive integer');
  const r = await ingestExtracted(values.in, { exists: resourceExists, publish }, limit);
  for (const f of r.failures.slice(0, 20)) console.error(`  ! ${f}`);
  console.log(`ingest done: published=${r.published} skipped_existing=${r.skippedExisting} failed=${r.failures.length}`);
  if (r.failures.length) process.exitCode = 1;
  await pool.end();
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
