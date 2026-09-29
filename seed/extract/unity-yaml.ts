/**
 * Parser for the subset of YAML that Unity's text serializer emits (`%YAML 1.1` + `!u!` tags).
 * Block mappings/sequences (including Unity's "sequence at the same indent as its key" style),
 * flow maps/sequences, and plain / single- / double-quoted scalars. Anything outside that
 * subset (block scalars, multi-line quoted scalars, anchors) THROWS — the extractor turns that
 * into a logged skip, never a silent partial.
 */

export type YamlValue = null | boolean | number | string | YamlValue[] | { [k: string]: YamlValue };
export type YamlMap = { [k: string]: YamlValue };

export class UnityYamlError extends Error {}

export interface UnityDoc {
  classId: number;
  fileId: string;
  stripped: boolean;
  /** Serialized type name, e.g. "ParticleSystem". */
  type: string;
  body: YamlMap;
}

interface Line {
  indent: number;
  text: string;
  no: number;
}

/** True when the buffer is a Unity text-serialized asset (vs. binary / other). */
export function isUnityTextYaml(head: string): boolean {
  return head.startsWith('%YAML');
}

const DOC_HEAD = /^--- !u!(\d+) &(-?\d+)( stripped)?\s*$/;

export function parseUnityDocs(text: string): UnityDoc[] {
  const raw = text.replace(/\r\n/g, '\n').split('\n');
  const docs: UnityDoc[] = [];
  let cur: { classId: number; fileId: string; stripped: boolean; lines: Line[] } | null = null;
  const flush = (): void => {
    if (!cur) return;
    const body = parseBody(cur.lines);
    const keys = Object.keys(body);
    if (keys.length !== 1) throw new UnityYamlError(`doc &${cur.fileId}: expected 1 root key`);
    const type = keys[0];
    const inner = body[type];
    docs.push({
      classId: cur.classId,
      fileId: cur.fileId,
      stripped: cur.stripped,
      type,
      body: inner !== null && typeof inner === 'object' && !Array.isArray(inner) ? inner : {},
    });
  };
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (line.startsWith('%')) continue;
    if (line.startsWith('---')) {
      flush();
      const m = DOC_HEAD.exec(line);
      if (!m) throw new UnityYamlError(`line ${i + 1}: unrecognised document header "${line}"`);
      cur = { classId: Number(m[1]), fileId: m[2], stripped: Boolean(m[3]), lines: [] };
      continue;
    }
    if (!cur) {
      if (line.trim() === '') continue;
      throw new UnityYamlError(`line ${i + 1}: content before first document`);
    }
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    cur.lines.push({ indent, text: line.slice(indent), no: i + 1 });
  }
  flush();
  return docs;
}

function parseBody(lines: Line[]): YamlMap {
  if (lines.length === 0) return {};
  const p = new BlockParser(lines);
  const v = p.parseBlock(lines[0].indent);
  if (p.pos < lines.length) throw new UnityYamlError(`line ${lines[p.pos].no}: trailing content`);
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new UnityYamlError('document body is not a mapping');
  }
  return v;
}

const KEY_RE = /^("[^"]*"|[^\s:#\-\[\]{},&*!|>'"%@`][^:]*?|-[^\s:][^:]*?):(?:\s+(.*)|)$/;

class BlockParser {
  pos = 0;
  private readonly lines: Line[];
  constructor(lines: Line[]) {
    this.lines = lines;
  }

  parseBlock(indent: number): YamlValue {
    const line = this.lines[this.pos];
    if (line.text === '-' || line.text.startsWith('- ')) return this.parseSeq(indent);
    return this.parseMap(indent);
  }

  private parseMap(indent: number): YamlMap {
    const out: YamlMap = {};
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos];
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new UnityYamlError(`line ${line.no}: unexpected indent`);
      }
      if (line.text === '-' || line.text.startsWith('- ')) break; // sibling seq of a parent
      const m = KEY_RE.exec(line.text);
      if (!m) throw new UnityYamlError(`line ${line.no}: cannot parse "${line.text}"`);
      const key = m[1].startsWith('"') ? m[1].slice(1, -1) : m[1];
      const rest = m[2];
      this.pos++;
      if (rest !== undefined && rest !== '') {
        const full = this.gather(rest);
        out[key] = key === 'guid' ? unquote(full.trim()) : parseInline(full, line.no);
      } else {
        out[key] = this.parseNested(indent);
      }
    }
    return out;
  }

  /**
   * Unity wraps long flow collections / quoted scalars onto continuation lines (indented
   * deeper than the key). Join them (YAML folds a line break to one space) until the
   * construct closes; `this.pos` is left after the last consumed line.
   */
  private gather(first: string): string {
    let text = first;
    while (this.pos < this.lines.length && !isBalanced(text)) {
      text += ` ${this.lines[this.pos].text}`;
      this.pos++;
    }
    if (!isBalanced(text)) throw new UnityYamlError(`unterminated value "${first.slice(0, 40)}"`);
    return text;
  }

  /** Value of `key:` with nothing after the colon. */
  private parseNested(keyIndent: number): YamlValue {
    if (this.pos >= this.lines.length) return null;
    const next = this.lines[this.pos];
    if (next.indent > keyIndent) return this.parseBlock(next.indent);
    if (next.indent === keyIndent && (next.text === '-' || next.text.startsWith('- '))) {
      return this.parseSeq(keyIndent);
    }
    return null;
  }

  private parseSeq(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos];
      if (line.indent !== indent || !(line.text === '-' || line.text.startsWith('- '))) break;
      const rest = line.text === '-' ? '' : line.text.slice(2).trimStart();
      if (rest === '') {
        this.pos++;
        const next = this.lines[this.pos];
        out.push(next && next.indent > indent ? this.parseBlock(next.indent) : null);
        continue;
      }
      const isKey = KEY_RE.test(rest) && !/^[\[{'"]/.test(rest);
      if (isKey) {
        // Re-interpret the remainder of the item line as the first line of a mapping whose
        // continuation keys sit at indent + 2 (Unity's fixed "- " prefix width).
        const childIndent = indent + (line.text.length - rest.length);
        this.lines[this.pos] = { indent: childIndent, text: rest, no: line.no };
        out.push(this.parseMap(childIndent));
      } else {
        this.pos++;
        out.push(parseInline(this.gather(rest), line.no));
      }
    }
    return out;
  }
}

/* ------------------------------------------------------------------ inline */

function parseInline(s: string, no: number): YamlValue {
  const t = s.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    const r = new FlowParser(t, no);
    const v = r.value();
    r.end();
    return v;
  }
  return parseScalar(t, no);
}

/** True when every {, [ and quote opened in `t` is closed (quotes inside flow are honoured). */
function isBalanced(t: string): boolean {
  const s = t.trim();
  if (s[0] === '"') {
    for (let i = 1; i < s.length; i++) {
      if (s[i] === '\\') i++;
      else if (s[i] === '"') return true;
    }
    return false;
  }
  if (s[0] === "'") {
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") i++;
        else return true;
      }
    }
    return false;
  }
  if (s[0] !== '{' && s[0] !== '[') return true;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return depth === 0 && quote === '';
}

function unquote(t: string): string {
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.endsWith(t[0])) return t.slice(1, -1);
  return t;
}

const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;

function parseScalar(t: string, no: number): YamlValue {
  if (t === '') return null;
  if (t[0] === "'") {
    if (t.length < 2 || !t.endsWith("'")) {
      throw new UnityYamlError(`line ${no}: multi-line quoted scalar unsupported`);
    }
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t[0] === '"') return parseDoubleQuoted(t, no);
  if (t[0] === '|' || t[0] === '>') throw new UnityYamlError(`line ${no}: block scalar unsupported`);
  if (t[0] === '&' || t[0] === '*') throw new UnityYamlError(`line ${no}: anchors unsupported`);
  if (INT_RE.test(t)) {
    const n = Number(t);
    // fileIDs / hashes exceed 2^53 — keep them exact as strings.
    return Number.isSafeInteger(n) ? n : t;
  }
  if (FLOAT_RE.test(t)) return Number(t);
  return t;
}

function parseDoubleQuoted(t: string, no: number): string {
  if (t.length < 2 || !t.endsWith('"')) {
    throw new UnityYamlError(`line ${no}: multi-line quoted scalar unsupported`);
  }
  const body = t.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = body[++i];
    switch (n) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '0': out += '\0'; break;
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case 'u': out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16)); i += 4; break;
      case 'x': out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16)); i += 2; break;
      default: throw new UnityYamlError(`line ${no}: unsupported escape \\${n}`);
    }
  }
  return out;
}

class FlowParser {
  private i = 0;
  private readonly s: string;
  private readonly no: number;
  constructor(s: string, no: number) {
    this.s = s;
    this.no = no;
  }

  private ws(): void {
    while (this.i < this.s.length && this.s[this.i] === ' ') this.i++;
  }

  end(): void {
    this.ws();
    if (this.i < this.s.length) throw new UnityYamlError(`line ${this.no}: junk after flow value`);
  }

  value(): YamlValue {
    this.ws();
    const c = this.s[this.i];
    if (c === '{') return this.map();
    if (c === '[') return this.seq();
    return this.scalar();
  }

  private map(): YamlMap {
    this.i++; // {
    const out: YamlMap = {};
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') { this.i++; return out; }
      const kStart = this.i;
      while (this.i < this.s.length && this.s[this.i] !== ':') this.i++;
      if (this.i >= this.s.length) throw new UnityYamlError(`line ${this.no}: unterminated flow map`);
      const key = this.s.slice(kStart, this.i).trim();
      this.i++; // :
      out[key] = key === 'guid' ? this.rawString() : this.value();
      this.ws();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== '}') throw new UnityYamlError(`line ${this.no}: bad flow map`);
    }
  }

  /** GUIDs are opaque hex strings; never let a numeric-looking one be coerced. */
  private rawString(): string {
    this.ws();
    const start = this.i;
    while (this.i < this.s.length && !',}]'.includes(this.s[this.i])) this.i++;
    return unquote(this.s.slice(start, this.i).trim());
  }

  private seq(): YamlValue[] {
    this.i++; // [
    const out: YamlValue[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === ']') { this.i++; return out; }
      out.push(this.value());
      this.ws();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== ']') throw new UnityYamlError(`line ${this.no}: bad flow seq`);
    }
  }

  private scalar(): YamlValue {
    const c = this.s[this.i];
    if (c === "'" || c === '"') {
      const q = c;
      let j = this.i + 1;
      while (j < this.s.length) {
        if (this.s[j] === '\\' && q === '"') { j += 2; continue; }
        if (this.s[j] === q) {
          if (q === "'" && this.s[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      if (j >= this.s.length) throw new UnityYamlError(`line ${this.no}: unterminated quote`);
      const tok = this.s.slice(this.i, j + 1);
      this.i = j + 1;
      return parseScalar(tok, this.no);
    }
    const start = this.i;
    while (this.i < this.s.length && !',}]'.includes(this.s[this.i])) this.i++;
    return parseScalar(this.s.slice(start, this.i).trim(), this.no);
  }
}

/* ---------------------------------------------------------------- helpers */

export function asMap(v: YamlValue | undefined): YamlMap | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
}
export function asSeq(v: YamlValue | undefined): YamlValue[] {
  return Array.isArray(v) ? v : [];
}
export function asNum(v: YamlValue | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
/** `{fileID: N}` / `{fileID: N, guid: G, type: T}` reference. */
export function asRef(v: YamlValue | undefined): { fileId: string; guid?: string } | undefined {
  const m = asMap(v);
  if (!m || m.fileID === undefined || m.fileID === null) return undefined;
  return { fileId: String(m.fileID), ...(typeof m.guid === 'string' ? { guid: m.guid } : {}) };
}
