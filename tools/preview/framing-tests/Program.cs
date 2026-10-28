using System;
using System.Collections.Generic;
using VfxPreview;

// Plain-dotnet checks for FramingMath, MagentaMath and MaterialMapping (run: dotnet run --project tools/preview/framing-tests). Exit 0 = all pass.
static class Program
{
    static int fails;
    static void Check(string name, bool ok) { Console.WriteLine((ok ? "PASS " : "FAIL ") + name); if (!ok) fails++; }
    static bool Near(float a, float b, float eps = 1e-3f) => Math.Abs(a - b) <= eps;
    const float Out = 0.02f, Margin = 1.15f, Min = 0.15f;

    static int Main()
    {
        Check("empty set does not fit", !FramingMath.TryFit(new List<Ball>(), Out, Margin, Min, out _));

        FramingMath.TryFit(new List<Ball> { new(1, 2, 3, 0.5f) }, Out, Margin, Min, out var one);
        Check("one ball: centred on it", Near(one.Cx, 1) && Near(one.Cy, 2) && Near(one.Cz, 3));
        Check("one ball: radius between half-extent and half-diagonal, times margin", Near(one.Radius, 0.5f * (0.5f + 0.5f * (float)Math.Sqrt(3)) * Margin));

        FramingMath.TryFit(new List<Ball> { new(-2, 0, 0, 0.1f), new(4, 0, 0, 0.1f) }, Out, Margin, Min, out var two);
        Check("sparse set is the exact union (centre)", Near(two.Cx, 1f));
        Check("sparse set is the exact union (radius covers both)", two.Radius >= 3.1f);

        FramingMath.TryFit(new List<Ball> { new(0, 0, 0, 0.001f) }, Out, Margin, Min, out var tiny);
        Check("minimum radius floors a tiny effect", Near(tiny.Radius, Min));

        var dense = new List<Ball>();
        for (int i = 0; i < 200; i++) dense.Add(new Ball((i % 10) * 0.1f, 0, 0, 0.05f)); // x in 0..0.9
        FramingMath.TryFit(dense, Out, Margin, Min, out var clean);
        dense.Add(new Ball(50f, 0, 0, 30f)); // one flash frame
        FramingMath.TryFit(dense, Out, Margin, Min, out var withFlash);
        Check("one outlier among 200 balls is ignored", Near(clean.Radius, withFlash.Radius, 0.2f) && withFlash.Radius < 2f);

        var many = new List<Ball>();
        for (int i = 0; i < 100; i++) many.Add(new Ball(i * 0.01f, 0, 0, 0.1f));
        for (int i = 0; i < 10; i++) many.Add(new Ball(100f, 0, 0, 1f)); // 10/110 is not an outlier
        FramingMath.TryFit(many, Out, Margin, Min, out var big);
        Check("a sustained far cluster is kept (not an outlier)", big.Radius > 40f);

        var a = new List<Ball> { new(1, 1, 1, 1), new(-1, 3, 0, 0.5f), new(2, -2, 2, 0.2f) };
        var b = new List<Ball>(); foreach (var x in a) b.Add(new Ball(x.X * 10, x.Y * 10, x.Z * 10, x.R * 10));
        FramingMath.TryFit(a, Out, Margin, 0f, out var fa); FramingMath.TryFit(b, Out, Margin, 0f, out var fb);
        Check("scale invariant", Near(fa.Radius * 10, fb.Radius, 1e-2f) && Near(fa.Cx * 10, fb.Cx, 1e-2f));

        Check("camera distance inscribes the sphere", Near(FramingMath.CameraDistance(1f, 30f), 3.8637f, 1e-3f));
        Magenta();
        Materials();
        Console.WriteLine(fails == 0 ? "ALL PASS" : fails + " FAILED");
        return fails == 0 ? 1 - 1 : 1;
    }

    // Same table as server/src/magenta.test.ts (PIXELS): the two copies of the rule must agree.
    static void Magenta()
    {
        Check("magenta: error shader (255,0,255)", MagentaMath.IsMagenta(255, 0, 255));
        Check("magenta: codec smear (240,10,235)", MagentaMath.IsMagenta(240, 10, 235));
        Check("magenta: additive glow keeps bg green (255,31,255) is NOT", !MagentaMath.IsMagenta(255, 31, 255));
        Check("magenta: hot pink (255,0,128) is NOT", !MagentaMath.IsMagenta(255, 0, 128));
        Check("magenta: pink (255,105,180) is NOT", !MagentaMath.IsMagenta(255, 105, 180));
        Check("magenta: dim (200,0,200) is NOT", !MagentaMath.IsMagenta(200, 0, 200));
        Check("magenta: background (28,31,36) is NOT", !MagentaMath.IsMagenta(28, 31, 36));
        Check("magenta: red and blue are NOT", !MagentaMath.IsMagenta(255, 0, 0) && !MagentaMath.IsMagenta(0, 0, 255));
        Check("magenta frame: 4 of 1000 is not, 5 of 1000 is", !MagentaMath.IsMagentaFrame(4, 1000) && MagentaMath.IsMagentaFrame(5, 1000));
        Check("magenta frame: an empty frame is not", !MagentaMath.IsMagentaFrame(0, 0));
        Check("magenta clip: one magenta frame breaks it, none does not", MagentaMath.IsMagentaClip(1) && !MagentaMath.IsMagentaClip(0));
    }

    static MaterialSnapshot Snap(string shader, int queue = -1, bool urpDrawable = false) => new MaterialSnapshot { Shader = shader, Queue = queue, UrpDrawable = urpDrawable };

    static void Materials()
    {
        // Retro Arsenal BasicGlow: Emission = vertexColor * ExtraGlow * Tint * tex, alpha = vertexColor.a * tex.a, alpha:fade.
        var glow = Snap("Archanor VFX/Retro Arsenal/BasicGlow");
        glow.Textures.Add("_TextureSample"); glow.Colors["_Tint"] = new Rgba(0.5f, 0.25f, 1f, 0f); glow.Floats["_ExtraGlow"] = 3f;
        var p = MaterialMapping.Plan(glow);
        Check("BasicGlow: planned", p != null && p.Rule.StartsWith("named:"));
        Check("BasicGlow: keeps the texture", p.BaseMapFrom == "_TextureSample");
        Check("BasicGlow: tint x ExtraGlow, alpha forced to 1 (the source ignores Tint.a)", Near(p.BaseColor.R, 1.5f) && Near(p.BaseColor.G, 0.75f) && Near(p.BaseColor.B, 3f) && Near(p.BaseColor.A, 1f));
        Check("BasicGlow: alpha blended, transparent queue", p.Blend == Blend.Alpha && p.Queue == 3000);

        var glowNoTex = Snap("Archanor VFX/Retro Arsenal/BasicGlow");
        Check("BasicGlow without a texture still maps (no BaseMap)", MaterialMapping.Plan(glowNoTex).BaseMapFrom == null);

        var text = Snap("Archanor VFX/Retro Arsenal/TextGlow"); text.Textures.Add("_TextureSample");
        var tp = MaterialMapping.Plan(text);
        Check("TextGlow: constant +2 glow, alpha blended", Near(tp.BaseColor.R, 2f) && tp.Blend == Blend.Alpha && tp.BaseMapFrom == "_TextureSample");

        var box = Snap("Archanor VFX/Retro Arsenal/Powerbox"); box.Textures.Add("_Background");
        var bp = MaterialMapping.Plan(box);
        Check("Powerbox: opaque, background texture", bp.Blend == Blend.Opaque && bp.BaseMapFrom == "_Background" && bp.Queue == 2000);

        var etfx = Snap("Archanor VFX/Epic Toon FX/ETFX_PowerboxUnlit", 2000); etfx.Textures.Add("_Background");
        etfx.Colors["_BackgroundTint"] = new Rgba(1f, 0f, 0.055f, 0f); etfx.Floats["_BackgroundBrightness"] = 2f;
        var ep = MaterialMapping.Plan(etfx);
        Check("ETFX powerbox: tint x brightness, opaque", ep.Blend == Blend.Opaque && Near(ep.BaseColor.R, 2f) && Near(ep.BaseColor.G, 0f) && ep.Queue == 2000);

        foreach (var s in new[] { "Beam", "BeamDouble", "Disintegrate", "TextGlow", "Powerbox", "Target", "FloorMask", "2SidedSprite", "2SidedSpriteAnimatedUnlit" })
            Check("every Retro Arsenal shader has a rule: " + s, MaterialMapping.Plan(Snap("Archanor VFX/Retro Arsenal/" + s)) != null);

        // The pre-existing legacy rules must keep their behaviour.
        var add = Snap("Legacy Shaders/Particles/Additive"); add.Textures.Add("_MainTex"); add.Colors["_TintColor"] = new Rgba(0.5f, 0.5f, 0.5f, 0.5f);
        var ap = MaterialMapping.Plan(add);
        Check("legacy additive: additive blend, tint alpha doubled (0.5 is neutral)", ap.Blend == Blend.Additive && Near(ap.BaseColor.A, 1f) && ap.BaseMapFrom == "_MainTex");
        var std = Snap("Particles/Standard Unlit"); std.Floats["_Mode"] = 4f; std.Colors["_Color"] = new Rgba(1, 1, 1, 0.25f);
        Check("Particles/Standard Unlit _Mode 4 is additive", MaterialMapping.Plan(std).Blend == Blend.Additive);
        var mul = Snap("Legacy Shaders/Particles/Multiply");
        Check("legacy multiply", MaterialMapping.Plan(mul).Blend == Blend.Multiply);

        // Anything else URP cannot draw gets the generic mapping; what URP can draw is left alone.
        var standard = Snap("Standard", 2000); standard.Textures.Add("_MainTex"); standard.Colors["_Color"] = new Rgba(0.2f, 0.4f, 0.6f, 1f);
        var sp = MaterialMapping.Plan(standard);
        Check("Standard (no URP pass): generic, opaque, keeps texture and _Color", sp.Rule.StartsWith("generic:") && sp.Blend == Blend.Opaque && sp.BaseMapFrom == "_MainTex" && Near(sp.BaseColor.G, 0.4f));
        standard.Floats["_Mode"] = 3f;
        Check("Standard _Mode 3 (transparent) keeps alpha blending", MaterialMapping.Plan(standard).Blend == Blend.Alpha);
        Check("a shader URP can draw is left alone", MaterialMapping.Plan(Snap("Some/Custom/UrpShader", urpDrawable: true)) == null);
        Check("URP Particles/Unlit is left alone", MaterialMapping.Plan(Snap(MaterialMapping.UrpParticlesUnlit)) == null);

        MaterialMapping.BlendState(Blend.Opaque, out int surf, out _, out _, out _, out int zw);
        Check("blend state: opaque writes depth", surf == 0 && zw == 1);
        MaterialMapping.BlendState(Blend.Additive, out surf, out int bl, out int src, out int dst, out zw);
        Check("blend state: additive is SrcAlpha/One, no depth write", surf == 1 && bl == 2 && src == 5 && dst == 1 && zw == 0);
        MaterialMapping.BlendState(Blend.Alpha, out _, out _, out src, out dst, out _);
        Check("blend state: alpha is SrcAlpha/OneMinusSrcAlpha", src == 5 && dst == 10);
    }
}
