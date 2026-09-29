using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using UnityEditor;
using UnityEngine;

namespace VfxPreview
{
    /// <summary>Imports every pack in seed/extract/packs.json under Assets/ImportedPacks/&lt;slug&gt;/.
    /// .unitypackage always lands at its original Assets/ path, so each import is followed by moving the
    /// new top-level folders (GUIDs survive a move). Stepped from EditorApplication.update and persisted in
    /// Library/ so a domain reload (pack scripts) does not lose the queue. Sources are read-only.</summary>
    [InitializeOnLoad]
    static class PackImporter
    {
        const string Root = "Assets/ImportedPacks";
        static readonly string StateFile = Path.Combine(Path.GetDirectoryName(Application.dataPath)!, "Library", "VfxPreviewImport.json");
        static readonly string[] Own = { "Editor", "ImportedPacks", "VfxPreviewSettings" };

        sealed class State { public List<string> queue = new(); public string current, phase = "idle"; public List<string> baseline = new(); }
        sealed class Pack { public string slug, file, sourceType, sourcePath, pathPrefix; }
        sealed class Packs { public List<Pack> packs; }

        static State _s;
        static bool _busy;

        static PackImporter() { EditorApplication.update += Tick; }

        [MenuItem("Tools/VFX Preview/1. Import Packs")]
        static void Start()
        {
            var packs = JsonConvert.DeserializeObject<Packs>(File.ReadAllText(Path.Combine(PreviewOptions.RepoRoot, "seed", "extract", "packs.json"))).packs;
            Save(new State { queue = packs.Select(p => p.slug).ToList() });
            Debug.Log("[VfxPreview] import queue: " + string.Join(", ", _s.queue));
        }

        static void Save(State s) { _s = s; File.WriteAllText(StateFile, JsonConvert.SerializeObject(s)); }
        static State Load() => _s ??= File.Exists(StateFile) ? JsonConvert.DeserializeObject<State>(File.ReadAllText(StateFile)) : new State();
        static string[] TopFolders() => Directory.GetDirectories("Assets").Select(d => Path.GetFileName(d)).ToArray();

        static void Tick()
        {
            if (_busy || EditorApplication.isCompiling || EditorApplication.isUpdating) return;
            var s = Load();
            if (s.phase == "idle" && s.queue.Count == 0) return;
            _busy = true;
            try { Step(s); }
            catch (Exception e) { Debug.LogError("[VfxPreview] import failed: " + e); s.queue.Clear(); s.phase = "idle"; Save(s); }
            finally { _busy = false; }
        }

        static void Step(State s)
        {
            if (s.phase == "move")
            {
                if (!AssetDatabase.IsValidFolder(Root + "/" + s.current)) AssetDatabase.CreateFolder(Root, s.current);
                foreach (var f in TopFolders().Except(s.baseline).Except(Own))
                {
                    var err = AssetDatabase.MoveAsset("Assets/" + f, $"{Root}/{s.current}/{f}");
                    if (err.Length > 0) Debug.LogWarning($"[VfxPreview] move {f} -> {s.current}: {err}");
                }
                Debug.Log("[VfxPreview] imported " + s.current);
                s.phase = "idle"; Save(s);
                return;
            }
            if (s.queue.Count == 0) return;
            var slug = s.queue[0]; s.queue.RemoveAt(0);
            var pack = JsonConvert.DeserializeObject<Packs>(File.ReadAllText(Path.Combine(PreviewOptions.RepoRoot, "seed", "extract", "packs.json"))).packs.First(p => p.slug == slug);
            if (!AssetDatabase.IsValidFolder(Root)) AssetDatabase.CreateFolder("Assets", "ImportedPacks");
            s.current = slug; s.baseline = TopFolders().ToList(); s.phase = "move"; Save(s);
            if (pack.sourceType == "folder") CopyFolder(pack);
            else
            {
                var dir = Environment.GetEnvironmentVariable("VFX_UNITYPACKAGE_DIR") ?? "/home/mike/Downloads/UnityPackages";
                AssetDatabase.ImportPackage(Path.Combine(dir, pack.file), false);
            }
            AssetDatabase.Refresh();
        }

        /// <summary>Folder source (NamuFX): copy with its .meta files so GUIDs match the extracted recipes.</summary>
        static void CopyFolder(Pack p)
        {
            var dest = Path.Combine("Assets", "ImportedPacks", p.slug, Path.GetFileName(p.pathPrefix));
            Copy(p.sourcePath, dest);
            Debug.Log($"[VfxPreview] copied {p.sourcePath} -> {dest}");
        }

        static void Copy(string src, string dst)
        {
            Directory.CreateDirectory(dst);
            foreach (var f in Directory.GetFiles(src)) File.Copy(f, Path.Combine(dst, Path.GetFileName(f)), true);
            foreach (var d in Directory.GetDirectories(src)) Copy(d, Path.Combine(dst, Path.GetFileName(d)));
            var meta = src + ".meta";
            if (File.Exists(meta)) File.Copy(meta, dst + ".meta", true);
        }
    }
}
