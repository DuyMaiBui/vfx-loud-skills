import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSpec, HAND_WRITTEN } from './recipe-spec.ts';

const fx = new URL('./fixtures/', import.meta.url).pathname;
const exists = (s: string, v: string) => existsSync(join(fx, s, `v${v}.yaml`));
const text = (slug: string) => { const f = readdirSync(join(fx, slug)).filter((x) => x.endsWith('.yaml')).sort().pop()!; return readFileSync(join(fx, slug, f), 'utf8'); };
const spec = (slug: string, t = text(slug)) => buildSpec(slug, 1, t, exists);

test('every fixture parses with no unsupported constructs', () => {
  for (const s of HAND_WRITTEN) assert.deepEqual(spec(s).unsupported, [], s);
});

test('layer count equals the YAML (18 component layers + 2 build blocks across the 10)', () => {
  let components = 0, builds = 0;
  for (const s of HAND_WRITTEN) {
    const t = text(s);
    const comp = (t.match(/^\s*- component:/gm) ?? []).length;
    const build = /^build:/m.test(t) ? 1 : 0;
    assert.equal(spec(s).layers.length, comp + build, s);
    components += comp; builds += build;
  }
  assert.equal(components, 18);
  assert.equal(builds, 2);
});

test('lifetime, delay, count and scale equal the YAML value for every layer of all 10', () => {
  for (const s of HAND_WRITTEN) {
    const t = text(s);
    const blocks = t.split(/^\s*- component:/m).slice(1).map((b) => b.split(/^\S/m)[0]);
    const layers = spec(s).layers.filter((l) => l.kind !== 'particle_system');
    assert.equal(blocks.length, layers.length, s);
    blocks.forEach((b, i) => {
      const get = (k: string) => new RegExp(`^\\s+${k}: (.+?)\\s*$`, 'm').exec(b)?.[1];
      const l = layers[i];
      for (const k of ['lifetime', 'delay', 'count'] as const) {
        const y = get(k);
        assert.equal(l[k], y === undefined ? null : Number(y), `${s}[${i}].${k}`);
      }
      const sc = get('scale');
      if (sc === undefined) assert.equal(l.scale, null, `${s}[${i}].scale`);
      else { const [a, z] = sc.split('->').map(Number); assert.deepEqual(l.scale, { from: a, to: z ?? a }, `${s}[${i}].scale`); }
    });
  }
});

test('scale "0.6 -> 1.0" yields {from:0.6,to:1.0}; a bare number is {n,n}', () => {
  assert.deepEqual(spec('hit-spark').layers[0].scale, { from: 0.6, to: 1.0 });
  assert.deepEqual(spec('teleport-gate').layers[2].scale, { from: 0.9, to: 0.9 });
});

test('an injected unknown layer key lands in unsupported[] (never ignored)', () => {
  const t = text('hit-spark').replace('    lifetime: 0.08', '    lifetime: 0.08\n    wobble: 3');
  const s = spec('hit-spark', t);
  assert.ok(s.unsupported.some((u) => u.includes('wobble')), JSON.stringify(s.unsupported));
});

test('an injected unknown top-level key and an unresolved recipe ref land in unsupported[]', () => {
  assert.ok(spec('hit-spark', text('hit-spark') + 'extra: 1\n').unsupported.some((u) => u.includes('extra')));
  const t = text('melee-slash').replace('vfx://recipe/hit-spark/1', 'vfx://recipe/nope/1');
  assert.ok(spec('melee-slash', t).unsupported.some((u) => u.includes('does not resolve')));
});

test('nested layers: vfx:// resolves to the fetched dir, recipe:// to the built prefab', () => {
  assert.equal(spec('hit-spark').layers[1].nestedPath, 'Assets/VFXCloud/vfx/sparks');
  assert.equal(spec('melee-slash').layers[1].nestedPath, 'Assets/RecipePrefabs/hit-spark.prefab');
});

test('build recipes: particle-system layer carries the explicit blocks', () => {
  const m = spec('metal-landing-spark').layers[0].particleSystem!;
  assert.equal(m.maxParticles, 12);
  assert.equal(m.emission, 'disabled');
  assert.equal(m.emitCount, 12);
  assert.deepEqual(m.emitSpeed, { from: 2, to: 3.5 });
  assert.equal(m.colorStops.length, 3);
  const r = spec('rod-twinkle-box').layers[0].particleSystem!;
  assert.equal(r.emission, 'enabled');
  assert.deepEqual(r.shapeScale, [0.18, 1, 0.1]);
  assert.ok(Math.abs(r.startRotation!.to - 2 * Math.PI) < 1e-9);
});
