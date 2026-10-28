/**
 * Test support for the uploader / verifier: a stub vfx-bytes/1 server (no DB, in-memory) and a temp
 * vendor source tree built with the phase-1 `.unitypackage` builder. Not a test file itself.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AssetFileInputSchema, type AssetFileInput } from '../../server/src/bundle-contract.ts';
import { blobLicenseProblem } from '../../server/src/license.ts';
import type { PackageEntry } from '../../server/src/unity-refs.ts';
import { makeUnityPackage } from '../extract/test-helpers.ts';
import type { UploadPack } from './collect.ts';

const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');
const g = (c: string): string => c.repeat(32);

export const GUID = {
  prefab: g('1'), mat: g('2'), script: g('3'), audio: g('4'), tex: g('5'), asm: g('6'), asm2: g('7'),
  unresolved: g('9'), mat2: g('a'), builtin: '0000000000000000f000000000000000',
  urpShader: '0406db5a14f94604a8c57ccfbc9f3b46', pkgOnly: g('b'), oldShader: g('c'),
} as const;

export const PACKAGE_GUIDS = new Map<string, PackageEntry>([
  [GUID.urpShader, { kind: 'package', name: 'Particles/Unlit', package: 'com.unity.render-pipelines.universal', version: null }],
]);

const ref = (guid: string): string => `{fileID: 1, guid: ${guid}, type: 2}`;

export const MAT_BYTES = `Material:\n  m_Shader: ${ref(GUID.oldShader)}\n  tex: ${ref(GUID.tex)}\n  urp: ${ref(GUID.urpShader)}\n`;

export function pkgAssets(matText = MAT_BYTES) {
  return [
    { guid: GUID.prefab, path: 'Assets/Retro/Prefabs/Boom.prefab', asset: `GameObject:\n  m: ${ref(GUID.mat)}\n  s: ${ref(GUID.script)}\n  a: ${ref(GUID.audio)}\n  u: ${ref(GUID.unresolved)}\n  b: ${ref(GUID.builtin)}\n` },
    { guid: GUID.mat, path: 'Assets/Retro/Materials/Fire.mat', asset: matText },
    { guid: GUID.mat2, path: 'Assets/Retro/Materials/Smoke.mat', asset: `Material:\n  m_Shader: ${ref(GUID.oldShader)}\n` },
    { guid: GUID.script, path: 'Assets/Retro/Scripts/Foo.cs', asset: 'class Foo {}\n' },
    { guid: GUID.audio, path: 'Assets/Retro/Audio/Boom.wav', asset: Buffer.from([0x52, 0x49, 0x00, 0x01, 0x02]) },
    { guid: GUID.tex, path: 'Assets/Retro/Textures/Fire.png', asset: Buffer.from([0x89, 0x50, 0x00, 0x47]) },
    { guid: GUID.asm, path: 'Assets/Retro/Scripts/Retro.asmdef', asset: `{"name":"Retro","references":["GUID:${GUID.asm2}"]}` },
    { guid: GUID.asm2, path: 'Assets/Retro/Other/Dep.asmdef', asset: '{"name":"Dep"}' },
  ];
}

export interface Fixture {
  dir: string;
  packs: UploadPack[];
  cleanup: () => Promise<void>;
}

/** Temp dir with `retro.unitypackage`; the pack is retro-arsenal. `extra` adds a second pack sharing guids. */
export async function makeFixture(extra?: { matText: string }): Promise<Fixture> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vfx-upload-'));
  await fs.writeFile(path.join(dir, 'retro.unitypackage'), makeUnityPackage(pkgAssets()));
  const base = { name: 'x', vendor: 'v', style: [] as string[], tags: [] as string[], license: 'asset-store-eula' };
  const packs: UploadPack[] = [{ ...base, slug: 'retro-arsenal', file: 'retro.unitypackage' }];
  if (extra) {
    await fs.writeFile(path.join(dir, 'sci.unitypackage'), makeUnityPackage([{ guid: GUID.mat, path: 'Assets/Sci/Fire.mat', asset: extra.matText }]));
    packs.push({ ...base, slug: 'sci-fi-arsenal', file: 'sci.unitypackage' });
  }
  return { dir, packs, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

export interface StubOptions {
  apiKey?: string;
  /** Always answer 503. */
  down?: boolean;
  /** Answer 503 to the first N PUTs, then behave. */
  failFirstPuts?: number;
  /** PUT of these shas answers 400 invalid (a sha256 mismatch injected server-side). */
  rejectPutSha?: Set<string>;
  /** GET of these shas serves altered bytes (corruption in transit / at rest). */
  corruptGet?: Set<string>;
  /** Bundles served by GET /v1/closure/recipe/<slug>/<version> (a function of the stub base URL). */
  bundles?: Map<string, (base: string) => unknown>;
}

export interface Stub {
  url: string;
  blobs: Map<string, Buffer>;
  files: Map<string, AssetFileInput>;
  counts: { requests: number; puts: number; putBytes: number; missing: number; registers: number };
  close: () => Promise<void>;
}

const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

export async function startStub(opts: StubOptions = {}): Promise<Stub> {
  const blobs = new Map<string, Buffer>();
  const files = new Map<string, AssetFileInput>();
  const counts = { requests: 0, puts: 0, putBytes: 0, missing: 0, registers: 0 };
  let putsSeen = 0;

  const server = http.createServer(async (req, res) => {
    counts.requests += 1;
    const send = (status: number, body: unknown, type = 'application/json'): void => {
      res.writeHead(status, { 'content-type': type });
      res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
      if (opts.down) return send(503, { error: 'down' });
      if (opts.apiKey && req.headers['x-vfx-key'] !== opts.apiKey) return send(403, { error: 'forbidden', code: 'forbidden' });
      const url = new URL(req.url ?? '/', 'http://stub');
      const base = `http://${req.headers.host}`;
      const parts = url.pathname.split('/').filter(Boolean); // v1 ...
      if (req.method === 'POST' && url.pathname === '/v1/blob/missing') {
        counts.missing += 1;
        const { sha256 } = JSON.parse((await readBody(req)).toString()) as { sha256: string[] };
        return send(200, { missing: [...new Set(sha256)].filter((s) => !blobs.has(s)) });
      }
      if (req.method === 'PUT' && parts[1] === 'blob') {
        const body = await readBody(req);
        putsSeen += 1;
        if (putsSeen <= (opts.failFirstPuts ?? 0)) return send(503, { error: 'busy' });
        if (opts.rejectPutSha?.has(parts[2])) return send(400, { error: 'sha256 mismatch', code: 'invalid', details: { actual: sha(body) } });
        if (sha(body) !== parts[2]) return send(400, { error: 'sha256 mismatch', code: 'invalid', details: { actual: sha(body) } });
        const created = !blobs.has(parts[2]);
        blobs.set(parts[2], body);
        if (created) {
          counts.puts += 1;
          counts.putBytes += body.length;
        }
        return send(created ? 201 : 200, { sha256: parts[2], bytes: body.length, created });
      }
      if (req.method === 'GET' && parts[1] === 'blob') {
        const b = blobs.get(parts[2]);
        if (!b) return send(404, { error: 'not found', code: 'not_found' });
        return send(200, opts.corruptGet?.has(parts[2]) ? Buffer.concat([b, Buffer.from('!')]) : b, 'application/octet-stream');
      }
      if (req.method === 'POST' && url.pathname === '/v1/asset-file/batch') {
        counts.registers += 1;
        const { files: input } = JSON.parse((await readBody(req)).toString()) as { files: unknown[] };
        const results = input.map((raw) => {
          const p = AssetFileInputSchema.safeParse(raw);
          const guid = (raw as { guid?: string }).guid ?? '';
          const variant = (raw as { variant?: string }).variant ?? '';
          if (!p.success) return { guid, variant, status: 'rejected', code: 'invalid', error: p.error.issues[0]?.message };
          const f = p.data;
          const why = blobLicenseProblem(f.license, f.visibility, false);
          if (why) return { guid, variant, status: 'rejected', code: 'forbidden', error: why };
          const miss = [f.asset_sha256, f.meta_sha256].filter((s): s is string => !!s && !blobs.has(s));
          if (miss.length) return { guid, variant, status: 'rejected', code: 'conflict', error: 'blob missing', details: { missing: miss } };
          const key = `${f.guid}|${f.variant}`;
          const old = files.get(key);
          if (old && old.asset_sha256 === f.asset_sha256 && old.meta_sha256 === f.meta_sha256) return { guid, variant, status: 'unchanged' };
          if (old && !f.replace) return { guid, variant, status: 'rejected', code: 'conflict', error: 'different bytes' };
          files.set(key, f);
          return { guid, variant, status: old ? 'replaced' : 'created' };
        });
        const n = (s: string): number => results.filter((r) => r.status === s).length;
        return send(200, { results, counts: { created: n('created'), unchanged: n('unchanged'), replaced: n('replaced'), rejected: n('rejected') } });
      }
      if (req.method === 'GET' && parts[1] === 'closure') {
        const mk = opts.bundles?.get(decodeURIComponent(parts[3]));
        if (!mk) return send(404, { error: 'not found', code: 'not_found' });
        return send(200, mk(base));
      }
      return send(404, { error: 'no route', code: 'not_found' });
    } catch (err) {
      return send(500, { error: (err as Error).message });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    blobs,
    files,
    counts,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
