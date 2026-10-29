using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;

namespace VfxPreview
{
    /// <summary>tools/preview/waivers.json: {"version":1,"waivers":[{slug, cause, detail, evidence}]}, read like MagentaAllow. `cause` is one of the C9
    /// `unfixable-*` causes (WaiverRules); the loader throws on anything else so a typo never silently un-waives. Applied in RenderFailures.RecordResult.</summary>
    static class Waivers
    {
        public sealed class Waiver { public string Cause, Detail; }
        static Dictionary<string, Waiver> _map;

        public static bool TryGet(string slug, out Waiver w)
        {
            if (_map == null) _map = Load(Path.Combine(PreviewOptions.RepoRoot, "tools", "preview", "waivers.json"));
            return _map.TryGetValue(slug, out w);
        }

        static Dictionary<string, Waiver> Load(string file)
        {
            var map = new Dictionary<string, Waiver>();
            if (!File.Exists(file)) return map;
            foreach (var t in (JArray)JObject.Parse(File.ReadAllText(file))["waivers"])
            {
                var slug = (string)t["slug"]; var cause = (string)t["cause"];
                if (string.IsNullOrEmpty(slug) || !WaiverRules.IsWaiverCause(cause)) throw new InvalidDataException($"waivers.json: bad entry slug='{slug}' cause='{cause}'");
                if (map.ContainsKey(slug)) throw new InvalidDataException("waivers.json: duplicate slug " + slug);
                map[slug] = new Waiver { Cause = cause, Detail = (string)t["detail"] };
            }
            return map;
        }
    }
}
