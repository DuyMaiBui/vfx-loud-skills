import fs from 'node:fs';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';

/**
 * Minimal streaming reader for `.unitypackage` (gzip'd tar). Read-only: the source archive is
 * never written to, and nothing is extracted to disk. Supports ustar, GNU long-name ('L') and
 * pax ('x') path records — enough for every archive Unity / macOS tar emits.
 */
export interface TarEntry {
  name: string;
  size: number;
  data: Buffer;
}

class ByteQueue {
  private chunks: Buffer[] = [];
  length = 0;
  push(b: Buffer): void {
    if (b.length === 0) return;
    this.chunks.push(b);
    this.length += b.length;
  }
  take(n: number): Buffer {
    if (n > this.length) throw new Error('ByteQueue underflow');
    if (n === 0) return Buffer.alloc(0);
    const first = this.chunks[0];
    if (first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.length -= n;
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0];
      const need = n - off;
      if (c.length <= need) {
        c.copy(out, off);
        off += c.length;
        this.chunks.shift();
      } else {
        c.copy(out, off, 0, need);
        this.chunks[0] = c.subarray(need);
        off += need;
      }
    }
    this.length -= n;
    return out;
  }
  drop(n: number): void {
    // Discard without copying.
    let left = n;
    while (left > 0) {
      const c = this.chunks[0];
      if (c.length <= left) {
        left -= c.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = c.subarray(left);
        left = 0;
      }
    }
    this.length -= n;
  }
}

function cstr(b: Buffer, start: number, len: number): string {
  const slice = b.subarray(start, start + len);
  const z = slice.indexOf(0);
  return slice.subarray(0, z === -1 ? len : z).toString('utf8');
}

function parseOctal(b: Buffer, start: number, len: number): number {
  const s = cstr(b, start, len).trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error(`tar: bad octal field "${s}"`);
  return parseInt(s, 8);
}

function parsePax(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp === -1) break;
    const recLen = parseInt(buf.subarray(i, sp).toString('ascii'), 10);
    if (!Number.isFinite(recLen) || recLen <= 0) break;
    const rec = buf.subarray(sp + 1, i + recLen - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += recLen;
  }
  return out;
}

/** Yields ONLY the regular files for which `wantData(name, size)` is true (data always set). */
export async function* tarEntries(
  source: Readable,
  wantData: (name: string, size: number) => boolean,
): AsyncGenerator<TarEntry> {
  const q = new ByteQueue();
  const it = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let ended = false;
  const fill = async (n: number): Promise<boolean> => {
    while (q.length < n && !ended) {
      const r = await it.next();
      if (r.done) ended = true;
      else q.push(r.value);
    }
    return q.length >= n;
  };
  // Consume `n` bytes; when `keep` is false they are dropped chunk-by-chunk (bounded memory).
  const consume = async (n: number, keep: boolean): Promise<Buffer | null> => {
    if (keep) {
      if (!(await fill(n))) throw new Error('tar: truncated archive');
      return q.take(n);
    }
    let left = n;
    while (left > 0) {
      if (q.length === 0 && !(await fill(1))) throw new Error('tar: truncated archive');
      const step = Math.min(left, q.length);
      q.drop(step);
      left -= step;
    }
    return null;
  };

  let longName: string | null = null;
  let paxPath: string | null = null;
  try {
    for (;;) {
      if (!(await fill(512))) return;
      const h = q.take(512);
      if (h.every((x) => x === 0)) continue; // end-of-archive blocks
      const size = parseOctal(h, 124, 12);
      const type = String.fromCharCode(h[156] || 0x30);
      const prefix = cstr(h, 345, 155);
      let name = cstr(h, 0, 100);
      if (prefix && cstr(h, 257, 5) === 'ustar') name = `${prefix}/${name}`;
      const padded = Math.ceil(size / 512) * 512;

      if (type === 'L' || type === 'x' || type === 'g') {
        const body = (await consume(size, true)) as Buffer;
        await consume(padded - size, false);
        if (type === 'L') longName = cstr(body, 0, body.length);
        else if (type === 'x') paxPath = parsePax(body).path ?? null;
        continue;
      }
      if (longName !== null) name = longName;
      if (paxPath !== null) name = paxPath;
      longName = null;
      paxPath = null;

      const isFile = type === '0' || type === '\0';
      const keep = isFile && wantData(name, size);
      const data = await consume(size, keep);
      await consume(padded - size, false);
      if (keep && data) yield { name, size, data };
    }
  } finally {
    // Early `break` by the consumer must release the gzip + file handles.
    await it.return?.();
  }
}

export function openUnityPackage(file: string): Readable {
  const raw = fs.createReadStream(file);
  const gz = zlib.createGunzip();
  raw.on('error', (e) => gz.destroy(e));
  gz.on('close', () => raw.destroy());
  return raw.pipe(gz);
}
