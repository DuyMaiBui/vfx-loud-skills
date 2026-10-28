import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge, type Item, type Row } from './merge-targets.ts';

const rows = (): Row[] => [
  { slug: 'hit-spark', prefabGuid: null, prefabPath: null },
  { slug: 'melee-slash', prefabGuid: null },
  { slug: 'extracted-one', prefabGuid: 'abc123', prefabPath: 'Assets/X.prefab' },
];
const items: Record<string, Item> = {
  'hit-spark': { status: 'built', prefabPath: 'Assets/RecipePrefabs/hit-spark.prefab', prefabGuid: 'g1', layersInRecipe: 2, systemsBuilt: 2 },
  'melee-slash': { status: 'skipped', reason: 'nested-missing:vfx://vfx/x/1' },
  'extracted-one': { status: 'built', prefabPath: 'Assets/Other.prefab', prefabGuid: 'zzz', layersInRecipe: 1, systemsBuilt: 1 },
};

test('a built slug fills prefabPath/prefabGuid; a skipped one keeps a null guid and gets its reason', () => {
  const r = merge(rows(), items);
  assert.deepEqual(r.merged, ['hit-spark']);
  assert.equal(r.rows[0].prefabGuid, 'g1');
  assert.equal(r.rows[0].prefabPath, 'Assets/RecipePrefabs/hit-spark.prefab');
  assert.equal(r.rows[1].prefabGuid, null);
  assert.match(String(r.rows[1].builderReason), /nested-missing/);
});

test('a non-null row is never changed', () => {
  const r = merge(rows(), items);
  assert.deepEqual(r.rows[2], rows()[2]);
});

test('idempotent: merging the merged result changes nothing', () => {
  const once = merge(rows(), items).rows;
  assert.deepEqual(merge(once, items).rows, once);
});

test('a built slug whose systems != layers is a problem and the row is left alone', () => {
  const bad = { ...items, 'hit-spark': { ...items['hit-spark'], systemsBuilt: 1 } };
  const r = merge(rows(), bad);
  assert.equal(r.problems.length, 1);
  assert.equal(r.rows[0].prefabGuid, null);
});
