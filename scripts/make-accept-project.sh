#!/usr/bin/env bash
# Create (idempotently) the clean acceptance project unity/VFXAccept (plan.md D13, phase 12 step 1) and print its absolute path as the LAST stdout line.
# It has the VFXPreview ProjectSettings + URP manifest + a COPY of Assets/Editor/VfxPreview (renderer, incl. RecipePrefabBuilder*.cs) + the client
# package (file: dependency). No ImportedPacks, no Assets/VFXCloud: those arrive only through a fetch. Also writes data/accept/samples.json and
# data/accept/targets.json + targets-control.json (tools/preview/targets.json filtered to the sample slugs / the negative-control subset; teleport-gate keeps prefabGuid null until the builder ran).
# Re-running refreshes the copied Editor sources and the manifest but never touches Library/, Assets/VFXCloud or settings Unity already wrote.
# Read-only on unity/VFXPreview (never opens or modifies it). Exit: 0 ok, 1 missing input.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
src="$repo/unity/VFXPreview"
proj="$repo/unity/VFXAccept"
acc="$repo/data/accept"
for f in "$src/ProjectSettings/ProjectVersion.txt" "$src/Packages/manifest.json" "$src/Assets/Editor/VfxPreview" "$repo/unity/Packages/com.mike.vfx-cloud/package.json" \
  "$repo/tools/preview/targets.json" "$repo/scripts/accept/phase-12-samples.json"; do
  [[ -e "$f" ]] || { echo "make-accept-project: missing $f" >&2; exit 1; }
done
mkdir -p "$proj/Assets/Editor" "$proj/ProjectSettings" "$proj/Packages" "$acc"

# ProjectSettings: copy once (no-clobber, so a re-run never undoes what Unity wrote); PackageManagerSettings.asset is machine-local state of the other Editor.
for f in "$src"/ProjectSettings/*; do
  [[ "$(basename "$f")" == PackageManagerSettings.asset* ]] && continue
  cp -n "$f" "$proj/ProjectSettings/"
done
# Renderer sources: always refreshed from VFXPreview (the source of truth).
mkdir -p "$proj/Assets/Editor/VfxPreview"
cp -f "$src"/Assets/Editor/VfxPreview/* "$proj/Assets/Editor/VfxPreview/"
[[ -f "$proj/Assets/Editor.meta" ]] || cp "$src/Assets/Editor.meta" "$proj/Assets/Editor.meta" 2>/dev/null || true

# Manifest: VFXPreview's (URP, shadergraph, modules) minus the unity-mcp git package, plus the client as a file: dependency.
node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
delete m.dependencies["com.coplaydev.unity-mcp"];
m.dependencies["com.mike.vfx-cloud"] = "file:../../Packages/com.mike.vfx-cloud";
const out = JSON.stringify(m, null, 2) + "\n";
const f = process.argv[2];
if (!fs.existsSync(f) || fs.readFileSync(f, "utf8") !== out) fs.writeFileSync(f, out);
' "$src/Packages/manifest.json" "$proj/Packages/manifest.json"

# Samples and targets.
cp -f "$repo/scripts/accept/phase-12-samples.json" "$acc/samples.json"
node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).samples;
const t = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const by = new Map(t.map((x) => [x.slug, x]));
const out = [];
for (const x of s) {
  const r = by.get(x.slug);
  if (!r) { console.error("make-accept-project: sample not in targets.json: " + x.slug); process.exit(1); }
  out.push(x.bundle ? r : { ...r, prefabPath: null, prefabGuid: null });
}
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
fs.writeFileSync(process.argv[4], JSON.stringify(out.filter((r, i) => s[i].control), null, 1));
' "$acc/samples.json" "$repo/tools/preview/targets.json" "$acc/targets.json" "$acc/targets-control.json"
echo "$proj"
