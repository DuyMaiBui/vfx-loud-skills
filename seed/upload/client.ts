/**
 * Minimal vfx-bytes/1 HTTP client for the uploader and the verifier (plan.md C3). Retries 5xx / 429 /
 * network errors with exponential backoff; a still-failing server is `ServerUnavailableError`
 * (exit 75). Any other non-2xx is `HttpError` carrying the C5 envelope. No bytes ever go over MCP.
 */
import type { AssetFileInput, Bundle } from '../../server/src/bundle-contract.ts';

export class ServerUnavailableError extends Error {}

export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface ClientOptions {
  server: string;
  apiKey?: string;
  /** Attempts per request including the first (default 5). */
  attempts?: number;
  /** First backoff in ms, doubled each retry (default 250). */
  backoffMs?: number;
}

export interface BatchResult {
  guid: string;
  variant: string;
  status: 'created' | 'unchanged' | 'replaced' | 'rejected';
  code?: string;
  error?: string;
  details?: Record<string, unknown>;
}

export interface BatchResponse {
  results: BatchResult[];
  counts: { created: number; unchanged: number; replaced: number; rejected: number };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createClient(opts: ClientOptions) {
  const base = opts.server.replace(/\/+$/, '');
  const attempts = opts.attempts ?? 5;
  const backoff = opts.backoffMs ?? 250;
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...(opts.apiKey ? { 'x-vfx-key': opts.apiKey } : {}),
    ...extra,
  });

  async function request(method: string, url: string, init: { headers?: Record<string, string>; body?: string | Uint8Array } = {}): Promise<Response> {
    let last = 'no attempt';
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(backoff * 2 ** (i - 1));
      let res: Response;
      try {
        res = await fetch(url, { method, headers: headers(init.headers), body: init.body });
      } catch (err) {
        last = `network: ${(err as Error).message}`;
        continue;
      }
      if (res.status >= 500 || res.status === 429) {
        last = `HTTP ${res.status}`;
        await res.arrayBuffer().catch(() => undefined);
        continue;
      }
      return res;
    }
    throw new ServerUnavailableError(`${method} ${url}: server unavailable after ${attempts} attempts (${last})`);
  }

  async function json<T>(res: Response, what: string): Promise<T> {
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const msg = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : text.slice(0, 200);
      throw new HttpError(res.status, `${what}: HTTP ${res.status} ${msg}`, body);
    }
    return body as T;
  }

  return {
    /** Subset of `sha256` the server does not hold, input order. */
    async missing(sha256: string[]): Promise<string[]> {
      const res = await request('POST', `${base}/v1/blob/missing`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha256 }),
      });
      return (await json<{ missing: string[] }>(res, 'blob/missing')).missing;
    },
    async putBlob(sha256: string, data: Buffer, kindHint?: string): Promise<{ created: boolean; bytes: number }> {
      const res = await request('PUT', `${base}/v1/blob/${sha256}`, {
        headers: { 'content-type': 'application/octet-stream', ...(kindHint ? { 'x-vfx-kind': kindHint } : {}) },
        body: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      });
      return json(res, `PUT blob ${sha256}`);
    },
    async registerBatch(files: AssetFileInput[]): Promise<BatchResponse> {
      const res = await request('POST', `${base}/v1/asset-file/batch`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files }),
      });
      return json(res, 'asset-file/batch');
    },
    async closure(slug: string, version: number, variant: 'urp' | 'original', type = 'recipe'): Promise<Bundle> {
      const res = await request('GET', `${base}/v1/closure/${type}/${encodeURIComponent(slug)}/${version}?variant=${variant}`);
      return json(res, `closure ${slug}`);
    },
    /** Downloads a blob (gzip transparently decoded by fetch); `url` is a bundle `download_url`. */
    async download(url: string): Promise<Buffer> {
      const res = await request('GET', url, { headers: { 'accept-encoding': 'gzip' } });
      if (!res.ok) throw new HttpError(res.status, `GET ${url}: HTTP ${res.status}`, null);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

export type VfxClient = ReturnType<typeof createClient>;
