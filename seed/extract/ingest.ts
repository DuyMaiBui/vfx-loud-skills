import fs from 'node:fs/promises';
import path from 'node:path';
import { VISIBILITIES, type Visibility } from '../../server/src/license.ts';

/** Minimal shape of an extractor record (`<slug>.json`); everything is re-validated by publish(). */
interface ExtractedRecord {
  type: 'recipe';
  slug: string;
  name: string;
  description: string;
  tags: string[];
  style: string[];
  category: string;
  license: string;
  /** Absent on records from before pack visibility existed: those are `project`. */
  visibility?: Visibility;
  fileName: string;
  meta: Record<string, unknown>;
  inline: string;
}

export interface IngestDeps {
  exists(type: string, slug: string): Promise<boolean>;
  publish(args: {
    type: 'recipe';
    slug: string;
    name: string;
    description: string;
    tags: string[];
    style: string[];
    category: string;
    license: string;
    visibility: Visibility;
    createdBy: string;
    fileName: string;
    b64: string;
    meta: Record<string, unknown>;
  }): Promise<{ uri: string }>;
}

export interface IngestResult {
  published: number;
  skippedExisting: number;
  failures: string[];
}

/** Every `<pack>/<slug>.json` under `dir` (pack `.log` / summary / skipped files are not records). */
export async function listRecordFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const pack of (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory())) {
    for (const f of await fs.readdir(path.join(dir, pack.name))) {
      if (f.endsWith('.json') && f !== 'summary.json') out.push(path.join(dir, pack.name, f));
    }
  }
  return out.sort();
}

/**
 * Publish extracted records through publish() (same licence gate as every other ingest), always
 * the record's own visibility (default project; global is refused). Idempotent exactly like seed/run.ts: an existing type+slug is skipped, so a
 * re-run creates no rows and bumps no versions. A rejected record is reported, never defaulted.
 */
export async function ingestExtracted(dir: string, deps: IngestDeps, limit?: number): Promise<IngestResult> {
  const files = (await listRecordFiles(dir)).slice(0, limit);
  const res: IngestResult = { published: 0, skippedExisting: 0, failures: [] };
  for (const file of files) {
    let rec: ExtractedRecord;
    try {
      rec = JSON.parse(await fs.readFile(file, 'utf8')) as ExtractedRecord;
      if (rec.type !== 'recipe' || typeof rec.inline !== 'string' || rec.meta?.extracted !== true) {
        throw new Error('not an extracted recipe record');
      }
      const visibility = rec.visibility ?? 'project';
      if (!(VISIBILITIES as readonly string[]).includes(visibility)) throw new Error(`unknown visibility "${String(visibility)}"`);
      if (visibility === 'global') throw new Error('extracted record refused: visibility "global"');
      if (await deps.exists(rec.type, rec.slug)) {
        res.skippedExisting++;
        continue;
      }
      await deps.publish({
        type: rec.type,
        slug: rec.slug,
        name: rec.name,
        description: rec.description,
        tags: rec.tags,
        style: rec.style,
        category: rec.category,
        license: rec.license,
        visibility,
        createdBy: 'seed',
        fileName: rec.fileName,
        b64: Buffer.from(rec.inline, 'utf8').toString('base64'),
        meta: rec.meta,
      });
      res.published++;
    } catch (err) {
      res.failures.push(`${path.basename(file)}: ${(err as Error).message}`);
    }
  }
  return res;
}
