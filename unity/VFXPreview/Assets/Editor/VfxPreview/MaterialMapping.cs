using System;
using System.Collections.Generic;

namespace VfxPreview
{
    public readonly struct Rgba
    {
        public readonly float R, G, B, A;
        public Rgba(float r, float g, float b, float a) { R = r; G = g; B = b; A = a; }
        public static readonly Rgba White = new Rgba(1, 1, 1, 1);
    }

    public enum Blend { Opaque, Alpha, Additive, Multiply }

    /// <summary>What the converter needs to know about a material, as plain data (MaterialConverter fills it from a UnityEngine.Material).</summary>
    public sealed class MaterialSnapshot
    {
        public string Shader = "";
        public int Queue = -1;
        /// <summary>True when the shader has a pass URP can draw (UniversalForward, SRPDefaultUnlit, or a pass with no LightMode).</summary>
        public bool UrpDrawable = true;
        public readonly Dictionary<string, float> Floats = new Dictionary<string, float>();
        public readonly Dictionary<string, Rgba> Colors = new Dictionary<string, Rgba>();
        /// <summary>Texture properties that have a texture assigned.</summary>
        public readonly HashSet<string> Textures = new HashSet<string>();

        public float Float(string name, float fallback) => name != null && Floats.TryGetValue(name, out var v) ? v : fallback;
        public bool TryColor(string name, out Rgba c) { c = default; return name != null && Colors.TryGetValue(name, out c); }
    }

    /// <summary>How to rebuild a material on URP/Particles/Unlit: which source property feeds _BaseMap, the _BaseColor, the blend and the queue.</summary>
    public sealed class MaterialPlan
    {
        /// <summary>Source texture property to copy into _BaseMap (null = no texture).</summary>
        public string BaseMapFrom;
        public Rgba BaseColor;
        public Blend Blend;
        public int Queue;
        /// <summary>Which rule produced the plan (for the log and the tests).</summary>
        public string Rule;
    }

    /// <summary>Pure shader-name + properties -> URP particle plan (no UnityEngine, so tools/preview/framing-tests runs it with plain dotnet).
    ///
    /// Why this exists: built-in-RP shaders (a pack's own Amplify surface shaders, "Standard") have no pass URP draws, so Unity renders the
    /// error shader, flat magenta (Retro Arsenal and the Epic Toon FX powerboxes). Order of evaluation: a NAMED rule (the pack shader's real
    /// maths, approximated with what URP Particles/Unlit can express) beats the legacy particle rules, which beat the GENERIC fallback for any
    /// other shader URP cannot draw (conventional property names). A shader URP can draw is left alone (null).</summary>
    public static class MaterialMapping
    {
        public const string UrpParticlesUnlit = "Universal Render Pipeline/Particles/Unlit";

        /// <summary>The pack shaders multiply their emission by an HDR "extra glow" (3-5) that a bloom pass turns into a soft halo. The LDR preview has
        /// none: the same factor clips every channel and washes the effect out to white (a blue laser became a white blob). The multiplier is capped
        /// so the tint colour survives.</summary>
        public const float GlowCap = 1.25f;

        sealed class Named
        {
            public string BaseMap;     // source property -> _BaseMap
            public string Color;       // source tint property (rgb only; the pack shaders take alpha from vertex colour x texture)
            public string Glow;        // source float multiplied into rgb (HDR "extra glow", capped at GlowCap)
            public float GlowConst = 1f;
            public Blend Blend;
            public string Note;
        }

        // Retro Arsenal "Unlit" surface shaders: Emission = vertexColor * ExtraGlow * Tint * tex, Alpha = vertexColor.a * tex.a, alpha:fade.
        // URP Particles/Unlit gives vertexColor * _BaseColor * tex, so _BaseColor = Tint.rgb * min(ExtraGlow, GlowCap), alpha 1 (Tint.a is not used by the original).
        // Scrolling (Beam*), a 2nd texture (BeamDouble) and the dissolve ramp (Disintegrate) have no URP-unlit equivalent: the first texture is shown still.
        static Named Glow(string note) => new Named { BaseMap = "_TextureSample", Color = "_Tint", Glow = "_ExtraGlow", Blend = Blend.Alpha, Note = note };

        static readonly Dictionary<string, Named> Rules = new Dictionary<string, Named>
        {
            ["Archanor VFX/Retro Arsenal/BasicGlow"] = Glow("emissive alpha-blended"),
            ["Archanor VFX/Retro Arsenal/Beam"] = Glow("scroll dropped"),
            ["Archanor VFX/Retro Arsenal/BeamDouble"] = Glow("2nd texture and scroll dropped"),
            ["Archanor VFX/Retro Arsenal/Disintegrate"] = Glow("dissolve ramp dropped"),
            // Emission = tex * (pan * CenterGlow * vc + 2) * vc, Alpha = tex.a: the constant +2 is the steady glow.
            ["Archanor VFX/Retro Arsenal/TextGlow"] = new Named { BaseMap = "_TextureSample", GlowConst = 2f, Blend = Blend.Alpha, Note = "pan texture dropped" },
            // Lit-looking boxes that are really emission-only and opaque: the background texture is what is seen.
            ["Archanor VFX/Retro Arsenal/Powerbox"] = new Named { BaseMap = "_Background", Blend = Blend.Opaque, Note = "icon and pan dropped" },
            ["Archanor VFX/Retro Arsenal/Target"] = new Named { BaseMap = "_Background", Blend = Blend.Opaque, Note = "pan dropped" },
            ["Archanor VFX/Retro Arsenal/FloorMask"] = new Named { BaseMap = "_Texture", Color = "_InnerColor", Blend = Blend.Opaque, Note = "sphere mask dropped" },
            ["Archanor VFX/Retro Arsenal/2SidedSprite"] = new Named { BaseMap = "_Texture", Blend = Blend.Alpha, Note = "demo sprite" },
            ["Archanor VFX/Retro Arsenal/2SidedSpriteAnimatedUnlit"] = new Named { BaseMap = "_Texture", Blend = Blend.Alpha, Note = "flipbook drawn as the whole sheet" },
            ["Archanor VFX/Epic Toon FX/ETFX_PowerboxUnlit"] = new Named { BaseMap = "_Background", Color = "_BackgroundTint", Glow = "_BackgroundBrightness", Blend = Blend.Opaque, Note = "icon dropped" },
        };

        /// <summary>Plan for this material, or null when it should be left as it is.</summary>
        public static MaterialPlan Plan(MaterialSnapshot m)
        {
            if (m.Shader == UrpParticlesUnlit) return null;
            if (Rules.TryGetValue(m.Shader, out var r)) return FromNamed(m, r);
            bool stdParticle = m.Shader == "Particles/Standard Unlit" || m.Shader == "Particles/Standard Surface";
            if (stdParticle || m.Shader.StartsWith("Legacy Shaders/Particles/", StringComparison.Ordinal)) return Legacy(m, stdParticle);
            if (!m.UrpDrawable) return Generic(m);
            return null;
        }

        static MaterialPlan FromNamed(MaterialSnapshot m, Named r)
        {
            var c = m.TryColor(r.Color, out var tint) ? tint : Rgba.White;
            float glow = Math.Min((r.Glow != null ? m.Float(r.Glow, 1f) : 1f) * r.GlowConst, GlowCap);
            return new MaterialPlan
            {
                BaseMapFrom = r.BaseMap != null && m.Textures.Contains(r.BaseMap) ? r.BaseMap : null,
                BaseColor = new Rgba(c.R * glow, c.G * glow, c.B * glow, 1f),
                Blend = r.Blend, Queue = QueueFor(m, r.Blend), Rule = "named:" + m.Shader + " (" + r.Note + ")",
            };
        }

        // The pre-existing rules (Epic Toon FX levelup/powerup, Synty): the particle is drawn transparent whatever _Mode says.
        static MaterialPlan Legacy(MaterialSnapshot m, bool std)
        {
            int mode = std ? (int)m.Float("_Mode", -1) : -1; // 0 opaque 1 cutout 2 fade 3 transparent 4 additive 5 subtractive 6 modulate
            bool additive = m.Shader.Contains("Additive") || mode == 4;
            bool multiply = m.Shader.Contains("Multiply") || mode == 6;
            var c = m.TryColor("_TintColor", out var t) ? t : m.TryColor("_Color", out var cc) ? cc : Rgba.White;
            if (additive) c = new Rgba(c.R, c.G, c.B, Clamp01(c.A * 2f)); // legacy tint of 0.5 is neutral
            var blend = additive ? Blend.Additive : multiply ? Blend.Multiply : Blend.Alpha;
            return new MaterialPlan { BaseMapFrom = m.Textures.Contains("_MainTex") ? "_MainTex" : null, BaseColor = c, Blend = blend, Queue = QueueFor(m, blend), Rule = "legacy:" + m.Shader };
        }

        // Any other shader URP cannot draw (a built-in "Standard", a pack's surface shader with no named rule): conventional property names.
        static MaterialPlan Generic(MaterialSnapshot m)
        {
            string map = m.Textures.Contains("_MainTex") ? "_MainTex" : m.Textures.Contains("_BaseMap") ? "_BaseMap" : m.Textures.Contains("_Texture") ? "_Texture" : null;
            Rgba c = Rgba.White;
            foreach (var p in new[] { "_TintColor", "_Tint", "_Color", "_BaseColor" })
                if (m.TryColor(p, out var found)) { c = found; break; }
            int mode = (int)m.Float("_Mode", 0); // Standard: 0 opaque 1 cutout 2 fade 3 transparent
            var blend = m.Shader.Contains("Additive") ? Blend.Additive : m.Shader.Contains("Multiply") ? Blend.Multiply : mode >= 1 ? Blend.Alpha : Blend.Opaque;
            if (blend == Blend.Opaque) c = new Rgba(c.R, c.G, c.B, 1f);
            return new MaterialPlan { BaseMapFrom = map, BaseColor = c, Blend = blend, Queue = QueueFor(m, blend), Rule = "generic:" + m.Shader };
        }

        /// <summary>Keep the source's queue when it is consistent with the blend; otherwise the URP default for it.</summary>
        static int QueueFor(MaterialSnapshot m, Blend blend)
        {
            if (blend == Blend.Opaque) return m.Queue > 0 && m.Queue < 2500 ? m.Queue : 2000;
            return Math.Max(3000, m.Queue);
        }

        static float Clamp01(float v) => v < 0f ? 0f : v > 1f ? 1f : v;

        /// <summary>URP Particles/Unlit blend state for a plan: _Surface, _Blend, _SrcBlend, _DstBlend, _ZWrite (UnityEngine.Rendering.BlendMode values).</summary>
        public static void BlendState(Blend b, out int surface, out int blend, out int src, out int dst, out int zWrite)
        {
            switch (b)
            {
                case Blend.Opaque: surface = 0; blend = 0; src = 1; dst = 0; zWrite = 1; break;     // One / Zero
                case Blend.Additive: surface = 1; blend = 2; src = 5; dst = 1; zWrite = 0; break;   // SrcAlpha / One
                case Blend.Multiply: surface = 1; blend = 3; src = 2; dst = 0; zWrite = 0; break;   // DstColor / Zero
                default: surface = 1; blend = 0; src = 5; dst = 10; zWrite = 0; break;              // SrcAlpha / OneMinusSrcAlpha
            }
        }
    }
}
