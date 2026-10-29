using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;

namespace VfxPreview
{
    /// <summary>Durable per-slug render outcome (plan.md C9): `data/previews/_failures.json`, one atomic write per run, merged into the previous
    /// file by slug (latest run wins). `seed/preview-failures-ingest.ts` persists it into `preview_render`. The cause strings are the C9 enum;
    /// the server contract (`RenderFailureFileSchema`) rejects anything else.</summary>
    static class RenderFailures
    {
        public const string StateOk = "ok", StateFailed = "failed", StateSkipped = "skipped";
        public const string MagentaPixel = "magenta-pixel", UnrenderableMaterial = "unrenderable-material", PrefabMissing = "prefab-missing",
            Exception = "exception", NoVisibleOutput = "no-visible-output", NoPrefab = "no-prefab";
        const int MaxDetail = 500;

        sealed class Entry { public string State, Cause, Detail; public List<string> Shaders; public string At; }

        static readonly Dictionary<string, Entry> Items = new Dictionary<string, Entry>();
        static string _runId;

        public static string FilePath => Path.Combine(PreviewOptions.PreviewDir, "_failures.json");
        static string Iso(DateTime t) => t.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");

        public static void Begin() { Items.Clear(); _runId = Iso(DateTime.UtcNow); }

        public static void Record(string slug, string state, string cause, string detail, IEnumerable<string> shaders)
        {
            if (state == StateFailed && string.IsNullOrEmpty(cause)) cause = Exception; // the contract refuses a failure without a cause
            if (detail != null && detail.Length > MaxDetail) detail = detail.Substring(0, MaxDetail);
            Items[slug] = new Entry { State = state, Cause = state == StateOk ? null : cause, Detail = detail, Shaders = new List<string>(shaders ?? new string[0]), At = Iso(DateTime.UtcNow) };
        }

        /// <summary>A rendered clip is `ok`, unless the cell saw nothing visible (still a clip, but recorded as failed/no-visible-output).</summary>
        public static void RecordResult(PreviewBatch.Result r)
        {
            if (r.ok && r.cause == null) { Record(r.slug, StateOk, null, r.note, r.shaders); return; }
            var cause = r.cause ?? Exception; var detail = r.error ?? r.note;
            // A waived slug that failed as the waiver expects is recorded with the waiver's unfixable-* cause (rendered cause kept in the detail);
            // a waived slug that rendered fine stays ok (the waiver is stale), a different failure keeps its own cause.
            if (Waivers.TryGet(r.slug, out var w) && WaiverRules.Resolve(cause, w.Cause) != cause)
            { detail = "waived: " + w.Detail + " [" + cause + (string.IsNullOrEmpty(detail) ? "" : ": " + detail) + "]"; cause = w.Cause; }
            Record(r.slug, StateFailed, cause, detail, r.shaders);
        }

        /// <summary>Merge this run into the existing file (a slug not rendered this run keeps its previous entry) and replace it atomically.</summary>
        public static void Write()
        {
            if (_runId == null) return;
            Directory.CreateDirectory(PreviewOptions.PreviewDir);
            var items = new JObject();
            if (File.Exists(FilePath))
            {
                try { if (JObject.Parse(File.ReadAllText(FilePath))["items"] is JObject prev) items = prev; }
                catch (Exception e) { UnityEngine.Debug.LogWarning("[RenderFailures] previous _failures.json unreadable, starting fresh: " + e.Message); }
            }
            foreach (var kv in Items)
                items[kv.Key] = new JObject
                {
                    ["state"] = kv.Value.State, ["cause"] = kv.Value.Cause, ["detail"] = kv.Value.Detail,
                    ["shaders"] = new JArray(kv.Value.Shaders), ["renderedAt"] = kv.Value.At,
                };
            var doc = new JObject { ["version"] = 1, ["runId"] = _runId, ["items"] = items };
            var tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, doc.ToString());
            if (File.Exists(FilePath)) File.Replace(tmp, FilePath, null); else File.Move(tmp, FilePath);
            UnityEngine.Debug.Log($"[RenderFailures] wrote {Items.Count} entries ({items.Count} total) to {FilePath}");
        }
    }
}
