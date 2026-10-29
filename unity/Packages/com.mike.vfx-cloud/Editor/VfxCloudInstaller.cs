using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using Newtonsoft.Json;
using UnityEditor;
using UnityEngine;

namespace VfxCloud
{
    public class InstallOptions
    {
        public string Server;
        public string ApiKey;
        public string Variant = "urp";
        public ConflictPolicy OnConflict = ConflictPolicy.Refuse;
        public string Root;                 // re-roots Assets/VFXCloud/<pack> (plan.md C4 reroot)
        public bool AllowIncomplete;
        public bool StrictRequires;
        public bool DryRun;
        public Action<string, float> Progress;

        public static InstallOptions FromSettings() => new InstallOptions
        {
            Server = VfxCloudSettings.Server,
            ApiKey = VfxCloudSettings.ApiKey,
            Variant = VfxCloudSettings.Variant,
            OnConflict = ParsePolicy(VfxCloudSettings.OnConflict),
        };

        public static ConflictPolicy ParsePolicy(string s)
        {
            switch ((s ?? "refuse").ToLowerInvariant())
            {
                case "skip": return ConflictPolicy.Skip;
                case "overwrite": return ConflictPolicy.Overwrite;
                default: return ConflictPolicy.Refuse;
            }
        }
    }

    public class InstallItemResult
    {
        [JsonProperty("guid")] public string Guid;
        [JsonProperty("path")] public string Path;
        [JsonProperty("action")] public string Action;
        [JsonProperty("reason")] public string Reason;
        [JsonProperty("guid_kept")] public string GuidKept;
    }

    /// <summary>The last stdout line of BatchFetch is this object (C7 summary plus ok/code/message/items).</summary>
    public class InstallSummary
    {
        [JsonProperty("uri")] public string Uri;
        [JsonProperty("variant")] public string Variant;
        [JsonProperty("written")] public int Written;
        [JsonProperty("unchanged")] public int Unchanged;
        [JsonProperty("reused")] public int Reused;
        [JsonProperty("skipped")] public int Skipped;
        [JsonProperty("requires_missing")] public int RequiresMissing;
        [JsonProperty("dangling")] public int Dangling;
        [JsonProperty("complete")] public bool Complete;
        [JsonProperty("ok")] public bool Ok;
        [JsonProperty("code")] public int Code;
        [JsonProperty("message")] public string Message;
        [JsonProperty("root_path")] public string RootPath;
        [JsonProperty("items")] public List<InstallItemResult> Items = new List<InstallItemResult>();
        [JsonProperty("warnings")] public List<string> Warnings = new List<string>();

        public InstallSummary Fail(int code, string message) { Ok = false; Code = code; Message = message; return this; }
    }

    public static class VfxCloudInstaller
    {
        public static InstallSummary Install(string uri, InstallOptions o)
        {
            var s = new InstallSummary { Uri = uri, Variant = o.Variant };
            var parts = (uri ?? "").StartsWith("vfx://", StringComparison.Ordinal) ? uri.Substring(6).TrimEnd('/').Split('/') : new string[0];
            if (parts.Length != 3 || Array.Exists(parts, string.IsNullOrEmpty)) return s.Fail(ExitCodes.Usage, "URI must be vfx://<type>/<slug>/<version>: " + uri);
            if (o.Variant != "urp" && o.Variant != "original") return s.Fail(ExitCodes.Usage, "variant must be urp|original: " + o.Variant);

            var temp = Path.Combine(ProjectRoot, "Temp", "vfx-cloud-" + System.Guid.NewGuid().ToString("N").Substring(0, 8));
            try
            {
                o.Progress?.Invoke("Fetching closure", 0.05f);
                var url = $"{o.Server.TrimEnd('/')}/v1/closure/{parts[0]}/{parts[1]}/{parts[2]}?variant={o.Variant}";
                var bundle = Bundle.Parse(Encoding.UTF8.GetString(Get(url, o.ApiKey)));
                s.Complete = bundle.Complete;
                // dangling GUIDs are a warning only: the bundle stays complete, the exit code unchanged
                var dangling = bundle.Dangling ?? new List<BundleDangling>();
                s.Dangling = dangling.Count;
                if (dangling.Count > 0)
                {
                    var pathOf = new Dictionary<string, string>();
                    foreach (var f in bundle.Files) if (!string.IsNullOrEmpty(f.Guid) && !pathOf.ContainsKey(f.Guid)) pathOf[f.Guid] = f.TargetPath;
                    foreach (var d in dangling)
                    {
                        var by = (d.ReferencedBy ?? new List<string>()).ConvertAll(g => pathOf.TryGetValue(g, out var shipped) ? shipped : g);
                        s.Warnings.Add($"dangling GUID {d.Guid} is defined in no source of the original pack (Unity shows the slot empty); referenced by {(by.Count > 0 ? string.Join(", ", by) : "a shipped file")}");
                    }
                }
                if (!bundle.Complete && !o.AllowIncomplete)
                    return s.Fail(ExitCodes.Incomplete, $"bundle incomplete (reason: {bundle.Reason ?? "unresolved"}, unresolved: {bundle.Unresolved.Count}); set VFX_ALLOW_INCOMPLETE=1 to install anyway");

                var manifest = Path.Combine(ProjectRoot, "Packages", "manifest.json");
                var missing = VfxCloudBundle.MissingPackages(bundle, File.Exists(manifest) ? File.ReadAllText(manifest) : null);
                s.RequiresMissing = missing.Count;
                var firstMissing = s.Warnings.Count;
                foreach (var m in missing) s.Warnings.Add($"requires package {m.Package} ({m.Name}) is missing from Packages/manifest.json");
                if (o.StrictRequires && missing.Count > 0) return s.Fail(ExitCodes.RequiresMissing, s.Warnings[firstMissing]);

                var plan = VfxCloudBundle.Plan(bundle, new EditorProjectIndex(), o.OnConflict, o.Root);
                foreach (var i in plan.Items) s.Items.Add(new InstallItemResult { Guid = i.File.Guid, Path = i.WritePath, Action = i.Action.ToString(), Reason = i.Reason, GuidKept = i.KeepMeta ? i.ExpectedGuid : null });
                s.Unchanged = plan.Count(PlanAction.Unchanged); s.Reused = plan.Count(PlanAction.Reused); s.Skipped = plan.Count(PlanAction.Skip);
                if (plan.Refused) return s.Fail(ExitCodes.ConflictRefused, "conflicts, nothing written (set OnConflict skip|overwrite): " + string.Join("; ", plan.Items.FindAll(x => x.Action == PlanAction.Conflict).ConvertAll(x => x.TargetPath + " (" + x.Reason + ")")));
                var rootFile = bundle.Files.Count > 0 ? bundle.Files[bundle.Files.Count - 1] : null;
                s.RootPath = rootFile == null ? null : VfxCloudBundle.TargetPath(rootFile, o.Root);
                if (o.DryRun) { s.Written = 0; s.Ok = true; s.Message = $"dry run: {plan.Writes.Count} would be written"; return s; }

                var jobs = Download(plan, o, temp, s);
                if (jobs == null) return s;

                o.Progress?.Invoke("Installing", 0.8f);
                try
                {
                    AssetDatabase.StartAssetEditing();
                    VfxCloudMover.Move(ProjectRoot, jobs, Path.Combine(ProjectRoot, "Temp", "vfx-cloud-journal.json"), Path.Combine(temp, "backup"));
                }
                catch (Exception ex) { return s.Fail(ExitCodes.Network, "move failed, undone best-effort: " + ex.Message); }
                finally { AssetDatabase.StopAssetEditing(); }
                AssetDatabase.Refresh();

                var changed = new List<string>();
                foreach (var i in plan.Writes)
                {
                    if (string.IsNullOrEmpty(i.File.Guid) || i.File.MetaSha256 == null) continue;
                    var actual = AssetDatabase.AssetPathToGUID(i.WritePath);
                    if (actual != i.ExpectedGuid) changed.Add($"{i.WritePath}: {i.ExpectedGuid} -> {actual}");
                }
                if (changed.Count > 0) return s.Fail(ExitCodes.GuidChanged, "guid_changed: " + string.Join("; ", changed));
                s.Written = plan.Writes.Count; s.Ok = true;
                s.Message = $"installed {s.Written}, unchanged {s.Unchanged}, reused {s.Reused}, skipped {s.Skipped}";
                return s;
            }
            catch (WebException ex) { return s.Fail(ExitCodes.Network, "network/server error: " + ex.Message); }
            catch (Exception ex) { return s.Fail(ExitCodes.Network, ex.GetType().Name + ": " + ex.Message); }
            finally { TryDelete(temp); }
        }

        // Downloads and sha256-verifies every blob before ANY move; null (summary failed with code 4) on a mismatch.
        static List<MoveJob> Download(InstallPlan plan, InstallOptions o, string temp, InstallSummary s)
        {
            var jobs = new List<MoveJob>();
            Directory.CreateDirectory(temp);
            for (var n = 0; n < plan.Writes.Count; n++)
            {
                var item = plan.Writes[n];
                o.Progress?.Invoke(item.File.TargetPath, 0.1f + 0.7f * n / Math.Max(1, plan.Writes.Count));
                var job = new MoveJob { TargetPath = item.WritePath, TempAsset = Path.Combine(temp, n + ".bin") };
                File.WriteAllBytes(job.TempAsset, Verified(item.File.DownloadUrl, item.File.Sha256, o, s, item.File.TargetPath));
                if (s.Code != 0) return null;
                if (!item.KeepMeta && item.File.MetaDownloadUrl != null)
                {
                    job.TempMeta = Path.Combine(temp, n + ".meta");
                    File.WriteAllBytes(job.TempMeta, Verified(item.File.MetaDownloadUrl, item.File.MetaSha256, o, s, item.File.TargetPath + ".meta"));
                    if (s.Code != 0) return null;
                }
                jobs.Add(job);
            }
            return jobs;
        }

        static byte[] Verified(string url, string sha, InstallOptions o, InstallSummary s, string what)
        {
            var bytes = Get(url, o.ApiKey);
            var actual = VfxCloudBundle.Sha256Hex(bytes);
            if (!string.Equals(actual, sha, StringComparison.OrdinalIgnoreCase)) s.Fail(ExitCodes.ShaMismatch, $"sha256 mismatch for {what}: {actual} != {sha}; nothing was moved");
            return bytes;
        }

        // Decompressed body (sha256 is over the uncompressed bytes).
        static byte[] Get(string url, string apiKey)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "GET";
            req.Timeout = 120000;
            req.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
            if (!string.IsNullOrEmpty(apiKey)) req.Headers["x-vfx-key"] = apiKey;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var stream = resp.GetResponseStream())
            using (var buf = new MemoryStream())
            {
                stream.CopyTo(buf);
                return buf.ToArray();
            }
        }

        static string ProjectRoot => Path.GetDirectoryName(Application.dataPath);

        static void TryDelete(string dir)
        {
            try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { /* temp only */ }
        }

        class EditorProjectIndex : IProjectIndex
        {
            public ProjectEntry ByGuid(string guid)
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                return string.IsNullOrEmpty(path) || !File.Exists(path) ? null : Entry(guid, path);
            }

            public ProjectEntry ByPath(string path)
            {
                if (!File.Exists(path)) return null;
                var guid = AssetDatabase.AssetPathToGUID(path);
                if (string.IsNullOrEmpty(guid) && File.Exists(path + ".meta")) guid = VfxCloudBundle.ParseMetaGuid(File.ReadAllText(path + ".meta"));
                return Entry(guid, path);
            }

            static ProjectEntry Entry(string guid, string path) => new ProjectEntry { Guid = guid, Path = path, Sha256 = () => VfxCloudBundle.Sha256Hex(File.ReadAllBytes(path)) };
        }
    }
}
