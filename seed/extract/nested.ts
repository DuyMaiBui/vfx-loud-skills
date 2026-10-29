import { SkipError } from './recipe.ts';
import {
  asMap,
  asRef,
  asSeq,
  isUnityTextYaml,
  parseUnityDocs,
  UnityYamlError,
  type UnityDoc,
  type YamlMap,
  type YamlValue,
} from './unity-yaml.ts';

/**
 * Nested prefab instances (D9). Only ONE shape is flattened: a prefab file that is nothing but a variant of
 * a regular base prefab (a single root PrefabInstance, no GameObject of its own) whose overrides touch
 * GameObject name/active, Transform and numeric ParticleSystem fields. Everything else is skipped with an
 * exact reason, never partially flattened and never with an override silently dropped:
 *   gameplay-prefab                     has its own GameObjects (or several instances) around nested prefabs
 *   nested-override-unsupported:<path>  a variant whose override (or added/removed object) is not representable
 *   nested-base-missing                 the base prefab is not in the source
 */

/** What flattening resolved; carried on the recipe payload and into the nested report. */
export interface NestedInfo {
  baseGuid: string;
  /** Every `m_Modifications` entry, applied or accepted as editor-only. */
  overrides: number;
}

export interface NestedContext {
  /** Text of the prefab with this guid when the source has it. */
  prefabText?(guid: string): string | undefined;
}

const unsupported = (path: string): SkipError =>
  new SkipError(`nested-override-unsupported:${path}`, `override "${path}" cannot be flattened into a recipe`);

const isMap = (v: YamlValue | undefined): v is YamlMap => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Transform fields that are editor bookkeeping: the recipe never emits them, so accepting them loses nothing. */
const EDITOR_ONLY = /^(m_LocalEulerAnglesHint\.[xyz]|m_RootOrder)$/;
const TRANSFORM_VALUE = /^m_Local(Position|Scale)\.[xyz]$|^m_LocalRotation\.[xyzw]$/;

const toNumber = (v: YamlValue | undefined): number | undefined => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

/** Sets a NUMERIC leaf of a serialized body by Unity property path (`a.b.Array.data[2].c`); false when it is not one. */
function setNumericLeaf(body: YamlMap, path: string, value: YamlValue | undefined): boolean {
  const n = toNumber(value);
  if (n === undefined) return false;
  const segs = path.split('.');
  let cur: YamlValue | undefined = body;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const idx = /^data\[(\d+)\]$/.exec(seg);
    const last = i === segs.length - 1;
    if (seg === 'Array' && Array.isArray(cur)) continue;
    let key: string | number;
    if (idx && Array.isArray(cur)) key = Number(idx[1]);
    else if (isMap(cur)) key = seg;
    else return false;
    const holder = cur as Record<string | number, YamlValue>;
    if (last) {
      if (typeof holder[key] !== 'number') return false; // only existing numeric fields are overridable
      holder[key] = n;
      return true;
    }
    cur = holder[key];
    if (cur === undefined) return false;
  }
  return false;
}

function parseBase(text: string): UnityDoc[] {
  if (!isUnityTextYaml(text.slice(0, 16))) throw new SkipError('nested-base-missing', 'base prefab is not text-serialized');
  try {
    return parseUnityDocs(text);
  } catch (e) {
    if (e instanceof UnityYamlError) throw new SkipError('yaml-parse-error', `base prefab: ${e.message}`);
    throw e;
  }
}

/**
 * Resolves a prefab's docs: unchanged when there is no PrefabInstance, the flattened base otherwise, or a
 * SkipError with the exact reason. Overrides are applied to a deep copy of the base docs.
 */
export function flattenNested(docs: UnityDoc[], ctx: NestedContext): { docs: UnityDoc[]; info?: NestedInfo } {
  const instances = docs.filter((d) => d.type === 'PrefabInstance');
  if (instances.length === 0) return { docs };
  const ownObjects = docs.some((d) => d.type === 'GameObject' && !d.stripped);
  if (ownObjects || instances.length > 1) {
    throw new SkipError('gameplay-prefab', 'prefab has its own GameObjects around nested prefab instances');
  }
  const pi = instances[0];
  const mod = asMap(pi.body.m_Modification) ?? {};
  if (asRef(mod.m_TransformParent)?.fileId !== '0') {
    throw new SkipError('gameplay-prefab', 'prefab instance is parented under another object');
  }
  for (const key of ['m_AddedGameObjects', 'm_AddedComponents', 'm_RemovedComponents', 'm_RemovedGameObjects']) {
    if (asSeq(mod[key]).length > 0) throw unsupported(key);
  }
  const baseGuid = asRef(pi.body.m_SourcePrefab)?.guid;
  const baseText = baseGuid ? ctx.prefabText?.(baseGuid) : undefined;
  if (!baseGuid || baseText === undefined) {
    throw new SkipError('nested-base-missing', `base prefab ${baseGuid ?? '(none)'} is not in the source`);
  }
  const base = structuredClone(parseBase(baseText));
  if (base.some((d) => d.type === 'PrefabInstance')) {
    if (base.some((d) => d.type === 'GameObject' && !d.stripped)) {
      throw new SkipError('gameplay-prefab', 'base prefab is itself a gameplay prefab with nested instances');
    }
    throw unsupported('variant-of-variant');
  }
  const byId = new Map(base.map((d) => [d.fileId, d]));

  const mods = asSeq(mod.m_Modifications);
  for (const raw of mods) {
    const m = asMap(raw) ?? {};
    const prop = String(m.propertyPath ?? '');
    const target = asRef(m.target);
    const doc = target ? byId.get(target.fileId) : undefined;
    if (!doc || (target?.guid && target.guid !== baseGuid)) throw unsupported(prop);
    const objRef = asRef(m.objectReference);
    if (objRef && objRef.fileId !== '0') throw unsupported(prop);
    if (doc.type === 'GameObject' && prop === 'm_Name') doc.body.m_Name = String(m.value ?? '');
    else if (doc.type === 'GameObject' && prop === 'm_IsActive' && toNumber(m.value) !== undefined) {
      doc.body.m_IsActive = toNumber(m.value) as number;
    } else if (doc.type === 'Transform' && EDITOR_ONLY.test(prop)) continue;
    else if (doc.type === 'Transform' && TRANSFORM_VALUE.test(prop)) {
      if (!setNumericLeaf(doc.body, prop, m.value)) throw unsupported(prop);
    } else if (doc.type === 'ParticleSystem') {
      if (!setNumericLeaf(doc.body, prop, m.value)) throw unsupported(prop);
    } else throw unsupported(prop);
  }
  return { docs: base, info: { baseGuid, overrides: mods.length } };
}

/* ------------------------------------------------------------------ report */

export interface NestedEntry {
  prefabPath: string;
  prefabGuid: string;
  /** `flattened` or the skip code (`gameplay-prefab`, `nested-override-unsupported:<path>`, ...). */
  outcome: string;
  baseGuid?: string;
  overrides?: number;
}

export interface NestedReport {
  /** True when no prefab was a flattenable variant: the flatten code ran on nothing real. */
  classAEmpty: boolean;
  counts: Record<string, number>;
  prefabs: NestedEntry[];
}

/** Outcome codes that belong to nested-prefab handling (everything else is some other skip). */
export const isNestedOutcome = (code: string): boolean =>
  code === 'gameplay-prefab' || code === 'nested-base-missing' || code.startsWith('nested-override-unsupported:');

/** Counts per outcome class (the `:<path>` suffix is dropped for the count key, kept per prefab). */
export function buildNestedReport(entries: NestedEntry[]): NestedReport {
  const counts: Record<string, number> = {};
  for (const e of entries) {
    const k = e.outcome.split(':')[0];
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const prefabs = [...entries].sort((a, b) => (a.prefabPath < b.prefabPath ? -1 : a.prefabPath > b.prefabPath ? 1 : 0));
  return { classAEmpty: !counts.flattened, counts, prefabs };
}
