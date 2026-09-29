using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace VfxPreview
{
    /// <summary>Menu "Tools/VFX Preview/2. Render Previews": reads tools/preview/run.json + targets.json, renders one
    /// batch per EditorApplication.update tick (Editor + MCP bridge stay responsive), status in data/previews/_status.json.</summary>
    static class PreviewRunner
    {
        static Queue<List<Target>> _batches;
        static PreviewOptions _o;
        static JObject _idx, _status;
        static int _done, _failed, _total;
        static readonly List<JObject> _batchTimings = new();
        static readonly JObject _notes = new();
        static readonly System.Diagnostics.Stopwatch _wall = new();

        [MenuItem("Tools/VFX Preview/2. Render Previews")]
        static void Start()
        {
            if (_batches != null) { Debug.LogWarning("[VfxPreview] a render run is already in progress"); return; }
            _o = PreviewOptions.Load();
            var all = JsonConvert.DeserializeObject<List<Target>>(File.ReadAllText(_o.targets));
            if (_o.only is { Length: > 0 }) { var set = _o.only.ToHashSet(); all = all.Where(t => set.Contains(t.slug)).ToList(); }
            _idx = PreviewIndex.Load();
            if (!_o.force) all = all.Where(t => !PreviewIndex.Has(_idx, t.slug)).ToList();
            if (_o.limit > 0) all = all.Take(_o.limit).ToList();
            int per = _o.GridN * _o.GridN;
            _batches = new Queue<List<Target>>(all.Select((t, i) => (t, i)).GroupBy(x => x.i / per).Select(g => g.Select(x => x.t).ToList()));
            _total = all.Count; _done = _failed = 0; _batchTimings.Clear(); _wall.Restart();
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var l = new GameObject("PreviewLight").AddComponent<Light>();
            l.type = LightType.Directional; l.intensity = 1.2f; l.transform.rotation = Quaternion.Euler(50, -30, 0);
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat; RenderSettings.ambientLight = new Color(0.4f, 0.4f, 0.42f);
            Status("running");
            Debug.Log($"[VfxPreview] rendering {_total} targets, mode={_o.mode}, batches={_batches.Count}");
            EditorApplication.update += Tick;
        }

        static void Tick()
        {
            if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
            if (_batches.Count == 0) { Finish(); return; }
            var batch = _batches.Dequeue();
            var tm = new JObject();
            var sw = System.Diagnostics.Stopwatch.StartNew();
            try
            {
                foreach (var r in PreviewBatch.Run(batch, _o, tm))
                {
                    if (r.note != null) _notes[r.slug] = r.note;
                    if (r.ok) { PreviewIndex.Merge(_idx, r.slug, r.bytes, _o.fps, _o.Frames, _o.size); _done++; }
                    else { _failed++; _notes[r.slug] = "FAILED: " + r.error; Debug.LogWarning($"[VfxPreview] {r.slug}: {r.error}"); }
                }
                PreviewIndex.Save(_idx);
            }
            catch (Exception e) { _failed += batch.Count; Debug.LogError("[VfxPreview] batch failed: " + e); }
            tm["batchMs"] = sw.ElapsedMilliseconds; _batchTimings.Add(tm);
            Status("running");
        }

        static void Finish()
        {
            EditorApplication.update -= Tick; _batches = null; _wall.Stop();
            Status("done");
            Debug.Log($"[VfxPreview] done: ok={_done} failed={_failed} wall={_wall.Elapsed.TotalSeconds:F1}s");
        }

        static void Status(string state)
        {
            Directory.CreateDirectory(PreviewOptions.PreviewDir);
            _status = new JObject { ["state"] = state, ["mode"] = _o.mode, ["total"] = _total, ["ok"] = _done, ["failed"] = _failed,
                ["wallSec"] = Math.Round(_wall.Elapsed.TotalSeconds, 1), ["batches"] = JArray.FromObject(_batchTimings), ["notes"] = _notes };
            File.WriteAllText(Path.Combine(PreviewOptions.PreviewDir, "_status.json"), _status.ToString());
        }
    }
}
