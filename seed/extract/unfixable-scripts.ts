/**
 * Recipes the extractor must not emit because their prefab needs a game C# script that bundles do not ship
 * (packs.json `stripScripts`) and renders nothing without it (cause `unfixable-script`, plan.md C9 / D21).
 * Data lives in `unfixable-scripts.json` next to packs.json; nothing here names a slug.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const Guid = z.string().regex(/^[0-9a-f]{32}$/);

export const UnfixableScriptsSchema = z.strictObject({
  note: z.string().optional(),
  version: z.literal(1),
  entries: z.array(
    z.strictObject({
      slug: z.string().min(1),
      pack: z.string().min(1),
      prefabGuid: Guid,
      prefabPath: z.string().min(1),
      scripts: z.array(z.strictObject({ name: z.string().min(1), guid: Guid })).min(1),
      cause: z.literal('unfixable-script'),
      evidence: z.string().min(1),
    }),
  ),
});
export type UnfixableEntry = z.infer<typeof UnfixableScriptsSchema>['entries'][number];

export const UNFIXABLE_SCRIPTS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'unfixable-scripts.json');

export function loadUnfixableScripts(file: string = UNFIXABLE_SCRIPTS_FILE): UnfixableEntry[] {
  const parsed = UnfixableScriptsSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`unfixable-scripts.json invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  return parsed.data.entries;
}

/**
 * Decide whether a prefab is on the list. Throws when it is listed but its YAML no longer references any listed
 * script (the list is stale: the prefab changed, so the recorded evidence no longer applies).
 */
export function unfixableScriptsFor(entry: UnfixableEntry | undefined, prefabYaml: string): UnfixableEntry | null {
  if (!entry) return null;
  if (!entry.scripts.some((s) => prefabYaml.includes(s.guid))) {
    throw new Error(`unfixable-scripts.json: ${entry.slug} (${entry.prefabGuid}) no longer references ${entry.scripts.map((s) => s.name).join(', ')}; remove or re-measure the entry`);
  }
  return entry;
}
