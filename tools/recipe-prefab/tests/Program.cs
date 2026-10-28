using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using VfxPreview;

// Plain-dotnet checks for RecipePlanner. usage: dotnet run --project tools/recipe-prefab/tests -- <specs dir (recipe-spec.ts output)>
// Exit 0 = all pass. Expected counts are literals on purpose: they do not follow the fixture, so a lost layer fails.
static class Program
{
    static int fails;
    static void Check(string name, bool ok) { Console.WriteLine((ok ? "PASS " : "FAIL ") + name); if (!ok) fails++; }
    static bool Near(float a, float b, float eps = 1e-4f) => Math.Abs(a - b) <= eps;

    static readonly Dictionary<string, int> Layers = new Dictionary<string, int>
    {
        ["cartoon-ground-impact"] = 3, ["hit-spark"] = 2, ["melee-slash"] = 2, ["metal-landing-spark"] = 1, ["pickup-pop"] = 2,
        ["projectile-trail"] = 1, ["reward-burst"] = 3, ["rod-twinkle-box"] = 1, ["soft-smoke-plume"] = 2, ["teleport-gate"] = 3,
    };

    static int Main(string[] args)
    {
        var dir = args.Length > 0 ? args[0] : throw new ArgumentException("usage: <specs dir>");
        var opt = new JsonSerializerOptions { IncludeFields = true, PropertyNameCaseInsensitive = true };
        var plans = new Dictionary<string, List<ParticlePlan>>();
        foreach (var kv in Layers)
        {
            var spec = JsonSerializer.Deserialize<RecipeSpecDto>(File.ReadAllText(Path.Combine(dir, kv.Key + ".json")), opt);
            Check(kv.Key + ": buildable (no skip reason)", RecipePlanner.SkipReason(spec) == null);
            var p = RecipePlanner.Plan(spec);
            plans[kv.Key] = p;
            Check($"{kv.Key}: systems == layers ({kv.Value})", p.Count == kv.Value && spec.layers.Count == kv.Value);
        }
        Check("total systems == 20 layers across the 10 recipes (18 component + 2 build)", plans.Values.Sum(x => x.Count) == 20);

        var cg = plans["cartoon-ground-impact"];
        Check("ring: additive, size 0.2 -> 1.8, lifetime 0.35", cg[0].Blend == Blend.Additive && Near(cg[0].SizeStart, 0.2f) && Near(cg[0].SizeEnd, 1.8f) && Near(cg[0].StartLifetimeMax, 0.35f));
        Check("dust: alpha blend, delay 0.03, size 0.5 -> 1.4", cg[1].Blend == Blend.Alpha && Near(cg[1].StartDelay, 0.03f) && Near(cg[1].SizeStart, 0.5f) && Near(cg[1].SizeEnd, 1.4f));
        Check("debris: burst of 8, velocity listed as unmapped", cg[2].BurstCount == 8 && cg[2].Unmapped.Contains("velocity:radial-outward"));
        Check("quad without count: a single particle burst", cg[0].BurstCount == 1);
        Check("pickup sparkles: burst 6, lifetime defaulted-free", plans["pickup-pop"][1].BurstCount == 6 && Near(plans["pickup-pop"][1].StartLifetimeMax, 0.4f));
        Check("hit-spark flash: size curve 0.6 -> 1.0", Near(plans["hit-spark"][0].SizeStart, 0.6f) && Near(plans["hit-spark"][0].SizeEnd, 1.0f));
        Check("hit-spark: layer 2 is a nested prefab with count listed as unmapped", plans["hit-spark"][1].Kind == "nested" && plans["hit-spark"][1].Unmapped.Contains("count") && plans["hit-spark"][1].NestedPath == "Assets/VFXCloud/vfx/sparks");
        Check("melee-slash: nested recipe delay 0.03", Near(plans["melee-slash"][1].StartDelay, 0.03f));
        var rb = plans["reward-burst"];
        Check("reward-burst: three nested layers, delays 0 / 0.05 / 0.1", rb.All(x => x.Kind == "nested") && Near(rb[1].StartDelay, 0.05f) && Near(rb[2].StartDelay, 0.1f));
        var sm = plans["soft-smoke-plume"];
        Check("smoke core: alpha 0.8 -> 0 as alpha stops, size 0.4 -> 1.6", sm[0].AlphaStops.Count == 2 && Near(sm[0].AlphaStops[0].a, 0.8f) && Near(sm[0].AlphaStops[1].a, 0f) && Near(sm[0].SizeEnd, 1.6f));
        Check("smoke fumes: random rotation, lifetime 1.2", sm[1].RandomRotation && Near(sm[1].StartLifetimeMax, 1.2f));
        var pt = plans["projectile-trail"][0];
        Check("projectile trail: stretch render, alpha 1 -> 0, lifetime defaulted-free 0.25", pt.StretchRender && pt.AlphaStops.Count == 2 && Near(pt.StartLifetimeMax, 0.25f));
        Check("teleport-gate: three looping layers; base-circle rotation listed as unmapped", plans["teleport-gate"].All(x => x.Loop) && plans["teleport-gate"][0].Unmapped.Contains("rotation"));
        Check("teleport-gate: lifetime defaulted and recorded", plans["teleport-gate"][0].Defaulted.Contains("lifetime") && Near(plans["teleport-gate"][0].StartLifetimeMax, RecipePlanner.DefaultLifetime));
        Check("teleport-gate glow: constant scale 0.9", Near(plans["teleport-gate"][2].SizeStart, 0.9f) && Near(plans["teleport-gate"][2].SizeEnd, 0.9f));

        var ml = plans["metal-landing-spark"][0];
        Check("metal spark: additive, burst 12 from emit_pattern, max 12, speed 2 -> 3.5, hemisphere", ml.Blend == Blend.Additive && ml.BurstCount == 12 && ml.MaxParticles == 12 && Near(ml.SpeedMin, 2f) && Near(ml.SpeedMax, 3.5f) && ml.ShapeType == "hemisphere");
        Check("metal spark: lifetime 0.22 -> 0.28, gravity 0.6, stretch 0.12/1.5, world space", Near(ml.StartLifetimeMin, 0.22f) && Near(ml.StartLifetimeMax, 0.28f) && Near(ml.GravityModifier, 0.6f) && ml.StretchRender && Near(ml.VelocityScale, 0.12f) && Near(ml.LengthScale, 1.5f) && !ml.SimulationLocal);
        Check("metal spark: colour stops 0, 0.85, 1 and alpha stops 0, 0.6, 1", ml.ColorStops.Count == 3 && Near(ml.ColorStops[1].t, 0.85f) && ml.AlphaStops.Count == 3 && Near(ml.AlphaStops[2].a, 0f));
        var rod = plans["rod-twinkle-box"][0];
        Check("rod twinkle: loop, local space, box shape (0.18,1,0.10) at y 0.5, max 6", rod.Loop && rod.SimulationLocal && rod.ShapeType == "box" && Near(rod.ShapeScale[0], 0.18f) && Near(rod.ShapePositionY, 0.5f) && rod.MaxParticles == 6);
        Check("rod twinkle: rate derived and recorded (6 / 0.65)", Near(rod.RatePerSecond, 6f / 0.65f, 1e-3f) && rod.Defaulted.Contains("emission.rate") && rod.BurstCount == 0);
        Check("rod twinkle: size 0.05 -> 0.09, rotation 0 -> 2pi", Near(rod.StartSizeMin, 0.05f) && Near(rod.StartSizeMax, 0.09f) && Near(rod.StartRotationMax, (float)(2 * Math.PI), 1e-3f));

        var withUnsupported = new RecipeSpecDto { slug = "x", unsupported = new List<string> { "x: unknown key \"wobble\"" } };
        Check("a spec with unsupported[] is skipped, never partially built", RecipePlanner.SkipReason(withUnsupported)?.StartsWith("unsupported:") == true);
        Check("zero-layer spec plans zero systems (the empty control)", RecipePlanner.Plan(new RecipeSpecDto { slug = "__empty-control" }).Count == 0);

        Console.WriteLine(fails == 0 ? "ALL PASS" : $"{fails} FAILED");
        return fails == 0 ? 0 : 1;
    }
}
