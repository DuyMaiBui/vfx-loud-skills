import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ingestExtracted, type IngestDeps } from './ingest.ts';
import { extractedLicenseProblem } from '../../server/src/license.ts';

function rec(slug: string, license = 'asset-store-eula', extracted = true): string {
  return JSON.stringify({
    type: 'recipe', slug, name: slug, description: 'd', tags: ['t'], style: ['s'], category: 'recipe',
    license, fileName: `${slug}.yaml`, inline: 'a: 1\n',
    meta: { extracted, license_class: 'proprietary-commercial', ai_training: false },
  });
}

async function fixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-ingest-'));
  await fs.mkdir(path.join(dir, 'p'));
  await fs.writeFile(path.join(dir, 'p', 'a.json'), rec('p-a'));
  await fs.writeFile(path.join(dir, 'p', 'b.json'), rec('p-b'));
  await fs.writeFile(path.join(dir, 'p', 'bad.json'), rec('p-bad', 'cc0'));
  await fs.writeFile(path.join(dir, 'p', 'summary.json'), '{}');
  await fs.writeFile(path.join(dir, 'p.log'), 'not a record');
  return dir;
}

test('ingest is idempotent, forces visibility=project, and the licence gate rejections are reported', async () => {
  const dir = await fixture();
  const db = new Set<string>();
  const seen: Array<{ slug: string; visibility: string; b64: string }> = [];
  const deps: IngestDeps = {
    exists: async (_t, slug) => db.has(slug),
    publish: async (a) => {
      const problem = extractedLicenseProblem(a.license);
      if (problem) throw new Error(`extracted record refused: ${problem}`);
      db.add(a.slug);
      seen.push({ slug: a.slug, visibility: a.visibility, b64: a.b64 });
      return { uri: `vfx://recipe/${a.slug}/1` };
    },
  };
  try {
    const first = await ingestExtracted(dir, deps);
    assert.equal(first.published, 2);
    assert.equal(first.failures.length, 1);
    assert.match(first.failures[0], /bad\.json.*refused/);
    assert.ok(seen.every((s) => s.visibility === 'project'));
    assert.equal(Buffer.from(seen[0].b64, 'base64').toString(), 'a: 1\n');
    const second = await ingestExtracted(dir, deps);
    assert.equal(second.published, 0); // no new rows, no version bump
    assert.equal(second.skippedExisting, 2);
    assert.equal(db.size, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a non-extracted json is refused, and --limit caps the batch', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-ingest-'));
  await fs.mkdir(path.join(dir, 'p'));
  await fs.writeFile(path.join(dir, 'p', 'x.json'), rec('p-x', 'asset-store-eula', false));
  await fs.writeFile(path.join(dir, 'p', 'y.json'), rec('p-y'));
  try {
    const deps: IngestDeps = { exists: async () => false, publish: async (a) => ({ uri: a.slug }) };
    const r = await ingestExtracted(dir, deps);
    assert.equal(r.published, 1);
    assert.match(r.failures[0], /not an extracted recipe/);
    assert.equal((await ingestExtracted(dir, deps, 1)).published + 0, 0); // first file (x) is refused
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
