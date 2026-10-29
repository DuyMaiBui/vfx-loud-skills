namespace VfxPreview
{
    /// <summary>Which material slots of a ParticleSystemRenderer are actually drawn (pure System code: tools/preview/framing-tests runs it with plain dotnet).
    /// Billboard, Stretch, Horizontal and Vertical modes draw slot 0 only; slot 1 is the trail material, drawn only when the trails module is on
    /// (checked by the caller). Mesh mode draws one slot per submesh of the particle mesh. A null in any other slot is serialized padding, not a
    /// missing-shader draw, so the pre-render gate must not fail on it.</summary>
    public static class MaterialSlots
    {
        /// <summary>Number of leading slots drawn by the particle renderer itself (never more than <paramref name="slotCount"/>).</summary>
        public static int DrawnParticleSlots(bool meshMode, int submeshCount, int slotCount)
        {
            int drawn = meshMode ? (submeshCount < 1 ? 1 : submeshCount) : 1;
            return drawn > slotCount ? slotCount : drawn;
        }
    }
}
