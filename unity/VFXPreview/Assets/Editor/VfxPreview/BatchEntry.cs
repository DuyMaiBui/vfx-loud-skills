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
    /// <summary>Headless driver: -executeMethod VfxPreview.BatchEntry.Run [-packs a,b,c] [-skipGifIngest]. Queues PackImporter for the given
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
                LogShaderHistogram();
                ConvertLegacyParticleMaterials();
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

        /// <summary>URP draws the built-in "Legacy Shaders/Particles/*" materials as nothing (Epic Toon FX uses ~40 of them), so remap
        /// them to URP/Particles/Unlit with the equivalent blend. Preview-only project: the pack assets are edited in place.</summary>
        static void ConvertLegacyParticleMaterials()
        {
            var urp = Shader.Find("Universal Render Pipeline/Particles/Unlit");
            if (urp == null) { Debug.LogWarning("[BatchEntry] URP particle shader missing, legacy materials left as is"); return; }
            int n = 0;
            foreach (var g in AssetDatabase.FindAssets("t:Material", new[] { "Assets/ImportedPacks" }))
            {
                var m = AssetDatabase.LoadAssetAtPath<Material>(AssetDatabase.GUIDToAssetPath(g));
                if (m == null || m.shader == null || !m.shader.name.StartsWith("Legacy Shaders/Particles/")) continue;
                var name = m.shader.name;
                var tex = m.HasProperty("_MainTex") ? m.GetTexture("_MainTex") : null;
                var off = m.HasProperty("_MainTex") ? m.GetTextureOffset("_MainTex") : Vector2.zero;
                var scl = m.HasProperty("_MainTex") ? m.GetTextureScale("_MainTex") : Vector2.one;
                var col = m.HasProperty("_TintColor") ? m.GetColor("_TintColor") : m.HasProperty("_Color") ? m.GetColor("_Color") : Color.white;
                m.shader = urp;
                m.SetTexture("_BaseMap", tex); m.SetTextureOffset("_BaseMap", off); m.SetTextureScale("_BaseMap", scl);
                if (name.Contains("Additive")) col.a = Mathf.Clamp01(col.a * 2f); // legacy tint of 0.5 is neutral
                m.SetColor("_BaseColor", col);
                int src = 5, dst = 10, blend = 0; // SrcAlpha / OneMinusSrcAlpha = alpha blended
                if (name.Contains("Additive")) { dst = 1; blend = 2; }
                else if (name.Contains("Multiply")) { src = 2; dst = 0; blend = 3; }
                m.SetFloat("_Surface", 1); m.SetFloat("_Blend", blend);
                m.SetFloat("_SrcBlend", src); m.SetFloat("_DstBlend", dst); m.SetFloat("_ZWrite", 0);
                m.SetOverrideTag("RenderType", "Transparent");
                m.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
                m.renderQueue = 3000;
                EditorUtility.SetDirty(m); n++;
            }
            AssetDatabase.SaveAssets();
            Debug.Log($"[BatchEntry] converted {n} legacy particle materials to URP Particles/Unlit");
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

        static void LogShaderHistogram()
        {
            var h = new System.Collections.Generic.SortedDictionary<string, int>();
            foreach (var g in AssetDatabase.FindAssets("t:Material", new[] { "Assets/ImportedPacks" }))
            {
                var m = AssetDatabase.LoadAssetAtPath<Material>(AssetDatabase.GUIDToAssetPath(g));
                var n = m != null && m.shader != null ? m.shader.name : "<null>";
                h[n] = h.TryGetValue(n, out var c) ? c + 1 : 1;
            }
            foreach (var kv in h) Debug.Log($"[BatchEntry] shader {kv.Value,5} x {kv.Key}");
        }

        static void Quit(int code, string msg)
        {
            Debug.Log($"[BatchEntry] exit {code}: {msg}");
            if (code != 2) IngestGifs(); // 2 = the render never finished: there is nothing new to encode
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

        static void Static(Type t, string field, object v) =>
            t.GetField(field, BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, v);
    }
}
