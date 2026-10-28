// Reads data/recipe/<slug>/v<N>.yaml of the hand-written recipes (no prefab) and writes
// data/previews/recipe-specs/<slug>.json for the Unity RecipePrefabBuilder.
// Unknown keys / unplaceable layers / unresolvable `recipe:` refs go to unsupported[] (never ignored); exit 1 if any.
// usage: node tools/recipe-prefab/recipe-spec.ts [--recipes data/recipe] [--out data/previews/recipe-specs] [--only a,b] [--empty-control]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, splitTop, type Yaml, type YamlMap } from './mini-yaml.ts';

/** The hand-written recipes that have no prefab (phase 14). */
export const HAND_WRITTEN = ['cartoon-ground-impact', 'hit-spark', 'melee-slash', 'metal-landing-spark', 'pickup-pop', 'projectile-trail', 'reward-burst', 'rod-twinkle-box', 'soft-smoke-plume', 'teleport-gate'];

export interface Range { from: number; to: number }
export interface Spec { slug: string; version: number; layers: Layer[]; unsupported: string[] }
export interface Layer {
  component: string; kind: 'quad' | 'particle_system' | 'nested';
  textureUri: string; texturePath: string; nestedUri: string; nestedPath: string;
  blend: string; lifetime: number | null; delay: number | null; loop: boolean;
  scale: Range | null; rotation: number | null; rotationRandom: boolean; alpha: Range | null; count: number | null;
  velocity: string; stretchByVelocity: boolean; particleSystem: PS | null;
}
export interface PS {
  playOnAwake: boolean; loop: boolean; startLifetime: Range | null; startSpeed: Range | null; startSize: Range | null; startRotation: Range | null;
  gravityModifier: number | null; simulationSpace: string; scalingMode: string; maxParticles: number | null;
  emission: string; emissionRate: number | null; shapeType: string; shapeScale: number[] | null;
  colorStops: { t: number; r: number; g: number; b: number }[]; alphaStops: { t: number; a: number }[];
  renderMode: string; velocityScale: number | null; lengthScale: number | null; sortMode: string; alignment: string; materialBlend: string; materialTextureUri: string;
  emitCount: number | null; emitSpeed: Range | null; emitDirection: string;
}

const KEYS = {
  top: ['id', 'intent', 'style', 'layers', 'notes', 'category', 'engine', 'license', 'description', 'build', 'emit_pattern'],
  layer: ['component', 'texture', 'recipe', 'blend', 'lifetime', 'delay', 'loop', 'scale', 'rotation', 'alpha', 'count', 'velocity', 'stretch-by-velocity'],
  build: ['particle_system'],
  ps: ['main', 'emission', 'shape', 'color_over_lifetime', 'renderer'],
  main: ['play_on_awake', 'loop', 'start_lifetime', 'start_speed', 'start_size', 'start_rotation', 'gravity_modifier', 'simulation_space', 'scaling_mode', 'max_particles'],
  shape: ['type', 'scale'], col: ['color', 'alpha'],
  renderer: ['render_mode', 'velocity_scale', 'length_scale', 'sort_mode', 'alignment', 'material'],
  emit: ['count', 'speed_m_per_s', 'direction', 'origin'],
};
const BLENDS = ['additive', 'alpha', 'multiply', 'opaque'];
const NAMED_COLORS: Record<string, [number, number, number]> = { white: [1, 1, 1], black: [0, 0, 0] };

class Ctx {
  unsupported: string[] = [];
  bad(what: string) { this.unsupported.push(what); }
  keys(m: YamlMap, allowed: string[], where: string) { for (const k of Object.keys(m)) if (!allowed.includes(k)) this.bad(`${where}: unknown key "${k}"`); }
}

function num(v: string): number | null {
  const s = v.trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const pi = /^(-?\d*\.?\d*)\s*pi$/.exec(s); // 2pi
  if (pi) return (pi[1] === '' ? 1 : Number(pi[1])) * Math.PI;
  return null;
}
function range(v: Yaml, where: string, c: Ctx): Range | null {
  if (typeof v !== 'string') { c.bad(`${where}: expected a number or "a -> b"`); return null; }
  const parts = v.split('->').map((p) => num(p));
  if (parts.length > 2 || parts.some((p) => p === null)) { c.bad(`${where}: cannot parse "${v}"`); return null; }
  return { from: parts[0]!, to: parts[parts.length - 1]! };
}
function scalar(v: Yaml | undefined, where: string, c: Ctx): number | null {
  if (v === undefined) return null;
  const n = typeof v === 'string' ? num(v) : null;
  if (n === null) c.bad(`${where}: expected a number, got ${JSON.stringify(v)}`);
  return n;
}
function bool(v: Yaml | undefined, where: string, c: Ctx): boolean {
  if (v === undefined) return false;
  if (v === 'true' || v === 'false') return v === 'true';
  c.bad(`${where}: expected true|false`);
  return false;
}
function str(v: Yaml | undefined, where: string, c: Ctx): string {
  if (v === undefined) return '';
  if (typeof v !== 'string') { c.bad(`${where}: expected a string`); return ''; }
  return v;
}
function asMap(v: Yaml | undefined, where: string, c: Ctx): YamlMap {
  if (v === undefined) return {};
  if (v === null || typeof v !== 'object' || Array.isArray(v)) { c.bad(`${where}: expected a map`); return {}; }
  return v;
}

function uriParts(uri: string, kind: string): { slug: string; version: string } | null {
  const m = new RegExp(`^vfx://${kind}/([a-z0-9][a-z0-9-]*)/(\\d+)$`).exec(uri);
  return m ? { slug: m[1], version: m[2] } : null;
}

function psSpec(raw: YamlMap, where: string, c: Ctx): PS {
  c.keys(raw, KEYS.ps, where);
  const main = asMap(raw.main, `${where}.main`, c); c.keys(main, KEYS.main, `${where}.main`);
  const shape = raw.shape === 'disabled' ? {} : asMap(raw.shape, `${where}.shape`, c); c.keys(shape, KEYS.shape, `${where}.shape`);
  const col = asMap(raw.color_over_lifetime, `${where}.color_over_lifetime`, c); c.keys(col, KEYS.col, `${where}.color_over_lifetime`);
  const rend = asMap(raw.renderer, `${where}.renderer`, c); c.keys(rend, KEYS.renderer, `${where}.renderer`);
  const opt = (k: string, m: YamlMap) => (m[k] === undefined ? null : range(m[k], `${where}.${k}`, c));
  const emissionRaw = typeof raw.emission === 'string' ? raw.emission : '';
  const rate = /^enabled at rate (\d+(?:\.\d+)?)/.exec(emissionRaw);
  if (emissionRaw !== 'disabled' && !rate) c.bad(`${where}.emission: expected "disabled" or "enabled at rate N ..."`);
  const stops = (key: 'color' | 'alpha') => {
    const list = col[key];
    const out: { t: number; r: number; g: number; b: number; a: number }[] = [];
    if (list === undefined) return out;
    if (!Array.isArray(list)) { c.bad(`${where}.color_over_lifetime.${key}: expected an inline list`); return out; }
    for (const item of list.flatMap((x) => (typeof x === 'string' ? [x] : []))) {
      const m = /^(.*?)\s+at\s+(\d+(?:\.\d+)?(?:\s+and\s+\d+(?:\.\d+)?)*)$/.exec(item);
      if (!m) { c.bad(`${where}.color_over_lifetime.${key}: cannot parse "${item}"`); continue; }
      let r = 1, g = 1, b = 1, a = 1;
      if (key === 'alpha') { const n = num(m[1]); if (n === null) { c.bad(`${where}.color_over_lifetime.alpha: cannot parse "${item}"`); continue; } a = n; }
      else {
        const rgb = /\((\s*[\d.]+\s*),(\s*[\d.]+\s*),(\s*[\d.]+\s*)\)/.exec(m[1]);
        const named = NAMED_COLORS[m[1].split(/\s/)[0]];
        if (rgb) [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
        else if (named) [r, g, b] = named;
        else { c.bad(`${where}.color_over_lifetime.color: colour without (r,g,b) "${item}"`); continue; }
      }
      for (const t of m[2].split(/\s+and\s+/)) out.push({ t: Number(t), r, g, b, a });
    }
    return out;
  };
  const material = typeof rend.material === 'string' ? rend.material : '';
  const shapeScale = typeof shape.scale === 'string' ? /^\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(shape.scale) : null;
  if (shape.scale !== undefined && !shapeScale) c.bad(`${where}.shape.scale: expected (x, y, z)`);
  const rm = typeof rend.render_mode === 'string' ? rend.render_mode : '';
  if (rm !== '' && !['billboard', 'stretch'].includes(rm)) c.bad(`${where}.renderer.render_mode: unsupported "${rm}"`);
  const ss = typeof main.simulation_space === 'string' ? main.simulation_space : '';
  if (ss !== '' && !['world', 'local'].includes(ss)) c.bad(`${where}.main.simulation_space: unsupported "${ss}"`);
  const st = typeof shape.type === 'string' ? shape.type : '';
  if (st !== '' && st !== 'box') c.bad(`${where}.shape.type: unsupported "${st}"`);
  const cs = stops('color'), as = stops('alpha');
  return {
    playOnAwake: bool(main.play_on_awake, `${where}.main.play_on_awake`, c), loop: bool(main.loop, `${where}.main.loop`, c),
    startLifetime: opt('start_lifetime', main), startSpeed: opt('start_speed', main), startSize: opt('start_size', main), startRotation: opt('start_rotation', main),
    gravityModifier: scalar(main.gravity_modifier, `${where}.main.gravity_modifier`, c), simulationSpace: ss, scalingMode: str(main.scaling_mode, `${where}.main.scaling_mode`, c),
    maxParticles: scalar(main.max_particles, `${where}.main.max_particles`, c),
    emission: rate ? 'enabled' : 'disabled', emissionRate: rate ? Number(rate[1]) : null,
    shapeType: st === '' ? 'none' : st, shapeScale: shapeScale ? [Number(shapeScale[1]), Number(shapeScale[2]), Number(shapeScale[3])] : null,
    colorStops: cs.map(({ t, r, g, b }) => ({ t, r, g, b })), alphaStops: as.map(({ t, a }) => ({ t, a })),
    renderMode: rm, velocityScale: scalar(rend.velocity_scale, `${where}.renderer.velocity_scale`, c), lengthScale: scalar(rend.length_scale, `${where}.renderer.length_scale`, c),
    sortMode: str(rend.sort_mode, `${where}.renderer.sort_mode`, c), alignment: str(rend.alignment, `${where}.renderer.alignment`, c),
    materialBlend: BLENDS.find((b) => material.includes(b)) ?? '', materialTextureUri: /vfx:\/\/texture\/[a-z0-9-]+\/\d+/.exec(material)?.[0] ?? '',
    emitCount: null, emitSpeed: null, emitDirection: '',
  };
}

export function buildSpec(slug: string, version: number, text: string, recipeExists: (slug: string, version: string) => boolean = () => false): Spec {
  const c = new Ctx();
  const doc = parseYaml(text);
  c.keys(doc, KEYS.top, slug);
  if (doc.id !== slug) c.bad(`${slug}: id "${String(doc.id)}" does not match the directory`);
  const layers: Layer[] = [];
  if (Array.isArray(doc.layers)) {
    doc.layers.forEach((li, i) => {
      const where = `${slug}.layers[${i}]`;
      const m = asMap(li, where, c);
      c.keys(m, KEYS.layer, where);
      const component = str(m.component, `${where}.component`, c);
      if (component === '') c.bad(`${where}: layer without a component name`);
      const textureUri = str(m.texture, `${where}.texture`, c);
      const recipeUri = str(m.recipe, `${where}.recipe`, c);
      const blend = str(m.blend, `${where}.blend`, c);
      if (blend !== '' && !BLENDS.includes(blend)) c.bad(`${where}.blend: unsupported "${blend}"`);
      let kind: Layer['kind'] = 'quad';
      let nestedPath = '';
      const tex = uriParts(textureUri, 'texture');
      if ((textureUri === '') === (recipeUri === '')) c.bad(`${where}: needs exactly one of texture / recipe`);
      if (textureUri !== '' && !tex) c.bad(`${where}.texture: not a vfx://texture/<slug>/<n> URI`);
      if (recipeUri !== '') {
        kind = 'nested';
        const asVfx = uriParts(recipeUri, 'vfx'), asRecipe = uriParts(recipeUri, 'recipe');
        if (asVfx) nestedPath = `Assets/VFXCloud/vfx/${asVfx.slug}`;
        else if (asRecipe && recipeExists(asRecipe.slug, asRecipe.version)) nestedPath = `Assets/RecipePrefabs/${asRecipe.slug}.prefab`;
        else c.bad(`${where}.recipe: "${recipeUri}" does not resolve`);
      }
      const rot = m.rotation;
      const vel = str(m.velocity, `${where}.velocity`, c);
      if (vel !== '' && vel !== 'radial-outward') c.bad(`${where}.velocity: unsupported "${vel}"`);
      layers.push({
        component, kind, textureUri, texturePath: tex ? `Assets/VFXCloud/texture/${tex.slug}` : '', nestedUri: recipeUri, nestedPath, blend,
        lifetime: scalar(m.lifetime, `${where}.lifetime`, c), delay: scalar(m.delay, `${where}.delay`, c), loop: bool(m.loop, `${where}.loop`, c),
        scale: m.scale === undefined ? null : range(m.scale, `${where}.scale`, c), rotation: rot === 'random' ? null : scalar(rot, `${where}.rotation`, c), rotationRandom: rot === 'random',
        alpha: m.alpha === undefined ? null : range(m.alpha, `${where}.alpha`, c), count: scalar(m.count, `${where}.count`, c), velocity: vel,
        stretchByVelocity: bool(m['stretch-by-velocity'], `${where}.stretch-by-velocity`, c), particleSystem: null,
      });
    });
  } else if (doc.layers !== undefined) c.bad(`${slug}.layers: expected a list`);

  if (doc.build !== undefined) {
    const build = asMap(doc.build, `${slug}.build`, c);
    c.keys(build, KEYS.build, `${slug}.build`);
    const ps = psSpec(asMap(build.particle_system, `${slug}.build.particle_system`, c), `${slug}.build.particle_system`, c);
    const ep = asMap(doc.emit_pattern, `${slug}.emit_pattern`, c);
    c.keys(ep, KEYS.emit, `${slug}.emit_pattern`);
    const cnt = typeof ep.count === 'string' ? /^(\d+)\b/.exec(ep.count) : null;
    if (ep.count !== undefined && !cnt) c.bad(`${slug}.emit_pattern.count: expected a leading integer`);
    ps.emitCount = cnt ? Number(cnt[1]) : null;
    ps.emitSpeed = ep.speed_m_per_s === undefined ? null : range(ep.speed_m_per_s, `${slug}.emit_pattern.speed_m_per_s`, c);
    ps.emitDirection = typeof ep.direction === 'string' ? (ep.direction.includes('hemisphere') ? 'hemisphere' : (c.bad(`${slug}.emit_pattern.direction: unsupported`), '')) : '';
    const uri = ps.materialTextureUri;
    const tex = uri ? uriParts(uri, 'texture') : null;
    if (!tex) c.bad(`${slug}.build.particle_system.renderer.material: no vfx://texture URI`);
    layers.push({
      component: 'particle-system', kind: 'particle_system', textureUri: uri, texturePath: tex ? `Assets/VFXCloud/texture/${tex.slug}` : '', nestedUri: '', nestedPath: '',
      blend: ps.materialBlend, lifetime: null, delay: null, loop: ps.loop, scale: null, rotation: null, rotationRandom: false, alpha: null, count: null, velocity: '', stretchByVelocity: false, particleSystem: ps,
    });
  } else if (doc.emit_pattern !== undefined) c.bad(`${slug}.emit_pattern without build`);
  if (layers.length === 0 && c.unsupported.length === 0) c.bad(`${slug}: no layers and no build block`);
  return { slug, version, layers, unsupported: c.unsupported };
}

function help() {
  console.log('usage: node tools/recipe-prefab/recipe-spec.ts [--recipes <dir=data/recipe>] [--out <dir=data/previews/recipe-specs>] [--only <slug,slug>] [--empty-control]\n  --out            directory for <slug>.json\n  --only           comma list of slugs (default: the 10 hand-written recipes)\n  --empty-control  also write __empty-control.json (zero layers) for the render-gate control\nexit 1 when any recipe has unsupported constructs');
}

function latest(dir: string): number | null {
  if (!existsSync(dir)) return null;
  const v = readdirSync(dir).map((f) => /^v(\d+)\.yaml$/.exec(f)?.[1]).filter((x): x is string => !!x).map(Number);
  return v.length ? Math.max(...v) : null;
}

export function main(argv: string[]): number {
  const arg = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  if (argv.includes('--help') || argv.includes('-h')) { help(); return 0; }
  const recipes = arg('--recipes', 'data/recipe'), out = arg('--out', 'data/previews/recipe-specs');
  const only = arg('--only', '').split(',').filter(Boolean);
  const slugs = only.length ? only : HAND_WRITTEN;
  mkdirSync(out, { recursive: true });
  const written: string[] = [], unsupported: string[] = [];
  const exists = (s: string, v: string) => existsSync(join(recipes, s, `v${v}.yaml`));
  for (const slug of slugs) {
    const v = latest(join(recipes, slug));
    if (v === null) { unsupported.push(`${slug}: no data/recipe/${slug}/v<N>.yaml`); continue; }
    try {
      const spec = buildSpec(slug, v, readFileSync(join(recipes, slug, `v${v}.yaml`), 'utf8'), exists);
      writeFileSync(join(out, `${slug}.json`), JSON.stringify(spec, null, 1));
      written.push(slug);
      unsupported.push(...spec.unsupported);
    } catch (e) { unsupported.push(`${slug}: ${(e as Error).message}`); }
  }
  if (argv.includes('--empty-control')) { writeFileSync(join(out, '__empty-control.json'), JSON.stringify({ slug: '__empty-control', version: 1, layers: [], unsupported: [] }, null, 1)); written.push('__empty-control'); }
  console.log(JSON.stringify({ tool: 'recipe-spec', out, written: written.length, unsupported }));
  return unsupported.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
