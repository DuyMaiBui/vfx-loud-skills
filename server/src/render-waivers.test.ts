import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FAILED_CAUSES } from './bundle-contract.ts';

const file = new URL('../../tools/preview/waivers.json', import.meta.url);
const doc = JSON.parse(readFileSync(file, 'utf8')) as { version: number; waivers: { slug: string; cause: string; detail: string; evidence: string }[] };

test('waivers.json: every waiver carries a C9 unfixable-* cause, a detail and evidence, and no slug repeats', () => {
  assert.equal(doc.version, 1);
  const seen = new Set<string>();
  for (const w of doc.waivers) {
    assert.match(w.cause, /^unfixable-(source|script|shader)$/, w.slug);
    assert.ok((FAILED_CAUSES as readonly string[]).includes(w.cause), `${w.slug}: ${w.cause} is not a contract failure cause`);
    assert.ok(w.detail.length > 0 && w.evidence.length > 0, `${w.slug}: detail and evidence required`);
    assert.ok(!seen.has(w.slug), `duplicate waiver ${w.slug}`);
    seen.add(w.slug);
  }
});

test('waivers.json: a waiver is not also on the magenta allowlist', () => {
  const allow = readFileSync(new URL('../../tools/preview/magenta-allow.txt', import.meta.url), 'utf8').split('\n').map((l) => l.split('#')[0].trim()).filter(Boolean);
  const waived = new Set(doc.waivers.map((w) => w.slug));
  for (const s of allow) assert.ok(!waived.has(s), `${s} is both allow-listed and waived`);
});
