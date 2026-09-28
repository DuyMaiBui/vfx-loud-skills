import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  repoRoot,
  port: int('PORT', 8787),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://vfx:vfx@127.0.0.1:5432/vfxcloud',
  dataDir: process.env.DATA_DIR ?? path.join(repoRoot, 'data'),
  apiKey: process.env.VFX_API_KEY ?? '',
  authDisabled: process.env.AUTH_DISABLED === '1',
  /** V0: embedder deterministic, offline. Đổi env sang model thật ở V0.1. */
  embedder: process.env.EMBEDDER ?? 'hashing',
  embeddingDim: int('EMBEDDING_DIM', 384),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? '',
  serverName: 'vfx-skill-cloud',
  serverVersion: '0.1.0',
};
