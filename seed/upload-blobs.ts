/**
 * Bulk uploader: collect the closure of every recipe prefab and asset from the vendor sources, upload the
 * blobs the server lacks and register them (vfx-bytes/1). Default is a dry run; `--yes` uploads.
 *
 *   node seed/upload-blobs.ts                       # dry run: data/upload/plan.json + table
 *   node seed/upload-blobs.ts --yes --limit 5       # smoke
 *   node seed/upload-blobs.ts --yes                 # full, idempotent, re-runnable (--resume)
 *   node seed/upload-blobs.ts --yes --variant urp --urp-dir data/export/urp
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPackageGuids } from '../server/src/unity-refs.ts';
import { buildSources, parseSkipKinds, type Root, type UploadPack } from './upload/collect.ts';
import { formatPlan, runUpload } from './upload/run.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

export const HELP = `usage: upload-blobs.ts [--yes | --dry-run] [options]

  --yes                 upload and register (default without it: dry run, nothing is sent)
  --dry-run             explicit dry run (conflicts with --yes)
  --limit N             only the first N files of the closure, in closure order (smoke)
  --pack <slug>         only roots whose winning source is this pack
  --skip-kinds a,b      kinds to leave out, e.g. audio,script
  --resume              skip files already registered by an earlier run (data/upload/state.json)
  --variant original|urp  (default original); urp needs --urp-dir (reads index.json, C8)
  --urp-dir <dir>       URP export directory (data/export/urp)
  --out <dir>           plan/state directory (default data/upload)
  --dangling-map <file> write the server map of dangling GUIDs (server/src/dangling-guids.json); a whole run only: no --pack, --limit or --skip-kinds
  --package-dir <dir>   .unitypackage directory (default $VFX_UNITYPACKAGE_DIR or /home/mike/Downloads/UnityPackages)
  --packs-file <file>   packs.json override
  --roots-file <file>   JSON [{"guid","pack"}] instead of reading roots from the database
  --json                one-line JSON summary on stdout (human output goes to stderr)
  --help

env: VFX_SERVER (default http://127.0.0.1:8787)  VFX_API_KEY  VFX_UNITYPACKAGE_DIR  DATABASE_URL (roots, read-only)
exit codes: 0 ok | 1 one or more files failed or were rejected | 2 usage | 75 server unavailable after retries`;

class UsageError extends Error {}

/** Recipe prefab guids and every asset guid, read-only. */
async function rootsFromDb(): Promise<Root[]> {
  const { config } = await import('../server/src/config.ts');
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    const recipes = await client.query<{ guid: string; pack: string | null }>(
      `SELECT meta->'source'->>'prefabGuid' AS guid, meta->>'pack' AS pack FROM resource
       WHERE type = 'recipe' AND meta->'source'->>'prefabGuid' IS NOT NULL ORDER BY id`,
    );
    const assets = await client.query<{ guid: string; pack: string }>('SELECT DISTINCT guid, pack FROM asset WHERE external = false ORDER BY guid');
    const seen = new Set<string>();
    const out: Root[] = [];
    for (const r of [...recipes.rows, ...assets.rows]) {
      if (seen.has(r.guid)) continue;
      seen.add(r.guid);
      out.push({ guid: r.guid, ...(r.pack ? { pack: r.pack } : {}) });
    }
    return out;
  } finally {
    await client.end();
  }
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, limit: { type: 'string' }, pack: { type: 'string' },
        'skip-kinds': { type: 'string' }, resume: { type: 'boolean' }, variant: { type: 'string' }, 'urp-dir': { type: 'string' },
        out: { type: 'string' }, 'dangling-map': { type: 'string' }, 'package-dir': { type: 'string' }, 'packs-file': { type: 'string' }, 'roots-file': { type: 'string' },
        json: { type: 'boolean' }, help: { type: 'boolean' },
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
  const human = (l: string): void => (values.json ? console.error(l) : console.log(l));
  try {
    if (values.yes && values['dry-run']) throw new UsageError('--yes and --dry-run conflict');
    const variant = values.variant ?? 'original';
    if (variant !== 'original' && variant !== 'urp') throw new UsageError(`--variant must be original or urp, got "${variant}"`);
    if (variant === 'urp' && !values['urp-dir']) throw new UsageError('--variant urp needs --urp-dir');
    let limit: number | undefined;
    if (values.limit !== undefined) {
      limit = Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`--limit must be a positive integer, got "${values.limit}"`);
    }
    if (values['dangling-map'] && (values.pack || values.limit !== undefined || values['skip-kinds'] || variant !== 'original')) {
      throw new UsageError('--dangling-map needs a whole original-variant run: no --pack, --limit, --skip-kinds, --variant urp');
    }
    let skipKinds;
    try {
      skipKinds = parseSkipKinds(values['skip-kinds']);
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
    const packs = (JSON.parse(await fs.readFile(values['packs-file'] ?? path.join(here, 'extract', 'packs.json'), 'utf8')) as { packs: UploadPack[] }).packs;
    if (values.pack && !packs.some((p) => p.slug === values.pack)) throw new UsageError(`unknown pack "${values.pack}"`);
    const sources = await buildSources(packs, values['package-dir'] ?? env.VFX_UNITYPACKAGE_DIR ?? '/home/mike/Downloads/UnityPackages');
    const roots = variant === 'urp' ? [] : values['roots-file'] ? (JSON.parse(await fs.readFile(values['roots-file'], 'utf8')) as Root[]) : await rootsFromDb();
    const { exitCode, summary } = await runUpload({
      sources,
      roots,
      packageGuids: loadPackageGuids(),
      server: env.VFX_SERVER ?? 'http://127.0.0.1:8787',
      apiKey: env.VFX_API_KEY,
      outDir: path.resolve(values.out ?? path.join(repoRoot, 'data', 'upload')),
      yes: values.yes === true,
      limit,
      skipKinds,
      pack: values.pack,
      resume: values.resume,
      variant,
      danglingMapOut: values['dangling-map'] ? path.resolve(values['dangling-map']) : undefined,
      urpDir: values['urp-dir'],
      log: (l) => console.error(l),
    });
    human(formatPlan(summary));
    for (const f of summary.failures.slice(0, 20)) console.error(`failure: ${f.stage} ${f.guid ?? f.sha256 ?? ''} ${f.message}`);
    if (values.json) console.log(JSON.stringify({ ...summary, failures: summary.failures.length }));
    else console.log(`${summary.mode}: ${summary.files} files, ${summary.blobs} blobs, ${summary.failed} failed (exit ${exitCode})`);
    return exitCode;
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return err instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
