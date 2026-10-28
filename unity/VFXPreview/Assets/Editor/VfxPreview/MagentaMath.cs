using System;

namespace VfxPreview
{
    /// <summary>The missing-shader detector's rule (pure System code: tools/preview/framing-tests runs it with plain dotnet).
    /// Mirrors server/src/magenta.ts (MAGENTA_RULE); the shared vectors in both test suites pin the two together.
    ///
    /// Unity draws a material it cannot render with the error shader: flat, unlit, opaque (255,0,255). The preview background is (28,31,36)
    /// and effects are alpha/additive blended on it, so a legitimate pink glow keeps green >= ~31 (additive) or is a gradient (alpha): only
    /// an opaque error pixel has r and b saturated with g ~ 0. The render lane checks the raw RGBA frames (no codec, so the tolerances only
    /// matter to the GIF-side copy of the rule).</summary>
    public static class MagentaMath
    {
        public const int MinRB = 225, MaxG = 20, MaxRBGap = 30;
        /// <summary>A frame is magenta when this share of its pixels is.</summary>
        public const double MinFrameShare = 0.005;
        /// <summary>A clip is broken when at least this many frames are magenta.</summary>
        public const int MinFrames = 1;

        public static bool IsMagenta(int r, int g, int b) => r >= MinRB && b >= MinRB && g <= MaxG && Math.Abs(r - b) <= MaxRBGap;

        public static bool IsMagentaFrame(long magentaPixels, long pixels) => pixels > 0 && (double)magentaPixels / pixels >= MinFrameShare;

        public static bool IsMagentaClip(int magentaFrames) => magentaFrames >= MinFrames;
    }
}
