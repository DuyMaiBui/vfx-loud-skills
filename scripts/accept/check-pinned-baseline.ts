// Pinned-baseline checker (plan.md D19, phase 9). Compares the red and skipped test NAME sets of a junit run with the pin,
// in both directions, by identity `<repo-relative file> :: <test name>`, never by count.
//   - a red/skipped test NOT in the pin  -> FAIL, named (a regression cannot hide behind the pinned ones)
//   - a pinned test that is GREEN        -> FAIL, named ("remove it from the pin, never re-pin the others")
// Usage: check-pinned-baseline.ts --profile scratch-unseeded|corpus-clone --junit <file.xml|-> [--pin <pinned-baseline.json>]
// Produce the junit with: node --test --test-reporter=junit <files> > run.xml   (through with-testdb.sh)
// Exit: 0 clean; 1 differences (each printed as a FAIL line); 2 usage/parse error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Outcome { red: Set<string>; skipped: Set<string>; green: Set<string> }
export interface Pin { red: string[]; skipped: string[] }

const unescape = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, '\n').replace(/&amp;/g, '&');

/** Parse node's junit reporter output. Identity is `<file relative to root> :: <name>`. */
export function parseJunit(xml: string, root: string): Outcome {
  const out: Outcome = { red: new Set(), skipped: new Set(), green: new Set() };
  // attribute values may hold a literal `>` (test names), so match `key="..."` pairs, never `[^>]*`
  const re = /<testcase((?:\s+[\w:.-]+="[^"]*")*)\s*(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const attrs = m[1]!;
    const body = m[3] ?? '';
    const attr = (k: string): string | null => {
      const a = new RegExp(`(?:^|\\s)${k}="([^"]*)"`).exec(attrs);
      return a ? unescape(a[1]!) : null;
    };
    const name = attr('name');
    if (name === null) continue;
    const file = attr('file');
    const rel = file ? path.relative(root, file) : '?';
    const id = `${rel} :: ${name}`;
    if (attr('failure') !== null || /<failure[\s>]/.test(body) || /<error[\s>]/.test(body)) out.red.add(id);
    else if (/<skipped[\s/>]/.test(body)) out.skipped.add(id);
    else out.green.add(id);
  }
  return out;
}

/** The both-directions comparison. Returns one FAIL message per difference (empty = clean). */
export function compare(actual: Outcome, pin: Pin): string[] {
  const fails: string[] = [];
  const pinRed = new Set(pin.red);
  const pinSkip = new Set(pin.skipped);
  for (const id of [...actual.red].sort()) if (!pinRed.has(id)) fails.push(`unpinned red: ${id}`);
  for (const id of [...actual.skipped].sort()) if (!pinSkip.has(id)) fails.push(`unpinned skip: ${id}`);
  for (const id of [...pinRed].sort()) {
    if (actual.green.has(id)) fails.push(`pinned test is green: ${id} (remove it from the pin, never re-pin the others)`);
    else if (!actual.red.has(id)) fails.push(`pinned red test did not run or is not red: ${id}`);
  }
  for (const id of [...pinSkip].sort()) {
    if (actual.green.has(id)) fails.push(`pinned skip is green: ${id} (remove it from the pin, never re-pin the others)`);
    else if (!actual.skipped.has(id)) fails.push(`pinned skip did not run or is not skipped: ${id}`);
  }
  return fails;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '../..');
  const arg = (k: string): string | undefined => {
    const i = process.argv.indexOf(k);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const profile = arg('--profile');
  const junit = arg('--junit');
  const pinFile = arg('--pin') ?? path.join(here, 'pinned-baseline.json');
  if (!profile || !junit) {
    console.error('usage: check-pinned-baseline.ts --profile scratch-unseeded|corpus-clone --junit <file|-> [--pin file]');
    process.exit(2);
  }
  const pins = JSON.parse(fs.readFileSync(pinFile, 'utf8')).profiles as Record<string, Pin>;
  const pin = pins[profile];
  if (!pin) {
    console.error(`unknown profile ${profile}; have ${Object.keys(pins).join(', ')}`);
    process.exit(2);
  }
  const xml = fs.readFileSync(junit === '-' ? 0 : junit, 'utf8');
  const actual = parseJunit(xml, root);
  if (actual.red.size + actual.skipped.size + actual.green.size === 0) {
    console.error('no testcases parsed from the junit input');
    process.exit(2);
  }
  const fails = compare(actual, pin);
  for (const f of fails) console.log(`FAIL ${f}`);
  console.log(`${fails.length === 0 ? 'PASS' : 'FAIL'} pinned-baseline[${profile}] red=${actual.red.size} skipped=${actual.skipped.size} green=${actual.green.size}`);
  process.exit(fails.length === 0 ? 0 : 1);
}
