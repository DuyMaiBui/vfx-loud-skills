import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conceptsForTokens, expandQuery, singular, splitName } from './vocab.ts';
import { searchDocument, coreName } from './search-doc.ts';

test('splitName handles underscores, camelCase, digits and acronyms', () => {
  assert.deepEqual(splitName('Bubbles_Burst'), ['bubbles', 'burst']);
  assert.deepEqual(splitName('ExplosionFireballPink'), ['explosion', 'fireball', 'pink']);
  assert.deepEqual(splitName('FX_Rain_01'), ['fx', 'rain']);
});

test('plural tokens match their concept ("Bubbles" is water, "flames" is fire)', () => {
  assert.equal(singular('bubbles'), 'bubble');
  assert.equal(singular('glass'), 'glass');
  assert.ok(conceptsForTokens(['bubbles']).element.includes('water'));
  assert.ok(conceptsForTokens(['flames']).element.includes('fire'));
});

test('Vietnamese and English synonyms expand to the same vocabulary (data-driven)', () => {
  const nl = expandQuery('nổ lửa');
  assert.ok(nl.expansion.includes('explosion') && nl.expansion.includes('fire'));
  const heal = expandQuery('hồi máu');
  assert.ok(heal.expansion.includes('heal'));
  assert.ok(!heal.expansion.includes('blood'), 'longest alias wins: "hồi máu" must not also mean blood');
  assert.ok(expandQuery('blast').expansion.includes('explosion'));
  assert.deepEqual(expandQuery('low poly').styles, ['low-poly']);
  assert.deepEqual(expandQuery('cartoon').styles.includes('toon'), true);
});

test('searchDocument is one shared definition: split name, keywords, synonyms, Vietnamese aliases', () => {
  const d = searchDocument({
    name: 'Bubbles_Burst (Stylized Water Effects)',
    description: 'blue water effect',
    category: 'recipe',
    tags: ['namufx'],
    keywords: ['water', 'blue'],
  });
  assert.equal(coreName('Bubbles_Burst (Stylized Water Effects)'), 'Bubbles_Burst');
  assert.match(d.searchText, /\bbubbles\b/);
  assert.match(d.searchText, /\bliquid\b/); // English synonym of water
  assert.match(d.searchText, /nước/); // Vietnamese alias
  assert.match(d.searchText, /\bnuoc\b/); // accent-folded alias
  assert.match(d.embedText, /bubbles burst/);
  assert.equal(searchDocument({ name: 'xy', description: '', category: '', tags: [], keywords: [] }).searchText, 'xy');
});
