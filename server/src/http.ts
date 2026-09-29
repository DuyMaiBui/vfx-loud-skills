import Fastify from 'fastify';
import { config } from './config.ts';
import { facets } from './facet-search.ts';
import { recolorRecord, type RecolorRequest } from './recolor-service.ts';
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

  app.post<{ Body: store.PublishArgs }>('/v1/publish', async (req) => {
    if (!req.body) throw new store.VfxError('body is required');
    const result = await store.publish(req.body);
    return { ...result, uri: result.uri };
  });

  return app;
}
