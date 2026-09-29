import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateFamily, recolorFlag, type FamilyMember } from './recolorable.ts';
import { recolor } from '../../server/src/recolor.ts';
import type { AssetRef } from './payload.ts';

const asset = (kind: AssetRef['kind'], guid: string): AssetRef => ({ kind, guid, path: null, external: false });
const start = (c: number[]) => ({ main: { startColor: { mode: 'color', color: [...c, 1] } } });
const gradient = (c: number[]) => ({ colorOverLifetime: { gradient: { gradient: { colorKeys: [[0, ...c]] } } } });
const member = (uri: string, node: Record<string, unknown> | null, assets: AssetRef[] = []): FamilyMember => ({
  uri,
  parsed: node ? { particleNodes: [node] } : { particleNodes: [{}] },
  facts: { assets },
});
const BLUE = [0.1, 0.3, 1];
/** A real colour variant of the base: what a recolour of it toward `hex` produces (so it is reachable by construction). */
const variantOf = (base: Record<string, unknown>, hex: string): Record<string, unknown> => (recolor({ particleNodes: [base] }, { targetColor: hex }).payload.particleNodes as Record<string, unknown>[])[0];
const RED_COLOURS = variantOf(start(BLUE), '#ff2020');

test('recolorable: a family whose every variant is a recolour of the base is good -> true/ok', () => {
  const { family } = evaluateFamily('f', member('base', start(BLUE)), [member('v1', variantOf(start(BLUE), '#ff2020')), member('v2', variantOf(start(BLUE), '#20ff40'))]);
  assert.equal(family.verdict, 'good');
  assert.deepEqual(recolorFlag(family), { recolorable: true, recolorReason: 'ok' });
});

test('recolorable: variant with a colour key the base cannot produce is partial/params -> false', () => {
  const both = { ...RED_COLOURS, ...gradient([1, 0.2, 0.1]) };
  const { family } = evaluateFamily('f', member('base', start(BLUE), [asset('texture', 't1')]), [member('v', both, [asset('texture', 't1')])]);
  assert.equal(family.verdict, 'partial');
  assert.deepEqual(recolorFlag(family), { recolorable: false, recolorReason: 'params' });
});

test('recolorable: different texture on a non-good variant -> reason texture', () => {
  const both = { ...RED_COLOURS, ...gradient([1, 0.2, 0.1]) };
  const { family } = evaluateFamily('f', member('base', start(BLUE), [asset('texture', 't1')]), [member('v', both, [asset('texture', 't2')])]);
  assert.equal(family.verdict, 'partial');
  assert.equal(recolorFlag(family).recolorReason, 'texture');
});

test('recolorable: nothing measurable is unmeasured, never good — no-keys and no-base-keys', () => {
  const noKeys = evaluateFamily('f', member('base', start(BLUE)), [member('v', {})]).family;
  assert.equal(noKeys.verdict, 'unmeasured');
  assert.deepEqual(recolorFlag(noKeys), { recolorable: false, recolorReason: 'no-keys' });
  const noBase = evaluateFamily('f', member('base', {}), [member('v', RED_COLOURS)]).family;
  assert.equal(noBase.verdict, 'unmeasured');
  assert.deepEqual(recolorFlag(noBase), { recolorable: false, recolorReason: 'no-base-keys' });
});

test('recolorable: ONE bad variant makes the whole family not recolourable', () => {
  const both = { ...RED_COLOURS, ...gradient([1, 0.2, 0.1]) };
  const { family } = evaluateFamily('f', member('base', start(BLUE)), [member('ok', RED_COLOURS), member('bad', both)]);
  assert.equal(family.good, 1);
  assert.equal(recolorFlag(family).recolorable, false);
});
