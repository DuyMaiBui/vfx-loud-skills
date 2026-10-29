// GUID integrity of the acceptance project against the bundles as the server declares them NOW (plan.md phase 12 step 5).
// usage: node scripts/accept/phase-12-guids.mjs <project> <bundle.json>...   (bundle.json = GET /v1/closure/... ?variant=urp saved by phase-12.sh)
// For every origin:"asset_file" item: <project>/<target_path>.meta exists with `guid:` == item.guid, the asset bytes hash to item.sha256 and the
// .meta bytes hash to item.meta_sha256 (Unity must not have rewritten it). Prints one JSON line {files, guid_ok, asset_ok, meta_exact, bad:[...]}.
// Exit 0 when bad is empty AND files > 0 (an empty set proves nothing), else 1.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
const [project, ...bundles] = process.argv.slice(2);
const sha = (b) => createHash('sha256').update(b).digest('hex');
let files = 0, guidOk = 0, assetOk = 0, metaExact = 0;
const bad = [];
for (const f of bundles) {
  const b = JSON.parse(readFileSync(f, 'utf8'));
  for (const x of b.files) {
    if (x.origin !== 'asset_file') continue;
    files++;
    const p = `${project}/${x.target_path}`;
    if (!existsSync(p) || !existsSync(p + '.meta')) { bad.push(`${x.target_path}: missing`); continue; }
    const meta = readFileSync(p + '.meta');
    const g = /guid:\s*([0-9a-f]{32})/.exec(meta.toString('utf8'));
    if (g && g[1] === x.guid) guidOk++; else bad.push(`${x.target_path}: guid ${g ? g[1] : 'none'} != ${x.guid}`);
    if (sha(readFileSync(p)) === x.sha256) assetOk++; else bad.push(`${x.target_path}: asset sha differs`);
    if (sha(meta) === x.meta_sha256) metaExact++; else bad.push(`${x.target_path}: .meta bytes differ from the bundle`);
  }
}
console.log(JSON.stringify({ files, guid_ok: guidOk, asset_ok: assetOk, meta_exact: metaExact, bad: bad.slice(0, 10), bad_count: bad.length }));
process.exit(bad.length === 0 && files > 0 ? 0 : 1);
