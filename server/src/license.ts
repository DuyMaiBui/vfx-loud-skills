/**
 * License taxonomy (pure, no I/O) — the SSOT behind LICENSES.md's mapping table. Kept free of
 * db/config imports so seed tooling and tests can use it without loading the server.
 */

/** Xem LICENSES.md — trục "dùng lại được tới đâu". */
export function licenseClassOf(license: string): string {
  const l = license.toLowerCase();
  if (l === 'cc0') return 'cc0';
  if (l.startsWith('cc-by')) return 'cc-attribution';
  if (l === 'synty-store-eula' || l === 'asset-store-eula') return 'proprietary-commercial';
  if (l === 'studio-internal') return 'studio-internal';
  if (l === 'restricted') return 'restricted';
  return 'unknown';
}

/** Trục độc lập: dữ liệu này có dùng huấn luyện model được không. Thiếu bằng chứng → false. */
export function aiTrainingAllowed(license: string): boolean {
  const l = license.toLowerCase();
  return l === 'cc0' || l.startsWith('cc-by') || l === 'ai-training-allowed';
}

/**
 * Store-EULA licenses (purchased packs) and the studio's own in-house game assets. Both are
 * proprietary: no ai_training, never redistributed as files. `studio-internal` = authored by the
 * studio in its own Unity projects, not bought, but still not licensable outside the studio.
 */
export const EXTRACTED_LICENSES = ['synty-store-eula', 'asset-store-eula', 'studio-internal'] as const;

/** license_class values an extracted record may carry (publish() and the extractor both enforce this). */
export const EXTRACTED_LICENSE_CLASSES = ['proprietary-commercial', 'studio-internal'] as const;

/**
 * Visibility of a resource / asset row (C1). Order of restriction: project < team < studio-only < global.
 * `studio-only` = holder of the single server key (D2): a label plus a never-global guarantee, not an ACL.
 */
export const VISIBILITIES = ['project', 'team', 'studio-only', 'global'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** Visibility an `asset_file` row (served bytes) may carry (C1 CHECK). Never `global`. */
export const BYTE_VISIBILITIES = ['project', 'team', 'studio-only'] as const;

/** Licenses that may carry stored bytes (C1). Everything else, including `unknown`, `restricted`, is refused. */
export const BYTE_LICENSES = ['synty-store-eula', 'asset-store-eula', 'studio-internal', 'cc0', 'cc-by', 'cc-by-sa'] as const;

/**
 * Gate for serving or registering stored bytes (`asset_file`, blob routes). Pure: returns why it is
 * refused, or null when acceptable. `aiTraining` is the request's flag (C1): true is always refused.
 * Never defaults a missing value.
 */
export function blobLicenseProblem(
  license: string | undefined | null,
  visibility: string | undefined | null,
  aiTraining = false,
): string | null {
  if (aiTraining) return 'ai_training=true is refused for stored bytes';
  const l = (license ?? '').trim().toLowerCase();
  if (!l) return 'license missing';
  if (!(BYTE_LICENSES as readonly string[]).includes(l)) {
    return `license "${l}" may not carry stored bytes (${BYTE_LICENSES.join(' | ')})`;
  }
  const v = visibility ?? '';
  if (!(BYTE_VISIBILITIES as readonly string[]).includes(v)) {
    return `visibility "${v}" may not carry stored bytes (${BYTE_VISIBILITIES.join(' | ')}; never global)`;
  }
  return null;
}

/**
 * Gate for `meta.extracted = true` records (recipes derived from purchased Unity packages).
 * Returns why the license is refused, or null when acceptable. Never defaults a missing value:
 * no resolvable store-EULA license -> refuse (cc0 / unknown / unrecognised all fail).
 */
export function extractedLicenseProblem(license: string | undefined | null): string | null {
  const l = (license ?? '').trim().toLowerCase();
  if (!l) return 'license missing';
  if (l === 'unknown') return 'license "unknown"';
  if (!(EXTRACTED_LICENSES as readonly string[]).includes(l)) {
    return `license "${l}" is not a store-EULA license (${EXTRACTED_LICENSES.join(' | ')})`;
  }
  if (!(EXTRACTED_LICENSE_CLASSES as readonly string[]).includes(licenseClassOf(l))) {
    return `license "${l}" is not ${EXTRACTED_LICENSE_CLASSES.join(' | ')}`;
  }
  if (aiTrainingAllowed(l)) return `license "${l}" would allow ai_training`;
  return null;
}
