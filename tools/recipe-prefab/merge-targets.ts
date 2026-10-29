// Merges the recipe-prefab builder's result (data/previews/_recipe-prefabs.json) into tools/preview/targets.json (gitignored, written by
// tools/preview/targets.ts, which lists the hand-written recipes as {slug, prefabGuid:null}).
// A `built` slug fills prefabPath/prefabGuid ONLY on a row whose prefabGuid is null/empty; every other row is untouched (a non-null row is never changed).
// A `skipped` slug keeps prefabGuid:null and gains builderReason (reported as skipped:no-prefab by the runner). Idempotent.
// usage: node tools/recipe-prefab/merge-targets.ts [--targets tools/preview/targets.json] [--prefabs data/previews/_recipe-prefabs.json] [--out <file=--targets, in place>]
import { readFileSync, writeFileSync } from 'node:fs';

export interface Row { slug: string; prefabGuid?: string | null; prefabPath?: string | null; builderReason?: string; [k: string]: unknown }
export interface Item { prefabPath?: string; prefabGuid?: string; layersInRecipe?: number; systemsBuilt?: number; status: 'built' | 'skipped'; reason?: string }

export function merge(rows: Row[], items: Record<string, Item>): { rows: Row[]; merged: string[]; skipped: string[]; problems: string[] } {
  const merged: string[] = [], skipped: string[] = [], problems: string[] = [];
  const out = rows.map((r) => {
    const it = items[r.slug];
    if (!it || (r.prefabGuid ?? '') !== '') return r;
    if (it.status === 'built') {
      if (!it.prefabPath || !it.prefabGuid) { problems.push(`${r.slug}: built without prefabPath/prefabGuid`); return r; }
      if (it.layersInRecipe !== it.systemsBuilt) { problems.push(`${r.slug}: systemsBuilt ${it.systemsBuilt} != layersInRecipe ${it.layersInRecipe}`); return r; }
      merged.push(r.slug);
      return { ...r, prefabPath: it.prefabPath, prefabGuid: it.prefabGuid };
    }
    if (it.status === 'skipped') { skipped.push(r.slug); return { ...r, builderReason: it.reason ?? 'unknown' }; }
    problems.push(`${r.slug}: unknown status ${String((it as { status: unknown }).status)}`);
    return r;
  });
  return { rows: out, merged, skipped, problems };
}

export function main(argv: string[]): number {
  const arg = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node tools/recipe-prefab/merge-targets.ts [--targets <file=tools/preview/targets.json>] [--prefabs <file=data/previews/_recipe-prefabs.json>] [--out <file=--targets>]\nexit 1 on a malformed input or any built slug that fails its checks');
    return 0;
  }
  const targets = arg('--targets', 'tools/preview/targets.json');
  const out = arg('--out', targets);
  let r;
  try {
    const rows = JSON.parse(readFileSync(targets, 'utf8')) as Row[];
    const doc = JSON.parse(readFileSync(arg('--prefabs', 'data/previews/_recipe-prefabs.json'), 'utf8')) as { version: number; items: Record<string, Item> };
    if (doc.version !== 1 || typeof doc.items !== 'object') throw new Error('_recipe-prefabs.json: expected {version:1, items:{...}}');
    if (!Array.isArray(rows)) throw new Error('targets.json: expected an array');
    r = merge(rows, doc.items);
  } catch (e) { console.log(JSON.stringify({ tool: 'merge-targets', error: (e as Error).message })); return 1; }
  writeFileSync(out, JSON.stringify(r.rows, null, 1));
  console.log(JSON.stringify({ tool: 'merge-targets', out, merged: r.merged.length, skipped: r.skipped.length, problems: r.problems }));
  return r.problems.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
