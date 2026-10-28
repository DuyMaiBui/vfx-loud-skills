import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiTrainingAllowed, extractedLicenseProblem, licenseClassOf } from './license.ts';
import { derivedLicenseProblem } from './derived.ts';
import { publish } from './store.ts';

test('both store EULAs map to proprietary-commercial with ai_training=false', () => {
  for (const l of ['synty-store-eula', 'asset-store-eula']) {
    assert.equal(licenseClassOf(l), 'proprietary-commercial', l);
    assert.equal(aiTrainingAllowed(l), false, l);
    assert.equal(extractedLicenseProblem(l), null, l);
  }
});

test('existing taxonomy is unchanged', () => {
  assert.equal(licenseClassOf('cc0'), 'cc0');
  assert.equal(licenseClassOf('CC-BY-SA'), 'cc-attribution');
  assert.equal(licenseClassOf('restricted'), 'restricted');
  assert.equal(licenseClassOf('nonsense'), 'unknown');
  assert.equal(aiTrainingAllowed('cc0'), true);
});

test('extracted records never resolve to cc0 / unknown / missing', () => {
  for (const l of ['cc0', 'unknown', '', '  ', 'cc-by', 'restricted', 'mit', 'ai-training-allowed', undefined, null]) {
    assert.notEqual(extractedLicenseProblem(l as string), null, String(l));
  }
});

test('publish() refuses an extracted record with a non-store license before touching the DB', async () => {
  const base = { type: 'recipe' as const, slug: 'x-y', name: 'n', b64: Buffer.from('x').toString('base64') };
  await assert.rejects(publish({ ...base, license: 'cc0', meta: { extracted: true } }), /extracted record refused/);
  await assert.rejects(publish({ ...base, license: 'unknown', meta: { extracted: true } }), /unknown/);
  await assert.rejects(
    publish({ ...base, license: 'asset-store-eula', meta: { extracted: true, license_class: 'cc0' } }),
    /proprietary-commercial/,
  );
  await assert.rejects(
    publish({ ...base, license: 'asset-store-eula', meta: { extracted: true, ai_training: true } }),
    /ai_training/,
  );
});

test('studio-internal: own in-house assets, own class, no ai_training, extractable', () => {
  assert.equal(licenseClassOf('studio-internal'), 'studio-internal');
  assert.equal(aiTrainingAllowed('studio-internal'), false);
  assert.equal(extractedLicenseProblem('studio-internal'), null);
});

test('studio-internal records refuse a licence class outside the extracted set', async () => {
  const base = { type: 'recipe' as const, slug: 'x-y', name: 'n', b64: Buffer.from('x').toString('base64') };
  await assert.rejects(
    publish({ ...base, license: 'studio-internal', meta: { extracted: true, license_class: 'cc0' } }),
    /proprietary-commercial \| studio-internal/,
  );
});

test('a derived record cannot relabel a studio-internal source as a store EULA', () => {
  const src = [{ uri: 'vfx://recipe/studio-game-vfx-fire/1', license: 'studio-internal' }];
  assert.equal(derivedLicenseProblem('studio-internal', src), null);
  assert.notEqual(derivedLicenseProblem('synty-store-eula', src), null);
  assert.notEqual(derivedLicenseProblem('cc0', src), null);
});
