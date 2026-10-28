using System;
using System.Collections.Generic;

namespace VfxPreview
{
    /// <summary>A sphere around something visible (a particle, a mesh), in world units.</summary>
    public readonly struct Ball
    {
        public readonly float X, Y, Z, R;
        public Ball(float x, float y, float z, float r) { X = x; Y = y; Z = z; R = r; }
    }

    /// <summary>Camera framing from what is actually visible. Pure System code (no UnityEngine) so tools/preview/framing-tests can
    /// build and run it with plain dotnet.</summary>
    public static class FramingMath
    {
        public struct Fit { public float Cx, Cy, Cz, Radius; }

        /// <summary>Box around every ball over the whole clip, ignoring the extreme <paramref name="outlier"/> fraction on each side of each
        /// axis (a one-frame flash does not shrink the rest of the effect to dots). With fewer than 1/outlier balls nothing is ignored, so a
        /// sparse effect is framed by the exact union. Radius sits between the box half-extent and its half-diagonal, times
        /// <paramref name="margin"/>, never below <paramref name="minRadius"/> (the minimum on-screen size).</summary>
        public static bool TryFit(IList<Ball> balls, float outlier, float margin, float minRadius, out Fit fit)
        {
            fit = default;
            int n = balls.Count;
            if (n == 0) return false;
            int cut = (int)Math.Floor(outlier * (n - 1));
            var lo = new float[n]; var hi = new float[n];
            var min = new float[3]; var max = new float[3];
            for (int axis = 0; axis < 3; axis++)
            {
                for (int i = 0; i < n; i++)
                {
                    var b = balls[i];
                    float c = axis == 0 ? b.X : axis == 1 ? b.Y : b.Z;
                    lo[i] = c - b.R; hi[i] = c + b.R;
                }
                Array.Sort(lo); Array.Sort(hi);
                min[axis] = lo[cut]; max[axis] = hi[n - 1 - cut];
                if (max[axis] < min[axis]) { float m = 0.5f * (min[axis] + max[axis]); min[axis] = max[axis] = m; }
            }
            float ex = 0.5f * (max[0] - min[0]), ey = 0.5f * (max[1] - min[1]), ez = 0.5f * (max[2] - min[2]);
            float maxE = Math.Max(ex, Math.Max(ey, ez));
            float diag = (float)Math.Sqrt(ex * ex + ey * ey + ez * ez);
            fit.Cx = 0.5f * (min[0] + max[0]); fit.Cy = 0.5f * (min[1] + max[1]); fit.Cz = 0.5f * (min[2] + max[2]);
            fit.Radius = Math.Max(0.5f * (maxE + diag) * margin, minRadius);
            return true;
        }

        /// <summary>Distance at which a sphere of this radius is inscribed in the vertical field of view.</summary>
        public static float CameraDistance(float radius, float fovDegrees) =>
            radius / (float)Math.Sin(fovDegrees * 0.5 * Math.PI / 180.0);
    }
}
