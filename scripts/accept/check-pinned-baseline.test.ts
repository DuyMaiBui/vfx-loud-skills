import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, parseJunit, type Outcome, type Pin } from './check-pinned-baseline.ts';

const pin: Pin = { red: ['a.test.ts :: r1', 'a.test.ts :: r2'], skipped: ['b.test.ts :: s1'] };
const mk = (red: string[], skipped: string[], green: string[]): Outcome => ({ red: new Set(red), skipped: new Set(skipped), green: new Set(green) });

test('exact match of the pin is clean', () => {
  assert.deepEqual(compare(mk(['a.test.ts :: r1', 'a.test.ts :: r2'], ['b.test.ts :: s1'], ['c :: ok']), pin), []);
});

test('an extra red outside the pin fails by name, even when the count equals the pin', () => {
  const f = compare(mk(['a.test.ts :: r1', 'c.test.ts :: new-regression'], ['b.test.ts :: s1'], ['a.test.ts :: r2']), pin);
  assert.ok(f.some((m) => m.includes('unpinned red: c.test.ts :: new-regression')));
  assert.ok(f.some((m) => m.includes('pinned test is green: a.test.ts :: r2')));
});

test('a pinned test turning green fails by name', () => {
  const f = compare(mk(['a.test.ts :: r1'], ['b.test.ts :: s1'], ['a.test.ts :: r2']), pin);
  assert.deepEqual(f.length, 1);
  assert.match(f[0]!, /pinned test is green: a\.test\.ts :: r2/);
});

test('an unpinned skip and a pinned skip turning green both fail', () => {
  const f = compare(mk(['a.test.ts :: r1', 'a.test.ts :: r2'], ['x.test.ts :: new-skip'], ['b.test.ts :: s1']), pin);
  assert.ok(f.some((m) => m.startsWith('unpinned skip: x.test.ts :: new-skip')));
  assert.ok(f.some((m) => m.startsWith('pinned skip is green: b.test.ts :: s1')));
});

test('an empty pin (corpus-clone) fails on any red or skip', () => {
  assert.equal(compare(mk(['a :: r'], [], []), { red: [], skipped: [] }).length, 1);
  assert.equal(compare(mk([], [], ['a :: ok']), { red: [], skipped: [] }).length, 0);
});

test('parseJunit classifies failure, skipped and passing testcases with file-relative identity', () => {
  const xml = `<testsuites><testsuite>
<testcase name="ok &amp; fine" file="/r/x/a.test.ts"/>
<testcase name="bad" file="/r/x/a.test.ts" failure="boom&#10;"><failure type="x" message="m"/></testcase>
<testcase name="sk" file="/r/x/b.test.ts"><skipped type="skipped" message="why"/></testcase>
</testsuite></testsuites>`;
  const o = parseJunit(xml, '/r');
  assert.deepEqual([...o.green], ['x/a.test.ts :: ok & fine']);
  assert.deepEqual([...o.red], ['x/a.test.ts :: bad']);
  assert.deepEqual([...o.skipped], ['x/b.test.ts :: sk']);
});

test('parseJunit survives a literal > inside a test-name attribute', () => {
  const xml = `<testcase name="embeds an <img> and a => arrow" file="/r/a.test.ts"/>
<testcase name="next" file="/r/a.test.ts" failure="x"><failure/></testcase>`;
  const o = parseJunit(xml, '/r');
  assert.deepEqual([...o.green], ['a.test.ts :: embeds an <img> and a => arrow']);
  assert.deepEqual([...o.red], ['a.test.ts :: next']);
});
