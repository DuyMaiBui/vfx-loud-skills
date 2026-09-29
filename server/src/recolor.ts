/**
 * Deterministic recolor transform over an extracted recipe payload.
 *
 * Pure: no DB, no network, no model. Shifts the hue of every colour in the particle/effect params
 * (startColor constant | gradient | random-between, colorOverLifetime, colorBySpeed, trail/line
 * colours, custom-data colours) and returns the tint the Unity client should apply to a material
 * COPY. Materials are guid refs, so the tint names {materialGuid, property, from, to} rather than
 * carrying bytes.
 *
 * The payload is edited IN PLACE on the parsed object — it is never re-emitted through the YAML
 * writer, so the record's stored bytes, sha and version are untouched. Callers that want text
 * render it themselves via `applyColourLines` (text surgery) or `toYaml` (full re-emit).
 *
 * Colour maths lives in ./colour.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { VfxError } from './errors.ts';
import { type Colour, ciede2000, hexToColour, hueDeltaDeg, rgbToHex, rotateHue, toColour, toGradientKeyColour } from './colour.ts';

export interface RecolorData {
  hue: { space: string; gamma: number; minChroma: number; maxChroma: number; preserveAlpha: boolean };
  material: {
    properties: { name: string; weight: number; note: string }[];
    defaultProperty: string;
  };
  paths: { colour: string[]; gradient: string[]; keys: string[] };
  textureBaked: { differentTextureGuid: boolean; noColourParams: boolean };
}

export const RECOLOR: RecolorData = JSON.parse(
  fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'recolor.json'), 'utf8'),
) as RecolorData;

/** Material colour properties to consider, most likely first. */
export const MATERIAL_COLOUR_PROPERTIES: string[] = [...RECOLOR.material.properties]
  .sort((a, b) => b.weight - a.weight || (a.name < b.name ? -1 : 1))
  .map((p) => p.name);

export interface RecolorOptions {
  /** Any CSS-ish hex (#rrggbb / #rgb / #rrggbbaa) — the colour every recoloured key moves TOWARD. */
  targetColor?: string;
  /** Signed degrees, -180..180; +90 = green -> blue. Used when targetColor is absent. */
  hueShiftDeg?: number;
  /**
   * Keep each colour's perceived lightness: the target's L is adopted, each source colour keeps its
   * own L. Default true — a hue shift should not also darken the effect.
   */
  preserveLuminance?: boolean;
}

export interface ColourChange {
  path: string;
  from: string;
  to: string;
}

export interface TintEntry {
  materialGuid: string;
  materialPath: string | null;
  /** "_Color" | "_BaseColor" | ... — the client skips names its shader does not declare. */
  property: string;
  from: string;
  to: string;
}

export interface RecolorResult {
  /** Deep copy of the input with every reachable colour rotated. */
  payload: Record<string, unknown>;
  changes: ColourChange[];
  /** Materials the client should tint (on a copy) — the keys the params cannot reach. */
  tint: TintEntry[];
  /** Mode that was actually applied. */
  mode: 'target' | 'hueShift';
  hueShiftDeg: number;
  preserveLuminance: boolean;
  summary: {
    keysTotal: number;
    keysRecolored: number;
    /** Distinct colours after the shift — what the effect will read as. */
    dominant: string;
    colourWords: string[];
    nodeCount: number;
    /** Paths named in recolor.json that the payload has no value for. */
    skipped: string[];
  };
}

/* ------------------------------------------------------------------ path walk */

/**
 * A pattern is a dotted path whose segments may end in `[]`, meaning "this value is an array —
 * take every element". So `effectNodes[].components[].m_Materials` is: root.effectNodes (array) ->
 * each element .components (array) -> each element .m_Materials.
 */
interface Step {
  key: string;
  iterate: boolean;
}

function steps(pattern: string): Step[] {
  return pattern.split('.').map((t) => (t.endsWith('[]') ? { key: t.slice(0, -2), iterate: true } : { key: t, iterate: false }));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A value reachable through a pattern, with the container it lives in so the caller can mutate it. */
interface Leaf {
  owner: Record<string, unknown> | unknown[];
  key: string | number;
  value: unknown;
  path: string;
}

function leaves(root: unknown, pattern: string): Leaf[] {
  const parts = steps(pattern);
  if (!parts.length) return [];
  const out: Leaf[] = [];
  const walk = (node: unknown, depth: number, trail: string): void => {
    if (depth >= parts.length) return;
    const step = parts[depth];
    if (!isPlainObject(node) || !(step.key in node)) return;
    const val = node[step.key];
    const p = trail ? `${trail}.${step.key}` : step.key;
    const last = depth === parts.length - 1;
    if (step.iterate) {
      if (!Array.isArray(val)) return;
      val.forEach((el, i) => {
        const ip = `${p}[${i}]`;
        if (last) out.push({ owner: val, key: i, value: el, path: ip });
        else walk(el, depth + 1, ip);
      });
      return;
    }
    if (last) out.push({ owner: node, key: step.key, value: val, path: p });
    else walk(val, depth + 1, p);
  };
  walk(root, 0, '');
  return out;
}

/* ------------------------------------------------------------------ colour words */

const HUE_WORDS: [number, string][] = [
  [15, 'red'],
  [40, 'orange'],
  [68, 'yellow'],
  [160, 'green'],
  [200, 'cyan'],
  [255, 'blue'],
  [290, 'purple'],
  [345, 'pink'],
  [360, 'red'],
];

/** Coarse colour word for a colour, matching seed/extract/enrich.ts's bucketing (HSV, same cuts). */
export function colourWord(c: Colour): string {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const v = max;
  const s = max === 0 ? 0 : (max - min) / max;
  if (v < 0.18) return 'black';
  if (s < 0.16) return v > 0.75 ? 'white' : 'grey';
  let h = 0;
  const d = max - min;
  if (d > 0) {
    if (max === c.r) h = 60 * (((c.g - c.b) / d) % 6);
    else if (max === c.g) h = 60 * ((c.b - c.r) / d + 2);
    else h = 60 * ((c.r - c.g) / d + 4);
  }
  if (h < 0) h += 360;
  for (const [cut, word] of HUE_WORDS) if (h < cut) return word;
  return 'red';
}

/* ------------------------------------------------------------------ transform */

/**
 * True when a leaf holds a list of GradientColorKey rows rather than one colour: the first element is
 * itself an array. Rows are [time, r, g, b], so the colour reader differs — see colour.ts.
 */
function isGradientRows(v: unknown): boolean {
  return Array.isArray(v) && Array.isArray((v as unknown[])[0]);
}

/** The three pattern groups in recolor.json, named so callers can select which to read. */
export type ColourGroup = 'colour' | 'gradient' | 'keys';

/**
 * Every colour the declared paths reach, with the concrete path each was found at.
 *
 * This is the single reader of "what colours does a payload have" — `recolor` uses it for the
 * summary, and the validation study uses it to compare a recoloured base against a real variant.
 * Two implementations would drift, and the drift would be invisible: both would look plausible.
 */
export function payloadColours(
  payload: unknown,
  groups: readonly ColourGroup[] = ['colour', 'gradient', 'keys'],
): { path: string; colour: Colour }[] {
  const out: { path: string; colour: Colour }[] = [];
  for (const group of groups) {
    for (const pattern of RECOLOR.paths[group]) {
      for (const leaf of leaves(payload, pattern)) {
        const grad = isGradientRows(leaf.value);
        const rows = grad ? (leaf.value as unknown[]) : [leaf.value];
        rows.forEach((row, i) => {
          const c = grad ? toGradientKeyColour(row) : toColour(row);
          if (c) out.push({ path: grad ? `${leaf.path}[${i}]` : leaf.path, colour: c });
        });
      }
    }
  }
  return out;
}

function normaliseOptions(o: RecolorOptions): { mode: 'target' | 'hueShift'; target: Colour | null; shift: number; preserve: boolean } {
  const hasTarget = typeof o.targetColor === 'string' && o.targetColor.trim() !== '';
  const hasShift = typeof o.hueShiftDeg === 'number' && Number.isFinite(o.hueShiftDeg);
  if (hasTarget && hasShift) throw new VfxError('give either targetColor or hueShiftDeg, not both');
  if (!hasTarget && !hasShift) throw new VfxError('targetColor or hueShiftDeg is required');
  if (hasTarget) {
    const target = hexToColour(o.targetColor as string);
    if (!target) throw new VfxError(`targetColor must be hex (#rrggbb or #rrggbbaa), got "${o.targetColor}"`);
    return { mode: 'target', target, shift: 0, preserve: o.preserveLuminance ?? true };
  }
  const shift = o.hueShiftDeg as number;
  if (shift < -360 || shift > 360) throw new VfxError('hueShiftDeg must be within -360..360');
  return { mode: 'hueShift', target: null, shift, preserve: o.preserveLuminance ?? true };
}

/** Unity stores colour components to ~5 decimals; keep the emitted file the same shape as the source. */
const r5 = (x: number): number => Math.round(x * 1e5) / 1e5;

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/**
 * Recolour one recipe payload. Deterministic: same payload + same options -> byte-identical output.
 */
export function recolor(payload: unknown, options: RecolorOptions): RecolorResult {
  if (!isPlainObject(payload)) throw new VfxError('payload must be an object');
  const { mode, target, shift, preserve } = normaliseOptions(options);

  const out = clone(payload) as Record<string, unknown>;
  const changes: ColourChange[] = [];
  const seenPaths = new Set<string>();
  let keysTotal = 0;
  let nodeCount = 0;

  const shiftOne = (c: Colour): Colour => rotateHue(c, target, shift, preserve);

  const record = (concrete: string, from: Colour, to: Colour): void => {
    const fromHex = rgbToHex(from);
    const toHex = rgbToHex(to);
    if (fromHex === toHex) return;
    changes.push({ path: concrete, from: fromHex, to: toHex });
  };

  const doColour = (pattern: string): void => {
    for (const leaf of leaves(out, pattern)) {
      seenPaths.add(pattern);
      keysTotal++;
      const c = toColour(leaf.value);
      if (!c) continue;
      const shifted = shiftOne(c);
      const next = [r5(shifted.r), r5(shifted.g), r5(shifted.b), (leaf.value as number[])[3] ?? 1];
      if (Array.isArray(leaf.owner)) leaf.owner[leaf.key as number] = next;
      else (leaf.owner as Record<string, unknown>)[leaf.key as string] = next;
      record(leaf.path, c, shifted);
    }
  };

  /** Gradient rows are [time, r, g, b]; the time is rewritten unchanged so only the colour moves. */
  const doGradient = (pattern: string): void => {
    for (const leaf of leaves(out, pattern)) {
      seenPaths.add(pattern);
      if (!Array.isArray(leaf.value)) continue;
      const rows = leaf.value as unknown[];
      rows.forEach((row, i) => {
        keysTotal++;
        const c = toGradientKeyColour(row);
        if (!c) return;
        const shifted = shiftOne(c);
        const time = (row as number[])[0];
        rows[i] = [time, r5(shifted.r), r5(shifted.g), r5(shifted.b)];
        record(`${leaf.path}[${i}]`, c, shifted);
      });
    }
  };

  for (const pattern of RECOLOR.paths.colour) doColour(pattern);
  for (const pattern of RECOLOR.paths.gradient) doGradient(pattern);
  for (const pattern of RECOLOR.paths.keys) doColour(pattern);

  // Colour words + dominant colour are read from the *result*, so they describe what the effect reads as.
  const words = new Map<string, number>();
  const buckets = new Map<string, { c: Colour; n: number }>();
  for (const { colour: c } of payloadColours(out, ['colour', 'gradient'])) {
    const w = colourWord(c);
    words.set(w, (words.get(w) ?? 0) + 1);
    const key = `${Math.round(c.r * 8)}-${Math.round(c.g * 8)}-${Math.round(c.b * 8)}`;
    const b = buckets.get(key) ?? { c, n: 0 };
    b.n++;
    buckets.set(key, b);
  }
  const dominant = [...buckets.values()].sort((a, b) => b.n - a.n)[0]?.c ?? { r: 1, g: 1, b: 1, a: 1 };

  // Effects carry no particle nodes; counting them keeps the summary honest about which case ran.
  nodeCount = Array.isArray(out.particleNodes) ? (out.particleNodes as unknown[]).length : 0;

  const tint = buildTint(out, dominant);
  const skipped = [...RECOLOR.paths.colour, ...RECOLOR.paths.gradient, ...RECOLOR.paths.keys].filter((p) => !seenPaths.has(p));

  return {
    payload: out,
    changes,
    tint,
    mode,
    hueShiftDeg: mode === 'target' ? Math.round(hueDeltaDeg(dominantBefore(payload), target as Colour) * 100) / 100 : shift,
    preserveLuminance: preserve,
    summary: {
      keysTotal,
      keysRecolored: changes.length,
      dominant: rgbToHex(dominant),
      colourWords: [...words].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([w]) => w),
      nodeCount,
      skipped,
    },
  };
}

/**
 * Mean of the payload's colours — the reference a reported hue delta is measured from, and the
 * "from" side of the tint list. Read from the ORIGINAL payload, so it is the pre-shift colour.
 */
export function dominantBefore(payload: unknown): Colour {
  const acc = { r: 0, g: 0, b: 0, a: 1, n: 0 };
  for (const { colour: c } of payloadColours(payload, ['colour', 'gradient'])) {
    acc.r += c.r;
    acc.g += c.g;
    acc.b += c.b;
    acc.n++;
  }
  if (!acc.n) return { r: 1, g: 1, b: 1, a: 1 };
  return { r: acc.r / acc.n, g: acc.g / acc.n, b: acc.b / acc.n, a: 1 };
}

/**
 * Tint list: every material the payload references, with the colour property to set on a COPY.
 * The from/to pair is the dominant pre-shift colour vs the dominant post-shift colour, so a client
 * that cannot reach the particle params can still move the material the same way.
 */
export function buildTint(payload: unknown, dominantAfter: Colour): TintEntry[] {
  const before = dominantBefore(payload);
  const prop = RECOLOR.material.defaultProperty;
  const out: TintEntry[] = [];
  const seen = new Set<string>();
  for (const leaf of leaves(payload, 'effectNodes[].components[].m_Materials')) {
    if (!Array.isArray(leaf.value)) continue;
    for (const m of leaf.value as unknown[]) {
      if (!isPlainObject(m)) continue;
      const guid = typeof m.guid === 'string' ? m.guid : null;
      if (!guid || seen.has(guid)) continue;
      seen.add(guid);
      out.push({
        materialGuid: guid,
        materialPath: typeof m.path === 'string' ? m.path : null,
        property: prop,
        from: rgbToHex(before),
        to: rgbToHex(dominantAfter),
      });
    }
  }
  return out;
}

/**
 * Materials of a payload as {guid, path, shader, textures} — the shape seed/graph/payload.ts already
 * extracts. Re-exported through this module so callers of recolor do not need the graph layer.
 */
export interface PayloadMaterial {
  guid: string;
  path: string | null;
  shader: string | null;
  textures: { slot: string; guid: string }[];
}

export function materialsOf(payload: unknown): PayloadMaterial[] {
  const out: PayloadMaterial[] = [];
  const push = (m: unknown): void => {
    if (!isPlainObject(m)) return;
    const guid = typeof m.guid === 'string' ? m.guid : null;
    if (!guid) return;
    const shader = isPlainObject(m.shader) && typeof m.shader.guid === 'string' ? m.shader.guid : null;
    const textures = Array.isArray(m.textures)
      ? (m.textures as unknown[]).filter(isPlainObject).map((t) => ({ slot: String(t.slot ?? ''), guid: String(t.guid ?? '') }))
      : [];
    out.push({ guid, path: typeof m.path === 'string' ? m.path : null, shader, textures });
  };
  for (const p of ['effectNodes[].components[].m_Materials', 'particleNodes[].renderer.materials']) {
    for (const leaf of leaves(payload, p)) {
      if (Array.isArray(leaf.value)) (leaf.value as unknown[]).forEach(push);
    }
  }
  return out;
}

/** Material/slot colours, for the tint list of a payload whose colours live on the material only. */
export function materialSlots(payload: unknown): { materialGuid: string; property: string; note: string }[] {
  return materialsOf(payload).flatMap((m) =>
    MATERIAL_COLOUR_PROPERTIES.slice(0, 3).map((property) => ({
      materialGuid: m.guid,
      property,
      note: m.path ?? '',
    })),
  );
}

export { ciede2000, hueDeltaDeg, rgbToHex, toColour, rotateHue };
export type { Colour };
