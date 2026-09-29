/**
 * Re-index existing rows IN PLACE: metadata + search text + embedding only. The payload file, its
 * sha256, the uri and the version are never touched. Idempotent: a row is updated only when its
 * computed index hash differs from `meta.index_hash`, so a second run changes nothing.
 *
 *   node seed/reindex.ts [--dry-run] [--limit N]
 *
 * Extracted recipes (meta.extracted): description, tags, style, meta.style, meta.keywords, meta.facets and
 * meta.behavior are regenerated from pack / path / name / payload parameters (seed/extract/enrich.ts).
 * Everything else (hand-written cc0 etc.): tags may GAIN vocabulary keywords, meta.keywords is set;
 * name, description and prose are never rewritten; meta.facets is derived from name / category / tags.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pool } from '../server/src/db.ts';
import { config } from '../server/src/config.ts';
import { getEmbedder } from '../server/src/embed.ts';
import { searchDocument } from '../server/src/search-doc.ts';
import { conceptsForTokens, coloursForTokens, splitName } from '../server/src/vocab.ts';
import { compactFacets, deriveTextFacets, type Facets } from '../server/src/facets.ts';
import { behaviorFromLayers } from './extract/behavior.ts';
import { enrichExtracted } from './extract/enrich.ts';
import type { PackConfig } from './extract/pipeline.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

interface Row {
  id: number;
  type: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  style: string[];
  category: string;
  storage_uri: string;
  meta: Record<string, unknown> & { source?: { prefabPath: string; vendor: string; pack: string }; pack?: string };
  search_text: string;
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];
const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, limit: { type: 'string' } }, strict: true });
  const packs = (JSON.parse(await fs.readFile(path.join(here, 'extract', 'packs.json'), 'utf8')) as { packs: PackConfig[] }).packs;
  const bySlug = new Map(packs.map((p) => [p.slug, p]));
  const embedder = getEmbedder();
  const limit = values.limit ? Number(values.limit) : undefined;

  const rows = (
    await pool.query<Row>('SELECT id, type, slug, name, description, tags, style, category, storage_uri, meta, search_text FROM resource ORDER BY id' + (limit ? ` LIMIT ${limit}` : ''))
  ).rows;
  let updated = 0;
  let unchanged = 0;
  const failures: string[] = [];

  for (const r of rows) {
    try {
      let description = r.description;
      let tags = r.tags;
      let style = r.style;
      let keywords: string[];
      let facets: Facets;
      let behavior: string | undefined;
      if (r.meta.extracted === true) {
        const pack = bySlug.get(String(r.meta.pack));
        const src = r.meta.source;
        if (!pack || !src) throw new Error(`extracted row without known pack/source (${r.meta.pack})`);
        const yaml = await fs.readFile(path.join(config.dataDir, r.storage_uri), 'utf8');
        const en = enrichExtracted({
          name: r.name,
          prefabPath: src.prefabPath,
          packName: pack.name,
          vendor: pack.vendor,
          metaStyle: pack.metaStyle ?? pack.style,
          kind: Array.isArray(r.meta.effectKinds) ? 'effect' : 'particle',
          effectKinds: (r.meta.effectKinds as string[] | undefined) ?? [],
          yaml,
          existingTags: r.tags,
        });
        ({ description, tags, style, keywords, facets, behavior } = { description: en.description, tags: en.tags, style: en.style, keywords: en.keywords, facets: en.facets, behavior: en.behavior });
      } else {
        const tokens = [...splitName(r.name), ...r.tags.flatMap(splitName)];
        const c = conceptsForTokens(tokens);
        keywords = uniq([...c.element, ...c.use, ...c.weather, ...coloursForTokens(tokens)]);
        tags = uniq([...r.tags, ...keywords]); // additions only; prose untouched
        const colours = coloursForTokens(tokens);
        facets = compactFacets({ ...deriveTextFacets([...splitName(r.name), ...splitName(r.category)], r.tags.flatMap(splitName)), colors: colours });
        if (r.type === 'recipe') {
          const yaml = await fs.readFile(path.join(config.dataDir, r.storage_uri), 'utf8');
          behavior = behaviorFromLayers(yaml, r.tags);
        }
      }
      const doc = searchDocument({ name: r.name, description, category: r.category, tags, keywords });
      const hash = createHash('sha1').update(JSON.stringify([doc.embedText, doc.searchText, description, tags, style, keywords, facets, behavior ?? null])).digest('hex');
      if (r.meta.index_hash === hash && same(r.tags, tags) && r.description === description && r.search_text === doc.searchText) {
        unchanged++;
        continue;
      }
      if (!values['dry-run']) {
        const vec = await embedder.embed(doc.embedText);
        const literal = vec.map((x) => Number(x.toFixed(6))).join(',');
        await pool.query(
          `UPDATE resource
              SET description = $2, tags = $3, style = $4, search_text = $5, embedding = $6::vector,
                  meta = (meta - 'facets' - 'behavior') || $7::jsonb || jsonb_build_object('index_hash', $8::text)
                              || CASE WHEN $9::boolean THEN jsonb_build_object('style', $4::text[]) ELSE '{}'::jsonb END
            WHERE id = $1`,
          [r.id, description, tags, style, doc.searchText, `[${literal}]`, JSON.stringify({ keywords, facets, ...(behavior ? { behavior } : {}) }), hash, r.meta.extracted === true],
        );
      }
      updated++;
    } catch (e) {
      failures.push(`${r.type}/${r.slug}: ${(e as Error).message}`);
    }
  }
  for (const f of failures.slice(0, 10)) console.error(`  ! ${f}`);
  console.log(`reindex${values['dry-run'] ? ' (dry-run)' : ''}: rows=${rows.length} updated=${updated} unchanged=${unchanged} failed=${failures.length}`);
  if (failures.length) process.exitCode = 1;
  await pool.end();
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
