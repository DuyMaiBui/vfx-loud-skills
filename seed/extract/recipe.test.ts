import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecipe, SkipError } from './recipe.ts';
import { materialYaml, prefabYaml } from './test-helpers.ts';

const PACK = { name: 'Test Pack', vendor: 'Test Vendor' };
const MAT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHADER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TEX = 'cccccccccccccccccccccccccccccccc';
const PATHS: Record<string, string> = {
  [MAT]: 'Assets/Test/Mat/Fire.mat',
  [SHADER]: 'Assets/Test/Shaders/Fire.shader',
  [TEX]: 'Assets/Test/Tex/Fire.png',
};
const ctx = {
  pathOf: (g: string) => PATHS[g],
  materialText: (g: string) => (g === MAT ? materialYaml(SHADER, TEX) : undefined),
};
const prefab = { path: 'Assets/Test/Prefabs/Boom.prefab', guid: 'dddddddddddddddddddddddddddddddd' };

function skipCode(text: string): string {
  try {
    buildRecipe(text, PACK, prefab, ctx);
  } catch (e) {
    if (e instanceof SkipError) return e.code;
    throw e;
  }
  return 'no-skip';
}

test('extracts every particle node with modules, renderer and sub-emitter wiring', () => {
  const r = buildRecipe(prefabYaml(), PACK, prefab, ctx);
  assert.equal(r.particleNodeCount, 2);
  assert.equal(r.nodeCount, 2);
  assert.deepEqual(r.summary, { durationMax: 2.5, loops: false, renderModes: [0] });
  const y = r.yaml;
  assert.match(y, /^schema: vfx-extracted-recipe\/1$/m);
  assert.match(y, /pack: Test Pack/);
  assert.match(y, /vendor: Test Vendor/);
  assert.match(y, /prefabGuid: "?d{32}"?/);
  assert.match(y, /path: Boom$/m);
  assert.match(y, /path: Boom\/Sparks$/m);
  assert.match(y, /startSpeed: \{mode: randomBetweenConstants, min: 4, max: 8\}/);
  assert.match(y, /startLifetime: \{mode: constant, value: 1.5\}/);
  assert.match(y, /m_Bursts: \[\{time: 0, countCurve: \{mode: constant, value: 12\}/);
  assert.match(y, /colorKeys: \[\[0, 1, 0, 0\], \[1, 0, 0, 1\]\]/); // gradient red -> blue
  assert.match(y, /textureSheetAnimation: \{enabled: true, mode: 0, tilesX: 4, tilesY: 4, sprites: \[\]\}/);
  assert.match(y, /sizeOverLifetime: \{enabled: false\}/);
  assert.match(y, /subEmitters: \{enabled: true, emitters: \[\{emitter: Boom\/Sparks, type: 1, properties: 0, emitProbability: 1\}\]\}/);
  assert.match(y, /m_RenderMode: 0/);
  assert.match(y, /m_SortMode: 1/);
  assert.match(y, /m_SortingOrder: 3/);
  assert.match(y, /localPosition: \[0, 0, 2\]/); // child transform captured
});

test('materials / textures / shaders are guid + source-path references only', () => {
  const y = buildRecipe(prefabYaml(), PACK, prefab, ctx).yaml;
  assert.match(y, new RegExp(`guid: "?${MAT}"?`));
  assert.match(y, /path: Assets\/Test\/Mat\/Fire\.mat/);
  assert.match(y, /shader:[\s\S]*Assets\/Test\/Shaders\/Fire\.shader/);
  assert.match(y, /slot: _MainTex[\s\S]*Assets\/Test\/Tex\/Fire\.png/);
  assert.doesNotMatch(y, /_Empty/); // null texture slot is not a reference
  assert.doesNotMatch(y, /PNG|m_SavedProperties|serializedVersion/); // no raw material body leaks in
});

test('an unresolvable guid is marked external, not invented', () => {
  const y = buildRecipe(prefabYaml({ materialGuid: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }), PACK, prefab, ctx).yaml;
  assert.match(y, /guid: "?e{32}"?, external: true/);
});

test('output is deterministic', () => {
  const a = buildRecipe(prefabYaml(), PACK, prefab, ctx).yaml;
  const b = buildRecipe(prefabYaml(), PACK, prefab, ctx).yaml;
  assert.equal(a, b);
});

test('skips (never a partial) for binary, unparseable, no-particle and nested-instance prefabs', () => {
  assert.equal(skipCode('\u0000\u0001BINARYSERIALIZED'), 'binary-serialization');
  assert.equal(skipCode('%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_A: |\n    x\n'), 'yaml-parse-error');
  assert.equal(skipCode(prefabYaml({ psCount: 'none' })), 'no-effect-component');
  assert.equal(skipCode(prefabYaml({ instance: true })), 'nested-prefab-instance');
});

test('a sub-emitter pointing outside the prefab is a skip, not a silently dropped edge', () => {
  const broken = prefabYaml().replace('emitter: {fileID: 310}', 'emitter: {fileID: 424242}');
  assert.equal(skipCode(broken), 'dangling-subemitter');
});

test('effect-only prefab (no ParticleSystem) yields an effect record with references, not a skip', () => {
  const r = buildRecipe(prefabYaml({ psCount: 'none', effect: true }), PACK, prefab, ctx);
  assert.equal(r.kind, 'effect');
  assert.deepEqual(r.effectKinds, ['line', 'script']);
  assert.equal(r.particleNodeCount, 0);
  assert.equal(r.effectNodeCount, 1);
  const y = r.yaml;
  assert.match(y, /^schema: vfx-extracted-effect\/1$/m);
  assert.match(y, /type: LineRenderer/);
  assert.match(y, /widthMultiplier: 0\.5/);
  assert.match(y, /m_Positions: \[\[0, 0, 0\], \[0, 0, 5\]\]/);
  assert.match(y, /type: MonoBehaviour/);
  assert.match(y, /beamLength: 30/);
  assert.match(y, /beamEndPrefab: \{guid: "?a{32}"?, path: Assets\/Test\/Mat\/Fire\.mat\}/); // field ref -> guid + path
  assert.match(y, /Assets\/Test\/Tex\/Fire\.png/); // material texture reference
  assert.doesNotMatch(y, /type: ParticleSystem|particleNodes/);
});
