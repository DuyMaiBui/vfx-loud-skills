using System;
using System.IO;
using Newtonsoft.Json.Linq;

namespace VfxPreview
{
    /// <summary>data/previews/index.json = { version:1, items:{ slug:{webm,poster,bytes,fps,frames,size,renderedAt} } }, merged atomically.</summary>
    static class PreviewIndex
    {
        static string Path_ => Path.Combine(PreviewOptions.PreviewDir, "index.json");

        public static JObject Load()
        {
            if (!File.Exists(Path_)) return new JObject { ["version"] = 1, ["items"] = new JObject() };
            return JObject.Parse(File.ReadAllText(Path_));
        }

        public static bool Has(JObject idx, string slug) =>
            idx["items"]?[slug] != null && File.Exists(Path.Combine(PreviewOptions.PreviewDir, slug + ".webm"));

        public static void Merge(JObject idx, string slug, long bytes, int fps, int frames, int size)
        {
            idx["items"][slug] = new JObject
            {
                ["webm"] = slug + ".webm", ["poster"] = slug + ".webp", ["bytes"] = bytes, ["fps"] = fps,
                ["frames"] = frames, ["size"] = size, ["renderedAt"] = DateTime.UtcNow.ToString("o"),
            };
        }

        public static void Save(JObject idx)
        {
            Directory.CreateDirectory(PreviewOptions.PreviewDir);
            var tmp = Path_ + ".tmp";
            File.WriteAllText(tmp, idx.ToString(Newtonsoft.Json.Formatting.Indented));
            File.Move(tmp, Path_, true);
        }
    }
}
