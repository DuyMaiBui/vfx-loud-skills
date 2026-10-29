import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConsistency } from './previews-consistency.ts';

const R = (slug: string, state: string) => ({ slug, state });

test('consistent: gif exists exactly for ok slugs', () => {
  const c = checkConsistency([R('a', 'ok'), R('b', 'failed'), R('c', 'skipped')], ['a']);
  assert.deepEqual(c, { okWithoutGif: [], nonOkWithGif: [], gifWithoutRender: [] });
});

test('an ok slug with no gif is a violation', () => {
  assert.deepEqual(checkConsistency([R('a', 'ok')], []).okWithoutGif, ['a']);
});

test('a failed or skipped slug that still holds a gif is a violation (stale gif)', () => {
  assert.deepEqual(checkConsistency([R('b', 'failed'), R('c', 'skipped')], ['b', 'c']).nonOkWithGif, ['b', 'c']);
});

test('a gif with no render row is a violation', () => {
  assert.deepEqual(checkConsistency([R('a', 'ok')], ['a', 'z']).gifWithoutRender, ['z']);
});
