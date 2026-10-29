#!/usr/bin/env node
// Undo the in-place URP conversion of the preview project (plan.md C8/D4): MaterialConverter.ConvertAll rewrites every
// `.mat` under Assets/ImportedPacks, so before a URP export the originals are put back from the cloud's vendor bytes.
// For each .mat GUID: GET /v1/asset-file/<guid>?variant=original, download the blob, verify sha256, rewrite the file
// in place (the .meta is kept). Reads the cloud, rewrites only gitignored ImportedPacks files.
//
//   node scripts/preview-restore-originals.ts [--dry-run] [--pack <folder>] [--root <unity project>] [--server <url>]
//
// stdout last line: one JSON summary {"checked","changed","unchanged","missing","failed","dryRun"}.
// Exit 0 ok, 1 one or more files failed (network, sha256 mismatch), 2 usage or no credentials.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `usage: node scripts/preview-restore-originals.ts [--dry-run] [--pack <folder>] [--root <dir>] [--server <url>]
  --dry-run  list what would change, write nothing
  --pack     only Assets/ImportedPacks/<folder>
  --root     Unity project (default unity/VFXPreview)
  --server   default $VFX_SERVER or http://127.0.0.1:8787
env: VFX_API_KEY is sent as x-vfx-key and is required unless VFX_BLOB_ALLOW_ANON=1
exit: 0 ok, 1 failures, 2 usage or no credentials`;

export interface Summary { checked: number; changed: number; unchanged: number; missing: number; failed: number; dryRun: boolean }
export interface Options { root: string; server: string; key: string; pack?: string; dryRun: boolean; log?: (line: string) => void }

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

function* walkMats(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkMats(p);
    else if (e.name.endsWith('.mat')) yield p;
  }
}

function guidOf(matPath: string): string | null {
  const meta = `${matPath}.meta`;
  if (!fs.existsSync(meta)) return null;
  return /^guid:\s*([0-9a-f]{32})\s*$/m.exec(fs.readFileSync(meta, 'utf8'))?.[1] ?? null;
}

export async function restore(o: Options): Promise<Summary> {
  const log = o.log ?? ((l: string) => console.error(l));
  const base = path.join(o.root, 'Assets', 'ImportedPacks', ...(o.pack ? [o.pack] : []));
  const s: Summary = { checked: 0, changed: 0, unchanged: 0, missing: 0, failed: 0, dryRun: o.dryRun };
  if (!fs.existsSync(base)) throw new Error(`no such directory: ${base}`);
  const headers: Record<string, string> = o.key ? { 'x-vfx-key': o.key } : {};
  for (const mat of walkMats(base)) {
    const guid = guidOf(mat);
    if (!guid) { s.missing++; log(`  no-meta   ${mat}`); continue; }
    s.checked++;
    try {
      const res = await fetch(`${o.server}/v1/asset-file/${guid}?variant=original`, { headers });
      if (res.status === 404) { s.missing++; log(`  missing   ${guid} ${mat}`); continue; }
      if (!res.ok) throw new Error(`asset-file ${res.status}`);
      const file = (await res.json()) as { sha256: string; download_url: string };
      const current = sha256(fs.readFileSync(mat));
      if (current === file.sha256) { s.unchanged++; continue; }
      if (o.dryRun) { s.changed++; log(`  would-restore ${guid} ${mat}`); continue; }
      const blob = await fetch(file.download_url, { headers });
      if (!blob.ok) throw new Error(`blob ${blob.status}`);
      const bytes = Buffer.from(await blob.arrayBuffer());
      const got = sha256(bytes);
      if (got !== file.sha256) throw new Error(`sha256 mismatch: expected ${file.sha256}, got ${got}`);
      fs.writeFileSync(mat, bytes); // the .meta stays: it carries the GUID
      s.changed++;
      log(`  restored  ${guid} ${mat}`);
    } catch (e) {
      s.failed++;
      log(`  FAILED    ${guid} ${mat}: ${(e as Error).message}`);
    }
  }
  return s;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return; }
  const flag = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const known = new Set(['--dry-run', '--pack', '--root', '--server']);
  const valued = ['pack', 'root', 'server'].filter((n) => argv.includes(`--${n}`) && !flag(n));
  if (argv.some((a) => a.startsWith('--') && !known.has(a)) || valued.length > 0) { console.error(HELP); process.exitCode = 2; return; }
  const key = process.env.VFX_API_KEY ?? '';
  if (!key && process.env.VFX_BLOB_ALLOW_ANON !== '1') {
    console.error('VFX_API_KEY is unset: blob and asset-file routes require the key (or VFX_BLOB_ALLOW_ANON=1 on the server)');
    process.exitCode = 2;
    return;
  }
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const summary = await restore({
    root: path.resolve(flag('root') ?? path.join(repo, 'unity', 'VFXPreview')),
    server: (flag('server') ?? process.env.VFX_SERVER ?? 'http://127.0.0.1:8787').replace(/\/$/, ''),
    key, pack: flag('pack'), dryRun: argv.includes('--dry-run'),
  });
  console.log(JSON.stringify(summary));
  if (summary.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`preview-restore-originals: ${(e as Error).message}`); process.exitCode = 1; });
}
