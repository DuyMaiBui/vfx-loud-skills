/**
 * Deterministic YAML emitter for plain JSON-like data (object key order is preserved, so the
 * same input always renders byte-identical output). Small scalar-only maps / number lists are
 * rendered in flow style to keep recipes readable; everything else is block style.
 */

const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~', 'y', 'n']);
const PLAIN_RE = /^[A-Za-z_][A-Za-z0-9_ ./()+\-]*$/;
const FLOW_MAX = 110;

function scalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`yaml-emit: non-finite number ${v}`);
    return String(v);
  }
  if (typeof v === 'string') {
    if (PLAIN_RE.test(v) && !v.endsWith(' ') && !RESERVED.has(v.toLowerCase())) return v;
    return JSON.stringify(v);
  }
  throw new Error(`yaml-emit: unsupported scalar ${typeof v}`);
}

function key(k: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.\-]*$/.test(k) && !RESERVED.has(k.toLowerCase())
    ? k
    : JSON.stringify(k);
}

function isScalar(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

/** Flow rendering when the value is small and made only of scalars / flow-able collections. */
function tryFlow(v: unknown): string | null {
  if (isScalar(v)) return scalar(v);
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const x of v) {
      const f = tryFlow(x);
      if (f === null) return null;
      parts.push(f);
    }
    const s = `[${parts.join(', ')}]`;
    return s.length <= FLOW_MAX ? s : null;
  }
  if (v && typeof v === 'object') {
    const parts: string[] = [];
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const f = tryFlow(x);
      if (f === null) return null;
      parts.push(`${key(k)}: ${f}`);
    }
    const s = `{${parts.join(', ')}}`;
    return s.length <= FLOW_MAX ? s : null;
  }
  return null;
}

function emit(v: unknown, indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    for (const item of v) {
      const f = tryFlow(item);
      if (f !== null) {
        out.push(`${pad}- ${f}`);
      } else if (Array.isArray(item)) {
        out.push(`${pad}-`);
        emit(item, indent + 2, out);
      } else {
        const sub: string[] = [];
        emit(item, indent + 2, sub);
        // Fold the first line of the nested map onto the "- " marker.
        out.push(`${pad}- ${sub[0].slice(indent + 2)}`, ...sub.slice(1));
      }
    }
    return;
  }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const f = tryFlow(x);
    if (f !== null) {
      out.push(`${pad}${key(k)}: ${f}`);
    } else {
      out.push(`${pad}${key(k)}:`);
      emit(x, indent + 2, out);
    }
  }
}

export function toYaml(value: Record<string, unknown>): string {
  const out: string[] = [];
  emit(value, 0, out);
  return `${out.join('\n')}\n`;
}
