using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using UnityEditor;
using UnityEngine;

namespace VfxPreview
{
    /// <summary>Builds a renderable prefab (Assets/RecipePrefabs/&lt;slug&gt;.prefab) from the parameters of a hand-written recipe (no prefab of its own):
    /// one child per recipe layer, a billboard ParticleSystem on URP Particles/Unlit, nested layers as prefab instances. Editor tooling (the
    /// construction-in-code ban is for runtime code). A construct it cannot map skips the slug; never a partial prefab.
    /// Batch: -vfxSpecs &lt;dir&gt; -vfxOut &lt;_recipe-prefabs.json&gt; [--empty-control]. Pure mapping lives in RecipePrefabBuilderModel.cs.</summary>
    public static class RecipePrefabBuilder
    {
        const string OutDir = "Assets/RecipePrefabs";
        const string ControlSlug = "__empty-control";
        static readonly Regex SafeSlug = new Regex("^[a-z0-9_-]+$");

        sealed class Item
        {
            public string prefabPath, prefabGuid, status, reason;
            public int layersInRecipe, systemsBuilt;
        }

        [MenuItem("Tools/VFX Preview/4. Build Recipe Prefabs")]
        static void Menu() => Execute(DefaultPath("recipe-specs"), DefaultPath("_recipe-prefabs.json"), false);

        static string DefaultPath(string leaf) => Path.GetFullPath(Path.Combine(Application.dataPath, "../../../data/previews", leaf));

        public static void Run()
        {
            var a = Environment.GetCommandLineArgs();
            string Arg(string n, string d) { int i = Array.IndexOf(a, n); return i >= 0 && i + 1 < a.Length ? a[i + 1] : d; }
            int code = 1;
            try
            {
                code = Execute(Arg("-vfxSpecs", DefaultPath("recipe-specs")), Arg("-vfxOut", DefaultPath("_recipe-prefabs.json")), a.Contains("--empty-control") || a.Contains("-emptyControl"));
            }
            catch (Exception e) { Debug.LogError("[RecipePrefabBuilder] " + e); }
            if (Application.isBatchMode) EditorApplication.Exit(code);
        }

        static int Execute(string specsDir, string outFile, bool emptyControl)
        {
            var items = new Dictionary<string, Item>();
            if (!AssetDatabase.IsValidFolder(OutDir)) AssetDatabase.CreateFolder("Assets", "RecipePrefabs");
            if (!AssetDatabase.IsValidFolder(OutDir + "/Materials")) AssetDatabase.CreateFolder(OutDir, "Materials");
            if (emptyControl)
            {
                items[ControlSlug] = Build(new RecipeSpecDto { slug = ControlSlug, version = 1 });
            }
            else
            {
                var specs = Directory.GetFiles(specsDir, "*.json").Select(f => JsonConvert.DeserializeObject<RecipeSpecDto>(File.ReadAllText(f))).Where(s => s != null && s.slug != ControlSlug).ToDictionary(s => s.slug);
                foreach (var slug in Order(specs)) items[slug] = Build(specs[slug]);
            }
            WriteManifest(outFile, items);
            int built = items.Values.Count(i => i.status == "built");
            Debug.Log($"[RecipePrefabBuilder] built={built} skipped={items.Count - built} -> {outFile}");
            return 0;
        }

        /// <summary>Dependency order: a recipe nested through recipe:// is built after the one it references.</summary>
        static List<string> Order(Dictionary<string, RecipeSpecDto> specs)
        {
            var order = new List<string>(); var state = new Dictionary<string, int>();
            void Visit(string s)
            {
                if (state.TryGetValue(s, out int st) && st != 0) return;
                state[s] = 1;
                foreach (var l in specs[s].layers.Where(l => l.nestedPath.StartsWith(OutDir + "/")))
                {
                    var dep = Path.GetFileNameWithoutExtension(l.nestedPath);
                    if (specs.ContainsKey(dep) && dep != s) Visit(dep);
                }
                state[s] = 2; order.Add(s);
            }
            foreach (var s in specs.Keys.OrderBy(x => x, StringComparer.Ordinal)) Visit(s);
            return order;
        }

        static Item Build(RecipeSpecDto spec)
        {
            var item = new Item { layersInRecipe = spec.layers.Count, status = "skipped" };
            var path = $"{OutDir}/{spec.slug}.prefab";
            if (!SafeSlug.IsMatch(spec.slug)) { item.reason = "bad-slug"; return item; }
            var skip = RecipePlanner.SkipReason(spec);
            var plans = skip == null ? RecipePlanner.Plan(spec) : null;
            if (skip == null) skip = Preflight(plans);
            if (skip != null) { AssetDatabase.DeleteAsset(path); item.reason = skip; return item; }

            var root = new GameObject(spec.slug);
            PrefabUtility.SaveAsPrefabAsset(root, path);
            UnityEngine.Object.DestroyImmediate(root);
            var contents = PrefabUtility.LoadPrefabContents(path);
            try
            {
                for (int i = 0; i < plans.Count; i++) AddLayer(contents.transform, plans[i], spec.slug, i);
                item.systemsBuilt = contents.transform.childCount;
                PrefabUtility.SaveAsPrefabAsset(contents, path);
            }
            finally { PrefabUtility.UnloadPrefabContents(contents); }
            AssetDatabase.ImportAsset(path);
            item.status = "built"; item.prefabPath = path; item.prefabGuid = AssetDatabase.AssetPathToGUID(path);
            return item;
        }

        static string Preflight(List<ParticlePlan> plans)
        {
            if (Shader.Find(MaterialMapping.UrpParticlesUnlit) == null && plans.Any(p => p.Kind != "nested")) return "shader-missing:" + MaterialMapping.UrpParticlesUnlit;
            foreach (var p in plans)
            {
                if (p.Kind == "nested") { if (ResolveNested(p) == null) return "nested-missing:" + p.NestedPath; }
                else if (ResolveTexture(p) == null) return "texture-missing:" + p.TextureUri;
            }
            return null;
        }

        static string FirstAsset(string filter, string dir)
        {
            if (!AssetDatabase.IsValidFolder(dir)) return null;
            return AssetDatabase.FindAssets(filter, new[] { dir }).Select(AssetDatabase.GUIDToAssetPath).OrderBy(x => x, StringComparer.Ordinal).FirstOrDefault();
        }
        static Texture2D ResolveTexture(ParticlePlan p) { var f = FirstAsset("t:Texture2D", p.TexturePath); return f == null ? null : AssetDatabase.LoadAssetAtPath<Texture2D>(f); }
        static GameObject ResolveNested(ParticlePlan p)
        {
            var f = p.NestedPath.EndsWith(".prefab") ? p.NestedPath : FirstAsset("t:Prefab", p.NestedPath);
            return f == null ? null : AssetDatabase.LoadAssetAtPath<GameObject>(f);
        }

        static void AddLayer(Transform root, ParticlePlan p, string slug, int index)
        {
            if (p.Kind == "nested")
            {
                var inst = (GameObject)PrefabUtility.InstantiatePrefab(ResolveNested(p), root);
                inst.name = $"{index:00}-{p.Component}";
                if (p.StartDelay > 0f)
                    foreach (var ps in inst.GetComponentsInChildren<ParticleSystem>(true)) { var m = ps.main; m.startDelay = m.startDelay.constant + p.StartDelay; }
                return;
            }
            var go = new GameObject($"{index:00}-{p.Component}");
            go.transform.SetParent(root, false);
            Configure(go.AddComponent<ParticleSystem>(), go.GetComponent<ParticleSystemRenderer>(), p, MakeMaterial(p, slug, index));
        }

        static Material MakeMaterial(ParticlePlan p, string slug, int index)
        {
            var path = $"{OutDir}/Materials/{slug}_{index:00}.mat";
            var m = new Material(Shader.Find(MaterialMapping.UrpParticlesUnlit));
            m.SetTexture("_BaseMap", ResolveTexture(p));
            m.SetColor("_BaseColor", Color.white);
            MaterialMapping.BlendState(p.Blend, out int surface, out int blend, out int src, out int dst, out int zWrite);
            m.SetFloat("_Surface", surface); m.SetFloat("_Blend", blend); m.SetFloat("_SrcBlend", src); m.SetFloat("_DstBlend", dst); m.SetFloat("_ZWrite", zWrite);
            m.SetOverrideTag("RenderType", surface == 0 ? "Opaque" : "Transparent");
            if (surface == 0) m.DisableKeyword("_SURFACE_TYPE_TRANSPARENT"); else { m.EnableKeyword("_SURFACE_TYPE_TRANSPARENT"); m.SetFloat("_Cull", 0); }
            m.renderQueue = surface == 0 ? 2000 : 3000;
            AssetDatabase.CreateAsset(m, path);
            return AssetDatabase.LoadAssetAtPath<Material>(path);
        }

        static void Configure(ParticleSystem ps, ParticleSystemRenderer r, ParticlePlan p, Material mat)
        {
            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
            var main = ps.main;
            main.duration = Mathf.Max(p.StartLifetimeMax, 0.1f);
            main.loop = p.Loop; main.playOnAwake = true;
            main.startDelay = p.StartDelay;
            main.startLifetime = new ParticleSystem.MinMaxCurve(p.StartLifetimeMin, p.StartLifetimeMax);
            main.startSpeed = new ParticleSystem.MinMaxCurve(p.SpeedMin, p.SpeedMax);
            main.startSize = new ParticleSystem.MinMaxCurve(p.StartSizeMin * p.SizeStart, p.StartSizeMax * p.SizeStart);
            if (p.RandomRotation) main.startRotation = new ParticleSystem.MinMaxCurve(0f, 2f * Mathf.PI);
            else main.startRotation = new ParticleSystem.MinMaxCurve(p.StartRotationMin, p.StartRotationMax);
            main.startColor = new Color(1f, 1f, 1f, p.StartAlpha);
            main.gravityModifier = p.GravityModifier;
            main.simulationSpace = p.SimulationLocal ? ParticleSystemSimulationSpace.Local : ParticleSystemSimulationSpace.World;
            main.maxParticles = Mathf.Max(1, p.MaxParticles);

            var em = ps.emission;
            em.enabled = true;
            em.rateOverTime = p.RatePerSecond;
            em.SetBursts(p.BurstCount > 0 ? new[] { new ParticleSystem.Burst(0f, (short)p.BurstCount) } : new ParticleSystem.Burst[0]);

            var shape = ps.shape;
            shape.enabled = p.ShapeType != "none";
            if (p.ShapeType == "box")
            {
                shape.shapeType = ParticleSystemShapeType.Box;
                if (p.ShapeScale != null && p.ShapeScale.Length == 3) shape.scale = new Vector3(p.ShapeScale[0], p.ShapeScale[1], p.ShapeScale[2]);
                shape.position = new Vector3(0f, p.ShapePositionY, 0f);
            }
            else if (p.ShapeType == "hemisphere") { shape.shapeType = ParticleSystemShapeType.Hemisphere; shape.radius = 0.05f; }

            var sol = ps.sizeOverLifetime;
            sol.enabled = Mathf.Abs(p.SizeStart - p.SizeEnd) > 1e-6f;
            if (sol.enabled) sol.size = new ParticleSystem.MinMaxCurve(1f, AnimationCurve.Linear(0f, 1f, 1f, p.SizeEnd / (Mathf.Abs(p.SizeStart) < 1e-6f ? 1f : p.SizeStart)));

            var col = ps.colorOverLifetime;
            col.enabled = p.ColorStops.Count > 0 || p.AlphaStops.Count > 0;
            if (col.enabled)
            {
                var g = new Gradient();
                var ck = p.ColorStops.Count > 0 ? p.ColorStops.Select(s => new GradientColorKey(new Color(s.r, s.g, s.b), s.t)).ToArray() : new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(Color.white, 1f) };
                var ak = p.AlphaStops.Count > 0 ? p.AlphaStops.Select(s => new GradientAlphaKey(s.a, s.t)).ToArray() : new[] { new GradientAlphaKey(1f, 0f), new GradientAlphaKey(1f, 1f) };
                g.SetKeys(ck, ak);
                col.color = new ParticleSystem.MinMaxGradient(g);
            }

            r.renderMode = p.StretchRender ? ParticleSystemRenderMode.Stretch : ParticleSystemRenderMode.Billboard;
            r.velocityScale = p.VelocityScale; r.lengthScale = p.LengthScale;
            r.sharedMaterial = mat;
        }

        static void WriteManifest(string outFile, Dictionary<string, Item> items)
        {
            var doc = new { version = 1, runId = DateTime.UtcNow.ToString("o"), items };
            Directory.CreateDirectory(Path.GetDirectoryName(outFile));
            var tmp = outFile + ".tmp";
            File.WriteAllText(tmp, JsonConvert.SerializeObject(doc, Formatting.Indented, new JsonSerializerSettings { NullValueHandling = NullValueHandling.Ignore }));
            if (File.Exists(outFile)) File.Delete(outFile);
            File.Move(tmp, outFile);
        }
    }
}
