using System;
using System.Collections.Generic;
using VfxPreview;

// Plain-dotnet checks for FramingMath (run: dotnet run --project tools/preview/framing-tests). Exit 0 = all pass.
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
        Console.WriteLine(fails == 0 ? "ALL PASS" : fails + " FAILED");
        return fails == 0 ? 1 - 1 : 1;
    }
}
