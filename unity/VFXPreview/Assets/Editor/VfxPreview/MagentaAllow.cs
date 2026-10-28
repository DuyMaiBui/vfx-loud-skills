using System.Collections.Generic;
using System.IO;

namespace VfxPreview
{
    /// <summary>tools/preview/magenta-allow.txt: slugs whose effect IS magenta (verified by eye), so the magenta gate lets them through.
    /// One slug per line, '#' starts a comment. Same file as server/src/magenta.ts reads.</summary>
    static class MagentaAllow
    {
        static HashSet<string> _set;

        public static bool Contains(string slug)
        {
            if (_set == null)
            {
                _set = new HashSet<string>();
                var f = Path.Combine(PreviewOptions.RepoRoot, "tools", "preview", "magenta-allow.txt");
                if (File.Exists(f))
                    foreach (var raw in File.ReadAllLines(f))
                    {
                        var line = raw.Split('#')[0].Trim();
                        if (line.Length > 0) _set.Add(line);
                    }
            }
            return _set.Contains(slug);
        }
    }
}
