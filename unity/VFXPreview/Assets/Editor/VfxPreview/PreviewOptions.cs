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
        public static string PreviewDir => Path.Combine(RepoRoot, "data", "previews");
        public static string RunFile => Path.Combine(RepoRoot, "tools", "preview", "run.json");
        public int GridN => mode == "single" ? 1 : 4;
        public int Frames => (int)Math.Round(seconds * fps);

        public static PreviewOptions Load()
        {
            var o = File.Exists(RunFile) ? JsonConvert.DeserializeObject<PreviewOptions>(File.ReadAllText(RunFile)) : new PreviewOptions();
            o.targets ??= Path.Combine(RepoRoot, "tools", "preview", "targets.json");
            return o;
        }
    }
}
