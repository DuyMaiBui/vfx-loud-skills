import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type Colour,
  ciede2000,
  colourDistance,
  hexToColour,
  hueDeltaDeg,
  labToRgb,
  oklchToRgb,
  rgbToHex,
  rgbToLab,
  rgbToOklch,
  rotateHue,
  toColour,
  toGradientKeyColour,
} from './colour.ts';
import { MATERIAL_COLOUR_PROPERTIES, colourWord, materialsOf, recolor } from './recolor.ts';

const near = (a: number, b: number, tol: number): void =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} within ${tol} of ${b}`);

const C = (r: number, g: number, b: number, a = 1): Colour => ({ r, g, b, a });

/* ------------------------------------------------------------------ conversion round trips */

test('colour: hex round-trips through rgbToHex / hexToColour', () => {
  for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#1a2b3c', '#ffffff', '#000000', '#7f7f7f']) {
    const c = hexToColour(hex);
    assert.ok(c, `parsed ${hex}`);
    assert.equal(rgbToHex(c), hex);
  }
});

test('colour: hex accepts #rgb, #rrggbb and #rrggbbaa; rejects junk', () => {
  assert.equal(rgbToHex(hexToColour('#f00')!), '#ff0000');
  assert.equal(hexToColour('#ff000080')!.a, 128 / 255);
  assert.equal(hexToColour('rebeccapurple'), null);
  assert.equal(hexToColour('#gg0000'), null);
  assert.equal(hexToColour('#12345'), null);
});

test('colour: Lab and OKLab round-trip within float error', () => {
  for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#c8641e', '#808080', '#00ffff']) {
    const c = hexToColour(hex)!;
    near(rgbToHex(labToRgb(rgbToLab(c))) === hex ? 0 : colourDistance(c, labToRgb(rgbToLab(c))), 0, 0.02);
    const back = oklchToRgb(rgbToOklch(c));
    near(colourDistance(c, back), 0, 0.05);
  }
});

test('colour: white and black land at the expected Lab L', () => {
  near(rgbToLab(C(1, 1, 1)).L, 100, 0.1);
  near(rgbToLab(C(0, 0, 0)).L, 0, 0.1);
  near(rgbToLab(C(0.5, 0.5, 0.5)).L, 53.39, 0.1);
});

test('toColour: accepts [r,g,b] and [r,g,b,a], defaults alpha, rejects non-colours', () => {
  assert.deepEqual(toColour([1, 0, 0]), C(1, 0, 0, 1));
  assert.deepEqual(toColour([0, 0, 1, 0.5]), C(0, 0, 1, 0.5));
  assert.equal(toColour([0, 0]), null);
  assert.equal(toColour(['a', 0, 0]), null);
  assert.equal(toColour({ r: 1 }), null);
  assert.equal(toColour([1, 0, Number.NaN]), null);
});

/* ------------------------------------------------------------------ CIEDE2000 */

test('ciede2000: identity is 0 and it is symmetric', () => {
  const a = rgbToLab(C(0.2, 0.4, 0.9));
  assert.equal(ciede2000(a, a), 0);
  const b = rgbToLab(C(0.9, 0.1, 0.1));
  near(ciede2000(a, b), ciede2000(b, a), 1e-9);
});

test('ciede2000: matches the Sharma et al. reference pairs', () => {
  // The CIEDE2000 test-data set from Sharma, Wu & Dalal (2005), Lab pairs -> expected dE00.
  const cases: [number[], number[], number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, -1.1848, -84.8006], [50, 0, -82.7485], 1.0],
    [[50, -0.9009, -85.5211], [50, 0, -82.7485], 1.0],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, -1, 2], [50, 0, 0], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
    [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
    [[50, 2.49, -0.001], [50, -2.49, 0.0012], 7.2195],
    [[50, -0.001, 2.49], [50, 0.0009, -2.49], 4.8045],
    [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[50, 2.5, 0], [56, -27, -3], 31.9030],
    [[50, 2.5, 0], [58, 24, 15], 19.4535],
    [[50, 2.5, 0], [50, 3.1736, 0.5854], 1.0],
    [[50, 2.5, 0], [50, 3.2972, 0], 1.0],
    [[50, 2.5, 0], [50, 1.8634, 0.5757], 1.0],
    [[50, 2.5, 0], [50, 3.2592, 0.335], 1.0],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.2630],
    [[61.2901, 3.7196, -5.3901], [61.4292, 2.248, -4.962], 1.8731],
    [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
    [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
    [[36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
    [[90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441],
    [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
    [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ];
  for (const [l1, l2, expected] of cases) {
    const got = ciede2000({ L: l1[0], a: l1[1], b: l1[2] }, { L: l2[0], a: l2[1], b: l2[2] });
    near(got, expected, 1e-4);
  }
});

test('colourDistance: identical colours are 0, opposite hues are large', () => {
  assert.equal(colourDistance(C(0.2, 0.5, 0.8), C(0.2, 0.5, 0.8)), 0);
  assert.ok(colourDistance(C(1, 0, 0), C(0, 0, 1)) > 30);
  // Adjacent shades of one hue are a small difference, not a large one.
  assert.ok(colourDistance(hexToColour('#3a5fcd')!, hexToColour('#3a63cd')!) < 5);
});

/* ------------------------------------------------------------------ hue rotation */

test('rotateHue: a hue shift keeps perceived lightness (that is why OKLCh, not HSV)', () => {
  const blue = hexToColour('#0077ff')!;
  const shifted = rotateHue(blue, null, 120, true);
  near(rgbToOklch(shifted).L, rgbToOklch(blue).L, 0.005);
  near(rgbToOklch(shifted).C, rgbToOklch(blue).C, 0.005);
});

test('rotateHue: 0 degrees is a no-op and 360 wraps back to the start', () => {
  for (const hex of ['#c84b1e', '#00ffff', '#7f7f7f', '#ff00ff']) {
    const c = hexToColour(hex)!;
    assert.equal(rgbToHex(rotateHue(c, null, 0, true)), hex);
    assert.equal(rgbToHex(rotateHue(c, null, 360, true)), hex);
    assert.equal(rgbToHex(rotateHue(c, null, -360, true)), hex);
  }
});

test('rotateHue: +120 and +240 on pure red give green and blue', () => {
  const red = C(1, 0, 0);
  assert.equal(colourWord(rotateHue(red, null, 120, true)), 'green');
  assert.equal(colourWord(rotateHue(red, null, 240, true)), 'blue');
});

test('rotateHue: a greyscale colour is left untouched', () => {
  for (const hex of ['#ffffff', '#000000', '#808080', '#3d3d3d']) {
    const c = hexToColour(hex)!;
    assert.equal(rgbToHex(rotateHue(c, null, 90, true)), hex, `${hex} should not gain a cast`);
  }
});

test('rotateHue: near-greyscale keeps its alpha and its value', () => {
  const dim = C(0.4, 0.41, 0.39, 0.25);
  const out = rotateHue(dim, null, 180, true);
  assert.deepEqual(out, dim);
});

test('rotateHue: target colour adopts the target hue and keeps alpha', () => {
  const src = C(0.1, 0.9, 0.2, 0.35);
  const target = hexToColour('#ff0000')!;
  const out = rotateHue(src, target, 0, true);
  near(hueDeltaDeg(out, target), 0, 1);
  assert.equal(out.a, 0.35);
});

test('rotateHue: preserveLuminance keeps each colour own L when a target is given', () => {
  const dark = C(0.05, 0.2, 0.1);
  const bright = C(0.5, 1, 0.6);
  const target = hexToColour('#ff00ff')!;
  const darkOut = rotateHue(dark, target, 0, true);
  const brightOut = rotateHue(bright, target, 0, true);
  // Same hue family...
  near(hueDeltaDeg(darkOut, brightOut), 0, 0.2);
  // ...but the lightness ordering survives.
  assert.ok(rgbToOklch(brightOut).L > rgbToOklch(darkOut).L);
  near(rgbToOklch(darkOut).L, rgbToOklch(dark).L, 0.005);
});

test('rotateHue: without preserveLuminance a target flattens L toward the target', () => {
  const dark = C(0.05, 0.2, 0.1);
  const target = hexToColour('#ff00ff')!;
  const out = rotateHue(dark, target, 0, false);
  near(rgbToOklch(out).L, rgbToOklch(target).L, 0.05);
});

test('hueDeltaDeg: signed, shortest way round', () => {
  near(hueDeltaDeg(hexToColour('#ff0000')!, hexToColour('#00ff00')!), 113.26, 0.05);
  near(hueDeltaDeg(hexToColour('#00ff00')!, hexToColour('#ff0000')!), -113.26, 0.05);
  near(hueDeltaDeg(hexToColour('#ff0000')!, hexToColour('#ff0000')!), 0, 1e-9);
});

/* ------------------------------------------------------------------ recolor: payload shapes */

/** A payload exercising every colour shape the corpus actually contains. */
function payload(): Record<string, unknown> {
  return {
    schema: 'vfx-extracted-recipe/1',
    particleNodes: [
      {
        path: 'Root/Fire',
        main: { startColor: { mode: 'color', color: [0.9, 0.2, 0.05, 1] } },
        colorOverLifetime: {
          enabled: true,
          gradient: {
            mode: 'gradient',
            gradient: {
              blend: 0,
              colorKeys: [
                [0, 1, 0.8, 0.2],
                [1, 0.6, 0.1, 0],
              ],
              alphaKeys: [
                [0, 1],
                [1, 0],
              ],
            },
          },
        },
        otherEnabledModules: {
          TrailModule: { colorOverTrail: { mode: 'color', color: [1, 0.5, 0.1, 1] } },
        },
      },
      {
        path: 'Root/Smoke',
        main: { startColor: { mode: 'randomBetweenColors', min: [0.2, 0.9, 0.3, 0.5], max: [0.1, 0.5, 0.2, 0.25] } },
        colorOverLifetime: { enabled: false },
      },
    ],
    effectNodes: [
      {
        path: 'Beam',
        components: [
          {
            type: 'LineRenderer',
            m_Materials: [{ guid: 'aaaa1111', path: 'Assets/Beam.mat', shader: { guid: 'bbbb2222' } }],
            m_Parameters: {
              colorGradient: { key0: [0.2, 0.4, 1, 1], key1: [0, 0, 0, 0], key2: [0, 0, 0, 0], ctime0: 0 },
            },
          },
        ],
      },
    ],
    hierarchy: [{ localRotation: [0, 0, 0, 1] }],
  };
}

test('recolor: requires exactly one of targetColor / hueShiftDeg', () => {
  assert.throws(() => recolor(payload(), {}), /targetColor or hueShiftDeg is required/);
  assert.throws(() => recolor(payload(), { targetColor: '#ff0000', hueShiftDeg: 30 }), /not both/);
  assert.throws(() => recolor(payload(), { targetColor: 'chartreuse' }), /must be hex/);
  assert.throws(() => recolor(payload(), { hueShiftDeg: 400 }), /within -360..360/);
});

test('recolor: does not mutate the input payload', () => {
  const p = payload();
  const snapshot = JSON.stringify(p);
  recolor(p, { targetColor: '#00ff00' });
  assert.equal(JSON.stringify(p), snapshot, 'input must be untouched — it is a stored record');
});

test('recolor: constant startColor shifts toward the target hue', () => {
  const p = payload();
  const r = recolor(p, { targetColor: '#0000ff' });
  const out = (r.payload.particleNodes as any[])[0].main.startColor.color as number[];
  const shifted = toColour(out)!;
  near(hueDeltaDeg(shifted, hexToColour('#0000ff')!), 0, 1);
  // Alpha is preserved exactly.
  assert.equal(out[3], 1);
});

test('recolor: gradient colorKeys are [time,r,g,b] — the time survives, the colour moves', () => {
  const p = payload();
  const before = (p.particleNodes as any[])[0].colorOverLifetime.gradient.gradient;
  const r = recolor(p, { targetColor: '#00ff00' });
  const after = (r.payload.particleNodes as any[])[0].colorOverLifetime.gradient.gradient;
  assert.equal(after.colorKeys.length, before.colorKeys.length);
  before.colorKeys.forEach((row: number[], i: number) => {
    assert.equal(after.colorKeys[i][0], row[0], 'key time (element 0) must not move');
    assert.equal(after.colorKeys[i].length, 4, 'row stays [time,r,g,b] — no alpha column is invented');
    near(hueDeltaDeg(toGradientKeyColour(after.colorKeys[i])!, hexToColour('#00ff00')!), 0, 0.2);
  });
  assert.deepEqual(after.alphaKeys, before.alphaKeys, 'alphaKeys are not colours — untouched');
});

test('recolor: a gradient key time is never read as a colour channel', () => {
  // [time, r, g, b] with a large time would look like a saturated red if read as [r,g,b,a].
  const p = { particleNodes: [{ colorOverLifetime: { gradient: { gradient: { colorKeys: [[0.95, 0.1, 0.1, 0.1]] } } } }] };
  const r = recolor(p, { hueShiftDeg: 0 });
  assert.deepEqual((r.payload.particleNodes as any[])[0].colorOverLifetime.gradient.gradient.colorKeys[0], [0.95, 0.1, 0.1, 0.1]);
  assert.equal(r.changes.length, 0, 'a neutral grey key is unchanged by a 0-degree shift');
});

test('recolor: randomBetweenColors shifts min and max independently', () => {
  const p = payload();
  const r = recolor(p, { targetColor: '#ff00ff' });
  const sc = (r.payload.particleNodes as any[])[1].main.startColor;
  near(hueDeltaDeg(toColour(sc.min)!, hexToColour('#ff00ff')!), 0, 1);
  near(hueDeltaDeg(toColour(sc.max)!, hexToColour('#ff00ff')!), 0, 1);
  // Alphas and the relative brightness ordering survive.
  assert.equal(sc.min[3], 0.5);
  assert.equal(sc.max[3], 0.25);
  assert.ok(rgbToOklch(toColour(sc.min)!).L > rgbToOklch(toColour(sc.max)!).L);
});

test('recolor: LineRenderer key0..key7 are shifted, transparent keys stay transparent', () => {
  const r = recolor(payload(), { targetColor: '#00ffff' });
  const g = (r.payload.effectNodes as any[])[0].components[0].m_Parameters.colorGradient;
  assert.deepEqual(g.key1, [0, 0, 0, 0], 'a fully transparent key must stay transparent');
  assert.equal(g.ctime0, 0, 'non-colour siblings in the same block are untouched');
  near(hueDeltaDeg(toColour(g.key0)!, hexToColour('#00ffff')!), 0, 1);
});

test('recolor: a hueShiftDeg run reports the shift and rotates each key by it', () => {
  const r = recolor(payload(), { hueShiftDeg: 90 });
  assert.equal(r.mode, 'hueShift');
  assert.equal(r.hueShiftDeg, 90);
  // Every key moves by the requested angle. Two effects set the floor on this tolerance: a key whose
  // rotated colour falls outside sRGB has its chroma reduced (oklchToRgbGamut) rather than its hue
  // bent, and the payload stores 8-bit-quantised sRGB. Both cost well under a degree; an HSV
  // implementation, which is what this replaces, drifts by tens of degrees on the same keys.
  for (const ch of r.changes) near(hueDeltaDeg(hexToColour(ch.from)!, hexToColour(ch.to)!), 90, 0.6);
});

test('recolor: is deterministic — same payload + options give byte-identical output', () => {
  const a = recolor(payload(), { targetColor: '#12ab34' });
  const b = recolor(payload(), { targetColor: '#12ab34' });
  assert.equal(JSON.stringify(a.payload), JSON.stringify(b.payload));
  assert.deepEqual(a.changes, b.changes);
  assert.deepEqual(a.tint, b.tint);
});

test('recolor: hierarchy rotations and non-colour 4-arrays are never touched', () => {
  const p = payload();
  const r = recolor(p, { hueShiftDeg: 45 });
  assert.deepEqual((r.payload.hierarchy as any[])[0].localRotation, [0, 0, 0, 1]);
});

test('recolor: changes list is empty for an all-greyscale payload', () => {
  const grey = {
    particleNodes: [{ main: { startColor: { mode: 'color', color: [0.5, 0.5, 0.5, 1] } } }],
  };
  const r = recolor(grey, { hueShiftDeg: 120 });
  assert.equal(r.changes.length, 0);
  assert.equal(r.summary.keysRecolored, 0);
});

/* ------------------------------------------------------------------ recolor: summary + tint */

test('recolor: summary reports key counts, colour words and skipped paths', () => {
  const r = recolor(payload(), { targetColor: '#ff0000' });
  assert.ok(r.summary.keysTotal >= 6, `counted ${r.summary.keysTotal} keys`);
  assert.ok(r.summary.colourWords.length > 0);
  assert.match(r.summary.dominant, /^#[0-9a-f]{6}$/);
  // Paths named in recolor.json that this payload does not have must be reported, not silently dropped.
  assert.ok(r.summary.skipped.includes('particleNodes[].otherEnabledModules.ColorBySpeedModule.color.color'));
  assert.ok(!r.summary.skipped.includes('particleNodes[].main.startColor.color'));
});

test('recolor: tint names the material guid, a property, and a from/to pair', () => {
  const r = recolor(payload(), { targetColor: '#0000ff' });
  assert.equal(r.tint.length, 1);
  const t = r.tint[0];
  assert.equal(t.materialGuid, 'aaaa1111');
  assert.equal(t.materialPath, 'Assets/Beam.mat');
  assert.equal(t.property, '_Color');
  assert.match(t.from, /^#[0-9a-f]{6}$/);
  assert.match(t.to, /^#[0-9a-f]{6}$/);
  assert.notEqual(t.from, t.to);
});

test('recolor: tint deduplicates a material referenced by several nodes', () => {
  const p = payload();
  (p.effectNodes as any[])[0].components.push({ type: 'MeshRenderer', m_Materials: [{ guid: 'aaaa1111' }] });
  const r = recolor(p, { targetColor: '#0000ff' });
  assert.equal(r.tint.length, 1);
});

test('material colour property list is data-driven and ordered by weight', () => {
  assert.ok(MATERIAL_COLOUR_PROPERTIES.includes('_Color'));
  assert.ok(MATERIAL_COLOUR_PROPERTIES.includes('_TintColor'));
  assert.ok(MATERIAL_COLOUR_PROPERTIES.includes('_BaseColor'));
  assert.ok(MATERIAL_COLOUR_PROPERTIES.includes('_EmissionColor'));
  assert.equal(MATERIAL_COLOUR_PROPERTIES[0], '_Color', 'highest weight first');
});

test('materialsOf: reads guid, path, shader and texture slots', () => {
  const p = payload();
  (p.effectNodes as any[])[0].components[0].m_Materials[0].textures = [{ slot: '_MainTex', guid: 'cccc3333' }];
  const m = materialsOf(p);
  assert.equal(m.length, 1);
  assert.equal(m[0].guid, 'aaaa1111');
  assert.equal(m[0].shader, 'bbbb2222');
  assert.deepEqual(m[0].textures, [{ slot: '_MainTex', guid: 'cccc3333' }]);
});

test('colourWord: buckets the corpus colour names', () => {
  assert.equal(colourWord(C(1, 0, 0)), 'red');
  assert.equal(colourWord(C(0, 1, 0)), 'green');
  assert.equal(colourWord(C(0, 0, 1)), 'blue');
  assert.equal(colourWord(C(1, 1, 1)), 'white');
  assert.equal(colourWord(C(0, 0, 0)), 'black');
  assert.equal(colourWord(C(0.5, 0.5, 0.5)), 'grey');
  assert.equal(colourWord(C(0.01, 0.01, 0.01)), 'black');
  assert.equal(colourWord(C(1, 1, 0)), 'yellow');
  assert.equal(colourWord(C(1, 0.5, 0)), 'orange');
});
