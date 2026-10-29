using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering.Universal;

namespace VfxPreview
{
    /// <summary>One prefab instance + its own camera and 256px render target. Simulation is deterministic
    /// (fixed seeds, ParticleSystem.Simulate) and framing comes from the live particles sampled over the whole clip.</summary>
    sealed class PreviewCell : IDisposable
    {
        public readonly Target Target;
        public string Error, Note;
        /// <summary>C9 cause for Error (RenderFailures.*), set together with Error by the constructor gates.</summary>
        public string Cause;
        /// <summary>Offending shader names for unrenderable-material; PreviewBatch adds the clip's shaders for magenta-pixel.</summary>
        public List<string> Shaders = new List<string>();
        /// <summary>Frame() found no visible particle or renderer in the whole clip: it still renders, but is recorded as no-visible-output.</summary>
        public bool NothingVisible;
        public bool Loop, HasParticles, HasScript;
        /// <summary>Set with Error when the target cannot be previewed correctly (a material URP draws as magenta): stale media of it must go.</summary>
        public bool Broken;
        /// <summary>Frames of the clip that were mostly the missing-shader colour (PreviewBatch.TrackPeak).</summary>
        public int MagentaFrames;
        public byte[] Peak; public long PeakCoverage;
        readonly GameObject _go;
        readonly ParticleSystem[] _roots;
        readonly Renderer[] _renderers;
        readonly Camera _cam;
        public readonly RenderTexture Rt;
        readonly int _size;
        readonly List<Ball> _balls = new(), _staticBounds = new();
        readonly ParticleSystem[] _all;
        readonly Dictionary<ParticleSystem, ParticleSystemRenderer> _psr = new();
        ParticleSystem.Particle[] _buf = new ParticleSystem.Particle[1024];
        float _skipSeconds;
        double _warmUsed = -1; // warm-up actually used (Probe falls back to 0 when the warmed-up clip is empty); -1 until probed
        bool _moving; Vector3 _home; // effects that emit over distance are translated along +x during the clip (see PreviewOptions.MoveSpeed)
        static readonly Color Bg = new(0.11f, 0.12f, 0.14f, 1f);

        public PreviewCell(Target t, Vector3 origin, int size)
        {
            Target = t; _size = size;
            var path = AssetDatabase.GUIDToAssetPath(t.prefabGuid);
            var asset = string.IsNullOrEmpty(path) ? null : AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (asset == null) { Error = "prefab not found for guid " + t.prefabGuid; Cause = RenderFailures.PrefabMissing; return; }
            _go = (GameObject)PrefabUtility.InstantiatePrefab(asset);
            _go.transform.position = origin; _home = origin;
            var unrenderable = MaterialConverter.Unrenderable(_go, out var badShaders);
            if (unrenderable != null) { Error = unrenderable; Broken = true; Cause = RenderFailures.UnrenderableMaterial; Shaders = badShaders; return; }
            var all = _go.GetComponentsInChildren<ParticleSystem>(true);
            _roots = all.Where(p => p.transform.parent == null || p.transform.parent.GetComponentInParent<ParticleSystem>(true) == null).ToArray();
            _all = all; HasParticles = all.Length > 0;
            foreach (var ps in all)
            {
                var pr = _psr[ps] = ps.GetComponent<ParticleSystemRenderer>();
                // Thin stretched sparks (width 0.02) are sub-pixel at 256 px: give them a minimum on-screen size.
                if (pr != null && pr.renderMode == ParticleSystemRenderMode.Stretch) pr.minParticleSize = Mathf.Max(pr.minParticleSize, PreviewOptions.StretchMinViewportFraction);
            }
            HasScript = _go.GetComponentsInChildren<MonoBehaviour>(true).Length > 0;
            int seed = 1337;
            foreach (var ps in all) { ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear); ps.useAutoRandomSeed = false; ps.randomSeed = (uint)seed++; }
            foreach (var a in _go.GetComponentsInChildren<AudioSource>(true)) a.enabled = false;
            _moving = all.Any(p => p.emission.enabled && EmitsOverDistance(p.emission.rateOverDistance));
            Loop = t.playback == "loop" || all.Any(p => p.main.loop);
            _renderers = _go.GetComponentsInChildren<Renderer>(true);
            if (!HasParticles) Note = HasScript ? "static: no ParticleSystem, script-driven" : "static: no ParticleSystem";
            else if (HasScript) Note = "script: MonoBehaviour present, Simulate may not reproduce it";

            Rt = new RenderTexture(size, size, 24, RenderTextureFormat.ARGB32) { antiAliasing = 1 };
            var cg = new GameObject("PreviewCam"); cg.transform.position = origin;
            _cam = cg.AddComponent<Camera>();
            _cam.enabled = false; _cam.clearFlags = CameraClearFlags.SolidColor; _cam.backgroundColor = Bg;
            _cam.fieldOfView = PreviewOptions.FovDegrees; _cam.targetTexture = Rt; _cam.allowMSAA = false; _cam.allowHDR = false;
            var d = _cam.GetUniversalAdditionalCameraData(); d.renderPostProcessing = false; d.antialiasing = AntialiasingMode.None;
        }

        public bool Ok => Error == null;

        /// <summary>Restart the simulation at the clip's start time (loops: after warm-up).</summary>
        public void Reset(double warmup)
        {
            float lead = (Loop ? (float)(_warmUsed >= 0 ? _warmUsed : warmup) : 0f) + _skipSeconds;
            _go.transform.position = _home;
            foreach (var ps in _roots) ps.Simulate(lead, true, true, true);
        }

        public void Step(float dt)
        {
            if (_moving) _go.transform.position += Vector3.right * (PreviewOptions.MoveSpeed * dt);
            foreach (var ps in _roots) ps.Simulate(dt, true, false, true);
        }

        static bool EmitsOverDistance(ParticleSystem.MinMaxCurve c) =>
            c.constantMax > 0f || ((c.mode == ParticleSystemCurveMode.Curve || c.mode == ParticleSystemCurveMode.TwoCurves) && c.curveMultiplier > 0f);

        /// <summary>Simulate the whole clip once without rendering and collect what is visible (CollectBalls). Dead time before the first
        /// visible particle (start delay, a burst late in a loop cycle) is skipped so the clip does not open on empty frames: the
        /// simulation is fast-forwarded to LeadInFrames before the first visible frame (deterministic seeds, so the render matches the probe).</summary>
        public void Probe(int frames, float dt, double warmup)
        {
            _skipSeconds = 0; _warmUsed = warmup;
            int first = RunProbe(frames, dt, warmup);
            // A loop warm-up lands one-shot burst effects past their only emission (a looping controller or a long duration flags the clip as a
            // loop): when the warmed-up clip is empty, probe again from t=0, which is what a one-shot shows.
            if (Loop && warmup > 0 && _balls.Count + _staticBounds.Count == 0) { _warmUsed = 0; first = RunProbe(frames, dt, 0); }
            if (first <= PreviewOptions.LeadInFrames) return;
            _skipSeconds = (first - PreviewOptions.LeadInFrames) * dt;
            RunProbe(frames, dt, warmup);
        }

        /// <summary>Returns the index of the first frame with a visible particle or renderer, or 0 when nothing is ever visible.</summary>
        int RunProbe(int frames, float dt, double warmup)
        {
            _balls.Clear(); _staticBounds.Clear();
            int first = -1;
            for (int f = 0; f < frames; f++)
            {
                if (f == 0) Reset(warmup); else Step(dt);
                int before = _balls.Count + _staticBounds.Count;
                CollectBalls();
                if (first < 0 && _balls.Count + _staticBounds.Count > before) first = f;
            }
            return Mathf.Max(first, 0);
        }

        /// <summary>Visible extents for this sample frame. Particle systems contribute their LIVE particles (position + rendered size);
        /// Renderer.bounds is NOT used for them: Unity's ParticleSystemRenderer bounds are a conservative estimate (max size, max speed x
        /// lifetime) and were 2-6x wider than the particles actually drawn, which shrank every effect to a few dots. Other renderers
        /// (meshes, lines) keep their bounds.</summary>
        void CollectBalls()
        {
            foreach (var ps in _all)
            {
                if (ps == null || !ps.gameObject.activeInHierarchy) continue;
                var r = _psr[ps]; if (r == null || !r.enabled || r.renderMode == ParticleSystemRenderMode.None) continue;
                int n = ps.particleCount; if (n == 0) continue;
                if (_buf.Length < n) _buf = new ParticleSystem.Particle[Mathf.Min(n * 2, 1 << 16)];
                n = ps.GetParticles(_buf, _buf.Length);
                var main = ps.main; var tr = ps.transform;
                float scale = main.scalingMode == ParticleSystemScalingMode.Hierarchy ? Mathf.Max(tr.lossyScale.x, tr.lossyScale.y, tr.lossyScale.z)
                    : main.scalingMode == ParticleSystemScalingMode.Local ? Mathf.Max(tr.localScale.x, tr.localScale.y, tr.localScale.z) : 1f;
                float meshExtent = r.renderMode == ParticleSystemRenderMode.Mesh && r.mesh != null ? Mathf.Max(r.mesh.bounds.size.x, r.mesh.bounds.size.y, r.mesh.bounds.size.z) : 1f;
                int stride = Mathf.Max(1, n / PreviewOptions.MaxBallsPerSystem);
                for (int i = 0; i < n; i += stride)
                {
                    var p = _buf[i];
                    if (p.GetCurrentColor(ps).a / 255f < PreviewOptions.VisibleAlpha) continue;
                    var sz = p.GetCurrentSize3D(ps); float size = Mathf.Max(sz.x, sz.y, sz.z) * scale;
                    if (size < 1e-5f) continue;
                    float half = 0.5f * size;
                    if (r.renderMode == ParticleSystemRenderMode.Stretch) half = 0.5f * (size * r.lengthScale + p.velocity.magnitude * scale * r.velocityScale);
                    else if (r.renderMode == ParticleSystemRenderMode.Mesh) half *= meshExtent;
                    var w = main.simulationSpace == ParticleSystemSimulationSpace.World ? p.position
                        : main.simulationSpace == ParticleSystemSimulationSpace.Custom && main.customSimulationSpace != null ? main.customSimulationSpace.TransformPoint(p.position)
                        : tr.TransformPoint(p.position);
                    _balls.Add(new Ball(w.x, w.y, w.z, half));
                }
            }
            foreach (var r in _renderers)
            {
                if (r == null || r is ParticleSystemRenderer || !r.enabled || !r.gameObject.activeInHierarchy) continue;
                var b = r.bounds;
                if (b.size.sqrMagnitude < 1e-8f || float.IsNaN(b.center.x)) continue;
                _staticBounds.Add(new Ball(b.center.x, b.center.y, b.center.z, b.extents.magnitude));
            }
        }

        /// <summary>Camera from the visible particles over the whole clip (FramingMath.TryFit); falls back to the non-particle renderer
        /// bounds, then to a default box above the prefab origin, and says so in Note.</summary>
        public void Frame()
        {
            var balls = new List<Ball>(_balls); balls.AddRange(_staticBounds);
            Vector3 c = _go.transform.position + Vector3.up * 0.5f; float r = 1f;
            if (balls.Count == 0) { NothingVisible = true; Note = (Note == null ? "" : Note + "; ") + "nothing visible in the clip: default framing"; }
            else if (FramingMath.TryFit(balls, PreviewOptions.FrameOutlierFraction, PreviewOptions.FrameMargin, PreviewOptions.FrameMinRadius, out var fit))
            { c = new Vector3(fit.Cx, fit.Cy, fit.Cz); r = fit.Radius; }
            var dir = new Vector3(0f, PreviewOptions.FramePitch, -1f).normalized;
            float dist = FramingMath.CameraDistance(r, _cam.fieldOfView);
            _cam.transform.position = c + dir * dist; _cam.transform.LookAt(c);
            _cam.nearClipPlane = Mathf.Max(0.01f, dist * 0.02f); _cam.farClipPlane = dist + r * 6f;
        }

        public void Render() { _cam.Render(); }

        /// <summary>Distinct shader names of every enabled renderer's materials (for the magenta-pixel record).</summary>
        public List<string> ShaderNames()
        {
            var set = new SortedSet<string>();
            if (_renderers != null)
                foreach (var r in _renderers)
                    if (r != null) foreach (var m in r.sharedMaterials) if (m != null && m.shader != null) set.Add(m.shader.name);
            return new List<string>(set);
        }

        public void Dispose()
        {
            if (_go != null) UnityEngine.Object.DestroyImmediate(_go);
            if (_cam != null) UnityEngine.Object.DestroyImmediate(_cam.gameObject);
            if (Rt != null) { Rt.Release(); UnityEngine.Object.DestroyImmediate(Rt); }
        }
    }
}
