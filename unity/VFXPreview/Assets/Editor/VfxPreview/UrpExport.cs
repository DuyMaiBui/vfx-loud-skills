using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace VfxPreview
{
    /// <summary>Headless URP export (plan.md C8/C10): `-executeMethod VfxPreview.UrpExport.Run -vfxExport &lt;dir&gt;`. Converts every material under
    /// Assets/ImportedPacks with the UNCAPPED glow (MaterialMapping.Options.Export: a real game with bloom wants the original HDR magnitude), then for
    /// each material whose shader changed copies the serialized .mat bytes to `&lt;dir&gt;/&lt;guid&gt;.mat` and writes `index.json`
    /// `{"version":1,"items":[{guid,path,rule,sha256,original_shader_guid,shader_guid}]}`. Same GUID, same path, same .meta as the original: the .meta
    /// is not exported (it carries the GUID and no shader data). MaterialConverter.ConvertAll rewrites ImportedPacks IN PLACE, so this assumes the
    /// originals were restored first (scripts/preview-restore-originals.ts); it never touches the vendor bytes in the cloud.
    /// Exit 0 ok, 1 error (bad arguments, no URP, a non-text .mat), 2 timeout.</summary>
    static class UrpExport
    {
        const double TimeoutMin = 30;
        static string _dir;
        static long _startedAt;
        static bool _hooked;

        public static void Run()
        {
            _dir = PreviewOptions.Arg("-vfxExport");
            if (string.IsNullOrEmpty(_dir)) { Quit(1, "-vfxExport <dir> is required"); return; }
            _dir = Path.GetFullPath(Path.Combine(PreviewOptions.RepoRoot, _dir));
            _startedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            if (!_hooked) { _hooked = true; EditorApplication.update += Tick; }
            Debug.Log("[UrpExport] waiting for import and the URP pipeline, then converting to " + _dir);
        }

        static void Tick()
        {
            if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
            if (DateTimeOffset.UtcNow.ToUnixTimeSeconds() - _startedAt > TimeoutMin * 60) { Quit(2, "timeout waiting for the URP pipeline"); return; }
            if (GraphicsSettings.defaultRenderPipeline == null) return; // ProjectBootstrap still creating URP
            EditorApplication.update -= Tick;
            try { Export(); }
            catch (Exception e) { Quit(1, "export failed: " + e); }
        }

        static void Export()
        {
            var converted = MaterialConverter.ConvertAll(MaterialMapping.Options.Export);
            AssetDatabase.SaveAssets();
            Directory.CreateDirectory(_dir);
            var items = new JArray();
            foreach (var c in converted.OrderBy(x => x.Guid, StringComparer.Ordinal))
            {
                // Only a changed shader is published (C8); a conversion that ended on a shader with no GUID cannot be fetched back.
                if (string.IsNullOrEmpty(c.ShaderGuid) || c.ShaderGuid == c.OriginalShaderGuid) continue;
                var bytes = File.ReadAllBytes(Path.GetFullPath(c.Path));
                if (!StartsWithYaml(bytes)) { Quit(1, $"{c.Path} is not a text-serialized .mat (set Asset Serialization to Force Text)"); return; }
                WriteAtomic(Path.Combine(_dir, c.Guid + ".mat"), bytes);
                items.Add(new JObject
                {
                    ["guid"] = c.Guid, ["path"] = c.Path, ["rule"] = c.Rule, ["sha256"] = Sha256(bytes),
                    ["original_shader_guid"] = c.OriginalShaderGuid, ["shader_guid"] = c.ShaderGuid,
                });
            }
            var index = new JObject { ["version"] = 1, ["items"] = items };
            WriteAtomic(Path.Combine(_dir, "index.json"), System.Text.Encoding.UTF8.GetBytes(index.ToString()));
            Quit(0, $"exported {items.Count} converted materials of {converted.Count} changed");
        }

        static bool StartsWithYaml(byte[] b) => b.Length >= 5 && b[0] == '%' && b[1] == 'Y' && b[2] == 'A' && b[3] == 'M' && b[4] == 'L';

        static string Sha256(byte[] b)
        {
            using var h = SHA256.Create();
            return string.Concat(h.ComputeHash(b).Select(x => x.ToString("x2")));
        }

        static void WriteAtomic(string path, byte[] bytes)
        {
            var tmp = path + ".tmp";
            File.WriteAllBytes(tmp, bytes);
            if (File.Exists(path)) File.Replace(tmp, path, null); else File.Move(tmp, path);
        }

        static void Quit(int code, string msg)
        {
            Debug.Log($"[UrpExport] exit {code}: {msg}");
            EditorApplication.Exit(code);
        }
    }
}
