/**
 * Closure verifier: for each recipe download its bundle, check every sha256, re-scan every file's GUID refs
 * and assert each is shipped, required or builtin. Writes data/reports/closure-verify.json.
 *
 *   node seed/verify-closure.ts --slugs a,b@2 | --sample N | --all [--variant urp|original] [--record]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient, ServerUnavailableError } from './upload/client.ts';
import { verifyClosures, type RecipeRef, type VerifyReport } from './upload/verify.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

export const HELP = `usage: verify-closure.ts (--slugs a,b@2 | --sample N | --all) [options]

  --slugs a,b@2     recipes to check; "@N" pins the version, otherwise the latest version (database)
  --sample N        N recipes (evenly spread over the extracted recipes)
  --all             every extracted recipe with a prefab
  --variant urp|original   (default urp)
  --record          upsert preview_render(state='failed', cause='closure-unresolved') for incomplete slugs with a prefab
  --out <file>      report path (default data/reports/closure-verify.json)
  --json            one-line JSON summary on stdout
  --help

env: VFX_SERVER (default http://127.0.0.1:8787)  VFX_API_KEY  DATABASE_URL (slug lookup, --record)
exit codes: 0 ok (incompleteness is a finding) | 1 sha256 mismatch or unreadable bundle | 2 usage | 75 server unavailable after retries`;

class UsageError extends Error {}

async function withDb<T>(readOnly: boolean, fn: (q: (sql: string, p?: unknown[]) => Promise<Array<Record<string, unknown>>>) => Promise<T>): Promise<T> {
  const { config } = await import('../server/src/config.ts');
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: config.databaseUrl });
  await c.connect();
  try {
    if (readOnly) await c.query('SET default_transaction_read_only = on');
    return await fn(async (sql, p) => (await c.query(sql, p)).rows);
  } finally {
    await c.end();
  }
}

const LATEST = `SELECT slug, max(version)::int AS version FROM resource
  WHERE type = 'recipe' AND meta->'source'->>'prefabGuid' IS NOT NULL GROUP BY slug ORDER BY slug`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        slugs: { type: 'string' }, sample: { type: 'string' }, all: { type: 'boolean' }, variant: { type: 'string' },
        record: { type: 'boolean' }, out: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(`error: ${(err as Error).message}\n${HELP}`);
    return 2;
  }
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  try {
    const variant = values.variant ?? 'urp';
    if (variant !== 'urp' && variant !== 'original') throw new UsageError(`--variant must be urp or original, got "${variant}"`);
    if ([values.slugs, values.sample, values.all].filter((v) => v !== undefined).length !== 1) throw new UsageError('give exactly one of --slugs, --sample, --all');
    let recipes: RecipeRef[];
    if (values.slugs) {
      const pinned = values.slugs.split(',').map((s) => s.trim()).filter(Boolean);
      if (!pinned.length) throw new UsageError('--slugs is empty');
      const latest = pinned.some((s) => !s.includes('@'))
        ? await withDb(true, async (q) => new Map((await q(LATEST)).map((r) => [r.slug as string, r.version as number])))
        : new Map<string, number>();
      recipes = pinned.map((s) => {
        const [slug, v] = s.split('@');
        const version = v !== undefined ? Number(v) : latest.get(slug);
        if (!Number.isInteger(version)) throw new UsageError(`cannot resolve a version for "${slug}"`);
        return { slug, version: version as number };
      });
    } else {
      const all = (await withDb(true, (q) => q(LATEST))).map((r) => ({ slug: r.slug as string, version: r.version as number }));
      if (values.all) recipes = all;
      else {
        const n = Number(values.sample);
        if (!Number.isInteger(n) || n < 1) throw new UsageError(`--sample must be a positive integer, got "${values.sample}"`);
        const step = Math.max(1, Math.floor(all.length / n));
        recipes = all.filter((_, i) => i % step === 0).slice(0, n);
      }
    }
    const client = createClient({ server: env.VFX_SERVER ?? 'http://127.0.0.1:8787', apiKey: env.VFX_API_KEY });
    let report: VerifyReport;
    try {
      report = await verifyClosures(client, recipes, variant);
    } catch (err) {
      if (err instanceof ServerUnavailableError) {
        console.error(`error: ${err.message}`);
        return 75;
      }
      throw err;
    }
    const out = path.resolve(values.out ?? path.join(repoRoot, 'data', 'reports', 'closure-verify.json'));
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(report, null, 2));
    if (values.record) {
      const rows = report.incomplete.filter((i) => i.has_prefab);
      const runId = `verify-${new Date().toISOString()}`;
      await withDb(false, async (q) => {
        for (const r of rows) {
          await q(
            `INSERT INTO preview_render (slug, state, cause, detail, shaders, run_id, rendered_at)
             VALUES ($1, 'failed', 'closure-unresolved', $2, '{}', $3, now())
             ON CONFLICT (slug) DO UPDATE SET state = 'failed', cause = 'closure-unresolved', detail = EXCLUDED.detail,
               shaders = '{}', run_id = EXCLUDED.run_id, rendered_at = EXCLUDED.rendered_at`,
            [r.slug, `${r.reason}: ${r.unresolved.slice(0, 8).join(',')}`, runId],
          );
        }
      });
    }
    const line = { checked: report.checked, complete: report.complete, incomplete: report.incomplete.length, sha_mismatch: report.sha_mismatch.length, errors: report.errors.length, report: out };
    console.log(values.json ? JSON.stringify(line) : `checked ${line.checked}, complete ${line.complete}, incomplete ${line.incomplete}, sha mismatch ${line.sha_mismatch}, errors ${line.errors} -> ${out}`);
    return report.sha_mismatch.length || report.errors.length ? 1 : 0;
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return err instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
