/**
 * `asset_file` registration (vfx-bytes/1, C3 POST /v1/asset-file/batch). One row per (guid, variant);
 * `refs` is computed HERE from the stored bytes with the shared scanner (D6), never taken from the client.
 * Each item has its own outcome: the batch is not atomic.
 */
import { AssetFileInputSchema, type AssetFileInput, type Kind } from './bundle-contract.ts';
import { blobRow, readBlob } from './blob-store.ts';
import { pool } from './db.ts';
import type { VfxErrorCode } from './errors.ts';
import { blobLicenseProblem } from './license.ts';
import { scanRefs } from './unity-refs.ts';

export type RegisterStatus = 'created' | 'unchanged' | 'replaced' | 'rejected';

export interface RegisterResult {
  guid: string;
  variant: string;
  status: RegisterStatus;
  code?: VfxErrorCode;
  error?: string;
  details?: Record<string, unknown>;
}

export interface RegisterCounts {
  created: number;
  unchanged: number;
  replaced: number;
  rejected: number;
}

/** Binary kinds never carry GUID references (C2): skip reading them. */
const BINARY_KINDS: readonly Kind[] = ['texture', 'mesh', 'audio'];

const SAFE_PACK = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

/** Path problems that would let a client write outside `Assets/VFXCloud/<pack>` (target_path is built from these). */
function pathProblem(f: AssetFileInput): string | null {
  if (!SAFE_PACK.test(f.pack) || f.pack.endsWith('.')) return `pack "${f.pack}" is not a safe folder name`;
  const p = f.path;
  if (!p.startsWith('Assets/') || p.includes('\\') || p.includes('\0')) return 'path must be a forward-slash path under Assets/';
  if (p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return 'path has an empty, "." or ".." segment';
  return null;
}

function reject(guid: string, variant: string, code: VfxErrorCode, error: string, details?: Record<string, unknown>): RegisterResult {
  return { guid, variant, status: 'rejected', code, error, ...(details ? { details } : {}) };
}

interface ExistingRow {
  asset_sha256: string;
  meta_sha256: string | null;
}

async function registerOne(raw: unknown): Promise<RegisterResult> {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const guid0 = typeof rec.guid === 'string' ? rec.guid : '';
  const variant0 = typeof rec.variant === 'string' ? rec.variant : '';

  // C1 first: a global/unlicensed item is `forbidden` (not a schema `invalid`) whenever both fields are present.
  if (typeof rec.license === 'string' && typeof rec.visibility === 'string') {
    const early = blobLicenseProblem(rec.license, rec.visibility);
    if (early) return reject(guid0, variant0, 'forbidden', early);
  }
  const parsed = AssetFileInputSchema.safeParse(raw);
  if (!parsed.success) {
    return reject(guid0, variant0, 'invalid', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const f = parsed.data;
  const problem = blobLicenseProblem(f.license, f.visibility);
  if (problem) return reject(f.guid, f.variant, 'forbidden', problem);
  const pathIssue = pathProblem(f);
  if (pathIssue) return reject(f.guid, f.variant, 'invalid', pathIssue);

  const need = [f.asset_sha256, ...(f.meta_sha256 ? [f.meta_sha256] : [])];
  const absent: string[] = [];
  for (const sha of need) if (!(await blobRow(sha))) absent.push(sha);
  if (absent.length) return reject(f.guid, f.variant, 'conflict', 'blob not stored: PUT it first', { missing: absent });

  let refs: string[] = [];
  if (!BINARY_KINDS.includes(f.kind)) refs = scanRefs(await readBlob(f.asset_sha256), f.guid);

  const insert = async (): Promise<boolean> => {
    const r = await pool.query(
      `INSERT INTO asset_file (guid, variant, kind, path, asset_sha256, meta_sha256, refs, pack, license, visibility, ai_training, source, urp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11::jsonb,$12::jsonb)
       ON CONFLICT (guid, variant) DO NOTHING`,
      [f.guid, f.variant, f.kind, f.path, f.asset_sha256, f.meta_sha256, refs, f.pack, f.license, f.visibility, JSON.stringify(f.source), f.urp ? JSON.stringify(f.urp) : null],
    );
    return (r.rowCount ?? 0) > 0;
  };
  if (await insert()) return { guid: f.guid, variant: f.variant, status: 'created' };

  const cur = await pool.query<ExistingRow>('SELECT asset_sha256, meta_sha256 FROM asset_file WHERE guid = $1 AND variant = $2', [f.guid, f.variant]);
  const existing = cur.rows[0];
  if (existing && existing.asset_sha256 === f.asset_sha256 && existing.meta_sha256 === f.meta_sha256) {
    return { guid: f.guid, variant: f.variant, status: 'unchanged' };
  }
  if (!f.replace) {
    return reject(f.guid, f.variant, 'conflict', 'guid+variant already registered with different bytes (set replace:true to overwrite)', {
      existing: { asset_sha256: existing?.asset_sha256 ?? null, meta_sha256: existing?.meta_sha256 ?? null },
    });
  }
  await pool.query(
    `UPDATE asset_file SET kind=$3, path=$4, asset_sha256=$5, meta_sha256=$6, refs=$7, pack=$8, license=$9, visibility=$10,
       source=$11::jsonb, urp=$12::jsonb, updated_at=now() WHERE guid=$1 AND variant=$2`,
    [f.guid, f.variant, f.kind, f.path, f.asset_sha256, f.meta_sha256, refs, f.pack, f.license, f.visibility, JSON.stringify(f.source), f.urp ? JSON.stringify(f.urp) : null],
  );
  return { guid: f.guid, variant: f.variant, status: 'replaced' };
}

/** Register every input, in order; a failing item is `rejected` with a stable `code`, the rest still run. */
export async function registerFiles(inputs: unknown[]): Promise<{ results: RegisterResult[]; counts: RegisterCounts }> {
  const results: RegisterResult[] = [];
  const counts: RegisterCounts = { created: 0, unchanged: 0, replaced: 0, rejected: 0 };
  for (const item of inputs) {
    const r = await registerOne(item);
    results.push(r);
    counts[r.status] += 1;
  }
  return { results, counts };
}
