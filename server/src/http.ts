import fs from 'node:fs';
import Fastify from 'fastify';
import { config } from './config.ts';
import { facets } from './facet-search.ts';
import { recolorRecord, type RecolorRequest } from './recolor-service.ts';
import { parseRange, PREVIEW_MIME, previewPath } from './previews.ts';
import * as review from './review.ts';
import * as store from './store.ts';

export async function buildHttp(): Promise<Fastify.FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  app.addHook('onRequest', async (req) => {
    if (config.authDisabled) return;
    if (!req.url.startsWith('/v1/')) return;
    if (req.headers['x-vfx-key'] !== config.apiKey) {
      const err = new Error('unauthorized') as Error & { statusCode?: number };
      err.statusCode = 401;
      throw err;
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof store.VfxError) {
      const code =
        err.code === 'not_found' ? 404 : err.code === 'conflict' ? 409 : 400;
      reply.code(code).send({ error: err.message, code: err.code });
      return;
    }
    app.log.error(err);
    const maybe = (err as { statusCode?: number }).statusCode;
    reply
      .code(typeof maybe === 'number' ? maybe : 500)
      .send({ error: err instanceof Error ? err.message : String(err) });
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
   * Preview media from data/previews. Only flat `<slug>.webm|webp` names resolve (previewPath is the traversal guard);
   * single-range requests get 206 so <video> can seek; ETag/Last-Modified allow 304.
   */
  app.get<{ Params: { file: string } }>('/previews/:file', async (req, reply) => {
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
    const result = await store.publish(req.body);
    return { ...result, uri: result.uri };
  });

  return app;
}
