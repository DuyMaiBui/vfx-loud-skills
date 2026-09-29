/**
 * Colour maths for the recolor transform. Pure functions, no dependencies.
 *
 * Hue rotation happens in OKLCh — rotating HSV hue on a saturated colour swings perceived lightness
 * and chroma badly (blue -> yellow goes nearly black), which makes the derived variant visibly a
 * different effect rather than the same effect in another colour. Distance is CIEDE2000 over Lab,
 * the metric the validation study reports.
 */

export interface Colour {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Lab {
  L: number;
  a: number;
  b: number;
}

export interface Oklch {
  L: number;
  C: number;
  h: number;
  a: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** [r,g,b,a] (or [r,g,b]) in 0..1 -> Colour. Returns null for anything that is not a colour row. */
export function toColour(v: unknown): Colour | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const [r, g, b, a] = v as unknown[];
  if (typeof r !== 'number' || typeof g !== 'number' || typeof b !== 'number') return null;
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return { r, g, b, a: typeof a === 'number' && Number.isFinite(a) ? a : 1 };
}

/** A Unity GradientColorKey row is [time, r, g, b] — element 0 is the key time, not a channel. */
export function toGradientKeyColour(v: unknown): Colour | null {
  if (!Array.isArray(v) || v.length < 4) return null;
  const [, r, g, b] = v as unknown[];
  if (typeof r !== 'number' || typeof g !== 'number' || typeof b !== 'number') return null;
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return { r, g, b, a: 1 };
}

export function rgbToHex(c: Colour): string {
  const h = (x: number): string => Math.round(clamp01(x) * 255).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** "#rgb" | "#rrggbb" | "#rrggbbaa" -> Colour. Null when the string is not a hex colour. */
export function hexToColour(s: string): Colour | null {
  const t = s.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(t)) return null;
  /** Short form doubles the nibble ("f" -> "ff"); long form reads the pair as-is. */
  const short = (x: string): number => parseInt(x + x, 16) / 255;
  const pair = (x: string): number => parseInt(x, 16) / 255;
  if (t.length === 3 || t.length === 4) {
    return { r: short(t[0]), g: short(t[1]), b: short(t[2]), a: t.length === 4 ? short(t[3]) : 1 };
  }
  if (t.length === 6 || t.length === 8) {
    return {
      r: pair(t.slice(0, 2)),
      g: pair(t.slice(2, 4)),
      b: pair(t.slice(4, 6)),
      a: t.length === 8 ? pair(t.slice(6, 8)) : 1,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ sRGB <-> linear <-> Lab */

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** D65 white point, matching Unity's Color space and CIEDE2000's usual reference. */
const WHITE = { x: 0.95047, y: 1, z: 1.08883 };

function rgbToXyz(c: Colour): { x: number; y: number; z: number } {
  const r = srgbToLinear(clamp01(c.r));
  const g = srgbToLinear(clamp01(c.g));
  const b = srgbToLinear(clamp01(c.b));
  return {
    x: r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    y: r * 0.2126729 + g * 0.7151522 + b * 0.072175,
    z: r * 0.0193339 + g * 0.119192 + b * 0.9503041,
  };
}

/** Linear XYZ -> sRGB with the channels left UNCLAMPED, so a caller can tell in-gamut from not. */
function xyzToRgbRaw(x: number, y: number, z: number): Colour {
  return {
    r: linearToSrgb(x * 3.2404542 + y * -1.5371385 + z * -0.4985314),
    g: linearToSrgb(x * -0.969266 + y * 1.8760108 + z * 0.041556),
    b: linearToSrgb(x * 0.0556434 + y * -0.2040259 + z * 1.0572252),
    a: 1,
  };
}

function xyzToRgb(x: number, y: number, z: number): Colour {
  const raw = xyzToRgbRaw(x, y, z);
  return { r: clamp01(raw.r), g: clamp01(raw.g), b: clamp01(raw.b), a: 1 };
}

const LAB_EPS = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

export function rgbToLab(c: Colour): Lab {
  const { x, y, z } = rgbToXyz(c);
  const f = (t: number): number => (t > LAB_EPS ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116);
  const fx = f(x / WHITE.x);
  const fy = f(y / WHITE.y);
  const fz = f(z / WHITE.z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function labToRgb(lab: Lab): Colour {
  const fy = (lab.L + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;
  const inv = (t: number): number => {
    const t3 = t ** 3;
    return t3 > LAB_EPS ? t3 : (116 * t - 16) / LAB_KAPPA;
  };
  return xyzToRgb(inv(fx) * WHITE.x, (lab.L > 8 ? ((lab.L + 16) / 116) ** 3 : lab.L / LAB_KAPPA) * WHITE.y, inv(fz) * WHITE.z);
}

/* ------------------------------------------------------------------ OKLab / OKLCh */

export function rgbToOklab(c: Colour): { L: number; a: number; b: number } {
  const r = srgbToLinear(clamp01(c.r));
  const g = srgbToLinear(clamp01(c.g));
  const b = srgbToLinear(clamp01(c.b));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** OKLab -> sRGB, channels UNCLAMPED (a wide-gamut colour comes back with values outside 0..1). */
export function oklabToRgb(lab: { L: number; a: number; b: number }): Colour {
  const l = (lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b) ** 3;
  const m = (lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b) ** 3;
  const s = (lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b) ** 3;
  return xyzToRgbRaw(
    1.2270138511 * l - 0.5577999807 * m + 0.281256149 * s,
    -0.0405801784 * l + 1.1122568696 * m - 0.0716766787 * s,
    -0.0763812845 * l - 0.4214819784 * m + 1.5861632204 * s,
  );
}

export function rgbToOklch(c: Colour): Oklch {
  const { L, a, b } = rgbToOklab(c);
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h, a: c.a };
}

export function oklchToRgb(c: Oklch): Colour {
  const rad = (c.h * Math.PI) / 180;
  const rgb = oklabToRgb({ L: c.L, a: Math.cos(rad) * c.C, b: Math.sin(rad) * c.C });
  return { r: clamp01(rgb.r), g: clamp01(rgb.g), b: clamp01(rgb.b), a: c.a };
}

const inGamut = (c: Colour): boolean => c.r >= -1e-6 && c.r <= 1 + 1e-6 && c.g >= -1e-6 && c.g <= 1 + 1e-6 && c.b >= -1e-6 && c.b <= 1 + 1e-6;

/**
 * OKLCh -> sRGB with gamut mapping.
 *
 * A hue rotation at constant L and C can land outside sRGB (yellow-green and magenta are the usual
 * offenders). Clamping each channel afterwards would hold the value but bend the hue — a +90 shift
 * would measure back as +94 — so instead chroma is reduced by bisection until the colour is inside
 * the gamut. Lightness and hue are what the eye reads as "same colour, different hue"; chroma is the
 * channel that can give, so that is the one that moves.
 */
export function oklchToRgbGamut(c: Oklch): Colour {
  const rad = (c.h * Math.PI) / 180;
  const raw = (C: number): Colour => oklabToRgb({ L: c.L, a: Math.cos(rad) * C, b: Math.sin(rad) * C });
  if (inGamut(raw(c.C))) return oklchToRgb(c);
  let lo = 0;
  let hi = c.C;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(raw(mid))) lo = mid;
    else hi = mid;
  }
  return oklchToRgb({ ...c, C: lo });
}

/* ------------------------------------------------------------------ hue distance */

/** Shortest signed hue delta in degrees, -180..180. Used to report the effective shift. */
export function hueDeltaDeg(from: Colour, to: Colour): number {
  const a = rgbToOklch(from).h;
  const b = rgbToOklch(to).h;
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/* ------------------------------------------------------------------ the transform */

/**
 * Rotate one colour's hue.
 *
 * - `target` given: adopt the target's hue (and, when preserveLuminance, its OKLab L) — every key
 *   lands on the same hue family, which is what "make this the red version" means.
 * - `hueShiftDeg` given: rotate by that many degrees. `preserveLuminance` is a no-op here: OKLCh
 *   rotation already holds L fixed, which is the point of using it.
 *
 * Near-greyscale colours (chroma below the floor) have no meaningful hue and are returned untouched,
 * so white cores / black smoke do not pick up a colour cast.
 */
export function rotateHue(c: Colour, target: Colour | null, hueShiftDeg: number, preserveLuminance: boolean): Colour {
  const src = rgbToOklch(c);
  if (src.C < 0.02) return { ...c };
  if (target) {
    const t = rgbToOklch(target);
    const L = preserveLuminance ? src.L : t.L;
    // Chroma is carried over, capped: adopting the target's chroma would flatten a gradient's
    // intensity variation (a bright core and a dim edge would become the same colour).
    const C = clamp(Math.max(src.C, t.C * 0.5), 0.02, 0.4);
    return oklchToRgbGamut({ L, C, h: t.h, a: c.a });
  }
  // A no-op rotation must be a true no-op: the OKLCh round trip is lossy at 8-bit sRGB precision, so
  // routing 0 (or 360) through it would perturb every key in the payload for nothing.
  const shift = ((hueShiftDeg % 360) + 360) % 360;
  if (shift === 0) return { ...c };
  return oklchToRgbGamut({ L: src.L, C: src.C, h: (src.h + shift) % 360, a: c.a });
}

/* ------------------------------------------------------------------ CIEDE2000 */

const deg = (x: number): number => (x * Math.PI) / 180;

/**
 * CIEDE2000 colour difference. ~1.0 is "just noticeable" for a trained eye; <2.3 is the usual
 * acceptable-render threshold, >10 reads as a different colour.
 */
export function ciede2000(lab1: Lab, lab2: Lab): number {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = C1p === 0 ? 0 : ((Math.atan2(b1, a1p) * 180) / Math.PI + 360) % 360;
  const h2p = C2p === 0 ? 0 : ((Math.atan2(b2, a2p) * 180) / Math.PI + 360) % 360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(deg(dhp) / 2);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbarp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    else hbarp = (h1p + h2p) / 2;
  }

  const T =
    1 -
    0.17 * Math.cos(deg(hbarp - 30)) +
    0.24 * Math.cos(deg(2 * hbarp)) +
    0.32 * Math.cos(deg(3 * hbarp + 6)) -
    0.2 * Math.cos(deg(4 * hbarp - 63));
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(deg(2 * dTheta)) * RC;

  return Math.sqrt(
    (dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH),
  );
}

/** CIEDE2000 between two sRGB colours, ignoring alpha. */
export function colourDistance(a: Colour, b: Colour): number {
  return ciede2000(rgbToLab(a), rgbToLab(b));
}
