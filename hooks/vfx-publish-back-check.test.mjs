import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { customisedReason, findUnpublished, isSettled } from './vfx-publish-back-check.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vfx-publish-back-check.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vfx-pb-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A game project with provenance records shaped like NutSort's art/provenance/nutsort/vfxcloud-<slug>.json. */
function project(name, records) {
  const root = path.join(tmp, name);
  const dir = path.join(root, 'art/provenance/game');
  fs.mkdirSync(dir, { recursive: true });
  for (const [slug, rec] of Object.entries(records)) {
    fs.writeFileSync(path.join(dir, `vfxcloud-${slug}.json`), typeof rec === 'string' ? rec : JSON.stringify(rec));
  }
  return root;
}

const SYNTY_EDIT = {
  uri: 'vfx://recipe/synty-polygon-particle-fx-fx-level-up-01/1',
  version: 1,
  license: 'synty-pack',
  modification: 'child FX_LevelUp_Swirl_01 (the ring layer) removed from the prefab',
};
const KENNEY_PLAIN = { uri: 'vfx://texture/kenney-spark-01/1', version: 1, license: 'cc0', sha256: 'ab' };

function run(root, env = {}, stdin = '{}') {
  const t = process.hrtime.bigint();
  const r = spawnSync('node', [HOOK], { input: stdin, encoding: 'utf8', env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: root, VFX_PUBLISH_BACK_ALWAYS: '1', ...env } });
  return { ...r, ms: Number(process.hrtime.bigint() - t) / 1e6 };
}

test('flags the modified record with no published_uri, one advisory line naming the skill section; the clean one is silent', () => {
  const root = project('flag', { 'synty-edit': SYNTY_EDIT, 'kenney-spark-01': KENNEY_PLAIN });
  const r = run(root);
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /vfxcloud-synty-edit\.json/);
  assert.match(lines[0], /customised \(modification\)/);
  assert.match(lines[0], /Publish-back on accept/);
  assert.ok(!r.stdout.includes('kenney'));
  // Budget is the hook's own cost, not the runner's load: node --test runs ~15 files in parallel (load average 30+), so a
  // spawn can be starved. Retry until one run is under budget; a hook that is itself slow fails every attempt.
  let best = r.ms;
  for (let i = 0; i < 8 && best >= 200; i += 1) best = Math.min(best, run(root).ms);
  assert.ok(best < 200, `took ${best} ms (best of up to 9 runs)`);
});

test('a record is settled by published_uri, a publish_waiver, or owner_accepted:false', () => {
  const root = project('settled', {
    published: { ...SYNTY_EDIT, published_uri: 'vfx://recipe/level-up-no-ring/1' },
    waived: { ...SYNTY_EDIT, publish_waiver: 'owner rejected the look' },
    rejected: { ...SYNTY_EDIT, owner_accepted: false },
    blankwaiver: { ...SYNTY_EDIT, publish_waiver: '  ' },
    badurl: { ...SYNTY_EDIT, published_uri: 'https://example.com/x' },
  });
  const flagged = findUnpublished(root, ['art/provenance']).map((f) => f.slug).sort();
  assert.deepEqual(flagged, ['badurl', 'blankwaiver']); // a blank waiver and a non-vfx URL do not count
  assert.equal(isSettled({ published_uri: 'vfx://recipe/a/1' }), true);
});

test('composed and list-style modifications count; empty ones do not', () => {
  assert.equal(customisedReason({ composed_from: ['vfx://recipe/a/1', 'vfx://recipe/b/1'] }), 'composed_from');
  assert.equal(customisedReason({ modifications: [{ op: 'rescale', target: 'root' }] }), 'modifications');
  assert.equal(customisedReason({ modifications: [], modification: '' }), null);
  assert.equal(customisedReason({ uri: 'vfx://texture/x/1' }), null);
});

test('fail-open: corrupt JSON, the allowed-licenses array, a missing directory and garbage stdin all exit 0 and say nothing wrong', () => {
  const root = project('broken', { corrupt: '{ not json', 'allowed-licenses': ['cc0', 'synty-pack'], ok: SYNTY_EDIT });
  const r = run(root, {}, 'this is not json');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.match(r.stdout, /vfxcloud-ok\.json/);

  const none = run(path.join(tmp, 'does-not-exist'));
  assert.equal(none.status, 0);
  assert.equal(none.stdout, '');
});

test('reports a record once per file version, not every turn', () => {
  const root = project('once', { edit: SYNTY_EDIT });
  const env = { VFX_PUBLISH_BACK_ALWAYS: '' };
  const first = run(root, env);
  assert.match(first.stdout, /vfxcloud-edit\.json/);
  assert.equal(run(root, env).stdout, '', 'already reported, unchanged');
  const file = path.join(root, 'art/provenance/game/vfxcloud-edit.json');
  fs.writeFileSync(file, JSON.stringify({ ...SYNTY_EDIT, note: 'touched' }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.match(run(root, env).stdout, /vfxcloud-edit\.json/, 'a changed record is reported again');
});

test('JSON mode, the off switch, the dirs override and the cwd from the Stop payload', () => {
  const root = project('modes', { edit: SYNTY_EDIT });
  const json = run(root, { VFX_PUBLISH_BACK_JSON: '1' });
  assert.match(JSON.parse(json.stdout).systemMessage, /vfxcloud-edit\.json/);
  assert.equal(run(root, { VFX_PUBLISH_BACK_OFF: '1' }).stdout, '');
  assert.equal(run(root, { VFX_PROVENANCE_DIRS: 'elsewhere' }).stdout, '');
  const viaPayload = run('', { CLAUDE_PROJECT_DIR: '' }, JSON.stringify({ cwd: root, hook_event_name: 'Stop' }));
  assert.match(viaPayload.stdout, /vfxcloud-edit\.json/);
});
