import {
  asMap,
  asNum,
  asRef,
  asSeq,
  isUnityTextYaml,
  parseUnityDocs,
  UnityYamlError,
  type UnityDoc,
  type YamlMap,
  type YamlValue,
} from './unity-yaml.ts';
import { toYaml } from './yaml-emit.ts';

/**
 * Turns one Unity VFX prefab (text-serialized YAML) into a deterministic "extracted recipe"
 * payload: ParticleSystem parameters of every particle node. Textures / meshes / materials /
 * shaders are emitted as {guid, path} REFERENCES only — no asset bytes are ever read into a
 * record. Anything the extractor cannot represent faithfully raises SkipError (never a partial).
 */

export class SkipError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface BuildContext {
  /** guid -> source path inside the package (undefined when the asset is not in the package). */
  pathOf(guid: string): string | undefined;
  /** guid -> text of a Material asset when the package contains it. */
  materialText(guid: string): string | undefined;
}

export interface PackInfo {
  name: string;
  vendor: string;
}

export type RecipeKind = 'particle' | 'effect';

export interface RecipePayload {
  yaml: string;
  /** 'particle' = has a ParticleSystem; 'effect' = only other effect components (line/mesh/light/...). */
  kind: RecipeKind;
  /** Sorted effect kinds present (effect records only; empty for particle records). */
  effectKinds: string[];
  effectNodeCount: number;
  particleNodeCount: number;
  nodeCount: number;
  prefabName: string;
  summary: { durationMax: number; loops: boolean; renderModes: number[] };
}

const DROP_KEYS = new Set([
  'serializedVersion',
  'm_ObjectHideFlags',
  'm_CorrespondingSourceObject',
  'm_PrefabInstance',
  'm_PrefabAsset',
  'm_GameObject',
  'm_EditorHideFlags',
  'm_EditorClassIdentifier',
]);

const r5 = (n: number): number => {
  const v = Math.round(n * 1e5) / 1e5;
  return Object.is(v, -0) ? 0 : v;
};

function isMap(v: YamlValue | undefined): v is YamlMap {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);
}

/* ------------------------------------------------------------ value convert */

class Converter {
  private readonly ctx: BuildContext;
  private readonly emitterName: (fileId: string) => string | undefined;
  constructor(ctx: BuildContext, emitterName: (fileId: string) => string | undefined) {
    this.ctx = ctx;
    this.emitterName = emitterName;
  }

  ref(guid: string | undefined, fileId: string): Record<string, unknown> {
    if (!guid) return { fileId };
    const path = this.ctx.pathOf(guid);
    return path ? { guid, path } : { guid, external: true };
  }

  /** MinMaxCurve -> compact tagged value. */
  curve(m: YamlMap): unknown {
    const state = asNum(m.minMaxState) ?? 0;
    const scalar = asNum(m.scalar) ?? 1;
    const keys = (c: YamlValue | undefined, mul: number): number[][] => {
      const cm = asMap(c);
      return asSeq(cm?.m_Curve).map((k) => {
        const km = asMap(k) ?? {};
        return [r5(asNum(km.time) ?? 0), r5((asNum(km.value) ?? 0) * mul)];
      });
    };
    switch (state) {
      case 0:
        return { mode: 'constant', value: r5(scalar) };
      case 1:
        return { mode: 'curve', keys: keys(m.maxCurve, scalar) };
      case 2:
        return {
          mode: 'randomBetweenCurves',
          min: keys(m.minCurve, asNum(m.minScalar) ?? scalar),
          max: keys(m.maxCurve, scalar),
        };
      case 3:
        return { mode: 'randomBetweenConstants', min: r5(asNum(m.minScalar) ?? 0), max: r5(scalar) };
      default:
        throw new SkipError('unknown-curve-state', `MinMaxCurve minMaxState=${state}`);
    }
  }

  private color(m: YamlValue | undefined): number[] | undefined {
    const c = asMap(m);
    if (!c) return undefined;
    return ['r', 'g', 'b', 'a'].map((k) => r5(asNum(c[k]) ?? 0));
  }

  private gradientKeys(g: YamlValue | undefined): unknown {
    const gm = asMap(g);
    if (!gm) return null;
    const nC = asNum(gm.m_NumColorKeys) ?? 0;
    const nA = asNum(gm.m_NumAlphaKeys) ?? 0;
    const colorKeys: number[][] = [];
    const alphaKeys: number[][] = [];
    for (let i = 0; i < nC; i++) {
      const c = this.color(gm[`key${i}`]) ?? [0, 0, 0, 0];
      colorKeys.push([r5((asNum(gm[`ctime${i}`]) ?? 0) / 65535), c[0], c[1], c[2]]);
    }
    for (let i = 0; i < nA; i++) {
      const c = this.color(gm[`key${i}`]) ?? [0, 0, 0, 0];
      alphaKeys.push([r5((asNum(gm[`atime${i}`]) ?? 0) / 65535), c[3]]);
    }
    return { blend: asNum(gm.m_Mode) ?? 0, colorKeys, alphaKeys };
  }

  /** MinMaxGradient -> compact tagged value. */
  gradient(m: YamlMap): unknown {
    const state = asNum(m.minMaxState) ?? 0;
    switch (state) {
      case 0:
        return { mode: 'color', color: this.color(m.maxColor) };
      case 1:
        return { mode: 'gradient', gradient: this.gradientKeys(m.maxGradient) };
      case 2:
        return { mode: 'randomBetweenColors', min: this.color(m.minColor), max: this.color(m.maxColor) };
      case 3:
        return {
          mode: 'randomBetweenGradients',
          min: this.gradientKeys(m.minGradient),
          max: this.gradientKeys(m.maxGradient),
        };
      case 4:
        return { mode: 'randomColor', gradient: this.gradientKeys(m.maxGradient) };
      default:
        throw new SkipError('unknown-gradient-state', `MinMaxGradient minMaxState=${state}`);
    }
  }

  /** Enabled module: `enabled: true` first, then its converted parameters. */
  module(mod: YamlMap): Record<string, unknown> {
    const { enabled: _drop, ...rest } = this.conv(mod) as Record<string, unknown>;
    void _drop;
    return { enabled: true, ...rest };
  }

  /** Generic conversion of a serialized value; drops null refs and bookkeeping keys. */
  conv(v: YamlValue | undefined): unknown {
    if (v === undefined) return undefined;
    if (Array.isArray(v)) {
      // Entries that collapse to nothing (e.g. {sprite: null-ref}) carry no information.
      return v
        .map((x) => this.conv(x))
        .filter((x) => x !== undefined && !(isMap(x as YamlValue) && Object.keys(x as object).length === 0));
    }
    if (!isMap(v)) return v;
    if ('fileID' in v && Object.keys(v).every((k) => ['fileID', 'guid', 'type'].includes(k))) {
      const ref = asRef(v);
      if (!ref || ref.fileId === '0') return undefined;
      return this.ref(ref.guid, ref.fileId);
    }
    if ('minMaxState' in v && 'maxCurve' in v) return this.curve(v);
    if ('minMaxState' in v && ('maxGradient' in v || 'maxColor' in v)) return this.gradient(v);
    const ks = Object.keys(v);
    if (ks.length > 0 && ks.length <= 4 && ks.every((k) => 'xyzw'.includes(k) && k.length === 1)) {
      if (ks.every((k) => typeof v[k] === 'number')) return ks.map((k) => r5(v[k] as number));
    }
    if (ks.length === 4 && ['r', 'g', 'b', 'a'].every((k) => typeof v[k] === 'number')) {
      return this.color(v);
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (DROP_KEYS.has(k)) continue;
      const c = this.conv(x);
      if (c === undefined) continue;
      out[k] = typeof c === 'number' ? r5(c) : c;
    }
    return out;
  }

  subEmitters(mod: YamlMap): unknown[] {
    const out: unknown[] = [];
    for (const e of asSeq(mod.subEmitters)) {
      const em = asMap(e);
      const target = asRef(em?.emitter);
      if (!em || !target || target.fileId === '0') continue;
      const name = target.guid ? undefined : this.emitterName(target.fileId);
      if (!target.guid && name === undefined) {
        throw new SkipError('dangling-subemitter', `sub-emitter fileID ${target.fileId} not in prefab`);
      }
      out.push({
        emitter: name ?? this.ref(target.guid, target.fileId),
        type: asNum(em.type) ?? 0,
        properties: asNum(em.properties) ?? 0,
        emitProbability: r5(asNum(em.emitProbability) ?? 1),
      });
    }
    return out;
  }
}

/* --------------------------------------------------------------- materials */

function materialRef(conv: Converter, ctx: BuildContext, guid: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...conv.ref(guid, '0') };
  const text = ctx.materialText(guid);
  if (!text || !isUnityTextYaml(text)) return out;
  let docs: UnityDoc[];
  try {
    docs = parseUnityDocs(text);
  } catch {
    return { ...out, materialParse: 'failed' }; // reference is still valid; say so, don't hide it
  }
  const mat = docs.find((d) => d.type === 'Material');
  if (!mat) return out;
  const sh = asRef(mat.body.m_Shader);
  if (sh?.guid) out.shader = conv.ref(sh.guid, sh.fileId);
  else if (sh && sh.fileId !== '0') out.shader = { fileId: sh.fileId, builtin: true };
  const textures: Record<string, unknown>[] = [];
  const saved = asMap(mat.body.m_SavedProperties);
  for (const entry of asSeq(saved?.m_TexEnvs)) {
    const em = asMap(entry);
    if (!em) continue;
    let slot: string | undefined;
    let tex: YamlValue | undefined;
    if ('first' in em) {
      slot = String(asMap(em.first)?.name ?? '');
      tex = asMap(em.second)?.m_Texture;
    } else {
      slot = Object.keys(em)[0];
      tex = asMap(em[slot])?.m_Texture;
    }
    const t = asRef(tex);
    if (!slot || !t?.guid) continue;
    textures.push({ slot, ...conv.ref(t.guid, t.fileId) });
  }
  if (textures.length) out.textures = textures;
  return out;
}

/* ---------------------------------------------------------------- hierarchy */

interface Node {
  path: string;
  parent: string | null;
  go: UnityDoc;
  transform: UnityDoc;
  components: UnityDoc[];
}

const CORE_MODULES: Array<[out: string, src: string]> = [
  ['emission', 'EmissionModule'],
  ['shape', 'ShapeModule'],
  ['colorOverLifetime', 'ColorModule'],
  ['sizeOverLifetime', 'SizeModule'],
  ['textureSheetAnimation', 'UVModule'],
  ['subEmitters', 'SubModule'],
];

export function buildRecipe(text: string, pack: PackInfo, prefab: { path: string; guid: string }, ctx: BuildContext): RecipePayload {
  if (!isUnityTextYaml(text.slice(0, 16))) {
    throw new SkipError('binary-serialization', 'asset is not text-serialized YAML (binary or other)');
  }
  let docs: UnityDoc[];
  try {
    docs = parseUnityDocs(text);
  } catch (e) {
    if (e instanceof UnityYamlError) throw new SkipError('yaml-parse-error', e.message);
    throw e;
  }
  if (docs.some((d) => d.type === 'PrefabInstance')) {
    throw new SkipError('nested-prefab-instance', 'prefab embeds a PrefabInstance (variant/nested); source not flattened');
  }
  const byId = new Map(docs.map((d) => [d.fileId, d]));
  const effectOnly = !docs.some((d) => d.type === 'ParticleSystem');
  if (effectOnly && !docs.some((d) => d.type in EFFECT_KIND)) {
    throw new SkipError('no-effect-component', 'prefab has neither a ParticleSystem nor another effect component');
  }

  // --- walk the transform hierarchy depth-first, in m_Children order
  const nodes: Node[] = [];
  const nodeByGo = new Map<string, Node>();
  const seen = new Set<string>();
  const walk = (tr: UnityDoc, parentPath: string | null, index: number, siblings: string[]): void => {
    if (seen.has(tr.fileId)) throw new SkipError('hierarchy-cycle', `transform &${tr.fileId} visited twice`);
    seen.add(tr.fileId);
    const goRef = asRef(tr.body.m_GameObject);
    const go = goRef ? byId.get(goRef.fileId) : undefined;
    if (!go) throw new SkipError('dangling-gameobject', `transform &${tr.fileId} has no GameObject`);
    const name = String(go.body.m_Name ?? '');
    const dup = siblings.filter((s) => s === name).length > 1;
    const seg = dup ? `${name}[${index}]` : name;
    const path = parentPath === null ? seg : `${parentPath}/${seg}`;
    const components = asSeq(go.body.m_Component).map((c) => {
      const id = asRef(asMap(c)?.component)?.fileId;
      const doc = id ? byId.get(id) : undefined;
      if (!doc) throw new SkipError('dangling-component', `component ${id} of "${path}" not in prefab`);
      return doc;
    });
    const node: Node = { path, parent: parentPath, go, transform: tr, components };
    nodes.push(node);
    nodeByGo.set(go.fileId, node);
    const kids = asSeq(tr.body.m_Children).map((c) => {
      const id = asRef(c)?.fileId;
      const doc = id ? byId.get(id) : undefined;
      if (!doc) throw new SkipError('dangling-child', `child transform ${id} of "${path}" not in prefab`);
      return doc;
    });
    const kidNames = kids.map((k) => {
      const g = asRef(k.body.m_GameObject);
      return String((g ? byId.get(g.fileId) : undefined)?.body.m_Name ?? '');
    });
    kids.forEach((k, i) => walk(k, path, i, kidNames));
  };
  const roots = docs.filter(
    (d) => (d.type === 'Transform' || d.type === 'RectTransform') && asRef(d.body.m_Father)?.fileId === '0',
  );
  if (roots.length === 0) throw new SkipError('no-root-transform', 'no root Transform');
  const rootNames = roots.map((t) => String(byId.get(asRef(t.body.m_GameObject)?.fileId ?? '')?.body.m_Name ?? ''));
  roots.forEach((t, i) => walk(t, null, i, rootNames));

  const psNodeByPsId = new Map<string, string>();
  for (const n of nodes) for (const c of n.components) if (c.type === 'ParticleSystem') psNodeByPsId.set(c.fileId, n.path);
  const conv = new Converter(ctx, (id) => psNodeByPsId.get(id));
  if (effectOnly) return buildEffectPayload(nodes, conv, ctx, pack, prefab);

  // --- particle nodes
  const particleNodes: Record<string, unknown>[] = [];
  const renderModes = new Set<number>();
  let durationMax = 0;
  let loops = false;
  for (const n of nodes) {
    const ps = n.components.find((c) => c.type === 'ParticleSystem');
    if (!ps) continue;
    const b = ps.body;
    const rend = n.components.find((c) => c.type === 'ParticleSystemRenderer');

    const main: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) {
      if (DROP_KEYS.has(k) || k.endsWith('Module')) continue;
      const c = conv.conv(v);
      if (c !== undefined) main[k] = typeof c === 'number' ? r5(c) : c;
    }
    const init = asMap(b.InitialModule);
    if (!init) throw new SkipError('missing-initial-module', `"${n.path}" ParticleSystem has no InitialModule`);
    const initOut = conv.conv(init) as Record<string, unknown>;
    delete initOut.enabled;
    if (init.size3D !== 1) for (const k of ['startSizeY', 'startSizeZ']) delete initOut[k];
    if (init.rotation3D !== 1) for (const k of ['startRotationX', 'startRotationY']) delete initOut[k];
    Object.assign(main, initOut);

    const node: Record<string, unknown> = {
      path: n.path,
      active: n.go.body.m_IsActive === 1,
      transform: {
        position: conv.conv(n.transform.body.m_LocalPosition),
        rotation: conv.conv(n.transform.body.m_LocalRotation),
        scale: conv.conv(n.transform.body.m_LocalScale),
      },
      main,
    };
    for (const [outKey, srcKey] of CORE_MODULES) {
      const mod = asMap(b[srcKey]);
      if (!mod) continue;
      if (mod.enabled !== 1) {
        node[outKey] = { enabled: false };
        continue;
      }
      node[outKey] =
        srcKey === 'SubModule'
          ? { enabled: true, emitters: conv.subEmitters(mod) }
          : conv.module(mod);
    }
    const others: Record<string, unknown> = {};
    const coreSrc = new Set(CORE_MODULES.map(([, s]) => s).concat('InitialModule'));
    for (const [k, v] of Object.entries(b)) {
      if (!k.endsWith('Module') || coreSrc.has(k)) continue;
      const mod = asMap(v);
      if (mod?.enabled === 1) others[k] = conv.module(mod);
    }
    node.otherEnabledModules = others;

    if (rend) {
      const rb = rend.body;
      const rOut: Record<string, unknown> = {};
      for (const k of [
        'm_Enabled', 'm_RenderMode', 'm_SortMode', 'm_SortingFudge', 'm_SortingLayerID', 'm_SortingOrder',
        'm_RendererPriority', 'm_MinParticleSize', 'm_MaxParticleSize', 'm_CameraVelocityScale',
        'm_VelocityScale', 'm_LengthScale', 'm_NormalDirection', 'm_RenderAlignment', 'm_Pivot', 'm_Flip',
        'm_AllowRoll', 'm_MeshDistribution', 'm_CastShadows', 'm_ReceiveShadows', 'm_UseCustomVertexStreams',
        'm_VertexStreams', 'm_Mesh', 'm_Mesh1', 'm_Mesh2', 'm_Mesh3',
      ]) {
        const c = conv.conv(rb[k]);
        if (c !== undefined) rOut[k] = typeof c === 'number' ? r5(c) : c;
      }
      const mats: unknown[] = [];
      for (const m of asSeq(rb.m_Materials)) {
        const ref = asRef(m);
        if (!ref || ref.fileId === '0') continue;
        mats.push(ref.guid ? materialRef(conv, ctx, ref.guid) : { fileId: ref.fileId });
      }
      rOut.materials = mats;
      node.renderer = rOut;
      const rm = asNum(rb.m_RenderMode);
      if (rm !== undefined && rb.m_Enabled === 1) renderModes.add(rm);
    } else {
      node.renderer = null;
    }

    particleNodes.push(node);
    durationMax = Math.max(durationMax, asNum(b.lengthInSec) ?? 0);
    if (b.looping === 1) loops = true;
  }

  // --- full hierarchy (child transforms, non-particle GameObjects included)
  const hierarchy = nodes.map((n) => ({
    path: n.path,
    parent: n.parent,
    active: n.go.body.m_IsActive === 1,
    components: n.components.map((c) => componentLabel(c, ctx)),
    localPosition: conv.conv(n.transform.body.m_LocalPosition),
    localRotation: conv.conv(n.transform.body.m_LocalRotation),
    localScale: conv.conv(n.transform.body.m_LocalScale),
  }));

  const rootName = nodes[0]?.path ?? '';
  const payload = {
    schema: 'vfx-extracted-recipe/1',
    source: { pack: pack.name, vendor: pack.vendor, prefabPath: prefab.path, prefabGuid: prefab.guid },
    prefab: { name: rootName, gameObjectCount: nodes.length, particleNodeCount: particleNodes.length },
    notes: [
      'Values are Unity serialized parameters; enum fields keep Unity numeric codes.',
      'Curve keys are [time, value] with the curve scalar applied; tangents are not kept.',
      'Parameters of disabled modules are omitted; their enabled flag is kept.',
      'Materials, textures, meshes and shaders are references (guid + source path) only; no asset bytes are included.',
    ],
    particleNodes,
    hierarchy,
  };
  return {
    yaml: toYaml(payload),
    kind: 'particle',
    effectKinds: [],
    effectNodeCount: 0,
    particleNodeCount: particleNodes.length,
    nodeCount: nodes.length,
    prefabName: rootName,
    summary: { durationMax: r5(durationMax), loops, renderModes: [...renderModes].sort((a, b) => a - b) },
  };
}

function componentLabel(c: UnityDoc, ctx: BuildContext): string {
  if (c.type !== 'MonoBehaviour') return c.type;
  const s = asRef(c.body.m_Script);
  if (!s?.guid) return 'MonoBehaviour';
  const path = ctx.pathOf(s.guid);
  return path ? `MonoBehaviour(${path})` : `MonoBehaviour(guid:${s.guid})`;
}

/* ------------------------------------------------- effect-only (no ParticleSystem) */

/** Serialized component type -> effect kind. Order defines the order of `effectKinds`. */
const EFFECT_KIND: Record<string, string> = {
  LineRenderer: 'line',
  TrailRenderer: 'trail',
  MeshFilter: 'mesh',
  MeshRenderer: 'mesh',
  SkinnedMeshRenderer: 'mesh',
  Light: 'light',
  Animator: 'animation',
  Animation: 'animation',
  AudioSource: 'audio',
  MonoBehaviour: 'script',
};
const KIND_ORDER = ['line', 'trail', 'mesh', 'light', 'animation', 'audio', 'script'];

function buildEffectPayload(
  nodes: Node[],
  conv: Converter,
  ctx: BuildContext,
  pack: PackInfo,
  prefab: { path: string; guid: string },
): RecipePayload {
  const kinds = new Set<string>();
  const effectNodes: Record<string, unknown>[] = [];
  for (const n of nodes) {
    const comps: Record<string, unknown>[] = [];
    for (const c of n.components) {
      const kind = EFFECT_KIND[c.type];
      if (!kind) continue;
      kinds.add(kind);
      const params = conv.conv(c.body) as Record<string, unknown>;
      // Materials get the same guid + path (+ shader / texture slots) treatment as particle renderers.
      if ('m_Materials' in c.body) {
        const mats: unknown[] = [];
        for (const m of asSeq(c.body.m_Materials)) {
          const ref = asRef(m);
          if (!ref || ref.fileId === '0') continue;
          mats.push(ref.guid ? materialRef(conv, ctx, ref.guid) : { fileId: ref.fileId });
        }
        params.m_Materials = mats;
      }
      comps.push({ type: c.type, ...params });
    }
    if (comps.length === 0) continue;
    effectNodes.push({
      path: n.path,
      active: n.go.body.m_IsActive === 1,
      transform: {
        position: conv.conv(n.transform.body.m_LocalPosition),
        rotation: conv.conv(n.transform.body.m_LocalRotation),
        scale: conv.conv(n.transform.body.m_LocalScale),
      },
      components: comps,
    });
  }
  const effectKinds = KIND_ORDER.filter((k) => kinds.has(k));
  const hierarchy = nodes.map((n) => ({
    path: n.path,
    parent: n.parent,
    active: n.go.body.m_IsActive === 1,
    components: n.components.map((c) => componentLabel(c, ctx)),
  }));
  const rootName = nodes[0]?.path ?? '';
  const payload = {
    schema: 'vfx-extracted-effect/1',
    source: { pack: pack.name, vendor: pack.vendor, prefabPath: prefab.path, prefabGuid: prefab.guid },
    prefab: { name: rootName, gameObjectCount: nodes.length, effectNodeCount: effectNodes.length, effectKinds },
    notes: [
      'Prefab has no ParticleSystem; effect components (line/trail/mesh/light/animation/audio/script) are captured.',
      'Values are Unity serialized parameters; enum fields keep Unity numeric codes.',
      'Meshes, materials, shaders, textures, controllers, clips, audio clips and scripts are references (guid + source path) only; no asset bytes are included.',
    ],
    effectNodes,
    hierarchy,
  };
  return {
    yaml: toYaml(payload),
    kind: 'effect',
    effectKinds,
    effectNodeCount: effectNodes.length,
    particleNodeCount: 0,
    nodeCount: nodes.length,
    prefabName: rootName,
    summary: { durationMax: 0, loops: false, renderModes: [] },
  };
}
