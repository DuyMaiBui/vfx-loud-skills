import fs from 'node:fs';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { VARIANTS, type Variant } from './bundle-contract.ts';
import * as blobs from './blob-store.ts';
import { registerFiles } from './blob-store-register.ts';
import { assetFileBundleFile, buildBundle } from './bundle-builder.ts';
import { config } from './config.ts';
import { facets } from './facet-search.ts';
import { gifBySlug, GIF_MIME } from './preview-gif.ts';
import { parseRange, PREVIEW_GIF_RE, PREVIEW_MIME, previewPath } from './previews.ts';
import { recolorRecord, type RecolorRequest } from './recolor-service.ts';
import * as review from './review.ts';
import * as store from './store.ts';

/**
 * `<slug>.gif` from the DB. The URL is not content-addressed (a re-render replaces the bytes under the same slug), so
 * it is revalidated like the webm: short max-age plus a sha256 ETag, which makes the common case a 304.
 */
async function sendGif(req: FastifyRequest<{ Params: { file: string } }>, reply: FastifyReply): Promise<unknown> {
  const name = req.params.file;
  const row = PREVIEW_GIF_RE.test(name) ? await gifBySlug(name.slice(0, -'.gif'.length)) : null;
  if (!row) return reply.code(404).send({ error: 'not found', code: 'not_found' });
  const etag = `"${row.sha256}"`;
  reply.header('content-type', GIF_MIME);
  reply.header('cache-control', 'public, max-age=300, must-revalidate');
  reply.header('etag', etag);
  reply.header('last-modified', new Date(row.updatedAt).toUTCString());
  if (req.headers['if-none-match'] === etag) return reply.code(304).send();
  reply.header('content-length', String(row.gif.length));
  return reply.send(row.gif);
}

/** Routes that carry purchased-pack bytes or their registry (C3): keyed even under AUTH_DISABLED=1. */
const BYTE_ROUTE_RE = /^\/v1\/(blob|asset-file|closure)(\/|$)/;

const MAX_MISSING_HASHES = 5000;
const MAX_BATCH_FILES = 500;
const GUID_PARAM_RE = /^[0-9a-f]{32}$/;

function keyMatches(given: string | string[] | undefined): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.apiKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  const h = Array.isArray(header) ? header.join(',') : (header ?? '');
  return h.split(',').some((t) => {
    const tag = t.trim().replace(/^W\//, '');
    return tag === '*' || tag === etag;
  });
}

function variantParam(raw: string | undefined, fallback: Variant): Variant {
  if (raw === undefined) return fallback;
  if (!(VARIANTS as readonly string[]).includes(raw)) throw new store.VfxError(`variant must be ${VARIANTS.join(' | ')}`, 'invalid');
  return raw as Variant;
}

export async function buildHttp(): Promise<Fastify.FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  app.addHook('onRequest', async (req) => {
    const route = req.url.split('?')[0];
    if (BYTE_ROUTE_RE.test(route) && !config.blobAllowAnon) {
      // D3: purchased bytes are never served open by accident, whatever AUTH_DISABLED says.
      if (!config.apiKey) throw new store.VfxError('blob routes need VFX_API_KEY (or VFX_BLOB_ALLOW_ANON=1)', 'forbidden');
      if (!keyMatches(req.headers['x-vfx-key'])) {
        const err = new Error('unauthorized') as Error & { statusCode?: number };
        err.statusCode = 401;
        throw err;
      }
      return;
    }
    if (config.authDisabled) return;
    if (!req.url.startsWith('/v1/')) return;
    if (req.headers['x-vfx-key'] !== config.apiKey) {
      const err = new Error('unauthorized') as Error & { statusCode?: number };
      err.statusCode = 401;
      throw err;
    }
  });

  // Blob bodies are raw octets, buffered up to the per-route bodyLimit (the parser itself keeps the server default).
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const STATUS_CODE: Record<number, 'invalid' | 'forbidden' | 'not_found' | 'too_large'> = { 400: 'invalid', 403: 'forbidden', 404: 'not_found', 413: 'too_large' };
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof store.VfxError) {
      const status =
        err.code === 'not_found' ? 404 : err.code === 'conflict' ? 409 : err.code === 'forbidden' ? 403 : err.code === 'too_large' ? 413 : 400;
      reply.code(status).send({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
      return;
    }
    const maybe = (err as { statusCode?: number }).statusCode;
    const message = err instanceof Error ? err.message : String(err);
    const code = typeof maybe === 'number' ? STATUS_CODE[maybe] : undefined;
    if (code) {
      reply.code(maybe as number).send({ error: message, code });
      return;
    }
    app.log.error(err);
    reply.code(typeof maybe === 'number' ? maybe : 500).send({ error: message });
  });

  app.get('/healthz', async () => {
    const n = await store.countResources();
    return { ok: true, resources: n, embedder: config.embedder };
  });

  app.post<{
    Body: { query: string; type?: store.ResourceType; tags?: string[]; style?: string[]; keywords?: string[]; filters?: unknown; limit?: number; collapseVariants?: boolean; graphWeight?: number };
  }>('/v1/search', async (req) => {
    const { query, type, tags, style, keywords, filters, limit, collapseVariants, graphWeight } = req.body ?? { query: '' };
    if (!query?.trim()) throw new store.VfxError('query is required');
    return { cards: await store.search({ query, type, tags, style, keywords, filters: store.parseFilters(filters), limit, collapseVariants, graphWeight }) };
  });

  /** Graph neighbourhood of one record: variant siblings, pairs_with, similar_to, applies_to, uses. */
  app.get<{ Querystring: { uri?: string; rel?: string; limit?: string } }>('/v1/related', async (req) => {
    const { uri, rel, limit } = req.query;
    if (!uri) throw new store.VfxError('uri is required');
    return store.related(uri, { rel: rel || undefined, limit: limit ? Number(limit) : undefined });
  });
  app.post<{ Body: { uri?: string; rel?: string; limit?: number } }>('/v1/related', async (req) => {
    const { uri, rel, limit } = req.body ?? {};
    if (!uri) throw new store.VfxError('uri is required');
    return store.related(uri, { rel, limit });
  });

  /** Facet value counts over the candidate set matching query + filters (see facet-search.ts for the cut-off). */
  app.post<{
    Body: { query?: string; type?: store.ResourceType; filters?: unknown; style?: string[]; keywords?: string[] };
  }>('/v1/facets', async (req) => {
    const { query, type, filters, style, keywords } = req.body ?? {};
    return facets({ query, type, style, keywords, filters: store.parseFilters(filters) });
  });

  app.get<{ Params: { type: string; slug: string; version: string } }>(
    '/v1/resource/:type/:slug/:version',
    async (req) => {
      const { type, slug, version } = req.params;
      return store.resolve(store.makeUri(type as store.ResourceType, slug, Number(version)));
    },
  );

  app.get<{ Params: { type: string; slug: string; version: string } }>(
    '/v1/resource/:type/:slug/:version/file',
    async (req, reply) => {
      const { type, slug, version } = req.params;
      const { row, buffer } = await store.readFile(
        store.makeUri(type as store.ResourceType, slug, Number(version)),
      );
      reply.header('content-type', row.mime);
      reply.header('content-length', String(buffer.length));
      reply.header('x-vfx-uri', row.uri);
      return reply.send(buffer);
    },
  );

  /**
   * Deterministic recolour of a stored recipe: derived payload + material tint list + per-key `changes`.
   * With publish:true also creates (idempotently) a NEW record derived_from the base.
   */
  app.post<{ Body: RecolorRequest }>('/v1/recolor', async (req) => {
    const b = req.body;
    if (!b || typeof b !== 'object') throw new store.VfxError('body is required');
    const opt = (v: unknown, t: string, name: string): void => {
      if (v !== undefined && typeof v !== t) throw new store.VfxError(`${name} must be a ${t}`);
    };
    opt(b.uri, 'string', 'uri');
    opt(b.targetColor, 'string', 'targetColor');
    opt(b.hueShiftDeg, 'number', 'hueShiftDeg');
    opt(b.preserveLuminance, 'boolean', 'preserveLuminance');
    opt(b.publish, 'boolean', 'publish');
    opt(b.includePayload, 'boolean', 'includePayload');
    return recolorRecord(b);
  });

  /**
   * Preview media. A `.gif` is answered from the DB (`preview_gif`): that copy is the one that travels with the
   * row. Everything else comes from data/previews — only flat `<slug>.webm|webp` names resolve (previewPath is
   * the traversal guard); single-range requests get 206 so <video> can seek; ETag/Last-Modified allow 304.
   */
  app.get<{ Params: { file: string } }>('/previews/:file', async (req, reply) => {
    if (req.params.file.endsWith('.gif')) return sendGif(req, reply);

    const abs = previewPath(req.params.file);
    if (!abs) return reply.code(404).send({ error: 'not found', code: 'not_found' });
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(abs);
      if (!st.isFile()) throw new Error('not a file');
    } catch {
      return reply.code(404).send({ error: 'not found', code: 'not_found' });
    }
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    reply.header('content-type', PREVIEW_MIME[abs.slice(abs.lastIndexOf('.'))]);
    reply.header('accept-ranges', 'bytes');
    reply.header('cache-control', 'public, max-age=300, must-revalidate');
    reply.header('etag', etag);
    reply.header('last-modified', st.mtime.toUTCString());
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    const range = parseRange(req.headers.range, st.size);
    if (range.kind === 'unsatisfiable') {
      reply.header('content-range', `bytes */${st.size}`);
      return reply.code(416).send();
    }
    if (range.kind === 'partial') {
      reply.code(206);
      reply.header('content-range', `bytes ${range.start}-${range.end}/${st.size}`);
      reply.header('content-length', String(range.end - range.start + 1));
      return reply.send(fs.createReadStream(abs, { start: range.start, end: range.end }));
    }
    reply.header('content-length', String(st.size));
    return reply.send(fs.createReadStream(abs));
  });

  /**
   * Review page. `?session=` re-opens a stored session (its id is the capability, no key needed); `?uris=` or
   * `?q=&type=&filters=<json>&set=a,b,c` creates one (needs the API key when auth is on: a browser cannot send it).
   */
  app.get<{ Querystring: { session?: string; uris?: string; q?: string; type?: string; filters?: string; set?: string; limit?: string; per?: string } }>('/review', async (req, reply) => {
    const { session, uris, q, type, filters, set, limit, per } = req.query;
    let id = session;
    if (!id) {
      if (!config.authDisabled && req.headers['x-vfx-key'] !== config.apiKey) {
        return reply.code(401).send({ error: 'unauthorized: create the session via POST /v1/review and open its url' });
      }
      let parsed: unknown;
      try {
        parsed = filters ? JSON.parse(filters) : undefined;
      } catch {
        throw new store.VfxError('filters must be JSON, e.g. {"element":["fire"]}', 'invalid');
      }
      id = (
        await review.createSession({
          uris: uris || undefined,
          q,
          type: type as store.ResourceType | undefined,
          filters: parsed,
          set,
          limit: limit ? Number(limit) : undefined,
          per: per ? Number(per) : undefined,
        })
      ).session;
    }
    const html = await review.renderPage(id);
    return reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').send(html);
  });

  app.post<{ Body: review.ReviewRequest }>('/v1/review', async (req) => {
    if (!req.body || typeof req.body !== 'object') throw new store.VfxError('body is required');
    return review.createSession(req.body);
  });
  app.post<{ Body: { session?: string; uris?: unknown; roles?: unknown } }>('/v1/review/selection', async (req) => {
    if (!req.body || typeof req.body !== 'object') throw new store.VfxError('body is required');
    return review.saveSelection(req.body);
  });
  // Same handler for the page itself: it cannot send the API key, the unguessable session id is the capability.
  app.post<{ Body: { session?: string; uris?: unknown; roles?: unknown } }>('/review/selection', async (req) => {
    if (!req.body || typeof req.body !== 'object') throw new store.VfxError('body is required');
    return review.saveSelection(req.body);
  });
  app.get<{ Querystring: { session?: string } }>('/v1/review/selection', async (req) => review.getSelection(req.query.session ?? ''));

  app.post<{ Body: store.PublishArgs }>('/v1/publish', async (req) => {
    if (!req.body) throw new store.VfxError('body is required');
    const result = await store.publishPublic(req.body);
    return { ...result, uri: result.uri };
  });

  // ---- vfx-bytes/1 blob and bundle routes (plan.md C3) ----

  app.post<{ Body: { sha256?: unknown } }>('/v1/blob/missing', async (req) => {
    const list = req.body?.sha256;
    if (!Array.isArray(list)) throw new store.VfxError('sha256 must be an array of 64-hex hashes', 'invalid');
    if (list.length > MAX_MISSING_HASHES) throw new store.VfxError(`at most ${MAX_MISSING_HASHES} hashes`, 'invalid', { max: MAX_MISSING_HASHES });
    const bad = list.find((h) => typeof h !== 'string' || !blobs.SHA256_RE.test(h));
    if (bad !== undefined) throw new store.VfxError('sha256 entries must be 64 lowercase hex', 'invalid', { bad: String(bad).slice(0, 80) });
    return { missing: await blobs.missing(list as string[]) };
  });

  app.put<{ Params: { sha256: string }; Body: Buffer | undefined }>(
    '/v1/blob/:sha256',
    { bodyLimit: config.blobMaxBytes },
    async (req, reply) => {
      const { sha256 } = req.params;
      if (!blobs.SHA256_RE.test(sha256)) throw new store.VfxError('sha256 must be 64 lowercase hex', 'invalid');
      const kind = req.headers['x-vfx-kind'];
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const put = await blobs.putBlob(body, sha256, typeof kind === 'string' ? kind : undefined);
      return reply.code(put.created ? 201 : 200).send(put);
    },
  );

  app.route<{ Params: { sha256: string } }>({
    method: ['GET', 'HEAD'],
    url: '/v1/blob/:sha256',
    handler: async (req, reply) => {
      const info = await blobs.servableBlob(req.params.sha256);
      if (!info) throw new store.VfxError('blob not found', 'not_found');
      const etag = `"${info.sha256}"`;
      reply.header('etag', etag);
      reply.header('x-vfx-sha256', info.sha256);
      reply.header('cache-control', 'private, max-age=31536000, immutable');
      reply.header('vary', 'accept-encoding');
      if (etagMatches(req.headers['if-none-match'], etag)) return reply.code(304).send();
      const gzip = blobs.acceptsGzip(req.headers['accept-encoding']);
      reply.header('content-type', 'application/octet-stream');
      if (req.method === 'HEAD') {
        const d = blobs.blobDelivery(info, gzip);
        if (d.contentEncoding) reply.header('content-encoding', d.contentEncoding);
        if (d.contentLength !== null) reply.header('content-length', String(d.contentLength));
        return reply.send();
      }
      const out = blobs.openBlob(info, gzip);
      if (out.contentEncoding) reply.header('content-encoding', out.contentEncoding);
      if (out.contentLength !== null) reply.header('content-length', String(out.contentLength));
      return reply.send(out.stream);
    },
  });

  app.post<{ Body: { files?: unknown } }>('/v1/asset-file/batch', async (req) => {
    const files = req.body?.files;
    if (!Array.isArray(files)) throw new store.VfxError('files must be an array of AssetFileInput', 'invalid');
    if (files.length > MAX_BATCH_FILES) throw new store.VfxError(`at most ${MAX_BATCH_FILES} files per batch`, 'invalid', { max: MAX_BATCH_FILES });
    return registerFiles(files);
  });

  app.get<{ Params: { guid: string }; Querystring: { variant?: string } }>('/v1/asset-file/:guid', async (req) => {
    if (!GUID_PARAM_RE.test(req.params.guid)) throw new store.VfxError('guid must be 32 lowercase hex', 'invalid');
    const variant = variantParam(req.query.variant, 'original');
    const file = await assetFileBundleFile(req.params.guid, variant);
    if (!file) throw new store.VfxError(`asset file ${req.params.guid} (${variant}) not found`, 'not_found');
    return file;
  });

  app.get<{ Params: { type: string; slug: string; version: string }; Querystring: { variant?: string } }>(
    '/v1/closure/:type/:slug/:version',
    async (req) => {
      const variant = variantParam(req.query.variant, 'urp');
      const { type, slug, version } = req.params;
      return buildBundle(store.makeUri(type as store.ResourceType, slug, Number(version)), variant);
    },
  );

  return app;
}
