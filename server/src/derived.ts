import { licenseClassOf } from './license.ts';
import { VfxError } from './errors.ts';

/**
 * Publish-back of a CUSTOMISED effect: a record derived from one or more cloud records (layers removed, rescaled,
 * retimed, recoloured, or several effects composed). Pure checks only (no I/O), so store.publish and the tests
 * share one definition. The skill side of the contract is `skills/vfx-authoring` § "Publish-back on accept".
 */

/** What was done to the source(s). `other` needs a `note`; the rest name a `target` (layer / property / material). */
export const MODIFICATION_OPS = [
  'remove-layer',
  'add-layer',
  'rescale',
  'retime',
  'recolor',
  'retarget-material',
  'retarget-texture',
  'compose',
  'other',
] as const;
export type ModificationOp = (typeof MODIFICATION_OPS)[number];

export interface Modification {
  op: ModificationOp;
  /** The layer / node / material / property touched, in the source's own naming (e.g. `FX_LevelUp_Swirl_01`). */
  target: string;
  from?: string | number;
  to?: string | number;
  note?: string;
}

const SCALAR = (v: unknown): v is string | number => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

/** Validate the list; throws VfxError('invalid') naming the first bad item. An empty list is refused. */
export function parseModifications(raw: unknown): Modification[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new VfxError('modifications must be a non-empty list: what was changed relative to derived_from', 'invalid');
  }
  return raw.map((m, i) => {
    const o = (m ?? {}) as Record<string, unknown>;
    const at = `modifications[${i}]`;
    if (!MODIFICATION_OPS.includes(o.op as ModificationOp)) {
      throw new VfxError(`${at}.op "${String(o.op)}" is not one of ${MODIFICATION_OPS.join(' | ')}`, 'invalid');
    }
    if (typeof o.target !== 'string' || !o.target.trim()) throw new VfxError(`${at}.target is required (the layer / material / property changed)`, 'invalid');
    for (const k of ['from', 'to'] as const) if (o[k] !== undefined && !SCALAR(o[k])) throw new VfxError(`${at}.${k} must be a string or a number`, 'invalid');
    if (o.note !== undefined && typeof o.note !== 'string') throw new VfxError(`${at}.note must be a string`, 'invalid');
    if (o.op === 'other' && !(typeof o.note === 'string' && o.note.trim())) throw new VfxError(`${at}: op "other" needs a note`, 'invalid');
    return {
      op: o.op as ModificationOp,
      target: o.target.trim(),
      ...(o.from !== undefined ? { from: o.from as string | number } : {}),
      ...(o.to !== undefined ? { to: o.to as string | number } : {}),
      ...(o.note !== undefined ? { note: o.note } : {}),
    };
  });
}

export interface UnityRef {
  /** Project path of the file, e.g. `Assets/VFXCloud/vfx/foo/Foo.prefab`. */
  path: string;
  /** The `.meta` guid the file carries, 32 lowercase hex: what other files' references point at. */
  guid: string;
}

export function parseUnityRef(raw: unknown): UnityRef {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o.path !== 'string' || !/^Assets\/[^\0]+$/.test(o.path) || o.path.includes('..')) {
    throw new VfxError('unity.path must be a project path under Assets/ (no "..")', 'invalid');
  }
  if (typeof o.guid !== 'string' || !/^[0-9a-f]{32}$/.test(o.guid)) {
    throw new VfxError('unity.guid must be 32 lowercase hex characters (the .meta guid)', 'invalid');
  }
  return { path: o.path, guid: o.guid };
}

/** Higher = more restrictive. Unknown classes rank highest: an unclassifiable source can never be relaxed. */
const RANK: Record<string, number> = {
  cc0: 0,
  'cc-attribution': 1,
  'proprietary-commercial': 2,
  'studio-internal': 3,
  restricted: 4,
  unknown: 5,
};
const rank = (license: string): number => RANK[licenseClassOf(license)] ?? RANK.unknown;

/**
 * A derived record inherits the licence of its sources. Returns why `license` is refused, or null.
 * The declared licence must be at least as restrictive as the most restrictive source and, when it ties with it,
 * must be one of the sources' own licences (so a Synty-derived record cannot be relabelled `asset-store-eula`).
 */
export function derivedLicenseProblem(license: string, sources: Array<{ uri: string; license: string }>): string | null {
  if (!sources.length) return null;
  const top = Math.max(...sources.map((s) => rank(s.license)));
  const topSources = sources.filter((s) => rank(s.license) === top);
  if (rank(license) < top) {
    return `license "${license}" is weaker than the source licence ${[...new Set(topSources.map((s) => `"${s.license}" (${s.uri})`))].join(', ')}: a derived record inherits it`;
  }
  if (rank(license) === top && !topSources.some((s) => s.license === license)) {
    return `license "${license}" is not the source licence (${[...new Set(topSources.map((s) => `"${s.license}"`))].join(' | ')}): a derived record inherits it, it does not re-label it`;
  }
  return null;
}

/** The public-interface checks for a derived publish (MCP + POST /v1/publish): the fields search and import need. */
export function assertDerivedComplete(a: { category?: string; tags?: string[]; meta?: Record<string, unknown> }): void {
  const missing: string[] = [];
  if (!a.category?.trim()) missing.push('category');
  if (!a.tags?.length) missing.push('tags');
  if (typeof a.meta?.behavior !== 'string' || !a.meta.behavior.trim()) missing.push('meta.behavior (1-3 sentences: what the viewer sees over time)');
  if (missing.length) throw new VfxError(`a derived record must be findable: missing ${missing.join(', ')}`, 'invalid');
}
