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
  if (l === 'restricted') return 'restricted';
  return 'unknown';
}

/** Trục độc lập: dữ liệu này có dùng huấn luyện model được không. Thiếu bằng chứng → false. */
export function aiTrainingAllowed(license: string): boolean {
  const l = license.toLowerCase();
  return l === 'cc0' || l.startsWith('cc-by') || l === 'ai-training-allowed';
}

/** Store-EULA licenses: the only ones an extracted (derived-from-purchased-asset) record may carry. */
export const EXTRACTED_LICENSES = ['synty-store-eula', 'asset-store-eula'] as const;

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
  if (licenseClassOf(l) !== 'proprietary-commercial') return `license "${l}" is not proprietary-commercial`;
  if (aiTrainingAllowed(l)) return `license "${l}" would allow ai_training`;
  return null;
}
