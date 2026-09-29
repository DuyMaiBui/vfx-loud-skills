import { getFacetRules } from '../../server/src/facets.ts';
import { singular, splitName } from '../../server/src/vocab.ts';
import type { EffectInfo, NodeInfo } from './facets.ts';

/**
 * `meta.behavior`: 1-3 plain sentences describing what a viewer SEES over time, phrased from the
 * analysed nodes and the derived text facets. All wording lives in facets.json `behavior`. No
 * licence / guid text, no numbers beyond one rounded duration.
 */
export interface BehaviorContext {
  category: string[];
  element: string[];
  colors: string[];
}

const sec = (x: number): string => (x < 0.1 ? 'under 0.1 s' : `${Math.round(x * 10) / 10} s`);

function joinList(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

function layerPhrases(nodes: NodeInfo[]): string[] {
  const rules = getFacetRules().behavior;
  const out: string[] = [];
  for (const n of nodes) {
    const tokens = splitName(n.path.split('/').slice(-1)[0] ?? '').map(singular);
    const hit = tokens.map((t) => rules.layerNouns[t]).find(Boolean);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

export function behaviorFromNodes(nodes: NodeInfo[], effect: EffectInfo | undefined, ctx: BehaviorContext): string | undefined {
  const b = getFacetRules().behavior;
  if (!nodes.length) {
    if (!effect) return undefined;
    const kinds = effect.kinds.map((k) => b.effect.kinds[k]).filter(Boolean);
    return kinds.length ? b.effect.template.replace('{kinds}', joinList(kinds)) : undefined;
  }
  const primary = nodes.reduce((best, n) => (n.weight > best.weight ? n : best), nodes[0]);
  const looping = nodes.some((n) => n.looping);
  // A role category (muzzle, projectile...) beats a theme word taken from the name (storm -> weather).
  const nounCat = b.nounCategoryPriority.find((c) => ctx.category.includes(c)) ?? ctx.category[0];
  const noun = (ctx.element[0] && b.nounByElement[ctx.element[0]]) || (nounCat && b.nounByCategory[nounCat]) || b.defaultNoun;
  const colour = ctx.colors[0] ? `${ctx.colors[0]} ` : '';
  const emission = primary.burst ? b.emission.burst : b.emission.stream;
  const main = b.motionPriority.find((m) => primary.motion.includes(m)) ?? 'static';
  const extra = primary.motion.includes('falling') && main !== 'falling' ? [b.motion.falling] : [];
  const shape = main === 'static' ? '' : ` from ${b.shape[primary.shape] ?? b.shape.point}`;

  const trends = [...(primary.sizeTrend === 'grow' ? [b.grow] : primary.sizeTrend === 'shrink' ? [b.shrink] : []), ...(primary.fade ? [b.fade] : [])];
  const trendText = trends.join(b.trendJoin);
  const fill = (tpl: string, x: number): string => tpl.replace('{sec}', sec(x));
  const t = Math.max(...nodes.map((n) => n.visibleSec));
  const tail = looping
    ? [...(trendText ? [trendText] : []), fill(b.repeat, t)]
    : t > 0
      ? [trendText ? `${trendText} ${fill(b.span, t)}` : fill(b.lasts, t)]
      : trendText ? [trendText] : [];
  const clauses = [`${b.motion[main]}${shape}`, ...extra, ...tail];
  const first = `A ${b.loop[looping ? 'loop' : 'one-shot']} ${emission} of ${colour}${noun} ${joinList(clauses)}.`;

  const others = nodes.filter((n) => n !== primary);
  const phrases = layerPhrases(others);
  const layers = !others.length ? '' : phrases.length ? ` Extra layers add ${joinList(phrases)}.` : ` Built from ${nodes.length} layers.`;
  return `${first}${layers} Loops: ${looping ? 'yes' : 'no'}.`;
}

/** Hand-written recipes carry a plain `layers:` list; describe it without guessing at motion. */
export function behaviorFromLayers(yaml: string, tags: string[]): string | undefined {
  const layers = [...yaml.matchAll(/^\s*-\s*component:\s*(\S+)/gm)].map((m) => m[1].replace(/-/g, ' '));
  if (!layers.length) return undefined;
  const lifetimes = [...yaml.matchAll(/^\s*lifetime:\s*([\d.]+)/gm)].map((m) => Number(m[1]));
  const t = lifetimes.length ? ` The longest layer lasts ${sec(Math.max(...lifetimes))}.` : '';
  const looping = tags.includes('loop') || tags.includes('looping');
  return `Layered effect of ${joinList(layers)}.${t} Loops: ${looping ? 'yes' : 'no'}.`;
}
