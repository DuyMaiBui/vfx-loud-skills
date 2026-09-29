import { getVocab, splitName } from '../../server/src/vocab.ts';
import { asMap, asSeq, type YamlMap, type YamlValue } from '../extract/unity-yaml.ts';
import { parsePayload } from '../extract/enrich.ts';
import { on } from '../extract/facets.ts';
import type { GraphRules } from './rules.ts';

export type AssetKind = 'material' | 'texture' | 'shader' | 'mesh';

export interface AssetRef {
  kind: AssetKind;
  guid: string;
  path: string | null;
  external: boolean;
  /** material only: the shader guid + texture guids it binds. */
  shader?: string;
  textures?: Array<{ slot: string; guid: string }>;
}

export interface PayloadGraphFacts {
  nodeCount: number;
  /** Stable text: node paths (root + colour/version words dropped) with their enabled modules. */
  signature: string;
  assets: AssetRef[];
}

export function colourTerms(): Set<string> {
  return new Set(Object.values(getVocab().colours).flatMap((c) => c.terms));
}

/** Tokens of `text` without colour words, version tokens and configured extras. */
export function stemTokens(text: string, versionPattern: string, extra: string[] = []): string[] {
  const colours = colourTerms();
  const version = new RegExp(versionPattern);
  const drop = new Set(extra);
  return splitName(text).filter((t) => !colours.has(t) && !version.test(t) && !drop.has(t));
}

function moduleNames(node: YamlMap): string[] {
  if (Array.isArray(node.components)) {
    return asSeq(node.components).map((c) => String(asMap(c)?.type ?? '?')).sort();
  }
  return Object.entries(node)
    .filter(([k, v]) => asMap(v) && (k === 'main' || on(asMap(v)?.enabled)))
    .map(([k]) => k)
    .sort();
}

function nodeSignature(nodes: YamlMap[], versionPattern: string): string {
  return nodes
    .map((n) => {
      const segs = String(n.path ?? '').split('/');
      const rel = ['$', ...segs.slice(1).map((s) => stemTokens(s, versionPattern).join('-'))].join('/');
      return `${rel}:${moduleNames(n).join('+')}`;
    })
    .sort()
    .join('|');
}

const hasGuid = (m: YamlMap | undefined): m is YamlMap => !!m && typeof m.guid === 'string' && m.guid.length > 0;

function asset(kind: AssetKind, m: YamlMap): AssetRef {
  return { kind, guid: String(m.guid), path: typeof m.path === 'string' ? m.path : null, external: m.external === true || typeof m.path !== 'string' };
}

/** Walk the payload once: node signature + every material / texture / shader / mesh GUID reference. */
export function analysePayload(yaml: string, rules: Pick<GraphRules, 'assets'> & { versionTokenPattern: string }): PayloadGraphFacts {
  const doc = parsePayload(yaml);
  const nodes = asSeq(doc.particleNodes ?? doc.effectNodes).map((n) => asMap(n) ?? {});
  const found = new Map<string, AssetRef>();
  const put = (a: AssetRef): AssetRef => {
    const k = `${a.kind}:${a.guid}`;
    const have = found.get(k);
    if (have) return have;
    found.set(k, a);
    return a;
  };
  const meshKeys = new Set(rules.assets.meshKeys);

  const walk = (v: YamlValue, key: string): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
      return;
    }
    const m = asMap(v);
    if (!m) return;
    if (key === 'materials' && hasGuid(m)) {
      const mat = put(asset('material', m));
      const sh = asMap(m.shader);
      if (hasGuid(sh)) mat.shader = put(asset('shader', sh)).guid;
      const tex = asSeq(m.textures)
        .map((t) => asMap(t))
        .filter(hasGuid)
        .map((t) => ({ slot: String(t.slot ?? ''), guid: put(asset('texture', t)).guid }));
      if (tex.length) mat.textures = tex;
      return;
    }
    for (const [k, child] of Object.entries(m)) {
      const cm = asMap(child);
      if (meshKeys.has(k) && hasGuid(cm)) put(asset('mesh', cm));
      else if (k === 'sprite' && hasGuid(cm)) put(asset('texture', cm));
      else walk(child, k);
    }
  };
  for (const n of nodes) walk(n, 'node');

  return {
    nodeCount: nodes.length,
    signature: nodeSignature(nodes, rules.versionTokenPattern),
    assets: [...found.values()].sort((a, b) => (a.kind + a.guid < b.kind + b.guid ? -1 : 1)),
  };
}
