import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colourName, enrichExtracted, payloadFacts } from './enrich.ts';
import { buildRecipe } from './recipe.ts';
import { materialYaml, prefabYaml } from './test-helpers.ts';

const ctx = { pathOf: () => undefined, materialText: () => materialYaml('b'.repeat(32), 'c'.repeat(32)) };
const yaml = buildRecipe(prefabYaml(), { name: 'P', vendor: 'V' }, { path: 'Assets/T/Prefabs/Boom.prefab', guid: 'd'.repeat(32) }, ctx).yaml;

test('colourName buckets hue / saturation / value', () => {
  assert.equal(colourName(1, 0, 0), 'red');
  assert.equal(colourName(0, 0, 1), 'blue');
  assert.equal(colourName(0, 1, 0), 'green');
  assert.equal(colourName(1, 0.5, 0), 'orange');
  assert.equal(colourName(0.05, 0.05, 0.05), 'black');
  assert.equal(colourName(0.95, 0.95, 0.95), 'white');
});

test('payloadFacts reads the emitted YAML back (quoted keys included)', () => {
  const f = payloadFacts(yaml);
  assert.equal(f.nodes, 2);
  assert.equal(f.looping, false);
  assert.equal(f.durationMax, 2.5);
  assert.deepEqual(f.colours, ['orange']); // start colour (1, 0.5, 0.25)
  assert.equal(f.hasSubEmitters, true);
});

test('enrichExtracted is deterministic and puts plain words in the description', () => {
  const input = {
    name: 'Water_Explosion (Test Pack)',
    prefabPath: 'Assets/T/Prefabs/Water/Water_Explosion.prefab',
    packName: 'Test Pack',
    vendor: 'Vendor',
    metaStyle: ['toon', 'stylized'],
    kind: 'particle' as const,
    yaml,
    existingTags: ['water', 'test'],
  };
  const a = enrichExtracted(input);
  assert.deepEqual(a, enrichExtracted(input));
  assert.ok(a.keywords.includes('water') && a.keywords.includes('explosion') && a.keywords.includes('one-shot'));
  assert.ok(a.keywords.includes('orange') && a.keywords.includes('sub-emitter'));
  assert.deepEqual(a.style, ['toon', 'stylized']);
  assert.ok(a.tags.includes('water') && a.tags.includes('toon'));
  assert.match(a.description, /^orange water explosion VFX "Water_Explosion"/);
  assert.doesNotMatch(a.description, /particle recipe/i);
});
