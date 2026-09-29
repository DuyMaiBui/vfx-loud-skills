import { conceptsForTokens, coloursForTokens, splitName } from '../../server/src/vocab.ts';
import { coreName } from '../../server/src/search-doc.ts';
import { parseUnityDocs, asMap, asNum, asSeq, type YamlMap, type YamlValue } from './unity-yaml.ts';

/**
 * Deterministic metadata for an EXTRACTED record, from data we already hold: pack, path segments,
 * split name tokens and the recipe's own parameters (loop / duration / dominant start colour /
 * sub-emitters / node count). No model, no network: same input -> same output, so the extractor and
 * the re-index command agree byte for byte.
 */
export interface EnrichInput {
  name: string; // "Bubbles_Burst (Stylized Water Effects)"
  prefabPath: string;
  packName: string;
  vendor: string;
  metaStyle: string[];
  kind: 'particle' | 'effect';
  effectKinds?: string[];
  yaml: string;
  existingTags: string[];
}

export interface Enriched {
  keywords: string[];
  style: string[];
  tags: string[];
  description: string;
  facts: PayloadFacts;
}

export interface PayloadFacts {
  nodes: number;
  looping: boolean;
  durationMax: number;
  colours: string[];
  hasSubEmitters: boolean;
}

export function parsePayload(yaml: string): YamlMap {
  // Re-use the Unity-YAML subset parser: nest our document under one root key inside a fake doc.
  const wrapped = '--- !u!1 &1\nR:\n' + yaml.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n');
  return parseUnityDocs(wrapped)[0].body;
}

function num(v: YamlValue | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/** Hue/saturation/value bucket -> a plain colour word. Thresholds are simple and documented here. */
export function colourName(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  if (v < 0.18) return 'black';
  if (s < 0.16) return v > 0.8 ? 'white' : 'grey';
  let h: number;
  if (d === 0) h = 0;
  else if (max === r) h = ((g - b) / d + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 15 || h >= 345) return s < 0.45 && v > 0.8 ? 'pink' : 'red';
  if (h < 40) return 'orange';
  if (h < 68) return 'yellow';
  if (h < 160) return 'green';
  if (h < 200) return 'cyan';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

/** Start colour of a node as [r,g,b,weight] (weight = alpha), or undefined when not derivable. */
function startColour(main: YamlMap): [number, number, number, number] | undefined {
  const sc = asMap(main.startColor);
  if (!sc) return undefined;
  const col = (c: YamlValue | undefined): number[] | undefined =>
    Array.isArray(c) && c.length >= 3 ? c.map((x) => (typeof x === 'number' ? x : 0)) : undefined;
  const mode = sc.mode;
  let rgba: number[] | undefined;
  if (mode === 'color') rgba = col(sc.color);
  else if (mode === 'randomBetweenColors') {
    const a = col(sc.min);
    const b = col(sc.max);
    if (a && b) rgba = a.map((x, i) => (x + b[i]) / 2);
  } else {
    const g = asMap(sc.gradient) ?? asMap(sc.max);
    const keys = asSeq(g?.colorKeys);
    const k = keys.find((x) => Array.isArray(x)) as YamlValue[] | undefined;
    if (k && k.length >= 4) rgba = [k[1], k[2], k[3], 1].map((x) => (typeof x === 'number' ? x : 0));
  }
  if (!rgba) return undefined;
  return [rgba[0], rgba[1], rgba[2], rgba[3] ?? 1];
}

export function payloadFacts(yaml: string): PayloadFacts {
  const doc = parsePayload(yaml);
  const nodes = asSeq(doc.particleNodes ?? doc.effectNodes).map((n) => asMap(n) ?? {});
  const facts: PayloadFacts = { nodes: nodes.length, looping: false, durationMax: 0, colours: [], hasSubEmitters: false };
  const votes = new Map<string, number>();
  for (const n of nodes) {
    const main = asMap(n.main);
    if (main) {
      if (main.looping === 1) facts.looping = true;
      facts.durationMax = Math.max(facts.durationMax, num(main.lengthInSec) ?? 0);
      const c = startColour(main);
      if (c && c[3] > 0.05) {
        const name = colourName(c[0], c[1], c[2]);
        votes.set(name, (votes.get(name) ?? 0) + c[3]);
      }
    }
    const sub = asMap(n.subEmitters);
    if (sub && (sub.enabled === true || sub.enabled === 'true') && asSeq(sub.emitters).length > 0) facts.hasSubEmitters = true;
  }
  const total = [...votes.values()].reduce((a, b) => a + b, 0);
  facts.colours = [...votes.entries()]
    .filter(([name, w]) => w / total >= 0.3 && name !== 'white' && name !== 'grey' && name !== 'black')
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 2)
    .map(([name]) => name);
  return facts;
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];

export function enrichExtracted(i: EnrichInput): Enriched {
  const rel = i.prefabPath.split('/Prefabs/').slice(1).join('/Prefabs/') || i.prefabPath;
  const folderTokens = rel.split('/').slice(0, -1).flatMap(splitName);
  const nameTokens = splitName(coreName(i.name));
  const tokens = [...nameTokens, ...folderTokens];
  const facts = payloadFacts(i.yaml);
  const c = conceptsForTokens(tokens);
  const nameColours = coloursForTokens(nameTokens);
  const colours = uniq([...nameColours, ...facts.colours]).slice(0, 3);

  const keywords = uniq([
    ...c.element,
    ...c.use,
    ...c.weather,
    ...colours,
    facts.looping ? 'looping' : 'one-shot',
    ...(facts.nodes >= 6 ? ['layered'] : []),
    ...(facts.hasSubEmitters ? ['sub-emitter'] : []),
    i.kind === 'effect' ? 'effect' : 'particle',
    ...(i.effectKinds ?? []).map((k) => `${k}-effect`),
  ]);
  const style = uniq(i.metaStyle);
  const words = [
    ...(colours.length ? [colours.join('-')] : []),
    ...[...c.element, ...c.weather].filter((x) => x !== 'ambient'),
    ...c.use,
  ];
  const what = words.length ? words.join(' ') : nameTokens.join(' ');
  const shape =
    i.kind === 'effect'
      ? `${facts.nodes} effect node(s) (${(i.effectKinds ?? []).join(', ')})`
      : `${facts.nodes} particle node(s), ${facts.looping ? 'looping' : 'one-shot'}, ${facts.durationMax}s${facts.hasSubEmitters ? ', with sub-emitters' : ''}`;
  const description =
    `${what} ${i.kind === 'effect' ? 'effect' : 'VFX'} "${coreName(i.name)}" from ${i.vendor} ${i.packName}` +
    ` (${style.join(', ') || 'unstyled'} style): ${shape}. Parameters only; assets are guid + path references.`;

  const tags = uniq([
    ...i.existingTags.filter((t) => t !== 'particle' || i.kind === 'particle'),
    ...keywords,
    ...style,
  ]).slice(0, 16);
  return { keywords, style, tags, description, facts };
}
