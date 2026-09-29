import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { config } from './config.ts';
import { pool } from './db.ts';
import { getEmbedder } from './embed.ts';
import { aiTrainingAllowed, extractedLicenseProblem, licenseClassOf } from './license.ts';
import { SLUG_RE } from './slug.ts';
import { searchDocument } from './search-doc.ts';
import { expandQuery } from './vocab.ts';

export { aiTrainingAllowed, licenseClassOf };

export const RESOURCE_TYPES = [
  'texture',
  'shader',
  'code',
  'recipe',
  'component',
  'vfx',
  'technique',
  'skill',
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export interface ResourceRow {
  id: number;
  uri: string;
  type: ResourceType;
  slug: string;
  version: number;
  name: string;
  description: string;
  tags: string[];
  style: string[];
  category: string;
  engine: string;
  license: string;
  visibility: string;
  storage_uri: string;
  preview_uri: string | null;
  mime: string;
  bytes: number;
  meta: Record<string, unknown>;
  created_by: string;
  created_at: string;
  score?: number;
}

export interface Card {
  uri: string;
  type: ResourceType;
  name: string;
  score: number;
  description: string;
  tags: string[];
  style: string[];
  keywords: string[];
  license: string;
  preview_uri: string | null;
}

export class VfxError extends Error {
  readonly code: 'not_found' | 'invalid' | 'conflict';

  constructor(
    message: string,
    code: 'not_found' | 'invalid' | 'conflict' = 'invalid',
  ) {
    super(message);
    this.code = code;
  }
}

const extFor: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'text/plain': 'txt',
  'application/json': 'json',
  'text/x-csharp': 'cs',
  'text/yaml': 'yaml',
  'text/plain; charset=utf-8': 'txt',
};

export function mimeFromName(name: string): string {
  const ext = path.extname(name).toLowerCase().replace('.', '');
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    tga: 'image/x-tga',
    psd: 'image/vnd.adobe.psd',
    exr: 'image/x-exr',
    cs: 'text/x-csharp',
    json: 'application/json',
    md: 'text/plain',
    txt: 'text/plain',
    shader: 'text/plain',
    shadergraph: 'application/json',
    mat: 'text/yaml',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    prefab: 'text/yaml',
    unity: 'text/yaml',
  };
  return map[ext] ?? 'application/octet-stream';
}

function extForMime(mime: string): string {
  return extFor[mime] ?? 'bin';
}

export function makeUri(type: ResourceType, slug: string, version: number): string {
  return `vfx://${type}/${slug}/${version}`;
}

function toCard(row: ResourceRow): Card {
  return {
    uri: row.uri,
    type: row.type,
    name: row.name,
    score: Number((row.score ?? 0).toFixed(4)),
    description: row.description,
    tags: row.tags ?? [],
    style: row.style ?? [],
    keywords: Array.isArray(row.meta?.keywords) ? (row.meta.keywords as string[]) : [],
    license: row.license,
    preview_uri: row.preview_uri,
  };
}

/* ------------------------------------------------------------------ search */

export interface SearchArgs {
  query: string;
  type?: ResourceType;
  tags?: string[];
  /** Pack-level style ids (toon, stylized, retro, sci-fi, low-poly); aliases like "cartoon" / "low poly" are normalised. */
  style?: string[];
  /** Match records carrying ANY of these meta.keywords (element / use / colour / loop ...). */
  keywords?: string[];
  limit?: number;
}

/** Hybrid weights: cosine of the (hashing) embedding vs. weighted full-text rank. Env-tunable. */
const W_VEC = Number(process.env.SEARCH_W_VEC ?? 0.3);
const W_KW = 1 - W_VEC;
const W_ALL = 0.15; // bonus when EVERY word the user typed is present ("blue fire" prefers blue AND fire)
const W_EXPANSION = 0.6; // synonym / Vietnamese-alias words count less than the user's own words

/** Words -> an AND tsquery string ("blue & fire"). */
function andQuery(words: string[]): string {
  return orQuery(words).split(' | ').filter(Boolean).join(' & ');
}

/** Words -> a safe OR tsquery string ("bubbl | burst"); empty when nothing usable. */
function orQuery(words: string[]): string {
  const ok = [...new Set(words.map((w) => w.replace(/[^\p{L}\p{N}]+/gu, '')).filter((w) => w.length > 1))];
  return ok.join(' | ');
}

export async function search(args: SearchArgs): Promise<Card[]> {
  const limit = Math.min(Math.max(args.limit ?? 8, 1), 50);
  const ex = expandQuery(args.query);
  const vec = await getEmbedder().embed(ex.text);
  const literal = vec.map((x) => Number(x.toFixed(6))).join(',');
  const qOrig = orQuery(ex.original);
  const qExp = orQuery(ex.expansion);
  const qAll = ex.original.length > 1 ? andQuery(ex.original) : '';
  const styles = (args.style ?? []).map((s) => expandQuery(s).styles[0] ?? s.toLowerCase());
  const keywords = (args.keywords ?? []).map((k) => k.toLowerCase());

  const rows = await pool.query<ResourceRow>(
    `WITH q AS (
       SELECT $1::vector AS v,
              CASE WHEN $2 = '' THEN NULL ELSE to_tsquery('english', $2) END AS orig,
              CASE WHEN $3 = '' THEN NULL ELSE to_tsquery('english', $3) END AS exp,
              CASE WHEN $12 = '' THEN NULL ELSE to_tsquery('english', $12) END AS allq
     )
     SELECT uri, type, slug, version, name, description, tags, style, category,
            engine, license, visibility, storage_uri, preview_uri, mime, bytes,
            meta, created_by, created_at,
            (
              $4::float * GREATEST(0, 1 - (embedding <=> q.v))
            + (1 - $4::float) * (
                COALESCE(ts_rank_cd('{0.1,0.2,0.4,1.0}', search_tsv, q.orig, 32), 0)
              + $5::float * COALESCE(ts_rank_cd('{0.1,0.2,0.4,1.0}', search_tsv, q.exp, 32), 0)
              + $13::float * (CASE WHEN q.allq IS NOT NULL AND search_tsv @@ q.allq THEN 1 ELSE 0 END))
            ) AS score
       FROM resource, q
      WHERE ($6::text IS NULL OR type = $6::text)
        AND ($7::text[] IS NULL OR tags && $7::text[])
        AND ($8::text[] IS NULL OR style && $8::text[])
        AND ($9::text[] IS NULL OR (meta->'keywords') ?| $9::text[])
        AND visibility = ANY($10::text[])
      ORDER BY score DESC, id
      LIMIT $11`,
    [
      `[${literal}]`,
      qOrig,
      qExp,
      W_VEC,
      W_EXPANSION,
      args.type ?? null,
      args.tags && args.tags.length ? args.tags : null,
      styles.length ? styles : null,
      keywords.length ? keywords : null,
      // V0 chưa có auth -> luôn thấy cả 3 mức. Cột đã sẵn sàng cho V0.4.
      ['project', 'team', 'global'],
      limit,
      qAll,
      W_ALL,
    ],
  );

  return rows.rows.map(toCard);
}

/* ----------------------------------------------------------------- resolve */

export interface Manifest {
  uri: string;
  type: ResourceType;
  slug: string;
  version: number;
  name: string;
  description: string;
  tags: string[];
  style: string[];
  category: string;
  license: string;
  visibility: string;
  mime: string;
  bytes: number;
  file_name: string;
  sha256: string;
  dependencies: string[];
  download_url: string;
  preview_url: string | null;
  meta: Record<string, unknown>;
}

function absoluteUrl(p: string | null | undefined): string | null {
  if (!p) return null;
  if (/^https?:\/\//.test(p)) return p;
  const base =
    config.publicBaseUrl ||
    `http://127.0.0.1:${config.port}`;
  return `${base}${p.startsWith('/') ? '' : '/'}${p}`;
}

export async function getByUri(uri: string): Promise<ResourceRow> {
  const row = await pool.query<ResourceRow>(
    'SELECT * FROM resource WHERE uri = $1',
    [uri],
  );
  if (!row.rowCount) throw new VfxError(`Not found: ${uri}`, 'not_found');
  return row.rows[0];
}

export async function resolve(uri: string): Promise<Manifest> {
  const r = await getByUri(uri);

  const edges = await pool.query<{ dst_uri: string }>(
    `SELECT d.uri AS dst_uri
       FROM resource_edge e JOIN resource d ON d.id = e.dst
      WHERE e.src = $1`,
    [r.id],
  );

  const fileUrl = `/v1/resource/${r.type}/${r.slug}/${r.version}/file`;

  let sha256: string;
  try {
    const abs = path.resolve(config.dataDir, r.storage_uri);
    const buf = await fs.readFile(abs);
    sha256 = createHash('sha256').update(buf).digest('hex');
  } catch {
    sha256 = '';
  }

  return {
    uri: r.uri,
    type: r.type,
    slug: r.slug,
    version: r.version,
    name: r.name,
    description: r.description,
    tags: r.tags ?? [],
    style: r.style ?? [],
    category: r.category,
    license: r.license,
    visibility: r.visibility,
    mime: r.mime,
    bytes: r.bytes,
    file_name: `${r.slug}${path.posix.extname(path.posix.basename(r.storage_uri))}`,
    sha256,
    dependencies: edges.rows.map((e) => e.dst_uri),
    download_url: absoluteUrl(fileUrl)!,
    preview_url: absoluteUrl(r.preview_uri),
    meta: r.meta ?? {},
  };
}

export async function readFile(
  uri: string,
): Promise<{ row: ResourceRow; buffer: Buffer }> {
  const r = await getByUri(uri);
  const abs = path.resolve(config.dataDir, r.storage_uri);
  if (!abs.startsWith(path.resolve(config.dataDir))) {
    throw new VfxError('Illegal storage path', 'invalid');
  }
  const buffer = await fs.readFile(abs);
  return { row: r, buffer };
}

/* ----------------------------------------------------------------- publish */

export interface PublishArgs {
  type: ResourceType;
  slug: string;
  name: string;
  description?: string;
  tags?: string[];
  style?: string[];
  category?: string;
  license: string;
  visibility?: 'project' | 'team' | 'global';
  fileName?: string;
  b64?: string;
  localPath?: string;
  dependencies?: string[];
  meta?: Record<string, unknown>;
  createdBy?: string;
}

function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new VfxError(
      `Invalid slug "${slug}" — dùng a-z, 0-9, dấu "-" (vd: soft-dust-03)`,
      'invalid',
    );
  }
}

/** Tham chiếu `vfx://type/slug/version` trong payload text/manifest. */
const URI_REF = /vfx:\/\/[a-z0-9-]+\/[a-z0-9-]+\/\d+/g;

function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/json';
}

/**
 * Dựng knowledge graph: ghi resource_edge 'uses' cho mọi URI được tham chiếu
 * trong payload + manifest + args.dependencies. URI chưa tồn tại thì bỏ qua
 * (edge chỉ trỏ tới resource thật).
 */
async function linkDependencies(
  client: PoolClient,
  srcId: number,
  refs: string[],
): Promise<number> {
  let linked = 0;
  for (const ref of new Set(refs)) {
    const dst = await client.query<{ id: number }>(
      'SELECT id FROM resource WHERE uri = $1',
      [ref],
    );
    if (!dst.rowCount) continue;
    const ins = await client.query(
      `INSERT INTO resource_edge (src, dst, rel) VALUES ($1, $2, 'uses')
       ON CONFLICT DO NOTHING`,
      [srcId, dst.rows[0].id],
    );
    linked += ins.rowCount ?? 0;
  }
  return linked;
}

function licenseMeta(
  license: string,
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...meta };
  if (out.license_class === undefined) out.license_class = licenseClassOf(license);
  if (out.ai_training === undefined) out.ai_training = aiTrainingAllowed(license);
  return out;
}

/** Idempotency probe shared by seed scripts: is there already a resource with this type+slug? */
export async function resourceExists(type: string, slug: string): Promise<boolean> {
  const r = await pool.query('SELECT 1 FROM resource WHERE type = $1 AND slug = $2 LIMIT 1', [type, slug]);
  return r.rowCount !== 0;
}

export async function publish(
  args: PublishArgs,
): Promise<{ uri: string; version: number; dependencies: number }> {
  const license = (args.license ?? '').trim();
  if (!license) throw new VfxError('license is required', 'invalid');
  if (license.toLowerCase() === 'unknown') {
    throw new VfxError(
      'license "unknown" bị từ chối — ingest gate (xem phase-0-contract.md)',
      'invalid',
    );
  }
  if (args.meta?.extracted === true) {
    const m = args.meta;
    const problem =
      extractedLicenseProblem(license) ??
      (m.license_class !== undefined && m.license_class !== 'proprietary-commercial'
        ? `meta.license_class "${String(m.license_class)}" must be proprietary-commercial`
        : m.ai_training === true
          ? 'meta.ai_training must be false'
          : null);
    if (problem) {
      throw new VfxError(`extracted record refused: ${problem}`, 'invalid');
    }
  }
  assertSlug(args.slug);

  let bytes: Buffer;
  if (args.b64) {
    bytes = Buffer.from(args.b64, 'base64');
  } else if (args.localPath) {
    const abs = path.resolve(args.localPath);
    bytes = await fs.readFile(abs);
    if (!args.fileName) args.fileName = path.basename(abs);
  } else {
    throw new VfxError('cần cả b64 hoặc local_path', 'invalid');
  }
  if (!bytes.length) throw new VfxError('payload rỗng', 'invalid');

  const embedder = getEmbedder();
  const description = args.description ?? '';
  const keywords = Array.isArray(args.meta?.keywords) ? (args.meta.keywords as string[]) : [];
  const doc = searchDocument({ name: args.name, description, category: args.category ?? '', tags: args.tags ?? [], keywords });
  const text = doc.embedText;
  const vec = await embedder.embed(text);
  const literal = vec.map((x) => Number(x.toFixed(6))).join(',');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const prev = await client.query<{ v: number }>(
      'SELECT COALESCE(MAX(version), 0) AS v FROM resource WHERE type = $1 AND slug = $2',
      [args.type, args.slug],
    );
    const version = prev.rows[0].v + 1;

    const fileName =
      args.fileName ?? `${args.slug}.${extForMime(mimeFromName(`${args.slug}.bin`))}`;
    const ext = path.extname(fileName).replace('.', '') || 'bin';
    const rel = path.posix.join(args.type, args.slug, `v${version}.${ext}`);
    const abs = path.join(config.dataDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);

    const uri = makeUri(args.type, args.slug, version);
    const mime = mimeFromName(fileName);

    const ins = await client.query<ResourceRow>(
      `INSERT INTO resource
         (uri, type, slug, version, name, description, tags, style, category,
          engine, license, visibility, storage_uri, preview_uri, mime, bytes,
          embedding, meta, created_by, search_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL,$14,$15,$16::vector,$17,$18,$19)
       RETURNING *`,
      [
        uri,
        args.type,
        args.slug,
        version,
        args.name,
        description,
        args.tags ?? [],
        args.style ?? [],
        args.category ?? '',
        'unity',
        license,
        args.visibility ?? 'project',
        rel,
        mime,
        bytes.length,
        `[${literal}]`,
        JSON.stringify(licenseMeta(license, args.meta ?? {})),
        args.createdBy ?? 'api',
        doc.searchText,
      ],
    );

    const linked = await linkDependencies(client, ins.rows[0].id, [
      ...(args.dependencies ?? []),
      ...((args.description ?? '').match(URI_REF) ?? []),
      ...(args.name.match(URI_REF) ?? []),
      ...(isTextMime(mime) ? (bytes.toString('utf8').match(URI_REF) ?? []) : []),
    ]);

    await client.query('COMMIT');
    return { uri: ins.rows[0].uri, version, dependencies: linked };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function countResources(): Promise<number> {
  const r = await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM resource');
  return Number(r.rows[0].n);
}

/**
 * Quét lại toàn bộ corpus và dựng resource_edge từ các tham chiếu vfx://.
 * Idempotent (ON CONFLICT DO NOTHING) — dùng để backfill sau khi đổi cách
 * extract dependency, hoặc khi seed lại corpus cũ.
 */
export async function relinkAll(): Promise<{ scanned: number; edges: number }> {
  const rows = await pool.query<{
    id: number;
    uri: string;
    name: string;
    description: string;
    mime: string;
    storage_uri: string;
  }>(
    'SELECT id, uri, name, description, mime, storage_uri FROM resource ORDER BY id',
  );

  const client = await pool.connect();
  let scanned = 0;
  let edges = 0;
  try {
    await client.query('BEGIN');
    for (const row of rows.rows) {
      let refs = [
        ...(row.name.match(URI_REF) ?? []),
        ...(row.description.match(URI_REF) ?? []),
      ];
      if (isTextMime(row.mime)) {
        try {
          const abs = path.resolve(config.dataDir, row.storage_uri);
          const buf = await fs.readFile(abs);
          refs.push(...(buf.toString('utf8').match(URI_REF) ?? []));
        } catch {
          /* file mất -> bỏ qua, edge cũ giữ nguyên */
        }
      }
      scanned++;
      edges += await linkDependencies(client, row.id, refs);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { scanned, edges };
}
