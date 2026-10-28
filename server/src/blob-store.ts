/**
 * Content-addressed blob store (vfx-bytes/1, C2). Bytes live under `${DATA_DIR}/blobs/<aa>/<bb>/<sha256>`
 * (sha256 of the UNCOMPRESSED bytes), metadata in `asset_blob`. Text kinds are gzipped at rest.
 * A blob is only SERVED when an `asset_file` row references it as asset or `.meta` (C1): an orphan is 404.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { KINDS, TEXT_KINDS } from './bundle-contract.ts';
import { config } from './config.ts';
import { pool } from './db.ts';
import { VfxError } from './errors.ts';

export const SHA256_RE = /^[0-9a-f]{64}$/;

/** Everything the `x-vfx-kind` header may name: the file kinds plus the two storage hints (C2). */
export const STORAGE_KINDS: readonly string[] = [...KINDS, 'meta', 'other-text'];

export interface PutResult {
  sha256: string;
  bytes: number;
  created: boolean;
}

export interface BlobInfo {
  sha256: string;
  bytes: number;
  storedBytes: number;
  encoding: 'identity' | 'gzip';
  abs: string;
}

/** Gzip at rest for the text kinds (C2); no kind or any binary kind is stored as is. */
export function encodingForKind(kind: string | undefined | null): 'identity' | 'gzip' {
  return kind && (TEXT_KINDS as readonly string[]).includes(kind) ? 'gzip' : 'identity';
}

function blobPath(sha: string): string {
  return path.join(config.blobDir, sha.slice(0, 2), sha.slice(2, 4), sha);
}

/** Resolve a `storage_uri` (relative to DATA_DIR) and refuse anything that escapes it. */
function resolveStored(uri: string): string {
  const root = path.resolve(config.dataDir);
  const abs = path.resolve(root, uri);
  if (!abs.startsWith(root + path.sep)) throw new VfxError('Illegal blob storage path', 'invalid');
  return abs;
}

type Source = Buffer | Uint8Array | AsyncIterable<Buffer | Uint8Array>;

/**
 * Store `source` under its sha256. Hashes while writing to `blobs/tmp/<rand>`, compares with `expectedSha`
 * (mismatch: `invalid` + `details.actual`, nothing left behind), aborts above `blobMaxBytes` (`too_large`),
 * then renames into place and upserts `asset_blob`. A second put of the same sha is a no-op (`created:false`).
 */
export async function putBlob(source: Source, expectedSha: string, kind?: string | null): Promise<PutResult> {
  if (!SHA256_RE.test(expectedSha)) throw new VfxError('sha256 must be 64 lowercase hex', 'invalid');
  if (kind && !STORAGE_KINDS.includes(kind)) throw new VfxError(`unknown x-vfx-kind "${kind}"`, 'invalid');
  const encoding = encodingForKind(kind);

  const tmpDir = path.join(config.blobDir, 'tmp');
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, randomBytes(12).toString('hex'));

  const hash = createHash('sha256');
  let bytes = 0;
  const limit = config.blobMaxBytes;
  async function* counted(): AsyncGenerator<Buffer> {
    const chunks = source instanceof Uint8Array ? [source] : source;
    for await (const c of chunks) {
      const chunk = Buffer.from(c.buffer, c.byteOffset, c.byteLength);
      bytes += chunk.length;
      if (bytes > limit) throw new VfxError(`blob exceeds ${limit} bytes`, 'too_large', { limit });
      hash.update(chunk);
      yield chunk;
    }
  }

  try {
    const input = Readable.from(counted(), { objectMode: false });
    const out = fs.createWriteStream(tmp, { flags: 'wx' });
    if (encoding === 'gzip') await pipeline(input, zlib.createGzip(), out);
    else await pipeline(input, out);

    const actual = hash.digest('hex');
    if (actual !== expectedSha) {
      throw new VfxError(`body sha256 ${actual} does not match ${expectedSha}`, 'invalid', { actual });
    }
    const dest = blobPath(expectedSha);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const storedBytes = (await fs.promises.stat(tmp)).size;
    await fs.promises.rename(tmp, dest);
    const ins = await pool.query(
      `INSERT INTO asset_blob (sha256, bytes, stored_bytes, encoding, storage_uri)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (sha256) DO NOTHING`,
      [expectedSha, bytes, storedBytes, encoding, path.relative(config.dataDir, dest)],
    );
    return { sha256: expectedSha, bytes, created: (ins.rowCount ?? 0) > 0 };
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

/** The subset of `shas` that is not stored, deduplicated, in input order. */
export async function missing(shas: string[]): Promise<string[]> {
  const unique = [...new Set(shas)];
  if (unique.length === 0) return [];
  const r = await pool.query<{ sha256: string }>('SELECT sha256 FROM asset_blob WHERE sha256 = ANY($1)', [unique]);
  const have = new Set(r.rows.map((x) => x.sha256));
  return unique.filter((s) => !have.has(s));
}

/** True when the sha is the `asset_sha256` OR the `meta_sha256` of any `asset_file` row (C1). */
export async function isReferenced(sha: string): Promise<boolean> {
  const r = await pool.query('SELECT 1 FROM asset_file WHERE asset_sha256 = $1 OR meta_sha256 = $1 LIMIT 1', [sha]);
  return (r.rowCount ?? 0) > 0;
}

/** Stored-blob metadata WITHOUT the referenced check (registration and tests); null when unknown. */
export async function blobRow(sha: string): Promise<BlobInfo | null> {
  const r = await pool.query<{ bytes: string; stored_bytes: string; encoding: 'identity' | 'gzip'; storage_uri: string }>(
    'SELECT bytes, stored_bytes, encoding, storage_uri FROM asset_blob WHERE sha256 = $1',
    [sha],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    sha256: sha,
    bytes: Number(row.bytes),
    storedBytes: Number(row.stored_bytes),
    encoding: row.encoding,
    abs: resolveStored(row.storage_uri),
  };
}

/** Metadata of a blob that may be SERVED: stored and referenced by an `asset_file` row, else null (404). */
export async function servableBlob(sha: string): Promise<BlobInfo | null> {
  if (!SHA256_RE.test(sha)) return null;
  const info = await blobRow(sha);
  if (!info || !(await isReferenced(sha))) return null;
  return info;
}

/** Does the Accept-Encoding header allow gzip (a `gzip` or `*` token with q > 0)? */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  const h = Array.isArray(header) ? header.join(',') : (header ?? '');
  for (const part of h.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (name !== 'gzip' && name !== '*') continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  }
  return false;
}

export interface BlobStream {
  stream: NodeJS.ReadableStream;
  /** 'gzip' when the STORED bytes are served as is to a gzip-accepting client. */
  contentEncoding: 'gzip' | null;
  /** Length of what is sent, or null when it is not known up front (gunzipped on the fly). */
  contentLength: number | null;
}

/** How a blob is sent to a client: identity as is, gzip-at-rest as is for gzip clients, else gunzipped. */
export function blobDelivery(info: BlobInfo, clientAcceptsGzip: boolean): Omit<BlobStream, 'stream'> {
  if (info.encoding === 'identity') return { contentEncoding: null, contentLength: info.bytes };
  return clientAcceptsGzip
    ? { contentEncoding: 'gzip', contentLength: info.storedBytes }
    : { contentEncoding: null, contentLength: null };
}

export function openBlob(info: BlobInfo, clientAcceptsGzip: boolean): BlobStream {
  const delivery = blobDelivery(info, clientAcceptsGzip);
  const file = fs.createReadStream(info.abs);
  const stream = info.encoding === 'gzip' && !clientAcceptsGzip ? file.pipe(zlib.createGunzip()) : file;
  if (stream !== file) file.on('error', (e) => stream.destroy(e));
  return { stream, ...delivery };
}

/** Decompressed bytes of a stored blob (server-side refs scan). */
export async function readBlob(sha: string): Promise<Buffer> {
  const info = await blobRow(sha);
  if (!info) throw new VfxError(`blob ${sha} not stored`, 'not_found');
  const raw = await fs.promises.readFile(info.abs);
  return info.encoding === 'gzip' ? zlib.gunzipSync(raw) : raw;
}
