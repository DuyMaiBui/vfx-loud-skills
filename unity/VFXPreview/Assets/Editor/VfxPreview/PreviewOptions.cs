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
