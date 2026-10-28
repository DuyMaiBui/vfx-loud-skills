/**
 * URP export reader (plan.md C8). `data/export/urp/index.json` is written by `VfxPreview.UrpExport.Run`;
 * an item is published only when the conversion really changed the shader to a package shader known to
 * `unity-package-guids.json`. Pure over the directory; no network.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { PackageEntry } from '../../server/src/unity-refs.ts';
import { sha256 } from './collect.ts';

const Guid = z.string().regex(/^[0-9a-f]{32}$/);
const Sha = z.string().regex(/^[0-9a-f]{64}$/);

const IndexSchema = z.object({
  version: z.literal(1),
  items: z.array(
    z.object({
      guid: Guid,
      path: z.string().min(1),
      rule: z.string().min(1),
      sha256: Sha,
      original_shader_guid: Guid,
      shader_guid: Guid,
    }),
  ),
});
export type UrpItem = z.infer<typeof IndexSchema>['items'][number];

export interface UrpAccepted {
  item: UrpItem;
  data: Buffer;
}

export interface UrpRejected {
  guid: string;
  reason: string;
}

/** Why an item is not published, or null when C8 accepts it. Pure. */
export function urpRejection(item: UrpItem, packageGuids: Map<string, PackageEntry>): string | null {
  const known = packageGuids.get(item.shader_guid);
  if (!known || known.kind !== 'package') return `shader_guid ${item.shader_guid} is not a known package shader`;
  if (item.shader_guid === item.original_shader_guid) return 'conversion did not change the shader';
  return null;
}

export async function loadUrpExport(
  dir: string,
  packageGuids: Map<string, PackageEntry>,
): Promise<{ accepted: UrpAccepted[]; rejected: UrpRejected[] }> {
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8')) as unknown;
  const parsed = IndexSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${dir}/index.json invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const accepted: UrpAccepted[] = [];
  const rejected: UrpRejected[] = [];
  for (const item of parsed.data.items) {
    const why = urpRejection(item, packageGuids);
    if (why) {
      rejected.push({ guid: item.guid, reason: why });
      continue;
    }
    let data: Buffer;
    try {
      data = await fs.readFile(path.join(dir, `${item.guid}.mat`));
    } catch {
      rejected.push({ guid: item.guid, reason: `${item.guid}.mat missing from export dir` });
      continue;
    }
    if (sha256(data) !== item.sha256) {
      rejected.push({ guid: item.guid, reason: 'sha256 in index.json does not match the .mat file' });
      continue;
    }
    accepted.push({ item, data });
  }
  return { accepted, rejected };
}
