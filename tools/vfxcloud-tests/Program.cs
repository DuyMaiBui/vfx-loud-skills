using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using VfxCloud;

// Plain-dotnet checks for VfxCloudBundle + VfxCloudMover (run: dotnet run --project tools/vfxcloud-tests). Exit 0 = all pass.
static class Program
{
    static int fails, passes;
    static void Check(string name, bool ok) { Console.WriteLine((ok ? "PASS " : "FAIL ") + name); if (ok) passes++; else fails++; }

    class FakeIndex : IProjectIndex
    {
        public Dictionary<string, ProjectEntry> Guids = new Dictionary<string, ProjectEntry>();
        public Dictionary<string, ProjectEntry> Paths = new Dictionary<string, ProjectEntry>();
        public void Add(string guid, string path, string sha) { var e = new ProjectEntry { Guid = guid, Path = path, Sha256 = () => sha }; if (guid != null) Guids[guid] = e; Paths[path] = e; }
        public ProjectEntry ByGuid(string g) => Guids.TryGetValue(g, out var e) ? e : null;
        public ProjectEntry ByPath(string p) => Paths.TryGetValue(p, out var e) ? e : null;
    }

    static string fixtures;
    static Bundle Sample() => Bundle.Parse(File.ReadAllText(Path.Combine(fixtures, "bundle-sample.json")));

    static FakeIndex IndexOf(Bundle b, Func<BundleFile, bool> include = null)
    {
        var idx = new FakeIndex();
        foreach (var f in b.Files) if (include == null || include(f)) idx.Add(f.Guid, f.TargetPath, f.Sha256);
        return idx;
    }

    static int Main()
    {
        var dir = AppContext.BaseDirectory;
        while (dir != null && !Directory.Exists(Path.Combine(dir, "server", "src", "test-fixtures"))) dir = Path.GetDirectoryName(dir);
        if (dir == null) { Console.WriteLine("FAIL cannot find server/src/test-fixtures"); return 1; }
        fixtures = Path.Combine(dir, "server", "src", "test-fixtures");

        Reroot(); Parsing(); Planning(); Policies(); Misc(); Mover();
        Console.WriteLine($"{passes} passed, {fails} failed");
        return fails == 0 ? 0 : 1;
    }

    static void Reroot()
    {
        var cases = JArray.Parse(File.ReadAllText(Path.Combine(fixtures, "reroot-cases.json")));
        var n = 0;
        foreach (var c in cases)
        {
            var root = c["root"].Type == JTokenType.Null ? null : (string)c["root"];
            var got = VfxCloudBundle.Reroot((string)c["target_path"], root);
            Check($"reroot #{n++} {(string)c["target_path"]} + {root ?? "null"}", got == (string)c["expected"]);
        }
    }

    static void Parsing()
    {
        var b = Sample();
        Check("bundle: 5 files, root file last, schema", b.Files.Count == 5 && b.Files[4].Guid == b.RootGuid && b.Schema == "vfx-bundle/1");
        Check("bundle: urp material + requires parsed", b.Files[2].UrpConverted && b.Files[2].Variant == "urp" && b.Requires.Count == 1 && b.Requires[0].Package == "com.unity.render-pipelines.universal");
        Check("bundle: meta fields mapped", b.Files[0].MetaSha256 != null && b.Files[0].MetaDownloadUrl.EndsWith(b.Files[0].MetaSha256));
        Check("sha256 helper (abc)", VfxCloudBundle.Sha256Hex(new byte[] { 97, 98, 99 }) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    static void Planning()
    {
        var b = Sample();
        var empty = VfxCloudBundle.Plan(b, new FakeIndex(), ConflictPolicy.Refuse);
        Check("empty project: all Install, 5 writes, not refused", empty.Items.All(i => i.Action == PlanAction.Install) && empty.Writes.Count == 5 && !empty.Refused);
        Check("empty project: keeps bundle order (root last)", empty.Writes[4].File.Guid == b.RootGuid);

        var same = VfxCloudBundle.Plan(b, IndexOf(b), ConflictPolicy.Refuse);
        Check("same guid/path/sha: all Unchanged, no writes", same.Count(PlanAction.Unchanged) == 5 && same.Writes.Count == 0);

        var moved = new FakeIndex();
        foreach (var f in b.Files) moved.Add(f.Guid, "Assets/Elsewhere/" + f.Guid + ".x", f.Sha256);
        var reused = VfxCloudBundle.Plan(b, moved, ConflictPolicy.Refuse);
        Check("guid elsewhere with same sha: Reused, nothing written", reused.Count(PlanAction.Reused) == 5 && reused.Writes.Count == 0 && !reused.Refused);

        var idx = IndexOf(b, f => f.Kind != "material" || f.Variant != "urp");
        var mat = b.Files[2];
        idx.Add(mat.Guid, mat.TargetPath, "0000000000000000000000000000000000000000000000000000000000000000");
        var refuse = VfxCloudBundle.Plan(b, idx, ConflictPolicy.Refuse);
        var item = refuse.Items[2];
        Check("refuse: same guid, different bytes is Conflict (never Install)", item.Action == PlanAction.Conflict);
        Check("refuse: plan refused and lists NO write at all (falsifiable check)", refuse.Refused && refuse.Writes.Count == 0);

        var other = new FakeIndex();
        other.Add(mat.Guid, "Assets/Else/m.mat", "ffff");
        Check("guid elsewhere, different bytes: Conflict", VfxCloudBundle.Plan(b, other, ConflictPolicy.Refuse).Items[2].Action == PlanAction.Conflict);

        var foreign = new FakeIndex();
        foreign.Add("99999999999999999999999999999999", mat.TargetPath, mat.Sha256);
        var fp = VfxCloudBundle.Plan(b, foreign, ConflictPolicy.Refuse);
        Check("target path holds another guid: Conflict", fp.Items[2].Action == PlanAction.Conflict && fp.Refused && fp.Writes.Count == 0);

        var noMeta = new BundleFile { Guid = null, Origin = "resource", Sha256 = "aa", TargetPath = "Assets/VFXCloud/p/x.prefab" };
        var rb = new Bundle(); rb.Files.Add(noMeta);
        Check("resource item (no guid): Install when absent", VfxCloudBundle.Plan(rb, new FakeIndex(), ConflictPolicy.Refuse).Items[0].Action == PlanAction.Install);
        var ri = new FakeIndex(); ri.Add(null, "Assets/VFXCloud/p/x.prefab", "bb");
        Check("resource item (no guid): existing different bytes is Conflict", VfxCloudBundle.Plan(rb, ri, ConflictPolicy.Refuse).Items[0].Action == PlanAction.Conflict);
    }

    static void Policies()
    {
        var b = Sample();
        var mat = b.Files[2];
        var idx = IndexOf(b, f => f.Guid != mat.Guid);
        idx.Add(mat.Guid, mat.TargetPath, "deadbeef");

        var skip = VfxCloudBundle.Plan(b, idx, ConflictPolicy.Skip);
        Check("skip: conflict -> Skip, others still planned (Unchanged here)", skip.Items[2].Action == PlanAction.Skip && skip.Count(PlanAction.Unchanged) == 4 && !skip.Refused && skip.Writes.Count == 0);

        var half = IndexOf(b, f => f.Guid != mat.Guid && f.Kind != "prefab");
        half.Add(mat.Guid, mat.TargetPath, "deadbeef");
        var skip2 = VfxCloudBundle.Plan(b, half, ConflictPolicy.Skip);
        Check("skip: installs the rest (prefab) and leaves the conflict", skip2.Writes.Count == 1 && skip2.Writes[0].File.Kind == "prefab" && skip2.Items[2].Action == PlanAction.Skip);

        var ow = VfxCloudBundle.Plan(b, idx, ConflictPolicy.Overwrite);
        var o = ow.Items[2];
        Check("overwrite: Install keeping the existing .meta and guid", o.Action == PlanAction.Install && o.KeepMeta && o.WritePath == mat.TargetPath && o.ExpectedGuid == mat.Guid && ow.Writes.Contains(o));

        var elsewhere = new FakeIndex();
        elsewhere.Add(mat.Guid, "Assets/Else/m.mat", "ffff");
        var ow2 = VfxCloudBundle.Plan(b, elsewhere, ConflictPolicy.Overwrite).Items[2];
        Check("overwrite, guid elsewhere: replaces content at the existing path, not a duplicate guid", ow2.WritePath == "Assets/Else/m.mat" && ow2.KeepMeta);

        var rooted = VfxCloudBundle.Plan(b, new FakeIndex(), ConflictPolicy.Refuse, "Assets/Game/VFX");
        Check("root: every write lands under the root", rooted.Writes.All(w => w.WritePath.StartsWith("Assets/Game/VFX/Archanor VFX/")));
    }

    static void Misc()
    {
        var b = Sample();
        const string without = "{\"dependencies\":{\"com.unity.nuget.newtonsoft-json\":\"3.2.1\"}}";
        const string with = "{\"dependencies\":{\"com.unity.render-pipelines.universal\":\"17.0.3\"}}";
        Check("requires: missing URP package reported", VfxCloudBundle.MissingPackages(b, without).Count == 1);
        Check("requires: present package not reported", VfxCloudBundle.MissingPackages(b, with).Count == 0);
        Check("requires: no manifest -> missing", VfxCloudBundle.MissingPackages(b, null).Count == 1);
        Check("meta guid parse", VfxCloudBundle.ParseMetaGuid("fileFormatVersion: 2\nguid: 2B3C4D5E6F70819A2B3C4D5E6F708192\nx: 1\n") == "2b3c4d5e6f70819a2b3c4d5e6f708192" && VfxCloudBundle.ParseMetaGuid("nope") == null);
    }

    static void Mover()
    {
        var root = Path.Combine(Path.GetTempPath(), "vfxcloud-mover-" + Guid.NewGuid().ToString("N"));
        var tmp = Path.Combine(root, "Temp", "t");
        Directory.CreateDirectory(tmp);
        string T(string name, string text) { var p = Path.Combine(tmp, name); File.WriteAllText(p, text); return p; }
        var journal = Path.Combine(root, "Temp", "journal.json");
        try
        {
            var ok = new List<MoveJob>
            {
                new MoveJob { TargetPath = "Assets/V/a.mat", TempAsset = T("a", "A"), TempMeta = T("a.m", "guid: a") },
                new MoveJob { TargetPath = "Assets/V/sub/b.png", TempAsset = T("b", "B"), TempMeta = T("b.m", "guid: b") },
            };
            var entries = VfxCloudMover.Move(root, ok, journal, Path.Combine(tmp, "backup"));
            Check("mover: asset and .meta byte-exact at target", File.ReadAllText(Path.Combine(root, "Assets/V/a.mat")) == "A" && File.ReadAllText(Path.Combine(root, "Assets/V/a.mat.meta")) == "guid: a" && File.ReadAllText(Path.Combine(root, "Assets/V/sub/b.png.meta")) == "guid: b");
            Check("mover: journal lists .meta before asset, 4 entries, file written", entries.Count == 4 && entries[0].Path.EndsWith("a.mat.meta") && entries[1].Path.EndsWith("a.mat") && File.Exists(journal));

            // failure on the 3rd job (temp file missing): undo removes created files and restores the replaced one
            Directory.CreateDirectory(Path.Combine(root, "Assets/W"));
            File.WriteAllText(Path.Combine(root, "Assets/W/keep.mat"), "ORIGINAL");
            File.WriteAllText(Path.Combine(root, "Assets/W/keep.mat.meta"), "guid: keep");
            var bad = new List<MoveJob>
            {
                new MoveJob { TargetPath = "Assets/W/new.mat", TempAsset = T("n", "N"), TempMeta = T("n.m", "guid: n") },
                new MoveJob { TargetPath = "Assets/W/keep.mat", TempAsset = T("k", "REPLACED"), TempMeta = null },
                new MoveJob { TargetPath = "Assets/W/boom.mat", TempAsset = Path.Combine(tmp, "missing"), TempMeta = null },
            };
            var threw = false;
            try { VfxCloudMover.Move(root, bad, journal, Path.Combine(tmp, "backup2")); } catch (IOException) { threw = true; }
            Check("mover: failure is rethrown", threw);
            Check("mover: undo removed created files", !File.Exists(Path.Combine(root, "Assets/W/new.mat")) && !File.Exists(Path.Combine(root, "Assets/W/new.mat.meta")));
            Check("mover: undo restored the replaced file and kept its .meta", File.ReadAllText(Path.Combine(root, "Assets/W/keep.mat")) == "ORIGINAL" && File.ReadAllText(Path.Combine(root, "Assets/W/keep.mat.meta")) == "guid: keep");
        }
        finally { try { Directory.Delete(root, true); } catch { } }
    }
}
