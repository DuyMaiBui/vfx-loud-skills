// `verify-closure --record` persistence, split out so the guard is testable against a scratch DB.
//
// Guard: a closure finding must never replace a deliberate render outcome.
//   - a row whose cause is `unfixable-*` is a documented waiver (tools/preview/waivers.json): never overwritten.
//   - a row whose latest render is `ok` for a recipe of a pack that is incomplete by design stays `ok`; the
//     incompleteness remains visible in the closure-verify report (`complete:false`), only the render row is protected.
// A pack is incomplete by design when `seed/extract/packs.json` does not flag it `completeSource: true` (e.g. the folder
// copy of namufx, parameters only). Recipe slugs are `<pack>-<name>`; the pack is read from the data, never hardcoded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Q = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
export interface ClosureRow { slug: string; reason: string; unresolved: string[] }
export interface Existing { state: string; cause: string | null }

const here = path.dirname(fileURLToPath(import.meta.url));

export function incompleteByDesignPacks(file = path.join(here, 'extract', 'packs.json')): string[] {
  const packs = (JSON.parse(fs.readFileSync(file, 'utf8')) as { packs: Array<{ slug: string; completeSource?: boolean }> }).packs;
  return packs.filter((p) => p.completeSource !== true).map((p) => p.slug);
}

/** Why a closure finding for `slug` must not be written over `existing`, or null when it may be. */
export function protectedReason(slug: string, existing: Existing | undefined, byDesignPacks: string[]): string | null {
  if (!existing) return null;
  if (existing.cause?.startsWith('unfixable-')) return `documented ${existing.cause}`;
  if (existing.state === 'ok' && byDesignPacks.some((p) => slug.startsWith(`${p}-`))) return 'ok render of an incomplete-by-design pack';
  return null;
}

export interface RecordResult { written: string[]; protectedSlugs: Array<{ slug: string; why: string }>; cleared: number }

export async function recordClosure(q: Q, rows: ClosureRow[], cleared: string[], runId: string, byDesignPacks: string[]): Promise<RecordResult> {
  const found = await q('SELECT slug, state, cause FROM preview_render WHERE slug = ANY($1)', [rows.map((r) => r.slug)]);
  const existing = new Map(found.map((r) => [r.slug as string, { state: r.state as string, cause: (r.cause as string | null) ?? null }]));
  const res: RecordResult = { written: [], protectedSlugs: [], cleared: 0 };
  for (const r of rows) {
    const why = protectedReason(r.slug, existing.get(r.slug), byDesignPacks);
    if (why) { res.protectedSlugs.push({ slug: r.slug, why }); continue; }
    await q(
      `INSERT INTO preview_render (slug, state, cause, detail, shaders, run_id, rendered_at)
       VALUES ($1, 'failed', 'closure-unresolved', $2, '{}', $3, now())
       ON CONFLICT (slug) DO UPDATE SET state = 'failed', cause = 'closure-unresolved', detail = EXCLUDED.detail,
         shaders = '{}', run_id = EXCLUDED.run_id, rendered_at = EXCLUDED.rendered_at`,
      [r.slug, `${r.reason}: ${r.unresolved.slice(0, 8).join(',')}`, runId],
    );
    res.written.push(r.slug);
  }
  res.cleared = (await q(`DELETE FROM preview_render WHERE state = 'failed' AND cause = 'closure-unresolved' AND slug = ANY($1) RETURNING slug`, [cleared])).length;
  return res;
}
