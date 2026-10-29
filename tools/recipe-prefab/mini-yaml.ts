// A minimal YAML-subset parser sized to exactly the grammar of the hand-written recipe files in data/recipe
// (the repo has no YAML dependency): block maps, block lists (of maps or scalars), inline lists, scalars as strings,
// `>`/`|` block scalars, and `# comments`. Everything is returned as strings; the semantic layer converts.
// Anything it cannot read THROWS (never guesses).

export type Yaml = string | Yaml[] | { [k: string]: Yaml } | null;
export type YamlMap = { [k: string]: Yaml };

interface Line { indent: number; text: string; no: number }

const KEY = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/;

export function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

function inline(v: string, no: number): Yaml {
  v = v.trim();
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) throw new Error(`line ${no}: unterminated inline list`);
    return splitTop(v.slice(1, -1));
  }
  return v;
}

/** `rawKeys`: keys whose body is free text (list items are NOT parsed as maps), e.g. `notes`. */
export function parseYaml(src: string, rawKeys: string[] = ['notes']): YamlMap {
  const lines: Line[] = [];
  src.split(/\r?\n/).forEach((raw, i) => {
    if (raw.includes('\t')) throw new Error(`line ${i + 1}: tab indentation`);
    const text = raw.replace(/(^|\s)#.*$/, '').trimEnd();
    if (text.trim() === '') return;
    lines.push({ indent: text.length - text.trimStart().length, text: text.trimStart(), no: i + 1 });
  });
  let pos = 0;

  function block(indent: number, raw: boolean): Yaml {
    const first = lines[pos];
    if (!first || first.indent < indent) return null;
    if (first.text.startsWith('- ') || first.text === '-') return list(first.indent, raw);
    if (raw) throw new Error(`line ${first.no}: free-text block must be a list`);
    return map(first.indent);
  }

  function list(indent: number, raw: boolean): Yaml[] {
    const out: Yaml[] = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith('- ') || lines[pos].text === '-')) {
      const l = lines[pos];
      const rest = l.text === '-' ? '' : l.text.slice(2).trim();
      if (raw || !KEY.test(rest)) { out.push(rest); pos++; continue; }
      // `- key: value` opens a map whose keys sit at indent+2
      lines[pos] = { indent: indent + 2, text: rest, no: l.no };
      out.push(map(indent + 2));
    }
    return out;
  }

  function map(indent: number): YamlMap {
    const out: YamlMap = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const l = lines[pos];
      const m = KEY.exec(l.text);
      if (!m) throw new Error(`line ${l.no}: expected "key: value", got "${l.text}"`);
      const key = m[1];
      if (key in out) throw new Error(`line ${l.no}: duplicate key "${key}"`);
      const val = (m[2] ?? '').trim();
      pos++;
      if (val === '>' || val === '|') {
        const parts: string[] = [];
        while (pos < lines.length && lines[pos].indent > indent) parts.push(lines[pos++].text);
        out[key] = parts.join(val === '>' ? ' ' : '\n');
      } else if (val !== '') {
        out[key] = inline(val, l.no);
      } else if (pos < lines.length && lines[pos].indent > indent) {
        out[key] = block(lines[pos].indent, rawKeys.includes(key));
      } else if (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('- ')) {
        out[key] = list(indent, rawKeys.includes(key)); // list at the same indent as its key
      } else out[key] = null;
    }
    if (pos < lines.length && lines[pos].indent > indent) throw new Error(`line ${lines[pos].no}: unexpected indentation`);
    return out;
  }

  const root = block(0, false);
  if (pos < lines.length) throw new Error(`line ${lines[pos].no}: unparsed content`);
  if (root === null || typeof root !== 'object' || Array.isArray(root)) throw new Error('document root must be a map');
  return root;
}
