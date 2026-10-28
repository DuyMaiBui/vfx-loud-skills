using System;
using System.IO;
using Newtonsoft.Json;
using UnityEngine;

namespace VfxPreview
{
    public sealed class Target
    {
        public string slug, pack, prefabPath, prefabGuid, family, playback;
    }

    /// <summary>Run config, read from tools/preview/run.json (an Editor cannot take CLI args once open).</summary>
    public sealed class PreviewOptions
    {
        public string targets;
        public string[] only;          // restrict to these slugs (smoke)
        public string mode = "grid";   // grid = 4x4 cells per 1024 frame, single = 1 clip per frame
        public int limit;
        public bool force;
        public int fps = 24, size = 256, crf = 36;
        public double seconds = 2.0;
        public double loopWarmup = 3.0;

        // Camera framing (PreviewCell.Frame -> FramingMath.TryFit), all in world units / fractions.
        public const float FovDegrees = 30f;
        public const float FramePitch = 0.25f;           // camera offset above the look direction (y of the unnormalised -z/up vector)
        public const float FrameMargin = 1.15f;          // breathing room around the visible particles
        public const float FrameMinRadius = 0.15f;       // minimum framed radius = minimum on-screen size of a tiny effect
        public const float FrameOutlierFraction = 0.02f; // ignored per side per axis, so one flash frame cannot shrink the rest
        public const float VisibleAlpha = 0.03f;         // particles fainter than this do not count as visible
        public const int MaxBallsPerSystem = 256;        // subsample dense systems per sample frame
        public const int LeadInFrames = 4;               // frames of dead time kept before the first visible particle
        public const float StretchMinViewportFraction = 0.012f; // minimum on-screen size of a stretched spark (fraction of the frame, ~3 px)

        public static string RepoRoot => Path.GetFullPath(Path.Combine(Application.dataPath, "..", "..", ".."));
        /// <summary>Command-line value of a flag such as -vfxOut, or null (plan.md C10).</summary>
        public static string Arg(string name)
        {
            var a = Environment.GetCommandLineArgs();
            for (int i = 0; i < a.Length - 1; i++) if (a[i] == name) return a[i + 1];
            return null;
        }
        public static bool HasArg(string name) => Array.IndexOf(Environment.GetCommandLineArgs(), name) >= 0;
        /// <summary>Output directory: `-vfxOut <dir>` (relative paths resolve against the repo root), default data/previews.</summary>
        public static string PreviewDir
        {
            get
            {
                var o = Arg("-vfxOut");
                return string.IsNullOrEmpty(o) ? Path.Combine(RepoRoot, "data", "previews") : Path.GetFullPath(Path.Combine(RepoRoot, o));
            }
        }
        public static string RunFile => Path.Combine(RepoRoot, "tools", "preview", "run.json");
        public int GridN => mode == "single" ? 1 : 4;
        public int Frames => (int)Math.Round(seconds * fps);

        public static PreviewOptions Load()
        {
            var o = File.Exists(RunFile) ? JsonConvert.DeserializeObject<PreviewOptions>(File.ReadAllText(RunFile)) : new PreviewOptions();
            var t = Arg("-vfxTargets");
            if (!string.IsNullOrEmpty(t)) o.targets = Path.GetFullPath(Path.Combine(RepoRoot, t));
            o.targets ??= Path.Combine(RepoRoot, "tools", "preview", "targets.json");
            return o;
        }
    }
}
