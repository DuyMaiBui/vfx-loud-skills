namespace VfxPreview
{
    /// <summary>Which rendered failure causes a waiver may re-label, and which causes it may carry (pure System code: tools/preview/framing-tests runs it).
    /// A waiver never hides a failure and never turns a good clip into a failure: it only re-labels a failure the render produced as the contract's
    /// `unfixable-*` cause, so the slug is documented as accepted rather than counted as fixable.</summary>
    public static class WaiverRules
    {
        public static bool IsWaivableRenderCause(string cause) =>
            cause == "no-visible-output" || cause == "prefab-missing" || cause == "unrenderable-material" || cause == "magenta-pixel";

        public static bool IsWaiverCause(string cause) => cause == "unfixable-source" || cause == "unfixable-script" || cause == "unfixable-shader";

        /// <summary>The cause to record: the waiver's when it applies to this rendered failure, else the rendered cause unchanged.</summary>
        public static string Resolve(string renderedCause, string waiverCause) =>
            waiverCause != null && IsWaiverCause(waiverCause) && IsWaivableRenderCause(renderedCause) ? waiverCause : renderedCause;
    }
}
