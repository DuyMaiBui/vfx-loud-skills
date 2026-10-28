/**
 * Closure verifier core (plan.md phase 3 step 5): for each recipe fetch its bundle, download every blob,
 * check sha256, re-scan the refs of every file and assert each one is in `files`, `requires` or builtin.
 * Incompleteness is a finding; only a sha256 mismatch (or an unreadable bundle) fails the run.
 */
import { BundleSchema, type Bundle } from '../../server/src/bundle-contract.ts';
import { isBuiltinGuid, scanRefs } from '../../server/src/unity-refs.ts';
import { HttpError, type VfxClient } from './client.ts';
import { isRefScanned, sha256 } from './collect.ts';

export interface RecipeRef {
  slug: string;
  version: number;
}

export interface Incomplete {
  slug: string;
  reason: string;
  unresolved: string[];
  /** True when the bundle names a root prefab (so a render failure can be recorded for it). */
  has_prefab: boolean;
}

export interface ShaMismatch {
  slug: string;
  guid: string | null;
  which: 'asset' | 'meta';
  expected: string;
  actual: string;
}

export interface VerifyReport {
  variant: 'urp' | 'original';
  checked: number;
  complete: number;
  incomplete: Incomplete[];
  sha_mismatch: ShaMismatch[];
  /** Bundles that could not be fetched or did not match the contract (not in the C-spec shape: extra key). */
  errors: Array<{ slug: string; error: string }>;
}

interface Downloaded {
  actual: string;
  /** Refs of the blob without own-guid exclusion (the own guid is dropped per file); [] when not scanned. */
  refs: string[];
}

export async function verifyClosures(
  client: VfxClient,
  recipes: RecipeRef[],
  variant: 'urp' | 'original',
  log: (l: string) => void = () => undefined,
): Promise<VerifyReport> {
  const report: VerifyReport = { variant, checked: 0, complete: 0, incomplete: [], sha_mismatch: [], errors: [] };
  // url -> hash + refs: every blob is downloaded and scanned once per run.
  const cache = new Map<string, Downloaded>();
  const fetchBlob = async (url: string, scan: boolean): Promise<Downloaded> => {
    const hit = cache.get(url);
    if (hit) return hit;
    const data = await client.download(url);
    const d: Downloaded = { actual: sha256(data), refs: scan ? scanRefs(data) : [] };
    cache.set(url, d);
    return d;
  };

  for (const { slug, version } of recipes) {
    report.checked += 1;
    let bundle: Bundle;
    try {
      const raw = await client.closure(slug, version, variant);
      const parsed = BundleSchema.safeParse(raw);
      if (!parsed.success) {
        report.errors.push({ slug, error: `bundle does not match vfx-bundle/1: ${parsed.error.issues[0]?.message ?? 'invalid'}` });
        continue;
      }
      bundle = parsed.data;
    } catch (err) {
      if (err instanceof HttpError) {
        report.errors.push({ slug, error: err.message });
        continue;
      }
      throw err; // a dead server is the caller's exit 75
    }

    const known = new Set<string>([...bundle.files.flatMap((f) => (f.guid ? [f.guid] : [])), ...bundle.requires.map((r) => r.guid)]);
    const missing = new Set<string>(bundle.unresolved.map((u) => u.guid));
    let mismatched = false;
    let blobError: string | null = null;
    try {
    for (const f of bundle.files) {
      for (const which of ['asset', 'meta'] as const) {
        const url = which === 'asset' ? f.download_url : f.meta_download_url;
        const expected = which === 'asset' ? f.sha256 : f.meta_sha256;
        if (!url || !expected) continue;
        const d = await fetchBlob(url, which === 'asset' && isRefScanned(f.path));
        if (d.actual !== expected) {
          mismatched = true;
          report.sha_mismatch.push({ slug, guid: f.guid, which, expected, actual: d.actual });
          continue;
        }
        for (const ref of d.refs) {
          if (ref !== f.guid && !known.has(ref) && !isBuiltinGuid(ref)) missing.add(ref);
        }
      }
    }
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      blobError = err.message;
    }
    if (blobError) {
      report.errors.push({ slug, error: blobError });
      continue;
    }
    const hasPrefab = bundle.root_guid !== null;
    if (bundle.reason) {
      report.incomplete.push({ slug, reason: bundle.reason, unresolved: [], has_prefab: bundle.reason !== 'no_prefab' });
    } else if (missing.size) {
      report.incomplete.push({
        slug,
        reason: bundle.unresolved.length && !bundle.complete ? 'unresolved' : 'ref-missing-from-bundle',
        unresolved: [...missing].sort(),
        has_prefab: hasPrefab,
      });
    } else if (!bundle.complete) {
      report.incomplete.push({ slug, reason: 'bundle-incomplete', unresolved: [], has_prefab: hasPrefab });
    } else if (!mismatched) {
      report.complete += 1;
    }
    log(`verify ${slug}: ${bundle.file_count} files`);
  }
  return report;
}
