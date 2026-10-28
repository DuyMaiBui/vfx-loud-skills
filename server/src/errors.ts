/**
 * Error codes the HTTP layer maps to statuses (plan.md C5). `too_large` and `forbidden` were added by
 * the self-contained fetch (vfx-bytes/1); the HTTP mapping of them lives in http.ts (lane S).
 */
export const VFX_ERROR_CODES = ['not_found', 'invalid', 'conflict', 'too_large', 'forbidden'] as const;
export type VfxErrorCode = (typeof VFX_ERROR_CODES)[number];

export class VfxError extends Error {
  readonly code: VfxErrorCode;
  /** Optional structured detail, e.g. `{ actual }` for a hash mismatch or `{ missing }` for a conflict. */
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: VfxErrorCode = 'invalid', details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
