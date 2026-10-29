/**
 * vfx-bytes/1 — the bundle contract as executable code (plans/261028-self-contained-vfx-fetch/plan.md
 * § Contract, C1-C9). Pure: no db, no config, no I/O. Every lane validates against these schemas and
 * never restates them. Field names are snake_case on the wire, exactly as C3/C4 spell them.
 */
import path from 'node:path';
import { z } from 'zod';
import { VFX_ERROR_CODES } from './errors.ts';
import { BYTE_VISIBILITIES } from './license.ts';

export const CONTRACT_ID = 'vfx-bytes/1';
export const BUNDLE_SCHEMA = 'vfx-bundle/1';

/** C3/C4 `kind` enum, in the order the spec lists it. */
export const KINDS = [
  'prefab', 'material', 'texture', 'shader', 'mesh', 'animation',
  'controller', 'script', 'asmdef', 'audio', 'other',
] as const;
export type Kind = (typeof KINDS)[number];

export const VARIANTS = ['original', 'urp'] as const;
export type Variant = (typeof VARIANTS)[number];

/**
 * C2: text kinds are gzipped at rest, binary kinds stored as is. `meta` and `other-text` are storage
 * hints (the `x-vfx-kind` header), not `kind` values.
 */
export const TEXT_KINDS = ['prefab', 'material', 'shader', 'animation', 'controller', 'script', 'asmdef', 'meta', 'other-text'] as const;
export type TextKind = (typeof TEXT_KINDS)[number];

/** C4 ordering: the lower rank is visited first among siblings in the dependency-first DFS. */
export const KIND_RANK: Readonly<Record<Kind, number>> = {
  shader: 0, texture: 1, mesh: 2, audio: 3, animation: 4, controller: 5,
  script: 6, asmdef: 7, material: 8, other: 9, prefab: 10,
};

export const REASONS = ['no_prefab', 'bytes_not_uploaded'] as const;
export const REQUIRE_KINDS = ['builtin', 'package'] as const;
export const FILE_ORIGINS = ['asset_file', 'resource'] as const;

/** C9 causes. `failed` takes the first list, `skipped` the second; `ok` takes none. */
export const FAILED_CAUSES = [
  'magenta-pixel', 'unrenderable-material', 'prefab-missing', 'exception',
  'no-visible-output', 'closure-unresolved', 'unfixable-shader', 'unfixable-source', 'unfixable-script',
] as const;
export const SKIPPED_CAUSES = ['no-prefab', 'variant-borrows-canonical'] as const;
export const RENDER_STATES = ['ok', 'failed', 'skipped'] as const;

const EXTENSION_KIND: Readonly<Record<string, Kind>> = {
  '.prefab': 'prefab',
  '.mat': 'material',
  '.anim': 'animation',
  '.controller': 'controller',
  '.cs': 'script',
  '.asmdef': 'asmdef',
  '.asmref': 'asmdef',
  '.shader': 'shader',
  '.shadergraph': 'shader',
  '.shadersubgraph': 'shader',
  '.cginc': 'shader',
  '.hlsl': 'shader',
  '.compute': 'shader',
  '.png': 'texture',
  '.jpg': 'texture',
  '.jpeg': 'texture',
  '.tga': 'texture',
  '.psd': 'texture',
  '.tif': 'texture',
  '.tiff': 'texture',
  '.exr': 'texture',
  '.hdr': 'texture',
  '.bmp': 'texture',
  '.gif': 'texture',
  '.fbx': 'mesh',
  '.obj': 'mesh',
  '.mesh': 'mesh',
  '.wav': 'audio',
  '.mp3': 'audio',
  '.ogg': 'audio',
  '.aif': 'audio',
  '.aiff': 'audio',
};

/**
 * Kind of a file from its Unity path extension. Anything unmapped is `other` (never guessed).
 * The shader-family extensions (.shadergraph, .shadersubgraph, .cginc, .hlsl, .compute) map to `shader`:
 * a decision of this module, not a line of the spec (flagged in the phase-1 report).
 */
export function kindOfPath(filePath: string): Kind {
  return EXTENSION_KIND[path.posix.extname(filePath).toLowerCase()] ?? 'other';
}

/** The Unity folder every bundle file of a pack is installed under (C4 `target_path`). */
const PACK_FOLDER = /^Assets\/VFXCloud\/[^/]+\//;

/**
 * C4 reroot. Replaces ONLY the `Assets/VFXCloud/<pack>` prefix of `targetPath` by `root`; the rest of the
 * relative structure is kept. A null/empty root, or a path outside the pack folder, returns `targetPath`.
 * Both clients implement this sentence and are tested against test-fixtures/reroot-cases.json.
 */
export function reroot(targetPath: string, root: string | null | undefined): string {
  if (!root) return targetPath;
  const m = PACK_FOLDER.exec(targetPath);
  if (!m) return targetPath;
  const base = root.replace(/\/+$/, '');
  return `${base}/${targetPath.slice(m[0].length)}`;
}

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'sha256: 64 lowercase hex');
const Guid = z.string().regex(/^[0-9a-f]{32}$/, 'guid: 32 lowercase hex');
const AbsoluteUrl = z.string().regex(/^https?:\/\/[^\s]+$/, 'absolute http(s) URL');
const NonEmpty = z.string().min(1);
const Count = z.number().int().nonnegative();
const Visibility = z.enum(BYTE_VISIBILITIES);

export const KindSchema = z.enum(KINDS);
export const VariantSchema = z.enum(VARIANTS);

/** C3 `AssetFileInput`: what the uploader registers with POST /v1/asset-file/batch. */
export const AssetFileInputSchema = z
  .strictObject({
    guid: Guid,
    variant: VariantSchema,
    kind: KindSchema,
    path: NonEmpty,
    asset_sha256: Sha256,
    meta_sha256: Sha256.nullable(),
    pack: NonEmpty,
    license: NonEmpty,
    visibility: Visibility,
    source: z.strictObject({
      game: z.string().nullable(),
      origin: NonEmpty,
      copies: z.array(z.strictObject({ origin: NonEmpty, sha256: Sha256 })).optional(),
    }),
    urp: z
      .strictObject({ rule: NonEmpty, glow_cap: z.number().nullable(), shader_guid: Guid })
      .optional(),
    replace: z.boolean().optional(),
  })
  .superRefine((f, ctx) => {
    if (f.variant === 'urp' && (f.kind !== 'material' || f.urp === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['variant'], message: 'variant urp requires kind material and a urp object' });
    }
  });
export type AssetFileInput = z.infer<typeof AssetFileInputSchema>;

/** C4 `BundleFile`. */
export const BundleFileSchema = z
  .strictObject({
    guid: Guid.nullable(),
    origin: z.enum(FILE_ORIGINS),
    kind: KindSchema,
    variant: VariantSchema,
    urp_converted: z.boolean(),
    urp_rule: NonEmpty.nullable(),
    path: NonEmpty,
    target_path: NonEmpty,
    pack: NonEmpty,
    license: NonEmpty,
    sha256: Sha256,
    bytes: Count,
    download_url: AbsoluteUrl,
    meta_sha256: Sha256.nullable(),
    meta_bytes: Count,
    meta_download_url: AbsoluteUrl.nullable(),
  })
  .superRefine((f, ctx) => {
    const issue = (message: string, p: string): void => ctx.addIssue({ code: 'custom', path: [p], message });
    if (f.origin === 'asset_file' && f.guid === null) issue('asset_file files carry a guid', 'guid');
    if (f.urp_converted && (f.variant !== 'urp' || f.urp_rule === null)) issue('urp_converted needs variant urp and urp_rule', 'urp_converted');
    if (!f.urp_converted && f.urp_rule !== null) issue('urp_rule is only set when urp_converted', 'urp_rule');
    const hasMeta = f.meta_sha256 !== null;
    if (hasMeta !== (f.meta_download_url !== null)) issue('meta_sha256 and meta_download_url go together', 'meta_download_url');
    if (hasMeta === (f.meta_bytes === 0)) issue('meta_bytes is 0 exactly when there is no .meta', 'meta_bytes');
    if (f.origin === 'resource' && hasMeta) issue('origin resource carries no .meta (C4)', 'meta_sha256');
  });
export type BundleFile = z.infer<typeof BundleFileSchema>;

const RequireSchema = z
  .strictObject({
    guid: Guid,
    kind: z.enum(REQUIRE_KINDS),
    name: NonEmpty,
    package: NonEmpty.nullable(),
    version: NonEmpty.nullable(),
    referenced_by: z.array(Guid),
  })
  .superRefine((r, ctx) => {
    if (r.kind === 'builtin' && r.package !== null) ctx.addIssue({ code: 'custom', path: ['package'], message: 'builtin requires has package null' });
    if (r.kind === 'package' && r.package === null) ctx.addIssue({ code: 'custom', path: ['package'], message: 'package requires a package name' });
  });

const UnresolvedSchema = z.strictObject({ guid: Guid, referenced_by: z.array(Guid) });
/**
 * C4 `dangling` entry: same shape as `unresolved`. A GUID a shipped file references that no readable source
 * of the (fully swept) pack defines: the vendor pack has the same hole and Unity renders the slot empty.
 * Non-blocking: it does not make the bundle incomplete.
 */
const DanglingSchema = z.strictObject({ guid: Guid, referenced_by: z.array(Guid) });

/** C4 `Bundle`: the closure response. */
export const BundleSchema = z
  .strictObject({
    schema: z.literal(BUNDLE_SCHEMA),
    uri: z.string().regex(/^vfx:\/\/[a-z]+\/[a-z0-9-]+\/\d+$/, 'vfx://<type>/<slug>/<version>'),
    variant: VariantSchema,
    root_guid: Guid.nullable(),
    complete: z.boolean(),
    reason: z.enum(REASONS).nullable(),
    files: z.array(BundleFileSchema),
    requires: z.array(RequireSchema),
    unresolved: z.array(UnresolvedSchema),
    dangling: z.array(DanglingSchema),
    cycles: z.array(z.array(Guid)),
    file_count: Count,
    total_bytes: Count,
  })
  .superRefine((b, ctx) => {
    const issue = (message: string, p: string): void => ctx.addIssue({ code: 'custom', path: [p], message });
    if (b.file_count !== b.files.length) issue('file_count must equal files.length', 'file_count');
    if (b.unresolved.length > 0 && b.complete) issue('unresolved entries make the bundle incomplete', 'complete');
    const unresolvedGuids = new Set(b.unresolved.map((u) => u.guid));
    if (b.dangling.some((d) => unresolvedGuids.has(d.guid))) issue('a guid is dangling or unresolved, never both', 'dangling');
    if (b.reason !== null && (b.files.length > 0 || b.complete)) issue('reason set: files is empty and complete is false', 'reason');
  });
export type Bundle = z.infer<typeof BundleSchema>;

/** C5 error envelope. */
export const ErrorEnvelopeSchema = z.strictObject({
  error: NonEmpty,
  code: z.enum(VFX_ERROR_CODES),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

const RenderItemSchema = z
  .strictObject({
    state: z.enum(RENDER_STATES),
    cause: z.string().nullable(),
    detail: z.string().nullable(),
    shaders: z.array(z.string()),
    renderedAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((it, ctx) => {
    const causeOk =
      it.state === 'ok' ? it.cause === null
      : it.state === 'failed' ? (FAILED_CAUSES as readonly string[]).includes(it.cause ?? '')
      : (SKIPPED_CAUSES as readonly string[]).includes(it.cause ?? '');
    if (!causeOk) ctx.addIssue({ code: 'custom', path: ['cause'], message: `cause "${it.cause}" is not valid for state ${it.state}` });
  });

/** C9 `data/previews/_failures.json`. */
export const RenderFailureFileSchema = z.strictObject({
  version: z.literal(1),
  runId: z.iso.datetime({ offset: true }),
  items: z.record(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'slug'), RenderItemSchema),
});
export type RenderFailureFile = z.infer<typeof RenderFailureFileSchema>;
