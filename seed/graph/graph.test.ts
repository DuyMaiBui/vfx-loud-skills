import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFamilies, folderKey } from './family.ts';
import { pickTargets, matches, type LinkableRecipe } from './knowledge.ts';
import { buildPairSets, pairKeyOf } from './pairs.ts';
import { loadRules } from './rules.ts';
import { topSimilar } from './similar.ts';

const rules = loadRules();
const item = (slug: string, name: string, path: string, sig = 'a') => ({ uri: `vfx://recipe/${slug}/1`, slug, name: `${name} (Pack)`, pack: 'p', prefabPath: path, nodeCount: 2, signature: sig });

test('family: colour and version words drop out; structure must match', () => {
  const dir = 'Assets/P/Prefabs/Combat/Muzzle/';
  const { families } = buildFamilies(
    [item('a-blue', 'FireMuzzleBlue', `${dir}FireMuzzleBlue.prefab`), item('a-red', 'FireMuzzleRed', `${dir}FireMuzzleRed.prefab`), item('a-odd', 'FireMuzzleGreen', `${dir}x.prefab`, 'different')],
    rules.family,
  );
  assert.equal(families.length, 1);
  assert.deepEqual(families[0].members, ['vfx://recipe/a-blue/1', 'vfx://recipe/a-red/1']);
  assert.equal(families[0].canonical, 'vfx://recipe/a-blue/1');
  assert.equal(folderKey('Assets/P/Prefabs/Impact v3/X.prefab', rules.family), 'impact');
});

test('pairs: role word stripped, same stem + colour links muzzle/projectile/impact', () => {
  assert.deepEqual(pairKeyOf('BlueShockwaveMissile (Sci)', rules.pairs), { role: 'projectile', stem: 'shockwave', variant: 'blue' });
  const mk = (slug: string, name: string) => ({ uri: slug, slug, name, pack: 'retro-arsenal' });
  const { sets } = buildPairSets([mk('m', 'RocketMuzzleRed'), mk('p', 'RocketMissileRed'), mk('i', 'RocketExplosionRed'), mk('x', 'RocketMissileBlue')], rules.pairs);
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0].members.map((m) => m.role).sort(), ['impact', 'muzzle', 'projectile']);
});

test('similar: capped top-K, skips very common assets and same family', () => {
  const sets = new Map([[1, new Set(['a', 'b'])], [2, new Set(['a', 'b'])], [3, new Set(['a', 'c'])], [4, new Set(['a', 'b'])]]);
  const e = topSimilar(sets, (id) => String(id), (x, y) => x + y === 3 /* 1,2 same family */, { maxAssetFanout: 10, minJaccard: 0.3, topK: 1 });
  assert.ok(e.every((x) => x.src !== x.dst) && e.filter((x) => x.src === 1).length === 1);
  assert.equal(e.find((x) => x.src === 1)?.dst, 4);
  assert.equal(topSimilar(sets, (id) => String(id), () => false, { maxAssetFanout: 2, minJaccard: 0, topK: 5 }).length, 0);
});

test('knowledge: facet OR/AND matching and per-pack round robin cap', () => {
  const r = (slug: string, pack: string, cat: string): LinkableRecipe => ({ uri: slug, slug, pack, handWritten: false, family: null, canonical: false, facets: { category: [cat] }, keywords: [] });
  assert.equal(matches(r('a', 'x', 'impact'), { category: ['impact', 'smoke'] }), true);
  assert.equal(matches(r('a', 'x', 'beam'), { category: ['impact'] }), false);
  const all = [r('a1', 'x', 'impact'), r('a2', 'x', 'impact'), r('b1', 'y', 'impact')];
  assert.deepEqual(pickTargets(all, { ref: 't/x', match: { category: ['impact'] } }, 2), ['a1', 'b1']);
});
