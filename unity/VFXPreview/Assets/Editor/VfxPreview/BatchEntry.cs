using System;
using System.IO;
using System.Reflection;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace VfxPreview
{
    /// <summary>Headless driver: -executeMethod VfxPreview.BatchEntry.Run [-packs a,b,c] [-skipGifIngest] [-noConvert]. Queues PackImporter for the given
    /// packs, then starts PreviewRunner, waits for _status.json state=done, encodes the fresh webm files into the VFX Cloud DB as GIFs
    /// (node seed/preview-gif-ingest.ts) and exits the Editor (0 ok, 1 failed targets, 2 timeout).
    /// Stage lives in Library/ so it survives the domain reloads pack imports cause.</summary>
    [InitializeOnLoad]
    static class BatchEntry
    {
        static readonly string Lib = Path.Combine(Path.GetDirectoryName(Application.dataPath)!, "Library");
        static readonly string StageFile = Path.Combine(Lib, "VfxBatchEntry.json");
        static readonly string ImportFile = Path.Combine(Lib, "VfxPreviewImport.json");
        static readonly string StatusFile = Path.Combine(PreviewOptions.PreviewDir, "_status.json");
        const double TimeoutMin = 120;
        const int IngestTimeoutMs = 10 * 60 * 1000;

        sealed class Stage { public string stage; public long startedAt, runStartedAt; }
        static bool _hooked;

        static BatchEntry() { if (File.Exists(StageFile)) Hook(); }

        public static void Run()
        {
            var packs = "synty-polygon-particle-fx,epic-toon-fx,epic-toon-vfx-2,background-effects";
            var a = Environment.GetCommandLineArgs();
            for (int i = 0; i < a.Length - 1; i++) if (a[i] == "-packs") packs = a[i + 1];
            Directory.CreateDirectory(Lib);
            var queue = new JArray(packs == "none" ? new string[0] : packs.Split(','));
            File.WriteAllText(ImportFile, new JObject { ["queue"] = queue, ["current"] = null, ["phase"] = "idle", ["baseline"] = new JArray() }.ToString());
            Static(typeof(PackImporter), "_s", null); // force PackImporter to re-read the state file
            Save(new Stage { stage = "importing", startedAt = Now() });
            Debug.Log("[BatchEntry] importing: " + packs);
            Hook();
        }

        static void Hook() { if (_hooked) return; _hooked = true; EditorApplication.update += Tick; }
        static long Now() => DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        static void Save(Stage s) => File.WriteAllText(StageFile, JsonConvert.SerializeObject(s));

        static void Tick()
        {
            if (EditorApplication.isCompiling || EditorApplication.isUpdating || !File.Exists(StageFile)) return;
            var s = JsonConvert.DeserializeObject<Stage>(File.ReadAllText(StageFile));
            if ((Now() - s.startedAt) / 60.0 > TimeoutMin) { Quit(2, "timeout in stage " + s.stage); return; }
            if (s.stage == "importing")
            {
                var imp = JObject.Parse(File.ReadAllText(ImportFile));
                if (((JArray)imp["queue"]).Count > 0 || (string)imp["phase"] != "idle") return;
                if (GraphicsSettings.defaultRenderPipeline == null) return; // ProjectBootstrap still creating URP
                s.stage = "rendering"; s.runStartedAt = Now(); Save(s);
                if (File.Exists(StatusFile)) File.Delete(StatusFile);
                MaterialConverter.LogShaderHistogram();
                if (Array.IndexOf(Environment.GetCommandLineArgs(), "-noConvert") >= 0) Debug.Log("[BatchEntry] material conversion skipped (-noConvert)");
                else MaterialConverter.ConvertAll();
                Diag("Assets/ImportedPacks/epic-toon-fx/Epic Toon FX/Prefabs/Interactive/Level Up/Nova/LevelupNovaBlue.prefab");
                Debug.Log("[BatchEntry] import done, starting render");
                typeof(PreviewRunner).GetMethod("Start", BindingFlags.NonPublic | BindingFlags.Static)!.Invoke(null, null);
            }
            else if (s.stage == "rendering")
            {
                if (!File.Exists(StatusFile)) return;
                var st = JObject.Parse(File.ReadAllText(StatusFile));
                if ((string)st["state"] != "done") return;
                int failed = (int)st["failed"];
                Quit(failed > 0 ? 1 : 0, $"render done ok={(int)st["ok"]} failed={failed}");
            }
        }

        static void Diag(string path)
        {
            var a = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (a == null) { Debug.Log("[BatchEntry] diag: prefab missing " + path); return; }
            var go = (GameObject)PrefabUtility.InstantiatePrefab(a);
            foreach (var ps in go.GetComponentsInChildren<ParticleSystem>(true))
            {
                ps.Simulate(0.5f, true, true, true);
                var r = ps.GetComponent<ParticleSystemRenderer>();
                var m = r.sharedMaterial;
                Debug.Log($"[BatchEntry] diag {ps.name}: count={ps.particleCount} active={ps.gameObject.activeInHierarchy} rend={r.enabled} mode={r.renderMode} mat={(m == null ? "null" : m.name + "/" + m.shader.name + "/q" + m.renderQueue + "/tex=" + (m.GetTexture("_BaseMap") != null) + "/col=" + (m.HasProperty("_BaseColor") ? m.GetColor("_BaseColor").ToString() : "-"))} bounds={r.bounds.size} startSize={ps.main.startSize.constant} maxP={ps.main.maxParticles} sim={ps.main.simulationSpace} scale={ps.transform.lossyScale}");
            }
            UnityEngine.Object.DestroyImmediate(go);
        }

        static void Quit(int code, string msg)
        {
            Debug.Log($"[BatchEntry] exit {code}: {msg}");
            if (code != 2) { IngestGifs(); IngestFailures(); } // 2 = the render never finished: there is nothing new to encode or record
            File.Delete(StageFile);
            EditorApplication.Exit(code);
        }

        /// <summary>Last step of a render: node seed/preview-gif-ingest.ts encodes data/previews/*.webm into the DB (idempotent by content hash,
        /// so unchanged previews cost nothing). Best effort: a failure is logged and never changes the render's exit code; the same work is
        /// `npm run previews:gif` from the repo root.</summary>
        static void IngestGifs()
        {
            if (Array.IndexOf(Environment.GetCommandLineArgs(), "-skipGifIngest") >= 0) { Debug.Log("[BatchEntry] gif ingest skipped (-skipGifIngest)"); return; }
            try
            {
                var repo = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "..", ".."));
                var psi = new System.Diagnostics.ProcessStartInfo("node", "seed/preview-gif-ingest.ts --json")
                {
                    WorkingDirectory = repo, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true,
                };
                using (var p = System.Diagnostics.Process.Start(psi)!)
                {
                    var stdout = p.StandardOutput.ReadToEndAsync();
                    var stderr = p.StandardError.ReadToEndAsync();
                    if (!p.WaitForExit(IngestTimeoutMs)) { p.Kill(); Debug.LogWarning("[BatchEntry] gif ingest timed out and was killed; run `npm run previews:gif`"); return; }
                    var last = "";
                    foreach (var line in stdout.Result.Split('\n')) if (line.TrimStart().StartsWith("{")) last = line;
                    if (last.Length > 0)
                    {
                        var j = JObject.Parse(last);
                        Debug.Log($"[BatchEntry] gif ingest exit {p.ExitCode}: stored={(int)j["stored"]} unchanged={(int)j["unchanged"]} skipped={(int)j["skipped"]} failed={(int)j["failed"]}");
                    }
                    else Debug.LogWarning($"[BatchEntry] gif ingest exit {p.ExitCode}, no summary: {stderr.Result.Trim()}");
                }
            }
            catch (Exception e) { Debug.LogWarning("[BatchEntry] gif ingest not run (" + e.Message + "); run `npm run previews:gif`"); }
        }

        /// <summary>Persist data/previews/_failures.json into preview_render (node seed/preview-failures-ingest.ts, plan.md C9). Best effort, same
        /// pattern as the GIF ingest: a failure is logged and never changes the render's exit code; re-run with `npm run ingest:failures`.</summary>
        static void IngestFailures()
        {
            var file = RenderFailures.FilePath;
            if (!File.Exists(file)) { Debug.LogWarning("[BatchEntry] no _failures.json to ingest"); return; }
            try
            {
                var repo = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "..", ".."));
                var psi = new System.Diagnostics.ProcessStartInfo("node", $"seed/preview-failures-ingest.ts --json --file \"{file}\"")
                {
                    WorkingDirectory = repo, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true,
                };
                using (var p = System.Diagnostics.Process.Start(psi)!)
                {
                    var stdout = p.StandardOutput.ReadToEndAsync();
                    var stderr = p.StandardError.ReadToEndAsync();
                    if (!p.WaitForExit(IngestTimeoutMs)) { p.Kill(); Debug.LogWarning("[BatchEntry] failure ingest timed out and was killed; run `npm run ingest:failures`"); return; }
                    var last = "";
                    foreach (var line in stdout.Result.Split('\n')) if (line.TrimStart().StartsWith("{")) last = line;
                    if (last.Length > 0) Debug.Log($"[BatchEntry] failure ingest exit {p.ExitCode}: {last.Trim()}");
                    else Debug.LogWarning($"[BatchEntry] failure ingest exit {p.ExitCode}, no summary: {stderr.Result.Trim()}");
                }
            }
            catch (Exception e) { Debug.LogWarning("[BatchEntry] failure ingest not run (" + e.Message + "); run `npm run ingest:failures`"); }
        }

        static void Static(Type t, string field, object v) =>
            t.GetField(field, BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, v);
    }
}
