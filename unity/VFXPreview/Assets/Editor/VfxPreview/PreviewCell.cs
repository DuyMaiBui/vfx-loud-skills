using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering.Universal;

namespace VfxPreview
{
    /// <summary>One prefab instance + its own camera and 256px render target. Simulation is deterministic
    /// (fixed seeds, ParticleSystem.Simulate) and framing comes from Renderer.bounds sampled over the whole clip.</summary>
    sealed class PreviewCell : IDisposable
    {
        public readonly Target Target;
        public string Error, Note;
        public bool Loop, HasParticles, HasScript;
        public byte[] Peak; public long PeakCoverage;
        readonly GameObject _go;
        readonly ParticleSystem[] _roots;
        readonly Renderer[] _renderers;
        readonly Camera _cam;
        public readonly RenderTexture Rt;
        readonly int _size;
        readonly List<Bounds> _bounds = new();
        static readonly Color Bg = new(0.11f, 0.12f, 0.14f, 1f);

        public PreviewCell(Target t, Vector3 origin, int size)
        {
            Target = t; _size = size;
            var path = AssetDatabase.GUIDToAssetPath(t.prefabGuid);
            var asset = string.IsNullOrEmpty(path) ? null : AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (asset == null) { Error = "prefab not found for guid " + t.prefabGuid; return; }
            _go = (GameObject)PrefabUtility.InstantiatePrefab(asset);
            _go.transform.position = origin;
            var all = _go.GetComponentsInChildren<ParticleSystem>(true);
            _roots = all.Where(p => p.transform.parent == null || p.transform.parent.GetComponentInParent<ParticleSystem>(true) == null).ToArray();
            HasParticles = all.Length > 0;
            HasScript = _go.GetComponentsInChildren<MonoBehaviour>(true).Length > 0;
            int seed = 1337;
            foreach (var ps in all) { ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear); ps.useAutoRandomSeed = false; ps.randomSeed = (uint)seed++; }
            foreach (var a in _go.GetComponentsInChildren<AudioSource>(true)) a.enabled = false;
            Loop = t.playback == "loop" || all.Any(p => p.main.loop);
            _renderers = _go.GetComponentsInChildren<Renderer>(true);
            if (!HasParticles) Note = HasScript ? "static: no ParticleSystem, script-driven" : "static: no ParticleSystem";
            else if (HasScript) Note = "script: MonoBehaviour present, Simulate may not reproduce it";

            Rt = new RenderTexture(size, size, 24, RenderTextureFormat.ARGB32) { antiAliasing = 1 };
            var cg = new GameObject("PreviewCam"); cg.transform.position = origin;
            _cam = cg.AddComponent<Camera>();
            _cam.enabled = false; _cam.clearFlags = CameraClearFlags.SolidColor; _cam.backgroundColor = Bg;
            _cam.fieldOfView = 30f; _cam.targetTexture = Rt; _cam.allowMSAA = false; _cam.allowHDR = false;
            var d = _cam.GetUniversalAdditionalCameraData(); d.renderPostProcessing = false; d.antialiasing = AntialiasingMode.None;
        }

        public bool Ok => Error == null;

        /// <summary>Restart the simulation at the clip's start time (loops: after warm-up).</summary>
        public void Reset(double warmup)
        {
            foreach (var ps in _roots) ps.Simulate(Loop ? (float)warmup : 0f, true, true, true);
        }

        public void Step(float dt) { foreach (var ps in _roots) ps.Simulate(dt, true, false, true); }

        public void SampleBounds()
        {
            Bounds? u = null;
            foreach (var r in _renderers)
            {
                if (r == null || !r.enabled || !r.gameObject.activeInHierarchy) continue;
                var b = r.bounds;
                if (b.size.sqrMagnitude < 1e-8f || float.IsNaN(b.center.x)) continue;
                if (u == null) u = b; else { var x = u.Value; x.Encapsulate(b); u = x; }
            }
            if (u != null) _bounds.Add(u.Value);
        }

        static float Median(List<float> v) { v.Sort(); return v[v.Count / 2]; }

        /// <summary>Camera from the sampled bounds: median centre, radius between box half-extent and half-diagonal, P95 over time.</summary>
        public void Frame()
        {
            Vector3 c = _go.transform.position + Vector3.up * 0.5f; float r = 1f;
            if (_bounds.Count == 0) Note = (Note == null ? "" : Note + "; ") + "no renderer bounds: default framing";
            else
            {
                c = new Vector3(Median(_bounds.Select(b => b.center.x).ToList()), Median(_bounds.Select(b => b.center.y).ToList()), Median(_bounds.Select(b => b.center.z).ToList()));
                var rs = _bounds.Select(b =>
                {
                    var lo = b.min - c; var hi = b.max - c;
                    var h = new Vector3(Mathf.Max(Mathf.Abs(lo.x), Mathf.Abs(hi.x)), Mathf.Max(Mathf.Abs(lo.y), Mathf.Abs(hi.y)), Mathf.Max(Mathf.Abs(lo.z), Mathf.Abs(hi.z)));
                    return 0.5f * (Mathf.Max(h.x, h.y, h.z) + h.magnitude);
                }).OrderBy(x => x).ToList();
                r = Mathf.Max(0.3f, rs[Mathf.Min(rs.Count - 1, (int)(rs.Count * 0.95f))] * 1.1f);
            }
            var dir = new Vector3(0f, 0.25f, -1f).normalized;
            float dist = r / Mathf.Sin(_cam.fieldOfView * 0.5f * Mathf.Deg2Rad);
            _cam.transform.position = c + dir * dist; _cam.transform.LookAt(c);
            _cam.nearClipPlane = Mathf.Max(0.01f, dist * 0.02f); _cam.farClipPlane = dist + r * 6f;
        }

        public void Render() { _cam.Render(); }

        public void Dispose()
        {
            if (_go != null) UnityEngine.Object.DestroyImmediate(_go);
            if (_cam != null) UnityEngine.Object.DestroyImmediate(_cam.gameObject);
            if (Rt != null) { Rt.Release(); UnityEngine.Object.DestroyImmediate(Rt); }
        }
    }
}
