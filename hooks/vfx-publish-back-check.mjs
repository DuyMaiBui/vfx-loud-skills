#!/usr/bin/env node
// Stop hook: nudge when a game project holds a CUSTOMISED VFX Cloud asset that was never published back.
//
// A game keeps one provenance record per VFX Cloud asset it uses (NutSort: art/provenance/nutsort/vfxcloud-<slug>.json).
// A record that says the asset was modified or composed (`modification`, `modifications`, `composed_from`) but has no
// `published_uri` is a customised effect that only exists in that game. The owner-accepted ones should become reusable
// recipes: skills/vfx-authoring/SKILL.md § "Publish-back on accept".
//
// Advisory only: one line per record on stdout, exit 0 on EVERY path (a broken record, a missing directory, bad stdin
// all end in silence). Node built-ins only, no network, a directory walk bounded in depth and file count.
//
// Environment:
//   VFX_PROVENANCE_DIRS     ':'-separated dirs relative to the project root (default: art/provenance)
//   VFX_PUBLISH_BACK_ALWAYS 1 = report every flagged record every turn (default: once per record version)
//   VFX_PUBLISH_BACK_JSON   1 = print one {"systemMessage": ...} JSON object instead of plain lines
//   VFX_PUBLISH_BACK_OFF    1 = do nothing
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_DEPTH = 3;
const MAX_FILES = 200;
const RECORD_RE = /^vfxcloud-.+\.json$/;
export const SECTION = 'skills/vfx-authoring/SKILL.md § "Publish-back on accept"';

const nonEmpty = (v) => (typeof v === 'string' && v.trim() !== '') || (Array.isArray(v) && v.length > 0);

/** Why a record counts as customised, or null. Records may say it as prose (`modification`) or as a list. */
export function customisedReason(rec) {
  if (nonEmpty(rec.modifications)) return 'modifications';
  if (nonEmpty(rec.modification)) return 'modification';
  if (nonEmpty(rec.composed_from)) return 'composed_from';
  return null;
}

/** true when the record is accounted for: published back, or waived with a reason, or the owner did not accept it. */
export function isSettled(rec) {
  if (typeof rec.published_uri === 'string' && /^vfx:\/\/[a-z]+\/[a-z0-9-]+\/\d+$/.test(rec.published_uri)) return true;
  if (typeof rec.publish_waiver === 'string' && rec.publish_waiver.trim() !== '') return true;
  return rec.owner_accepted === false;
}

function* walk(dir, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isFile() && RECORD_RE.test(e.name)) yield p;
    else if (e.isDirectory() && depth < MAX_DEPTH && !e.name.startsWith('.') && e.name !== 'node_modules') yield* walk(p, depth + 1);
  }
}

/** Every flagged record under `root`: [{ file (relative), slug, reason, mtimeMs }]. Never throws. */
export function findUnpublished(root, dirs = ['art/provenance']) {
  const found = [];
  let seen = 0;
  for (const d of dirs) {
    for (const file of walk(path.resolve(root, d), 0)) {
      if (++seen > MAX_FILES) return found;
      try {
        const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue; // e.g. the allowed-licenses list
        const reason = customisedReason(rec);
        if (!reason || isSettled(rec)) continue;
        found.push({ file: path.relative(root, file), slug: path.basename(file).replace(/^vfxcloud-/, '').replace(/\.json$/, ''), reason, mtimeMs: fs.statSync(file).mtimeMs });
      } catch {
        /* unreadable or not JSON: not this hook's job to report */
      }
    }
  }
  return found;
}

export function adviceLine(f) {
  return (
    `[vfx-publish-back] ${f.file}: customised (${f.reason}) and no published_uri. ` +
    `If the owner accepted it, publish it back as a recipe: ${SECTION}; ` +
    `if not, add "publish_waiver": "<reason>" to the record.`
  );
}

/** Drop what this project was already told about at this file version; remember what is reported now. */
function unseen(root, flagged) {
  const stateFile = path.join(os.tmpdir(), `vfx-publish-back-${createHash('sha1').update(root).digest('hex').slice(0, 10)}.json`);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    /* first run */
  }
  const fresh = flagged.filter((f) => state[f.file] !== f.mtimeMs);
  try {
    fs.writeFileSync(stateFile, JSON.stringify(Object.fromEntries(flagged.map((f) => [f.file, f.mtimeMs]))));
  } catch {
    /* read-only tmp: report again next turn, harmless */
  }
  return fresh;
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return {};
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

export function main(env = process.env, payload = readStdin()) {
  if (env.VFX_PUBLISH_BACK_OFF === '1') return '';
  const root = path.resolve(env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd());
  const dirs = (env.VFX_PROVENANCE_DIRS || 'art/provenance').split(':').filter(Boolean);
  const flagged = findUnpublished(root, dirs);
  const report = env.VFX_PUBLISH_BACK_ALWAYS === '1' ? flagged : unseen(root, flagged);
  if (!report.length) return '';
  const lines = report.map(adviceLine);
  return env.VFX_PUBLISH_BACK_JSON === '1' ? JSON.stringify({ systemMessage: lines.join('\n') }) : lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const out = main();
    if (out) process.stdout.write(`${out}\n`);
  } catch {
    /* fail open */
  }
  process.exit(0);
}
