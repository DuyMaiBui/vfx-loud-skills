import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactFacets, deriveTextFacets, FACET_NAMES, getFacetRules } from './facets.ts';

test('category is ordered by first appearance in the name and capped', () => {
  assert.deepEqual(deriveTextFacets(['missile', 'explosion', 'fire', 'magic'], []).category, ['projectile', 'explosion', 'fire']);
});

test('digit-glued names are split; sub-category needs its category', () => {
  const f = deriveTextFacets(['punch2blue'], []);
  assert.deepEqual(f.category, ['impact']);
  assert.deepEqual(f.subcategory, ['impact/punch']);
});

test('folder tokens are only a fallback when the name matches no category', () => {
  assert.deepEqual(deriveTextFacets(['blob'], ['fire']).category, ['fire']);
  assert.deepEqual(deriveTextFacets(['explosion'], ['fire']).category, ['explosion']);
});

test('element uses the contract set: magic -> arcane, non-elements dropped', () => {
  const rules = getFacetRules();
  const f = deriveTextFacets(['magic', 'rain', 'lava'], []);
  assert.ok(f.element?.includes('arcane') && f.element.includes('fire'));
  for (const e of f.element ?? []) assert.ok(rules.elements.includes(e));
});

test('compactFacets omits empty arrays and undefined (missing = key omitted)', () => {
  assert.deepEqual(compactFacets({ category: [], element: ['fire'], playback: undefined, cost: 'low' }), { element: ['fire'], cost: 'low' });
});

test('facet names: the meta.facets keys plus style', () => {
  assert.deepEqual([...FACET_NAMES].sort(), ['category', 'colors', 'cost', 'duration', 'element', 'motion', 'playback', 'renderMode', 'scale', 'shape', 'style', 'subcategory']);
});
