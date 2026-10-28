import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecipe, SkipError } from './recipe.ts';
import { buildNestedReport, isNestedOutcome } from './nested.ts';
import { prefabYaml } from './test-helpers.ts';

const PACK = { name: 'Test Pack', vendor: 'Test Vendor' };
const BASE_GUID = '224c4574d4d272a4b92df19ede61b338';
// The base is the fixture's single-node VFX prefab: GameObject &100, Transform &400, ParticleSystem &300.
const BASE = prefabYaml({ name: 'Water_Splash', withChild: false });
const prefab = { path: 'Assets/Test/Prefabs/PS_Splash.prefab', guid: 'dddddddddddddddddddddddddddddddd' };

const HEAD = '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n';

interface Mod {
  fileId: number;
  path: string;
  value: string;
  objectReference?: string;
}

/** A pure variant file shaped like SmashFest's PS_Surface_Splash.prefab: one root PrefabInstance and nothing else. */
function variant(mods: Mod[], extra = ''): string {
  const items = mods
    .map(
      (m) => `    - target: {fileID: ${m.fileId}, guid: ${BASE_GUID},
        type: 3}
      propertyPath: ${m.path}
      value: ${m.value}
      objectReference: ${m.objectReference ?? '{fileID: 0}'}`,
    )
    .join('\n');
  return `${HEAD}--- !u!1001 &9059586847937716274
PrefabInstance:
  m_ObjectHideFlags: 0
  serializedVersion: 2
  m_Modification:
    serializedVersion: 3
    m_TransformParent: {fileID: 0}
    m_Modifications:
${items}
    m_RemovedComponents: []
    m_RemovedGameObjects: []
    m_AddedGameObjects: []
    m_AddedComponents: []
${extra}  m_SourcePrefab: {fileID: 100100000, guid: ${BASE_GUID}, type: 3}
`;
}

const ctx = {
  pathOf: () => undefined,
  materialText: () => undefined,
  prefabText: (g: string) => (g === BASE_GUID ? BASE : undefined),
};

function skipCode(text: string, c = ctx): string {
  try {
    buildRecipe(text, PACK, prefab, c);
  } catch (e) {
    if (e instanceof SkipError) return e.code;
    throw e;
  }
  return 'no-skip';
}

test('a variant is flattened: ParticleSystem scalar, Transform and name overrides win over the base', () => {
  const base = buildRecipe(BASE, PACK, prefab, ctx);
  const r = buildRecipe(
    variant([
      { fileId: 300, path: 'InitialModule.startSpeed.scalar', value: '20' },
      { fileId: 300, path: 'InitialModule.startSpeed.minScalar', value: '12' },
      { fileId: 300, path: 'ShapeModule.radius.value', value: '3' },
      { fileId: 400, path: 'm_LocalPosition.y', value: '5' },
      { fileId: 400, path: 'm_LocalEulerAnglesHint.x', value: '0' }, // editor bookkeeping, accepted
      { fileId: 100, path: 'm_Name', value: 'PS_Splash' },
    ]),
    PACK,
    prefab,
    ctx,
  );
  assert.deepEqual(r.nested, { baseGuid: BASE_GUID, overrides: 6 });
  assert.equal(r.prefabName, 'PS_Splash');
  // the override value, not the base's (8 / 4): a dropped override would leave the base numbers
  assert.match(r.yaml, /startSpeed: \{mode: randomBetweenConstants, min: 12, max: 20\}/);
  assert.match(base.yaml, /startSpeed: \{mode: randomBetweenConstants, min: 4, max: 8\}/);
  assert.match(r.yaml, /radius: \{value: 3,/);
  assert.match(r.yaml, /localPosition: \[0, 5, 0\]/);
  assert.equal(r.particleNodeCount, base.particleNodeCount);
  assert.equal(base.nested, undefined);
  // the base text handed in is never mutated: flattening twice gives the same result
  assert.equal(buildRecipe(BASE, PACK, prefab, ctx).yaml, base.yaml);
});

test('an unsupported override skips with the exact path, never a partial flatten', () => {
  const cases: Array<[Mod, string]> = [
    // objectReference override (material swap): the reference cannot be represented
    [{ fileId: 350, path: 'm_Materials.Array.data[0]', value: '', objectReference: '{fileID: 2100000, guid: ffffffffffffffffffffffffffffffff, type: 2}' }, 'm_Materials.Array.data[0]'],
    // array resize (the real Fx_Star_LoopStarOnly variant)
    [{ fileId: 300, path: 'EmissionModule.m_Bursts.Array.size', value: '0' }, 'EmissionModule.m_Bursts.Array.size'],
    // a path the base ParticleSystem does not have
    [{ fileId: 300, path: 'InitialModule.startSize.scalar', value: '2' }, 'InitialModule.startSize.scalar'],
    // a renderer field
    [{ fileId: 350, path: 'm_SortingLayer', value: '0' }, 'm_SortingLayer'],
    // a target that is not in the base
    [{ fileId: 777, path: 'm_Name', value: 'x' }, 'm_Name'],
  ];
  for (const [mod, path] of cases) {
    // a supported override first: it must not leak out as a half-flattened recipe
    const text = variant([{ fileId: 300, path: 'InitialModule.startSpeed.scalar', value: '20' }, mod]);
    assert.equal(skipCode(text), `nested-override-unsupported:${path}`, path);
  }
  const added = variant([{ fileId: 300, path: 'InitialModule.startSpeed.scalar', value: '20' }]).replace(
    'm_AddedComponents: []',
    'm_AddedComponents:\n    - targetCorrespondingSourceObject: {fileID: 400, guid: ' + BASE_GUID + ', type: 3}',
  );
  assert.equal(skipCode(added), 'nested-override-unsupported:m_AddedComponents');
});

test('gameplay prefabs around nested instances, variants of them and missing bases get their own reasons', () => {
  assert.equal(skipCode(prefabYaml({ instance: true })), 'gameplay-prefab');
  // a variant whose base is itself a prefab with its own GameObjects and a nested instance
  const gameplayBase = { ...ctx, prefabText: () => prefabYaml({ instance: true }) };
  assert.equal(skipCode(variant([{ fileId: 300, path: 'InitialModule.startSpeed.scalar', value: '20' }]), gameplayBase), 'gameplay-prefab');
  // a variant of a pure variant is not resolved
  const chain = { ...ctx, prefabText: () => variant([{ fileId: 300, path: 'InitialModule.startSpeed.scalar', value: '1' }]) };
  assert.equal(skipCode(variant([{ fileId: 300, path: 'InitialModule.startSpeed.scalar', value: '20' }]), chain), 'nested-override-unsupported:variant-of-variant');
  const noBase = { ...ctx, prefabText: () => undefined };
  assert.equal(skipCode(variant([]), noBase), 'nested-base-missing');
});

test('the nested report counts per class and says when no variant was flattenable', () => {
  const none = buildNestedReport([
    { prefabPath: 'b', prefabGuid: '2', outcome: 'gameplay-prefab' },
    { prefabPath: 'a', prefabGuid: '1', outcome: 'nested-override-unsupported:m_Materials.Array.data[0]' },
    { prefabPath: 'c', prefabGuid: '3', outcome: 'nested-override-unsupported:m_SortingLayer' },
  ]);
  assert.deepEqual(none.counts, { 'gameplay-prefab': 1, 'nested-override-unsupported': 2 });
  assert.equal(none.classAEmpty, true);
  assert.deepEqual(none.prefabs.map((p) => p.prefabPath), ['a', 'b', 'c']);
  const some = buildNestedReport([{ prefabPath: 'a', prefabGuid: '1', outcome: 'flattened', baseGuid: BASE_GUID, overrides: 3 }]);
  assert.equal(some.classAEmpty, false);
  assert.ok(isNestedOutcome('gameplay-prefab') && isNestedOutcome('nested-override-unsupported:x'));
  assert.ok(!isNestedOutcome('yaml-parse-error'));
});
