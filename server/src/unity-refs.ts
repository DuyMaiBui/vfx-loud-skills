/**
 * Unity GUID-reference scanner and classifier (vfx-bytes/1, C2 `refs`, C4 `requires`/`unresolved`, D6, D7).
 * ONE implementation: the server, the uploader and the verifier all import this file (lanes never restate
 * the patterns). Pure except `loadPackageGuids()`, which reads the committed package map.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadRules } from '../../seed/graph/rules.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_GUID_MAP_PATH = path.join(here, 'unity-package-guids.json');

/** C2 exactly. P1: YAML `{fileID, guid, type}` references. */
const P1_YAML = /guid:\s*([0-9a-f]{32})/g;
/** P2: asmdef / asmref `references` by GUID. */
const P2_ASMDEF = /GUID:([0-9a-f]{32})/g;
/** P3: Shader Graph and JSON-embedded references, escaped (`\"guid\":\"...\"`) or plain. */
const P3_JSON = /\\?"guid\\?"\s*:\s*\\?"([0-9a-f]{32})/g;

/** Names of Unity's built-in resource GUIDs (C4 `requires.name`). */
export const BUILTIN_NAMES = {
  default: 'Unity default resources',
  extra: 'Unity extra resources',
  other: 'Unity built-in resources',
} as const;

/** A NUL byte in the first 8000 bytes marks binary content (textures, meshes, audio): no refs (C2). */
function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/**
 * Distinct, lower-case GUIDs referenced by a Unity text file, in first-occurrence order. Binary input
 * yields []. `ownGuid` (the file's own `.meta` guid) is excluded: a real self-reference exists (Retro
 * Arsenal `BalloonRelease.prefab` `m_CorrespondingSourceObject`), and the file is not its own dependency.
 */
export function scanRefs(bytes: Buffer | string, ownGuid?: string): string[] {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  if (looksBinary(buf)) return [];
  const text = buf.toString('utf8');
  const own = ownGuid?.toLowerCase();
  const seen = new Set<string>();
  for (const re of [P1_YAML, P2_ASMDEF, P3_JSON]) {
    for (const m of text.matchAll(re)) {
      const guid = m[1];
      if (guid !== own) seen.add(guid);
    }
  }
  return [...seen];
}

/** True for Unity built-in resource GUIDs (`rules.assets.builtinGuidPattern`, shared with the graph build). */
export function isBuiltinGuid(guid: string): boolean {
  return new RegExp(loadRules().assets.builtinGuidPattern).test(guid);
}

/** Name of a built-in GUID: the two fixed constants for `...f000...` and `...e000...`, a generic one otherwise. */
export function builtinName(guid: string): string {
  const mid = guid.slice(16, 20);
  if (mid === 'f000') return BUILTIN_NAMES.default;
  if (mid === 'e000') return BUILTIN_NAMES.extra;
  return BUILTIN_NAMES.other;
}

const Guid = z.string().regex(/^[0-9a-f]{32}$/);
const PackageEntry = z
  .strictObject({
    kind: z.enum(['package', 'builtin']),
    name: z.string().min(1),
    package: z.string().min(1).nullable(),
    version: z.string().min(1).nullable(),
  })
  .superRefine((e, ctx) => {
    if (e.kind === 'package' && e.package === null) ctx.addIssue({ code: 'custom', path: ['package'], message: 'package entries name their package' });
    if (e.kind === 'builtin' && e.package !== null) ctx.addIssue({ code: 'custom', path: ['package'], message: 'builtin entries have package null' });
  });
export type PackageEntry = z.infer<typeof PackageEntry>;

export const PackageGuidMapSchema = z.strictObject({
  version: z.literal(1),
  entries: z.record(Guid, PackageEntry),
});
export type PackageGuidMap = z.infer<typeof PackageGuidMapSchema>;

/** Loads and validates the committed map (lane P is its only writer). Throws on a malformed file. */
export function loadPackageGuids(file: string = PACKAGE_GUID_MAP_PATH): Map<string, PackageEntry> {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  const parsed = PackageGuidMapSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`unity-package-guids.json invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  return new Map(Object.entries(parsed.data.entries));
}

export const DANGLING_GUID_MAP_PATH = path.join(here, 'dangling-guids.json');

const DanglingEntry = z.strictObject({ packs: z.array(z.string().min(1)).min(1) });
export type DanglingEntry = z.infer<typeof DanglingEntry>;

/**
 * Committed map of GUIDs that are referenced by shipped files but defined in no readable source although every
 * complete source of the referencing pack was swept (written by the uploader, `--dangling-map`). `packs` lists the
 * packs whose files reference the guid: only those packs were fully swept for it.
 */
export const DanglingGuidMapSchema = z.strictObject({
  version: z.literal(1),
  entries: z.record(Guid, DanglingEntry),
});

export function loadDanglingGuids(file: string = DANGLING_GUID_MAP_PATH): Map<string, DanglingEntry> {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  const parsed = DanglingGuidMapSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`dangling-guids.json invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  return new Map(Object.entries(parsed.data.entries));
}

/**
 * True iff `guid` is in the dangling map and EVERY referrer is a shipped pack file of a pack the entry names.
 * A referrer with `pack: null` (a resource root, a recipe prefab, anything not a shipped pack file) or a pack the
 * map does not name keeps the guid an error: roots never dangle.
 */
export function isDangling(guid: string, referrers: Array<{ pack: string | null }>, map: Map<string, DanglingEntry>): boolean {
  const entry = map.get(guid);
  if (!entry || referrers.length === 0) return false;
  return referrers.every((r) => r.pack !== null && entry.packs.includes(r.pack));
}

export type GuidClass =
  | { kind: 'builtin'; name: string; package: null; version: null }
  | { kind: 'package'; name: string; package: string; version: string | null }
  | { kind: 'unresolved' };

/**
 * Classify a referenced GUID (C4). Builtin pattern first, then the package map; anything else is
 * `unresolved` (never a nameless `requires`). Package files are never shipped (D7).
 */
export function classifyGuid(guid: string, packageMap: Map<string, PackageEntry>): GuidClass {
  if (isBuiltinGuid(guid)) return { kind: 'builtin', name: builtinName(guid), package: null, version: null };
  const entry = packageMap.get(guid);
  if (!entry) return { kind: 'unresolved' };
  if (entry.kind === 'builtin') return { kind: 'builtin', name: entry.name, package: null, version: null };
  return { kind: 'package', name: entry.name, package: entry.package as string, version: entry.version };
}
