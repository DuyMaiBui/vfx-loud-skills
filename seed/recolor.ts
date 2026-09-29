/**
 * Recolour a stored recipe from the shell.
 *   npm run recolor -- <vfx://recipe/...> (--target '#ff2020' | --hue 120) [--no-preserve-luminance] [--publish] [--payload out.json] [--changes]
 * Same code path as POST /v1/recolor and the vfx_recolor MCP tool (server/src/recolor-service.ts).
 * Prints the response without the payload (use --payload to save it); read-only unless --publish.
 */
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pool } from '../server/src/db.ts';
import { recolorRecord } from '../server/src/recolor-service.ts';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      target: { type: 'string' },
      hue: { type: 'string' },
      'no-preserve-luminance': { type: 'boolean' },
      publish: { type: 'boolean' },
      payload: { type: 'string' },
      changes: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  const uri = positionals[0];
  if (!uri) throw new Error('usage: npm run recolor -- <vfx://recipe/slug/version> (--target #rrggbb | --hue deg) [--publish] [--payload out.json] [--changes]');
  const hue = values.hue === undefined ? undefined : Number(values.hue);
  if (hue !== undefined && !Number.isFinite(hue)) throw new Error(`--hue must be a number, got "${values.hue}"`);
  const res = await recolorRecord({
    uri,
    targetColor: values.target,
    hueShiftDeg: hue,
    preserveLuminance: values['no-preserve-luminance'] ? false : undefined,
    publish: values.publish,
  });
  const { payload, changes, ...rest } = res;
  if (values.payload) await fs.writeFile(values.payload, JSON.stringify(payload, null, 1));
  console.log(JSON.stringify({ ...rest, changesCount: changes.length, ...(values.changes ? { changes } : {}) }, null, 1));
}

main()
  .catch((e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
