/**
 * Recolour a stored recipe and (optionally) publish the result as a NEW record derived from it.
 *
 * The one entry point behind POST /v1/recolor, the `vfx_recolor` MCP tool and `npm run recolor`, so the
 * three surfaces cannot drift.
 *
 * The base record is never touched. With `publish: true` a new record is created with
 *   - slug        <base-slug>-recolor-<hex>   (hex = the most saturated colour a changed key ended on)
 *   - derived_from edge -> the base
 *   - license / license_class / ai_training inherited verbatim, visibility = project
 * and the call is idempotent: the same base + same result finds the record it made before and returns it
 * with `created: false`, publishing nothing.
 */
import { createHash } from 'node:crypto';
import { parsePayload } from '../../seed/extract/enrich.ts';
import { toYaml } from '../../seed/extract/yaml-emit.ts';
import { VfxError } from './errors.ts';
import { hexToColour } from './colour.ts';
import { recolor, type RecolorOptions, type RecolorResult } from './recolor.ts';
import * as store from './store.ts';

export interface RecolorRequest extends RecolorOptions {
  uri: string;
  /** Create (or find) a derived record for the result. Default false: compute only. */
  publish?: boolean;
  /** Return the recoloured payload object. Default true; false keeps a publish:true response small. */
  includePayload?: boolean;
}

export interface RecolorResponse extends Omit<RecolorResult, 'payload'> {
  base: { uri: string; recolorable: boolean | null; recolorReason: string | null };
  /** Recoloured payload (parsed). Absent when includePayload is false. */
  payload?: Record<string, unknown>;
  /** Only with publish:true. */
  published?: { uri: string; slug: string; created: boolean; visibility: string; license: string; sha256: string; download_url: string };
  /** Present when the base is not a validated recolour source (family verdict is not `good`). */
  warning?: string;
}

/**
 * The payload parser reads YAML `true` / `false` / `null` as the strings "true" / "false" / "null"; the
 * emitter would then quote them and change the file for every field, not just the colours. Restore them.
 * Safe because the emitter quotes a genuine string with that spelling, and `assertRoundTrips` proves it
 * for the payload at hand.
 */
function restoreScalars(v: unknown): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (Array.isArray(v)) return v.map(restoreScalars);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, restoreScalars(x)]));
  return v;
}

function assertRoundTrips(text: string, parsed: Record<string, unknown>): void {
  if (toYaml(parsed) !== text) {
    throw new VfxError('base payload does not round-trip through the recipe emitter; refusing to derive a record from it', 'invalid');
  }
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const hexOf = (h: string): string => h.replace(/^#/, '').slice(0, 6).toLowerCase();

/**
 * The colour the result reads as, for the slug: the most saturated colour any changed key ended on.
 * (summary.dominant is the most COMMON bucket, which is white on many effects and says nothing.)
 */
function readsAs(changes: { to: string }[]): string {
  let best = changes[0].to;
  let bestSat = -1;
  for (const { to } of changes) {
    const c = hexToColour(to);
    if (!c) continue;
    const max = Math.max(c.r, c.g, c.b);
    const sat = max === 0 ? 0 : (max - Math.min(c.r, c.g, c.b)) / max;
    if (sat > bestSat) (bestSat = sat, (best = to));
  }
  return best;
}

export async function recolorRecord(req: RecolorRequest): Promise<RecolorResponse> {
  if (!req.uri) throw new VfxError('uri is required');
  const { row, buffer } = await store.readFile(req.uri);
  if (row.type !== 'recipe') throw new VfxError(`only recipes can be recoloured, ${req.uri} is a ${row.type}`);
  const text = buffer.toString('utf8');
  let parsed: Record<string, unknown>;
  try {
    parsed = restoreScalars(parsePayload(text)) as Record<string, unknown>;
  } catch (e) {
    throw new VfxError(`cannot parse payload of ${req.uri}: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !('particleNodes' in parsed || 'effectNodes' in parsed)) {
    throw new VfxError(`${req.uri} is not an extracted recipe payload (no particleNodes / effectNodes)`);
  }

  const result = recolor(parsed, { targetColor: req.targetColor, hueShiftDeg: req.hueShiftDeg, preserveLuminance: req.preserveLuminance });
  if (!result.changes.length) throw new VfxError(`recolor changed no colour in ${req.uri} (no reachable colour keys, or the target equals the current colour)`);

  const recolorable = typeof row.meta.recolorable === 'boolean' ? row.meta.recolorable : null;
  const recolorReason = typeof row.meta.recolorReason === 'string' ? row.meta.recolorReason : null;
  const { payload, ...rest } = result;
  const out: RecolorResponse = {
    ...rest,
    base: { uri: row.uri, recolorable, recolorReason },
    ...(req.includePayload === false ? {} : { payload }),
    ...(recolorable === false ? { warning: `family is not a validated recolour source (${recolorReason}); fetch the real variant instead if one exists` } : {}),
  };
  if (!req.publish) return out;

  assertRoundTrips(text, parsed);
  const yaml = toYaml(payload);
  const digest = sha256(yaml);
  const hex = hexOf(readsAs(result.changes));
  // Same input -> same slug -> same record. A different result that lands on the same dominant colour
  // (e.g. preserveLuminance flipped) gets a digest suffix instead of overwriting or aliasing.
  let slug = `${row.slug}-recolor-${hex}`;
  let existing = await store.latestBySlug('recipe', slug);
  if (existing && (await store.payloadSha256(existing)) !== digest) {
    slug = `${slug}-${digest.slice(0, 6)}`;
    existing = await store.latestBySlug('recipe', slug);
  }
  let created = false;
  let target = existing;
  if (!target) {
    const facets = { ...((row.meta.facets as Record<string, unknown> | undefined) ?? {}), colors: result.summary.colourWords.filter((w) => w !== 'white' && w !== 'black' && w !== 'grey') };
    const meta: Record<string, unknown> = {
      pack: row.meta.pack,
      style: row.meta.style,
      facets,
      behavior: row.meta.behavior,
      keywords: [...new Set([...(Array.isArray(row.meta.keywords) ? (row.meta.keywords as string[]) : []), ...(facets.colors as string[])])],
      license_class: row.meta.license_class,
      ai_training: row.meta.ai_training,
      derived: { from: row.uri, transform: 'recolor', mode: result.mode, hueShiftDeg: result.hueShiftDeg, preserveLuminance: result.preserveLuminance, dominant: result.summary.dominant, keysRecolored: result.summary.keysRecolored },
    };
    for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k];
    const pub = await store.publish({
      type: 'recipe',
      slug,
      name: `${row.name} (recolor #${hex})`,
      description: `Recolour of ${row.name}: ${result.mode === 'target' ? 'hue moved toward the target colour' : `hue shifted ${result.hueShiftDeg} deg`}, ${result.summary.keysRecolored} colour keys changed. ${row.description}`.trim(),
      tags: row.tags,
      style: row.style,
      category: row.category,
      license: row.license,
      visibility: 'project',
      b64: Buffer.from(yaml, 'utf8').toString('base64'),
      fileName: `${slug}.yaml`,
      meta,
      derivedFrom: row.uri,
      createdBy: 'recolor',
    });
    target = await store.getByUri(pub.uri);
    created = true;
  }
  out.published = {
    uri: target.uri,
    slug: target.slug,
    created,
    visibility: target.visibility,
    license: target.license,
    sha256: digest,
    download_url: (await store.resolve(target.uri)).download_url,
  };
  return out;
}
