using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace VfxPreview
{
    /// <summary>Unity side of MaterialMapping: reads a Material into a MaterialSnapshot, applies the plan on URP Particles/Unlit, and answers
    /// "can URP draw this at all?" for the pre-render gate (a material it cannot draw renders as flat magenta, never as the effect).
    /// Preview-only project: the imported pack assets are edited in place.</summary>
    static class MaterialConverter
    {
        static readonly ShaderTagId LightMode = new ShaderTagId("LightMode");
        static readonly ShaderTagId[] UrpDrawn =
        {
            ShaderTagId.none, // no LightMode tag = SRPDefaultUnlit
            new ShaderTagId("UniversalForward"), new ShaderTagId("UniversalForwardOnly"), new ShaderTagId("SRPDefaultUnlit"),
        };

        [MenuItem("Tools/VFX Preview/3. Convert Materials For URP")]
        static void Menu() => ConvertAll();

        /// <summary>Remap every material under Assets/ImportedPacks that URP cannot draw (or draws as nothing) to URP Particles/Unlit.</summary>
        public static void ConvertAll()
        {
            var urp = Shader.Find(MaterialMapping.UrpParticlesUnlit);
            if (urp == null) { Debug.LogWarning("[BatchEntry] URP particle shader missing, materials left as is"); return; }
            int fixedKw = 0;
            var byRule = new SortedDictionary<string, int>();
            foreach (var g in AssetDatabase.FindAssets("t:Material", new[] { "Assets/ImportedPacks" }))
            {
                var m = AssetDatabase.LoadAssetAtPath<Material>(AssetDatabase.GUIDToAssetPath(g));
                if (m == null || m.shader == null) continue;
                var plan = MaterialMapping.Plan(Snapshot(m));
                if (plan == null) { if (m.shader == urp && DropSoftParticleKeywords(m)) { EditorUtility.SetDirty(m); fixedKw++; } continue; }
                Apply(m, plan, urp);
                byRule[plan.Rule] = byRule.TryGetValue(plan.Rule, out var c) ? c + 1 : 1;
            }
            AssetDatabase.SaveAssets();
            foreach (var kv in byRule) Debug.Log($"[BatchEntry] converted {kv.Value,4} x {kv.Key}");
            Debug.Log($"[BatchEntry] converted {byRule.Values.Sum()} materials to URP Particles/Unlit, dropped soft-particle keywords on {fixedKw} more");
        }

        static MaterialSnapshot Snapshot(Material m)
        {
            var s = new MaterialSnapshot { Shader = m.shader.name, Queue = m.renderQueue, UrpDrawable = IsUrpDrawable(m) };
            var sh = m.shader;
            for (int i = 0; i < sh.GetPropertyCount(); i++)
            {
                var name = sh.GetPropertyName(i);
                switch (sh.GetPropertyType(i))
                {
                    case ShaderPropertyType.Float: case ShaderPropertyType.Range: s.Floats[name] = m.GetFloat(name); break;
                    case ShaderPropertyType.Color: var c = m.GetColor(name); s.Colors[name] = new Rgba(c.r, c.g, c.b, c.a); break;
                    case ShaderPropertyType.Texture: if (m.GetTexture(name) != null) s.Textures.Add(name); break;
                }
            }
            return s;
        }

        /// <summary>True when the shader compiles, is supported here and has at least one pass URP draws.</summary>
        public static bool IsUrpDrawable(Material m)
        {
            var sh = m.shader;
            if (sh == null || sh.name == "Hidden/InternalErrorShader" || !sh.isSupported || ShaderUtil.ShaderHasError(sh)) return false;
            for (int i = 0; i < m.passCount; i++)
            {
                var tag = sh.FindPassTagValue(i, LightMode);
                if (UrpDrawn.Contains(tag)) return true;
            }
            return false;
        }

        /// <summary>Why a shader was judged not drawable: supported / error flags and each pass's LightMode.</summary>
        static string Describe(Shader sh)
        {
            var tags = new List<string>();
            for (int i = 0; i < sh.passCount; i++) { var tag = sh.FindPassTagValue(i, LightMode); tags.Add(tag == ShaderTagId.none ? "-" : tag.name); }
            return $"[supported={sh.isSupported} error={ShaderUtil.ShaderHasError(sh)} passes={sh.passCount} lightModes={string.Join(",", tags)}]";
        }

        static void Apply(Material m, MaterialPlan p, Shader urp)
        {
            var tex = p.BaseMapFrom != null ? m.GetTexture(p.BaseMapFrom) : null;
            var off = p.BaseMapFrom != null ? m.GetTextureOffset(p.BaseMapFrom) : Vector2.zero;
            var scl = p.BaseMapFrom != null ? m.GetTextureScale(p.BaseMapFrom) : Vector2.one;
            m.shader = urp;
            m.SetTexture("_BaseMap", tex); m.SetTextureOffset("_BaseMap", off); m.SetTextureScale("_BaseMap", scl);
            m.SetColor("_BaseColor", new Color(p.BaseColor.R, p.BaseColor.G, p.BaseColor.B, p.BaseColor.A));
            MaterialMapping.BlendState(p.Blend, out int surface, out int blend, out int src, out int dst, out int zWrite);
            m.SetFloat("_Surface", surface); m.SetFloat("_Blend", blend);
            m.SetFloat("_SrcBlend", src); m.SetFloat("_DstBlend", dst); m.SetFloat("_ZWrite", zWrite);
            m.SetOverrideTag("RenderType", surface == 0 ? "Opaque" : "Transparent");
            DropSoftParticleKeywords(m);
            if (surface == 0) m.DisableKeyword("_SURFACE_TYPE_TRANSPARENT"); else { m.EnableKeyword("_SURFACE_TYPE_TRANSPARENT"); m.SetFloat("_Cull", 0); } // the pack quads are Cull Off
            m.renderQueue = p.Queue;
            EditorUtility.SetDirty(m);
        }

        /// <summary>Standard/legacy particle materials carry _SOFTPARTICLES_ON / _FADING_ON; URP's particle shader shares those keywords, and with no
        /// depth texture in the preview pipeline the soft-particle factor is 0, so the particle is drawn as nothing.</summary>
        public static bool DropSoftParticleKeywords(Material m)
        {
            bool any = false;
            foreach (var k in new[] { "_SOFTPARTICLES_ON", "_FADING_ON", "_FLIPBOOKBLENDING_ON" })
                if (m.IsKeywordEnabled(k)) { m.DisableKeyword(k); any = true; }
            foreach (var f in new[] { "_SoftParticlesEnabled", "_CameraFadingEnabled", "_FlipbookBlending" })
                if (m.HasProperty(f) && m.GetFloat(f) != 0f) { m.SetFloat(f, 0f); any = true; }
            return any;
        }

        /// <summary>Pre-render gate: why this prefab instance would draw as the missing-shader colour, or null. Checks every enabled renderer's
        /// materials (and the trail material of a particle system with trails) AFTER ConvertAll, so what is left is a shader with no rule.</summary>
        public static string Unrenderable(GameObject instance)
        {
            var bad = new SortedSet<string>();
            foreach (var r in instance.GetComponentsInChildren<Renderer>(true))
            {
                if (r == null || !r.enabled || !r.gameObject.activeInHierarchy) continue;
                if (r is ParticleSystemRenderer pr)
                {
                    if (pr.renderMode == ParticleSystemRenderMode.None) continue;
                    var ps = pr.GetComponent<ParticleSystem>();
                    if (ps != null && ps.trails.enabled) Check(pr.trailMaterial, r, bad);
                }
                foreach (var m in r.sharedMaterials) Check(m, r, bad);
            }
            return bad.Count == 0 ? null : "unrenderable material (URP draws it as missing-shader magenta): " + string.Join("; ", bad);
        }

        static void Check(Material m, Renderer r, ISet<string> bad)
        {
            if (m == null) { bad.Add("null material on " + r.name); return; }
            if (!IsUrpDrawable(m)) bad.Add($"'{m.name}' uses shader '{(m.shader == null ? "<null>" : m.shader.name)}'");
        }

        /// <summary>One log line per shader under Assets/ImportedPacks: how many materials use it and whether URP can draw it (before conversion).</summary>
        public static void LogShaderHistogram()
        {
            var h = new SortedDictionary<string, (int n, bool ok)>();
            foreach (var g in AssetDatabase.FindAssets("t:Material", new[] { "Assets/ImportedPacks" }))
            {
                var m = AssetDatabase.LoadAssetAtPath<Material>(AssetDatabase.GUIDToAssetPath(g));
                var n = m != null && m.shader != null ? m.shader.name : "<null>";
                h[n] = h.TryGetValue(n, out var c) ? (c.n + 1, c.ok) : (1, m != null && m.shader != null && IsUrpDrawable(m));
            }
            foreach (var kv in h)
            {
                var sh = Shader.Find(kv.Key);
                Debug.Log($"[BatchEntry] shader {kv.Value.n,5} x {kv.Key} urpDrawable={kv.Value.ok}{(sh == null || kv.Value.ok ? "" : " " + Describe(sh))}");
            }
        }
    }
}
