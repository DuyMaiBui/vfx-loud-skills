/**
 * Combined fingerprint of every resource row: sha256 over "<uri> <version> <bytes> <sha256 of the payload file>\n",
 * rows in id order. Proves that a graph / reindex / enrichment step did not touch any payload. Asset rows live in
 * their own table, so they never enter this hash.   npm run corpus:sha
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../server/src/config.ts';
import { pool } from '../server/src/db.ts';

const rows = (await pool.query<{ uri: string; version: number; bytes: number; storage_uri: string }>('SELECT uri, version, bytes, storage_uri FROM resource ORDER BY id')).rows;
const h = createHash('sha256');
for (const r of rows) {
  const payload = createHash('sha256').update(fs.readFileSync(path.join(config.dataDir, r.storage_uri))).digest('hex');
  h.update(`${r.uri} ${r.version} ${r.bytes} ${payload}\n`);
}
console.log(`rows=${rows.length} sha256=${h.digest('hex')}`);
await pool.end();
