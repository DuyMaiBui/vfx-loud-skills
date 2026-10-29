// Pure half of the render-failure ingest (plan.md C9): parse + validate `data/previews/_failures.json`
// and build the upsert. No pool import: callers pass any `{ query }`, so tests can use a scratch DB or a fake.
import { RenderFailureFileSchema, type RenderFailureFile } from '../server/src/bundle-contract.ts';

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export interface FailureSummary {
  runId: string;
  total: number;
  ok: number;
  /** state=failed only: skipped rows are by-design omissions, never failures. */
  failed: number;
  skipped: number;
  /** Rows written or refreshed; a row held back because the DB already has a newer run is not counted. */
  written: number;
  stale: number;
}

/** Throws a readable error when the text is not a valid C9 file (failed without a cause, invented cause, bad slug...). */
export function parseFailures(text: string): RenderFailureFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`_failures.json is not JSON: ${(e as Error).message}`);
  }
  const parsed = RenderFailureFileSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`_failures.json invalid at ${first?.path.join('.') ?? '?'}: ${first?.message ?? 'schema'}`);
  }
  return parsed.data;
}

/**
 * One multi-row upsert. Latest run wins per slug: an existing row is replaced only when the incoming
 * (rendered_at, run_id) is >= the stored one, so replaying an older file never clobbers a newer render.
 */
export function buildUpsert(file: RenderFailureFile): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const tuples: string[] = [];
  for (const [slug, it] of Object.entries(file.items)) {
    const base = params.length;
    params.push(slug, it.state, it.cause, it.detail, it.shaders, file.runId, it.renderedAt);
    tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::text[], $${base + 6}, $${base + 7}::timestamptz)`);
  }
  const sql =
    `INSERT INTO preview_render (slug, state, cause, detail, shaders, run_id, rendered_at) VALUES ${tuples.join(', ')} ` +
    `ON CONFLICT (slug) DO UPDATE SET state = EXCLUDED.state, cause = EXCLUDED.cause, detail = EXCLUDED.detail, ` +
    `shaders = EXCLUDED.shaders, run_id = EXCLUDED.run_id, rendered_at = EXCLUDED.rendered_at ` +
    `WHERE (EXCLUDED.rendered_at, EXCLUDED.run_id) >= (preview_render.rendered_at, preview_render.run_id) RETURNING slug`;
  return { sql, params };
}

export function summarize(file: RenderFailureFile, written = 0): FailureSummary {
  const items = Object.values(file.items);
  const count = (s: string): number => items.filter((i) => i.state === s).length;
  return { runId: file.runId, total: items.length, ok: count('ok'), failed: count('failed'), skipped: count('skipped'), written, stale: items.length - written };
}

/** Migration 010 owns the table; this never creates it. */
export async function tableExists(db: Queryable): Promise<boolean> {
  const r = await db.query(`SELECT to_regclass('preview_render') AS t`);
  return r.rows[0]?.t != null;
}

export async function ingestFailures(db: Queryable, file: RenderFailureFile): Promise<FailureSummary> {
  if (!(await tableExists(db))) {
    throw new Error('table preview_render does not exist: apply migration 010_asset_blobs.sql (server start or `npm run migrate`) first; this script never migrates');
  }
  if (Object.keys(file.items).length === 0) return summarize(file, 0);
  const { sql, params } = buildUpsert(file);
  const r = await db.query(sql, params);
  return summarize(file, r.rowCount ?? 0);
}
