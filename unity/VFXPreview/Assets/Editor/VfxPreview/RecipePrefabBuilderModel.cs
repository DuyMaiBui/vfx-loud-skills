using System;
using System.Collections.Generic;
using System.Linq;

namespace VfxPreview
{
    // JSON shapes of data/previews/recipe-specs/<slug>.json (written by tools/recipe-prefab/recipe-spec.ts). Field names are the JSON keys.
    // Optional numbers are nullable: absent = the recipe did not say.
    public sealed class RangeDto { public float from; public float to; }
    public sealed class ColorStopDto { public float t, r, g, b; }
    public sealed class AlphaStopDto { public float t, a; }

    public sealed class PsDto
    {
        public bool playOnAwake, loop;
        public RangeDto startLifetime, startSpeed, startSize, startRotation;
        public float? gravityModifier, maxParticles, velocityScale, lengthScale, emissionRate, emitCount;
        public string simulationSpace = "", scalingMode = "", emission = "", shapeType = "none", renderMode = "", sortMode = "", alignment = "", materialBlend = "", materialTextureUri = "", emitDirection = "";
        public float[] shapeScale;
        public List<ColorStopDto> colorStops = new List<ColorStopDto>();
        public List<AlphaStopDto> alphaStops = new List<AlphaStopDto>();
        public RangeDto emitSpeed;
    }

    public sealed class LayerDto
    {
        public string component = "", kind = "", textureUri = "", texturePath = "", nestedUri = "", nestedPath = "", blend = "", velocity = "";
        public float? lifetime, delay, rotation, count;
        public bool loop, rotationRandom, stretchByVelocity;
        public RangeDto scale, alpha;
        public PsDto particleSystem;
    }

    public sealed class RecipeSpecDto
    {
        public string slug = "";
        public int version;
        public List<LayerDto> layers = new List<LayerDto>();
        public List<string> unsupported = new List<string>();
    }

    /// <summary>One layer as Unity will build it: a single ParticleSystem (quad / particle_system) or a nested prefab child.</summary>
    public sealed class ParticlePlan
    {
        public string Component = "", Kind = "";
        public string TextureUri = "", TexturePath = "", NestedPath = "";
        public Blend Blend = Blend.Alpha;
        public float StartLifetimeMin, StartLifetimeMax, StartDelay, StartSizeMin = 1f, StartSizeMax = 1f;
        /// <summary>Size-over-lifetime multiplier endpoints (recipe `scale: a -> b`).</summary>
        public float SizeStart = 1f, SizeEnd = 1f;
        public float SpeedMin, SpeedMax, GravityModifier, StartAlpha = 1f, RatePerSecond, VelocityScale, LengthScale = 1f;
        public bool Loop, PlayOnAwake = true, SimulationLocal, RandomRotation, StretchRender;
        public float StartRotationMin, StartRotationMax;
        public int BurstCount, MaxParticles = 1;
        /// <summary>"none" | "box" | "hemisphere".</summary>
        public string ShapeType = "none";
        public float[] ShapeScale;
        public float ShapePositionY;
        public List<ColorStopDto> ColorStops = new List<ColorStopDto>();
        public List<AlphaStopDto> AlphaStops = new List<AlphaStopDto>();
        /// <summary>Recipe fields this mapping does NOT express (listed, never silently dropped).</summary>
        public List<string> Unmapped = new List<string>();
        /// <summary>Values the mapping filled in because the recipe did not say (named constants below).</summary>
        public List<string> Defaulted = new List<string>();
    }

    /// <summary>Pure recipe spec -> ParticlePlan mapping (no UnityEngine; plain dotnet runs it via tools/recipe-prefab/tests). The single place values are converted.</summary>
    public static class RecipePlanner
    {
        /// <summary>Lifetime used when a layer states none (seconds).</summary>
        public const float DefaultLifetime = 1f;

        public static Blend ParseBlend(string s)
        {
            switch (s) { case "additive": return Blend.Additive; case "multiply": return Blend.Multiply; case "opaque": return Blend.Opaque; default: return Blend.Alpha; }
        }

        /// <summary>null = buildable; otherwise the reason the whole slug is skipped (no partial preview).</summary>
        public static string SkipReason(RecipeSpecDto spec)
        {
            if (spec.unsupported != null && spec.unsupported.Count > 0) return "unsupported:" + spec.unsupported[0];
            return null;
        }

        public static List<ParticlePlan> Plan(RecipeSpecDto spec) => spec.layers.Select(PlanLayer).ToList();

        public static ParticlePlan PlanLayer(LayerDto l)
        {
            var p = new ParticlePlan { Component = l.component, Kind = l.kind, TextureUri = l.textureUri, TexturePath = l.texturePath, NestedPath = l.nestedPath, Blend = ParseBlend(l.blend) };
            if (l.kind == "nested") { PlanNested(l, p); return p; }
            if (l.kind == "particle_system") { PlanExplicit(l.particleSystem, p); return p; }
            PlanQuad(l, p);
            return p;
        }

        static void PlanNested(LayerDto l, ParticlePlan p)
        {
            p.StartDelay = l.delay ?? 0f;
            // Overrides of a referenced prefab's own timing/size are not applied; listed instead of guessed.
            if (l.count.HasValue) p.Unmapped.Add("count");
            if (l.lifetime.HasValue) p.Unmapped.Add("lifetime");
            if (l.scale != null) p.Unmapped.Add("scale");
            if (l.alpha != null) p.Unmapped.Add("alpha");
            if (l.rotation.HasValue || l.rotationRandom) p.Unmapped.Add("rotation");
            if (l.loop) p.Unmapped.Add("loop");
        }

        static void PlanQuad(LayerDto l, ParticlePlan p)
        {
            if (l.lifetime.HasValue) p.StartLifetimeMin = p.StartLifetimeMax = l.lifetime.Value;
            else { p.StartLifetimeMin = p.StartLifetimeMax = DefaultLifetime; p.Defaulted.Add("lifetime"); }
            p.StartDelay = l.delay ?? 0f;
            p.Loop = l.loop;
            if (l.scale != null) { p.SizeStart = l.scale.from; p.SizeEnd = l.scale.to; }
            p.BurstCount = l.count.HasValue ? (int)l.count.Value : 1;
            p.MaxParticles = Math.Max(1, p.BurstCount);
            if (l.alpha != null)
            {
                p.StartAlpha = l.alpha.from;
                if (Math.Abs(l.alpha.from - l.alpha.to) > 1e-6f) p.AlphaStops.AddRange(new[] { new AlphaStopDto { t = 0f, a = l.alpha.from }, new AlphaStopDto { t = 1f, a = l.alpha.to } });
            }
            p.RandomRotation = l.rotationRandom;
            if (l.rotation.HasValue) p.Unmapped.Add("rotation"); // unit not stated by the recipe
            if (l.velocity != "") p.Unmapped.Add("velocity:" + l.velocity); // direction without a speed
            if (l.stretchByVelocity) { p.StretchRender = true; p.Unmapped.Add("stretch-by-velocity:no-velocity-source"); }
        }

        static void PlanExplicit(PsDto s, ParticlePlan p)
        {
            var life = s.startLifetime ?? new RangeDto { from = DefaultLifetime, to = DefaultLifetime };
            if (s.startLifetime == null) p.Defaulted.Add("lifetime");
            p.StartLifetimeMin = life.from; p.StartLifetimeMax = life.to;
            if (s.startSize != null) { p.StartSizeMin = s.startSize.from; p.StartSizeMax = s.startSize.to; }
            if (s.startRotation != null) { p.StartRotationMin = s.startRotation.from; p.StartRotationMax = s.startRotation.to; }
            p.GravityModifier = s.gravityModifier ?? 0f;
            p.Loop = s.loop;
            if (!s.playOnAwake) p.Defaulted.Add("playOnAwake:forced-true-for-preview"); // the runtime calls Play(); a preview has no such caller
            p.SimulationLocal = s.simulationSpace == "local";
            p.MaxParticles = (int)(s.maxParticles ?? 1000f);
            p.ShapeType = s.shapeType; p.ShapeScale = s.shapeScale;
            if (s.shapeType == "box") p.ShapePositionY = (s.shapeScale != null && s.shapeScale.Length == 3 ? s.shapeScale[1] : 1f) / 2f; // recipe note: position.y = h/2 at neutral height
            p.ColorStops.AddRange(s.colorStops); p.AlphaStops.AddRange(s.alphaStops);
            p.StretchRender = s.renderMode == "stretch";
            p.VelocityScale = s.velocityScale ?? 0f; p.LengthScale = s.lengthScale ?? 1f;
            var speed = s.startSpeed ?? new RangeDto();
            p.SpeedMin = speed.from; p.SpeedMax = speed.to;
            if (s.emission == "enabled")
            {
                if (s.emissionRate.HasValue && s.emissionRate.Value > 0f) p.RatePerSecond = s.emissionRate.Value;
                else
                {
                    // The recipe's runtime raises the rate on trigger: steady state = max alive / mean lifetime.
                    p.RatePerSecond = p.MaxParticles / Math.Max(0.01f, (p.StartLifetimeMin + p.StartLifetimeMax) / 2f);
                    p.Defaulted.Add("emission.rate");
                }
            }
            else if (s.emitCount.HasValue)
            {
                // Emission is disabled because the runtime Emit()s a fixed pool; emit_pattern is the recipe's own description of that.
                p.BurstCount = (int)s.emitCount.Value;
                if (s.emitSpeed != null) { p.SpeedMin = s.emitSpeed.from; p.SpeedMax = s.emitSpeed.to; }
                if (s.emitDirection == "hemisphere") p.ShapeType = "hemisphere";
                p.Defaulted.Add("emission:burst-from-emit_pattern");
            }
            if (s.scalingMode != "") p.Unmapped.Add("main.scaling_mode");
            if (s.sortMode != "") p.Unmapped.Add("renderer.sort_mode");
            if (s.alignment != "") p.Unmapped.Add("renderer.alignment");
        }
    }
}
