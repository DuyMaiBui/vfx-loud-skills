import { getFacetRules, type Facets } from '../../server/src/facets.ts';
import { parsePayload } from './enrich.ts';
import { asMap, asNum, asSeq, type YamlMap, type YamlValue } from './unity-yaml.ts';

/**
 * Payload-derived facets (duration, scale, playback, motion, shape, renderMode, cost). The analysis
 * reads the extracted recipe YAML once into a `NodeInfo` per particle node; `facetsFromNodes` maps
 * those to the contract, `behavior.ts` phrases the same nodes. Thresholds and code tables come from
 * facets.json. Same input -> same output.
 */
export interface NodeInfo {
  path: string;
  weight: number; // maxNumParticles
  looping: boolean;
  visibleSec: number; // startDelay + emit span + longest lifetime
  size: number;
  extent: number;
  shape: string; // point when the shape module is off
  motion: string[];
  burst: boolean;
  fade: boolean;
  sizeTrend?: 'grow' | 'shrink';
  renderMode?: string;
  trail: boolean;
}

export interface EffectInfo {
  kinds: string[];
}

export const on = (v: YamlValue | undefined): boolean => v === true || v === 'true' || v === 1 || v === '1';
const off = (v: YamlValue | undefined): boolean => v === false || v === 'false' || v === 0 || v === '0';

function keysMax(keys: YamlValue | undefined): number {
  const vs = asSeq(keys).map((k) => (Array.isArray(k) && typeof k[1] === 'number' ? k[1] : 0));
  return vs.length ? Math.max(...vs) : 0;
}
function keysMin(keys: YamlValue | undefined): number {
  const vs = asSeq(keys).map((k) => (Array.isArray(k) && typeof k[1] === 'number' ? k[1] : 0));
  return vs.length ? Math.min(...vs) : 0;
}

/** [lo, hi] of a serialized MinMaxCurve ({mode: constant|randomBetweenConstants|curve|randomBetweenCurves}). */
export function range(v: YamlValue | undefined): [number, number] {
  const m = asMap(v);
  if (!m) return typeof v === 'number' ? [v, v] : [0, 0];
  switch (m.mode) {
    case 'randomBetweenConstants': {
      const a = asNum(m.min) ?? 0;
      const b = asNum(m.max) ?? 0;
      return [Math.min(a, b), Math.max(a, b)];
    }
    case 'curve':
      return [keysMin(m.keys), keysMax(m.keys)];
    case 'randomBetweenCurves':
      return [Math.min(keysMin(m.min), keysMin(m.max)), Math.max(keysMax(m.min), keysMax(m.max))];
    default: {
      const x = asNum(m.value) ?? 0;
      return [x, x];
    }
  }
}

function alphaEnd(colour: YamlMap | undefined): number | undefined {
  const g = asMap(colour?.gradient);
  const grad = asMap(g?.gradient) ?? asMap(g?.max);
  const keys = asSeq(grad?.alphaKeys);
  const last = keys[keys.length - 1];
  return Array.isArray(last) && typeof last[1] === 'number' ? last[1] : undefined;
}

/** Direction of local +Z after the node's local rotation quaternion [x,y,z,w]: its y component. */
function forwardY(rot: YamlValue | undefined): number {
  const q = asSeq(rot).map((x) => (typeof x === 'number' ? x : 0));
  if (q.length < 4) return 0;
  const [x, , z, w] = q;
  return 2 * (q[1] * z - w * x);
}

function shapeInfo(n: YamlMap): { shape: string; extent: number; angle: number } {
  const rules = getFacetRules();
  const s = asMap(n.shape);
  if (!s || !on(s.enabled)) return { shape: 'point', extent: 0, angle: 0 };
  const shape = rules.shapeTypes[String(s.type)] ?? 'mesh';
  const scale = asSeq(s.m_Scale).map((x) => (typeof x === 'number' ? x : 0));
  const radius = asNum(asMap(s.radius)?.value) ?? asNum(s.radius) ?? 0;
  const extent = shape === 'box' ? Math.max(0, ...scale) / 2 : radius;
  return { shape, extent, angle: asNum(s.angle) ?? 0 };
}

function nodeMotion(n: YamlMap, shape: string, angle: number, speed: number, gravity: [number, number]): string[] {
  const t = getFacetRules().thresholds.motion;
  const rules = getFacetRules();
  const out = new Set<string>();
  const other = asMap(n.otherEnabledModules) ?? {};
  const vel = asMap(other.VelocityModule);
  const force = asMap(other.ForceModule);
  if (speed > t.minSpeed) {
    const radial = rules.radialShapes.includes(shape) || (shape === 'cone' && angle >= t.radialConeAngle);
    if (radial) out.add('radial');
    else {
      const y = forwardY(asMap(n.transform)?.rotation);
      out.add(y > t.verticalDirection ? 'upward' : y < -t.verticalDirection ? 'downward' : 'directional');
    }
  }
  if (gravity[1] > t.minGravity) out.add('falling');
  if (gravity[0] < -t.minGravity) out.add('upward');
  for (const m of [vel, force]) {
    if (!m) continue;
    const y = range(m.y);
    if (y[1] > t.minSpeed) out.add('upward');
    if (y[0] < -t.minSpeed) out.add('downward');
  }
  if (vel) {
    const orbital = ['orbitalX', 'orbitalY', 'orbitalZ'].some((k) => range(vel[k])[1] !== 0 || range(vel[k])[0] !== 0);
    if (orbital) {
      out.add('orbit');
      if (out.has('upward') || out.has('radial') || speed > t.minSpeed || range(vel.radial)[1] !== 0) out.add('spiral');
    }
    if (range(vel.radial)[1] > 0) out.add('radial');
  }
  if (!out.size) out.add('static');
  return [...out];
}

export function analyseNode(n: YamlMap): NodeInfo | undefined {
  const main = asMap(n.main);
  if (!main) return undefined;
  const em = asMap(n.emission);
  const renderer = asMap(n.renderer);
  const rendererOn = !renderer || !off(renderer.m_Enabled);
  const emitting = !!em && on(em.enabled) && rendererOn && !off(n.active);
  const rate = range(em?.rateOverTime)[1];
  const bursts = asSeq(em?.m_Bursts).map((b) => asMap(b) ?? {});
  const burstTimes = bursts.filter((b) => range(b.countCurve)[1] > 0).map((b) => asNum(b.time) ?? 0);
  const looping = on(main.looping);
  const length = asNum(main.lengthInSec) ?? 0;
  const emitSpan = !emitting ? 0 : rate > 0 || looping ? length : Math.max(0, ...burstTimes);
  const life = range(main.startLifetime)[1];
  const delay = range(main.startDelay)[1];
  const speed = range(main.startSpeed)[1];
  const { shape, extent, angle } = shapeInfo(n);
  const gravity = range(main.gravityModifier);
  const size = range(main.startSize)[1];
  const col = asMap(n.colorOverLifetime);
  const szo = asMap(n.sizeOverLifetime);
  let sizeTrend: NodeInfo['sizeTrend'];
  if (szo && on(szo.enabled)) {
    const [lo, hi] = range(szo.curve);
    const keys = asSeq(asMap(szo.curve)?.keys ?? asMap(szo.curve)?.max);
    const first = Array.isArray(keys[0]) && typeof keys[0][1] === 'number' ? keys[0][1] : lo;
    const last = Array.isArray(keys[keys.length - 1]) && typeof (keys[keys.length - 1] as YamlValue[])[1] === 'number' ? ((keys[keys.length - 1] as YamlValue[])[1] as number) : hi;
    if (last < first * 0.7) sizeTrend = 'shrink';
    else if (last > first * 1.3 && first >= 0) sizeTrend = 'grow';
  }
  const end = col && on(col.enabled) ? alphaEnd(col) : undefined;
  const mode = renderer ? getFacetRules().renderModes[String(renderer.m_RenderMode)] : undefined;
  const trailMod = asMap(asMap(n.otherEnabledModules)?.TrailModule);
  return {
    path: String(n.path ?? ''),
    weight: emitting ? (asNum(main.maxNumParticles) ?? 0) : 0,
    looping: emitting && looping,
    visibleSec: emitting ? delay + emitSpan + life : 0,
    size,
    extent,
    shape,
    motion: nodeMotion(n, shape, angle, speed, [gravity[0], gravity[1]]),
    burst: rate === 0 && burstTimes.length > 0,
    fade: end !== undefined && end < 0.2,
    sizeTrend,
    renderMode: mode,
    trail: !!trailMod && on(trailMod.enabled),
  };
}

/** Emitting nodes (falls back to all nodes so a payload that emits nothing still gets facets). */
export function payloadNodes(yaml: string): { nodes: NodeInfo[]; effect?: EffectInfo } {
  const doc = parsePayload(yaml);
  const all = asSeq(doc.particleNodes)
    .map((n) => analyseNode(asMap(n) ?? {}))
    .filter((x): x is NodeInfo => !!x);
  if (all.length) {
    const emitting = all.filter((n) => n.weight > 0 || n.visibleSec > 0);
    return { nodes: emitting.length ? emitting : all };
  }
  const kinds = new Set<string>();
  const rules = getFacetRules();
  for (const n of asSeq(doc.effectNodes)) {
    for (const c of asSeq(asMap(n)?.components)) {
      const t = String(asMap(c)?.type ?? '');
      if (t === 'LineRenderer') kinds.add('line');
      else if (t === 'TrailRenderer') kinds.add('trail');
      else if (t.startsWith('Mesh') || t === 'SkinnedMeshRenderer') kinds.add('mesh');
      else if (t === 'Light') kinds.add('light');
      else if (t === 'MonoBehaviour') kinds.add('script');
    }
  }
  const order = Object.keys(rules.behavior.effect.kinds);
  return { nodes: [], effect: { kinds: order.filter((k) => kinds.has(k)) } };
}

const bucket = (v: number, lo: number, hi: number): 0 | 1 | 2 => (v < lo ? 0 : v > hi ? 2 : 1);
const uniq = (xs: string[]): string[] => [...new Set(xs)];

/** Contract facets that come from the payload (text facets are added by the caller). */
export function facetsFromNodes(nodes: NodeInfo[], effect?: EffectInfo): Facets {
  const rules = getFacetRules();
  const th = rules.thresholds;
  if (!nodes.length) {
    const kinds = effect?.kinds ?? [];
    return {
      shape: uniq(kinds.map((k) => rules.effectKindShapes[k]).filter(Boolean)),
      renderMode: uniq(kinds.map((k) => rules.effectKindRenderModes[k]).filter(Boolean)),
      cost: 'low',
    };
  }
  const visible = Math.max(...nodes.map((n) => n.visibleSec));
  const scale = Math.max(...nodes.map((n) => n.size * Math.max(1, n.extent)));
  const particles = nodes.reduce((s, n) => s + n.weight, 0);
  const motionOrder = Object.keys(rules.behavior.motion);
  const motion = uniq(nodes.flatMap((n) => n.motion));
  const cost =
    particles >= th.cost.highParticles || nodes.length >= th.cost.highNodes
      ? 'high'
      : particles >= th.cost.mediumParticles || nodes.length >= th.cost.mediumNodes
        ? 'medium'
        : 'low';
  return {
    playback: nodes.some((n) => n.looping) ? 'loop' : 'one-shot',
    duration: (['short', 'medium', 'long'] as const)[bucket(visible, th.durationSec.shortBelow, th.durationSec.longAbove)],
    scale: (['small', 'medium', 'large'] as const)[bucket(scale, th.scale.smallBelow, th.scale.largeAbove)],
    motion: (motion.length > 1 ? motion.filter((m) => m !== 'static') : motion).sort((a, b) => motionOrder.indexOf(a) - motionOrder.indexOf(b)),
    shape: uniq(nodes.map((n) => n.shape)),
    renderMode: uniq(nodes.flatMap((n) => [...(n.renderMode ? [n.renderMode] : []), ...(n.trail ? ['trail'] : [])])),
    cost,
  };
}
