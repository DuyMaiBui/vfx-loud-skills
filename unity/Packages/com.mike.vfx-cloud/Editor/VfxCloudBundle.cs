using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

// Pure logic (no UnityEngine/UnityEditor): compiled by plain dotnet in tools/vfxcloud-tests.
// Field names follow plan.md C4 `vfx-bundle/1`; server/src/bundle-contract.ts is the SSOT.
namespace VfxCloud
{
    public class BundleFile
    {
        [JsonProperty("guid")] public string Guid;
        [JsonProperty("origin")] public string Origin;
        [JsonProperty("kind")] public string Kind;
        [JsonProperty("variant")] public string Variant;
        [JsonProperty("urp_converted")] public bool UrpConverted;
        [JsonProperty("urp_rule")] public string UrpRule;
        [JsonProperty("path")] public string Path;
        [JsonProperty("target_path")] public string TargetPath;
        [JsonProperty("pack")] public string Pack;
        [JsonProperty("license")] public string License;
        [JsonProperty("sha256")] public string Sha256;
        [JsonProperty("bytes")] public long Bytes;
        [JsonProperty("download_url")] public string DownloadUrl;
        [JsonProperty("meta_sha256")] public string MetaSha256;
        [JsonProperty("meta_bytes")] public long MetaBytes;
        [JsonProperty("meta_download_url")] public string MetaDownloadUrl;
    }

    public class BundleRequire
    {
        [JsonProperty("guid")] public string Guid;
        [JsonProperty("kind")] public string Kind;
        [JsonProperty("name")] public string Name;
        [JsonProperty("package")] public string Package;
        [JsonProperty("version")] public string Version;
        [JsonProperty("referenced_by")] public List<string> ReferencedBy = new List<string>();
    }

    public class BundleUnresolved
    {
        [JsonProperty("guid")] public string Guid;
        [JsonProperty("referenced_by")] public List<string> ReferencedBy = new List<string>();
    }

    public class Bundle
    {
        [JsonProperty("schema")] public string Schema;
        [JsonProperty("uri")] public string Uri;
        [JsonProperty("variant")] public string Variant;
        [JsonProperty("root_guid")] public string RootGuid;
        [JsonProperty("complete")] public bool Complete;
        [JsonProperty("reason")] public string Reason;
        [JsonProperty("files")] public List<BundleFile> Files = new List<BundleFile>();
        [JsonProperty("requires")] public List<BundleRequire> Requires = new List<BundleRequire>();
        [JsonProperty("unresolved")] public List<BundleUnresolved> Unresolved = new List<BundleUnresolved>();
        [JsonProperty("cycles")] public List<List<string>> Cycles = new List<List<string>>();
        [JsonProperty("file_count")] public int FileCount;
        [JsonProperty("total_bytes")] public long TotalBytes;

        public static Bundle Parse(string json) => JsonConvert.DeserializeObject<Bundle>(json);
    }

    public enum PlanAction { Install, Unchanged, Reused, Conflict, Skip }

    public enum ConflictPolicy { Refuse, Skip, Overwrite }

    /// <summary>Exit codes aligned with plan.md C7 (shell client); the Unity client reuses the numbers.</summary>
    public static class ExitCodes
    {
        public const int Ok = 0, Network = 1, Usage = 2, ConflictRefused = 3, ShaMismatch = 4, Incomplete = 5, RequiresMissing = 6, GuidChanged = 7;
    }

    /// <summary>What the project already holds, resolved lazily by the editor side (GUID lookup, path lookup).</summary>
    public class ProjectEntry
    {
        public string Guid;   // null/"" when unknown (file on disk without a readable .meta)
        public string Path;
        public Func<string> Sha256;
    }

    public interface IProjectIndex
    {
        ProjectEntry ByGuid(string guid);
        ProjectEntry ByPath(string path);
    }

    public class PlanItem
    {
        public BundleFile File;
        public string TargetPath;       // after reroot
        public PlanAction Action;
        public string Reason;
        public string WritePath;        // where bytes go when Action == Install
        public bool KeepMeta;           // overwrite: keep the existing .meta, write no new one
        public string ExpectedGuid;     // GUID the post-install assert expects (kept guid under overwrite)
    }

    public class InstallPlan
    {
        public List<PlanItem> Items = new List<PlanItem>();
        public bool Refused;
        /// <summary>Items that will be written. Empty when the plan is refused.</summary>
        public List<PlanItem> Writes = new List<PlanItem>();
        public int Count(PlanAction a) { int n = 0; foreach (var i in Items) if (i.Action == a) n++; return n; }
    }

    public static class VfxCloudBundle
    {
        const string RootPrefix = "Assets/VFXCloud/";

        /// <summary>Pure reroot (plan.md C4): replace ONLY the `Assets/VFXCloud/&lt;pack&gt;` prefix with the root.</summary>
        public static string Reroot(string targetPath, string root)
        {
            if (string.IsNullOrEmpty(root) || targetPath == null) return targetPath;
            if (!targetPath.StartsWith(RootPrefix, StringComparison.Ordinal)) return targetPath;
            var slash = targetPath.IndexOf('/', RootPrefix.Length);
            if (slash < 0) return targetPath;
            return root.TrimEnd('/') + "/" + targetPath.Substring(slash + 1);
        }

        public static string TargetPath(BundleFile file, string root) => Reroot(file.TargetPath, root);

        public static string Sha256Hex(byte[] bytes)
        {
            using (var sha = SHA256.Create())
            {
                var hash = sha.ComputeHash(bytes);
                var sb = new StringBuilder(hash.Length * 2);
                foreach (var b in hash) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }

        public static InstallPlan Plan(Bundle bundle, IProjectIndex index, ConflictPolicy policy, string root = null)
        {
            var plan = new InstallPlan();
            foreach (var f in bundle.Files)
            {
                var target = TargetPath(f, root);
                var item = Classify(f, target, index);
                if (item.Action == PlanAction.Conflict && policy == ConflictPolicy.Skip)
                {
                    item.Action = PlanAction.Skip;
                }
                else if (item.Action == PlanAction.Conflict && policy == ConflictPolicy.Overwrite)
                {
                    ApplyOverwrite(item, index);
                }
                plan.Items.Add(item);
            }
            plan.Refused = policy == ConflictPolicy.Refuse && plan.Count(PlanAction.Conflict) > 0;
            if (!plan.Refused)
            {
                foreach (var i in plan.Items) if (i.Action == PlanAction.Install) plan.Writes.Add(i);
            }
            return plan;
        }

        static PlanItem Classify(BundleFile f, string target, IProjectIndex index)
        {
            var item = new PlanItem { File = f, TargetPath = target, WritePath = target, ExpectedGuid = f.Guid, Action = PlanAction.Install };
            var atPath = index.ByPath(target);
            var byGuid = string.IsNullOrEmpty(f.Guid) ? null : index.ByGuid(f.Guid);

            if (byGuid != null && !SamePath(byGuid.Path, target))
            {
                if (Same(byGuid, f)) { item.Action = PlanAction.Reused; item.Reason = "guid present at " + byGuid.Path; }
                else { item.Action = PlanAction.Conflict; item.Reason = "guid present at " + byGuid.Path + " with different bytes"; }
                return item;
            }
            if (atPath == null) return item;

            var pathGuid = string.IsNullOrEmpty(atPath.Guid) ? null : atPath.Guid;
            var guidMatches = string.IsNullOrEmpty(f.Guid) || pathGuid == f.Guid;
            if (!guidMatches)
            {
                item.Action = PlanAction.Conflict;
                item.Reason = "path exists with guid " + (pathGuid ?? "unknown");
            }
            else if (Same(atPath, f)) item.Action = PlanAction.Unchanged;
            else { item.Action = PlanAction.Conflict; item.Reason = "path exists with different bytes"; }
            return item;
        }

        // overwrite: replace content, keep the existing .meta (so the existing GUID stays and is reported).
        static void ApplyOverwrite(PlanItem item, IProjectIndex index)
        {
            var existing = (string.IsNullOrEmpty(item.File.Guid) ? null : index.ByGuid(item.File.Guid)) ?? index.ByPath(item.TargetPath);
            item.Action = PlanAction.Install;
            item.KeepMeta = true;
            item.WritePath = existing.Path;
            item.ExpectedGuid = string.IsNullOrEmpty(existing.Guid) ? item.File.Guid : existing.Guid;
        }

        static bool Same(ProjectEntry e, BundleFile f) => string.Equals(e.Sha256 == null ? null : e.Sha256(), f.Sha256, StringComparison.OrdinalIgnoreCase);
        static bool SamePath(string a, string b) => string.Equals(a, b, StringComparison.Ordinal);

        /// <summary>`package` requires whose name is absent from Packages/manifest.json dependencies.</summary>
        public static List<BundleRequire> MissingPackages(Bundle bundle, string manifestJson)
        {
            var have = new HashSet<string>();
            if (!string.IsNullOrEmpty(manifestJson))
            {
                var deps = JObject.Parse(manifestJson)["dependencies"] as JObject;
                if (deps != null) foreach (var p in deps.Properties()) have.Add(p.Name);
            }
            var missing = new List<BundleRequire>();
            var seen = new HashSet<string>();
            foreach (var r in bundle.Requires)
            {
                if (r.Kind != "package" || string.IsNullOrEmpty(r.Package) || have.Contains(r.Package)) continue;
                if (seen.Add(r.Package)) missing.Add(r);
            }
            return missing;
        }

        /// <summary>First `guid:` value of a Unity `.meta` file, or null.</summary>
        public static string ParseMetaGuid(string metaText)
        {
            if (metaText == null) return null;
            var m = System.Text.RegularExpressions.Regex.Match(metaText, @"^guid:\s*([0-9a-fA-F]{32})", System.Text.RegularExpressions.RegexOptions.Multiline);
            return m.Success ? m.Groups[1].Value.ToLowerInvariant() : null;
        }
    }
}
