import { test } from 'node:test';
import assert from 'node:assert/strict';
import { behaviorFromLayers, behaviorFromNodes } from './behavior.ts';
import { enrichExtracted } from './enrich.ts';
import { facetsFromNodes, payloadNodes, type NodeInfo } from './facets.ts';

interface NodeOpts {
  path: string;
  looping?: number;
  length?: number;
  life?: string;
  speed?: number;
  size?: number;
  max?: number;
  gravity?: number;
  rate?: number;
  burstAt?: number;
  shape?: string;
  rotation?: string;
  renderMode?: number;
  velocity?: string;
  fade?: boolean;
  sizeCurve?: string;
}

/** One serialized particle node in the same shape the extractor emits. */
function node(o: NodeOpts): string {
  return `  - path: ${o.path}
    active: true
    transform: {position: [0, 0, 0], rotation: ${o.rotation ?? '[0, 0, 0, 1]'}, scale: [1, 1, 1]}
    main:
      lengthInSec: ${o.length ?? 5}
      looping: ${o.looping ?? 0}
      startDelay: {mode: constant, value: 0}
      startLifetime: ${o.life ?? '{mode: constant, value: 0.3}'}
      startSpeed: {mode: constant, value: ${o.speed ?? 0}}
      startSize: {mode: constant, value: ${o.size ?? 0.3}}
      maxNumParticles: ${o.max ?? 200}
      gravityModifier: {mode: constant, value: ${o.gravity ?? 0}}
      startColor: {mode: color, color: [1, 0.5, 0, 1]}
    emission:
      enabled: true
      rateOverTime: {mode: constant, value: ${o.rate ?? 0}}
      m_BurstCount: 1
      m_Bursts: [{time: ${o.burstAt ?? 0}, countCurve: {mode: constant, value: 20}, cycleCount: 1, repeatInterval: 0.01, probability: 1}]
    shape: ${o.shape ?? '{enabled: true, type: 0, angle: 25, radius: {value: 1, mode: 0}, m_Scale: [1, 1, 1]}'}
    colorOverLifetime: ${o.fade ? '{enabled: true, gradient: {mode: gradient, gradient: {blend: 0, colorKeys: [[0, 1, 1, 1]], alphaKeys: [[0, 1], [1, 0]]}}}' : '{enabled: false}'}
    sizeOverLifetime: ${o.sizeCurve ? `{enabled: true, curve: {mode: curve, keys: ${o.sizeCurve}}}` : '{enabled: false}'}
    textureSheetAnimation: {enabled: false}
    subEmitters: {enabled: false}
    otherEnabledModules: ${o.velocity ? `{VelocityModule: {enabled: true, ${o.velocity}}}` : '{}'}
    renderer: {m_Enabled: 1, m_RenderMode: ${o.renderMode ?? 0}}`;
}
const payload = (...nodes: NodeOpts[]): string => `particleNodes:\n${nodes.map(node).join('\n')}\n`;

const boom = payload({ path: 'Boom/Sparks', life: '{mode: randomBetweenConstants, min: 0.2, max: 0.3}', speed: 6, gravity: 1, fade: true, renderMode: 1 });

test('one-shot burst: playback / duration / scale / motion / shape / renderMode / cost', () => {
  const { nodes } = payloadNodes(boom);
  const f = facetsFromNodes(nodes);
  assert.equal(f.playback, 'one-shot');
  assert.equal(f.duration, 'short'); // burst at 0 + 0.3 s lifetime, NOT the 5 s module duration
  assert.equal(f.scale, 'small'); // size 0.3 x max(1, radius 1)
  assert.deepEqual(f.motion, ['radial', 'falling']);
  assert.deepEqual(f.shape, ['sphere']);
  assert.deepEqual(f.renderMode, ['stretched']);
  assert.equal(f.cost, 'low');
});

test('looping cone rotated up: loop, long, upward, cone; velocity module orbit -> spiral', () => {
  const up = payload({ path: 'Fire', looping: 1, length: 4, rate: 10, life: '{mode: constant, value: 6}', speed: 2, size: 5, max: 1000, shape: '{enabled: true, type: 4, angle: 10, radius: {value: 1, mode: 0}, m_Scale: [1, 1, 1]}', rotation: '[-0.7071, 0, 0, 0.7071]' });
  const f = facetsFromNodes(payloadNodes(up).nodes);
  assert.equal(f.playback, 'loop');
  assert.equal(f.duration, 'long'); // 4 s emit span + 6 s lifetime
  assert.equal(f.scale, 'large');
  assert.deepEqual(f.motion, ['upward']);
  assert.deepEqual(f.shape, ['cone']);
  const swirl = payload({ path: 'Swirl', looping: 1, rate: 5, speed: 0, shape: '{enabled: false}', velocity: 'y: {mode: constant, value: 1}, orbitalY: {mode: constant, value: 2}' });
  const g = facetsFromNodes(payloadNodes(swirl).nodes);
  assert.deepEqual(g.motion, ['upward', 'orbit', 'spiral']);
  assert.deepEqual(g.shape, ['point']);
});

test('no speed, gravity or modules is static; static is dropped once another motion exists', () => {
  assert.deepEqual(facetsFromNodes(payloadNodes(payload({ path: 'Glow', shape: '{enabled: false}' })).nodes).motion, ['static']);
  const mixed = payload({ path: 'A', shape: '{enabled: false}' }, { path: 'B', speed: 3 });
  assert.deepEqual(facetsFromNodes(payloadNodes(mixed).nodes).motion, ['radial']);
});

const fake = (o: Partial<NodeInfo>): NodeInfo => ({ path: 'X', weight: 100, looping: false, visibleSec: 1, size: 1, extent: 0, shape: 'point', motion: ['static'], burst: true, fade: false, trail: false, ...o });

test('thresholds come from facets.json: 0.5 / 2 s and 1 / 4 scale are inclusive of medium', () => {
  const d = (s: number) => facetsFromNodes([fake({ visibleSec: s })]).duration;
  assert.deepEqual([d(0.49), d(0.5), d(2), d(2.01)], ['short', 'medium', 'medium', 'long']);
  const sc = (size: number, extent = 0) => facetsFromNodes([fake({ size, extent })]).scale;
  assert.deepEqual([sc(0.99), sc(1), sc(4), sc(4.01), sc(0.5, 10)], ['small', 'medium', 'medium', 'large', 'large']);
  const cost = (n: number, weight: number) => facetsFromNodes(Array.from({ length: n }, () => fake({ weight }))).cost;
  assert.deepEqual([cost(1, 100), cost(5, 100), cost(1, 2500), cost(8, 100), cost(1, 5000)], ['low', 'medium', 'medium', 'high', 'high']);
});

test('behavior: plain deterministic sentences, at most three, no licence / guid talk', () => {
  const layered = payload(
    { path: 'Boom/Sparks', life: '{mode: randomBetweenConstants, min: 0.2, max: 0.9}', speed: 6, gravity: 1, fade: true, max: 300 },
    { path: 'Boom/Smoke', speed: 1, max: 100 },
  );
  const { nodes } = payloadNodes(layered);
  const ctx = { category: ['explosion'], element: ['fire'], colors: ['orange'] };
  const text = behaviorFromNodes(nodes, undefined, ctx) as string;
  assert.equal(text, 'A one-shot burst of orange flames spreads outward from a sphere, falls under gravity and fades out over 0.9 s. Extra layers add smoke. Loops: no.');
  assert.equal(text, behaviorFromNodes(nodes, undefined, ctx));
  assert.ok(text.split(/(?<=\.)\s/).length <= 3);
  assert.doesNotMatch(text, /licen[cs]e|guid|Unity|Assets\//i);
});

test('behavior: looping, size trend and cycle length', () => {
  const y = payload({ path: 'Aura', looping: 1, length: 3, rate: 8, speed: 0, life: '{mode: constant, value: 2}', shape: '{enabled: false}', sizeCurve: '[[0, 1], [1, 0.1]]' });
  const text = behaviorFromNodes(payloadNodes(y).nodes, undefined, { category: [], element: [], colors: [] }) as string;
  assert.equal(text, 'A looping steady stream of particles stays in place, shrinks and repeats every 5 s. Loops: yes.');
});

test('effect-only payloads describe their components and carry line / mesh facets', () => {
  const yaml = 'effectNodes:\n  - path: Beam\n    active: true\n    transform: {position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1]}\n    components:\n      - type: LineRenderer\n      - type: MonoBehaviour\n';
  const { nodes, effect } = payloadNodes(yaml);
  assert.equal(nodes.length, 0);
  assert.deepEqual(facetsFromNodes(nodes, effect), { shape: ['line'], renderMode: ['line'], cost: 'low' });
  assert.equal(behaviorFromNodes(nodes, effect, { category: [], element: [], colors: [] }), 'A non-particle effect built from a stretched line and script-driven behaviour; its motion is driven by components, not particle emission.');
});

test('hand-written layers recipe: behaviour from the layer list', () => {
  const yaml = 'layers:\n  - component: shockwave-ring\n    lifetime: 0.35\n  - component: soft-dust\n    lifetime: 0.7\n';
  assert.equal(behaviorFromLayers(yaml, ['impact']), 'Layered effect of shockwave ring and soft dust. The longest layer lasts 0.7 s. Loops: no.');
  assert.equal(behaviorFromLayers(yaml, ['loop'])?.endsWith('Loops: yes.'), true);
});

test('enrichExtracted emits contract facets + behavior and stays deterministic', () => {
  const input = { name: 'Fire_Explosion (Test Pack)', prefabPath: 'Assets/T/Prefabs/Combat/Fire_Explosion.prefab', packName: 'Test Pack', vendor: 'V', metaStyle: ['toon'], kind: 'particle' as const, yaml: boom, existingTags: [] };
  const a = enrichExtracted(input);
  assert.deepEqual(a, enrichExtracted(input));
  assert.deepEqual(a.facets.category, ['fire', 'explosion']);
  assert.deepEqual(a.facets.element, ['fire']);
  assert.equal(a.facets.playback, 'one-shot');
  assert.ok(a.behavior && a.behavior.endsWith('Loops: no.'));
});
