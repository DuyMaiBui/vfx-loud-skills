import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aiTrainingAllowed,
  licenseClassOf,
  publish,
  relinkAll,
  type ResourceType,
} from '../server/src/store.ts';
import { pool } from '../server/src/db.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const VFX_ROOT =
  process.env.VFX_SOURCE_ROOT ??
  '/var/home/mike/Documents/Work/The1/Unity/VFXSource/Assets/Synty/PolygonParticleFX';

interface Entry {
  type: ResourceType;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  style: string[];
  category: string;
  license?: string;
  licenseClass?: string;
  aiTraining?: boolean;
  source?: string;
  contentFile?: string;
  inline?: string;
  fileName?: string;
}

async function exists(type: string, slug: string): Promise<boolean> {
  const r = await pool.query(
    'SELECT 1 FROM resource WHERE type = $1 AND slug = $2 LIMIT 1',
    [type, slug],
  );
  return r.rowCount !== 0;
}

interface KenneyGroup {
  name: string;
  description: string;
  tags: string[];
  style: string[];
  category: string;
}

const KENNEY_DIR = path.join(here, 'vendor', 'kenney');

/** Seed Kenney Particle Pack (CC0). Metadata semantic lấy từ kenney-groups.json (viết tay). */
async function seedKenney(failures: string[]): Promise<number> {
  let files: string[];
  try {
    files = (await fs.readdir(KENNEY_DIR)).filter((f) => /^[a-z]+_\d+\.png$/.test(f));
  } catch {
    console.log('\nkenney: chưa có seed/vendor/kenney — bỏ qua (chạy scripts/fetch-kenney.sh)');
    return 0;
  }
  if (files.length === 0) return 0;

  const rawGroups = await fs.readFile(path.join(here, 'kenney-groups.json'), 'utf8');
  const groups = (JSON.parse(rawGroups) as { groups: Record<string, KenneyGroup> }).groups;

  let newCount = 0;
  let skipCount = 0;
  let unknownGroup = 0;

  for (const file of files) {
    const m = /^([a-z]+)_(\d+)\.png$/.exec(file);
    if (!m) continue;
    const [, prefix, num] = m;
    const slug = `kenney-${prefix}-${num}`;
    if (await exists('texture', slug)) {
      skipCount++;
      continue;
    }

    const g = groups[prefix];
    if (!g) {
      unknownGroup++;
      failures.push(`kenney texture: không có group cho prefix "${prefix}"`);
      continue;
    }

    try {
      const out = await publish({
        type: 'texture',
        slug,
        name: `${g.name} ${num} (Kenney)`,
        description: `${g.description} Từ Kenney Particle Pack, CC0.`,
        tags: [...g.tags, 'kenney', 'cc0'],
        style: g.style,
        category: g.category,
        license: 'cc0',
        visibility: 'project',
        createdBy: 'seed',
        localPath: path.join(KENNEY_DIR, file),
        fileName: file,
        meta: {
          source: 'kenney.nl/assets/particle-pack',
          pack: 'kenney-particle-pack',
          pack_version: '1.1',
          license_class: 'cc0',
          ai_training: true,
          credit: 'Kenney Vleugels (kenney.nl)',
        },
      });
      newCount++;
      console.log(`  + ${out.uri}  ${g.name} ${num}`);
    } catch (err) {
      failures.push(`kenney/${slug}: ${(err as Error).message}`);
      console.error(`  ! kenney/${slug}: ${(err as Error).message}`);
    }
  }

  console.log(
    `\nkenney: published=${newCount} skipped=${skipCount} unknown_prefix=${unknownGroup}`,
  );
  return newCount;
}

async function main(): Promise<void> {
  const raw = await fs.readFile(path.join(here, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(raw) as { entries: Entry[] };

  let published = 0;
  let skipped = 0;
  const failures: string[] = [];

  for (const e of manifest.entries) {
    if (await exists(e.type, e.slug)) {
      skipped++;
      continue;
    }
    try {
      // Không có e.source = nội dung tự viết → cc0. Có source (file PNG Synty) → EULA store.
      const license = e.license ?? (e.source ? 'synty-store-eula' : 'cc0');
      const base: Parameters<typeof publish>[0] = {
        type: e.type,
        slug: e.slug,
        name: e.name,
        description: e.description,
        tags: e.tags,
        style: e.style,
        category: e.category,
        license,
        visibility: 'project',
        createdBy: 'seed',
        meta: {
          source: e.source ?? 'manifest-inline',
          pack: e.source ? 'synty-polygon-particle-fx' : 'vfx-skill-cloud-authored',
          license_class: e.licenseClass ?? licenseClassOf(license),
          ai_training: e.aiTraining ?? aiTrainingAllowed(license),
        },
      };

      if (e.inline !== undefined) {
        base.b64 = Buffer.from(e.inline, 'utf8').toString('base64');
        base.fileName = e.fileName ?? `${e.slug}.yaml`;
      } else if (e.contentFile) {
        base.localPath = path.join(here, e.contentFile);
      } else if (e.source) {
        base.localPath = path.join(VFX_ROOT, e.source);
      } else {
        throw new Error('entry thiếu source, contentFile hoặc inline');
      }

      const out = await publish(base);
      published++;
      console.log(`  + ${out.uri}  ${e.name}`);
    } catch (err) {
      failures.push(`${e.type}/${e.slug}: ${(err as Error).message}`);
      console.error(`  ! ${e.type}/${e.slug}: ${(err as Error).message}`);
    }
  }

  published += await seedKenney(failures);

  const graph = await relinkAll();
  console.log(`\nknowledge graph: scanned=${graph.scanned} edges+=${graph.edges}`);

  console.log(`\nseed done: published=${published} skipped=${skipped} failed=${failures.length}`);
  if (failures.length) {
    process.exitCode = 1;
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
