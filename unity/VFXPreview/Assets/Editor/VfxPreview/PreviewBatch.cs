using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using UnityEngine;

namespace VfxPreview
{
    /// <summary>Renders up to GridN^2 targets in one atlas: per frame every cell simulates + renders into its own RT,
    /// GPU-copies into a (GridN*size)^2 atlas, ONE ReadPixels, ONE raw stream to ffmpeg which crops each cell to its own VP9 webm.</summary>
    static class PreviewBatch
    {
        public sealed class Result { public string slug; public bool ok; public string error, note; public long bytes; }

        public static List<Result> Run(List<Target> targets, PreviewOptions o, JObject timings)
        {
            int n = o.GridN, size = o.size, frames = o.Frames, atlasPx = n * size;
            var sw = Stopwatch.StartNew(); double tSim = 0, tRender = 0, tRead = 0, tPrep = 0, tEnc = 0;
            var cells = new List<PreviewCell>();
            var results = new List<Result>();
            var atlas = new RenderTexture(atlasPx, atlasPx, 0, RenderTextureFormat.ARGB32);
            var tex = new Texture2D(atlasPx, atlasPx, TextureFormat.RGBA32, false);
            var buf = new byte[atlasPx * atlasPx * 4];
            try
            {
                for (int i = 0; i < targets.Count; i++) cells.Add(new PreviewCell(targets[i], new Vector3((i % n) * 5000f, 0, (i / n) * 5000f), size));
                foreach (var c in cells.Where(c => !c.Ok)) results.Add(new Result { slug = c.Target.slug, error = c.Error });
                var live = cells.Where(c => c.Ok).ToList();
                if (live.Count == 0) return results;
                float dt = 1f / o.fps;
                foreach (var c in live) { c.Reset(o.loopWarmup); c.SampleBounds(); }
                for (int f = 1; f < frames; f++) foreach (var c in live) { c.Step(dt); c.SampleBounds(); }
                foreach (var c in live) { c.Frame(); c.Reset(o.loopWarmup); }
                tPrep = sw.Elapsed.TotalMilliseconds; sw.Restart();

                Directory.CreateDirectory(PreviewOptions.PreviewDir);
                int K = live.Count;
                var fc = new StringBuilder();
                if (K > 1) { fc.Append("[0:v]split=" + K); for (int k = 0; k < K; k++) fc.Append($"[s{k}]"); fc.Append(';'); }
                var args = new StringBuilder($"-f rawvideo -pix_fmt rgba -s {atlasPx}x{atlasPx} -r {o.fps} -i - -filter_complex \"");
                for (int k = 0; k < K; k++)
                {
                    int cx = (k % n) * size, cy = (k / n) * size; // raw rows start at the bottom of the atlas
                    fc.Append($"{(K > 1 ? $"[s{k}]" : "[0:v]")}crop={size}:{size}:{cx}:{cy},vflip[o{k}]{(k < K - 1 ? ";" : "")}");
                }
                args.Append(fc).Append('"');
                for (int k = 0; k < K; k++)
                    args.Append($" -map \"[o{k}]\" -c:v libvpx-vp9 -crf {o.crf} -b:v 0 -pix_fmt yuv420p -an -deadline good -cpu-used 4 -row-mt 1 -threads 4 \"{Path.Combine(PreviewOptions.PreviewDir, live[k].Target.slug + ".webm")}\"");

                using var sink = new FfmpegSink(args.ToString());
                var prev = RenderTexture.active;
                var bg = new Color32(28, 31, 36, 255);
                for (int f = 0; f < frames; f++)
                {
                    var t0 = sw.Elapsed.TotalMilliseconds;
                    if (f > 0) foreach (var c in live) c.Step(dt);
                    var t1 = sw.Elapsed.TotalMilliseconds; tSim += t1 - t0;
                    for (int k = 0; k < K; k++)
                    {
                        live[k].Render();
                        Graphics.CopyTexture(live[k].Rt, 0, 0, 0, 0, size, size, atlas, 0, 0, (k % n) * size, (k / n) * size);
                    }
                    var t2 = sw.Elapsed.TotalMilliseconds; tRender += t2 - t1;
                    RenderTexture.active = atlas;
                    tex.ReadPixels(new Rect(0, 0, atlasPx, atlasPx), 0, 0); 
                    tex.GetRawTextureData<byte>().CopyTo(buf);
                    var t3 = sw.Elapsed.TotalMilliseconds; tRead += t3 - t2;
                    for (int k = 0; k < K; k++) TrackPeak(live[k], buf, atlasPx, size, (k % n) * size, (k / n) * size, bg);
                    sink.Write(buf);
                    tEnc += sw.Elapsed.TotalMilliseconds - t3;
                }
                RenderTexture.active = prev;
                var t4 = sw.Elapsed.TotalMilliseconds;
                var encErr = sink.Finish();
                double tWait = sw.Elapsed.TotalMilliseconds - t4;
                for (int k = 0; k < K; k++)
                {
                    var c = live[k]; var slug = c.Target.slug;
                    var webm = Path.Combine(PreviewOptions.PreviewDir, slug + ".webm");
                    var webp = Path.Combine(PreviewOptions.PreviewDir, slug + ".webp");
                    string err = encErr;
                    if (err == null) err = Poster(c, webp, size);
                    if (err == null && (!File.Exists(webm) || new FileInfo(webm).Length == 0)) err = "webm missing";
                    results.Add(err != null ? new Result { slug = slug, error = err, note = c.Note }
                        : new Result { slug = slug, ok = true, note = c.Note, bytes = new FileInfo(webm).Length + new FileInfo(webp).Length });
                }
                timings["prepMs"] = Math.Round(tPrep); timings["simMs"] = Math.Round(tSim); timings["renderMs"] = Math.Round(tRender);
                timings["readbackMs"] = Math.Round(tRead); timings["streamMs"] = Math.Round(tEnc); timings["encodeWaitMs"] = Math.Round(tWait);
                timings["clips"] = K;
            }
            finally
            {
                foreach (var c in cells) c.Dispose();
                UnityEngine.Object.DestroyImmediate(tex); atlas.Release(); UnityEngine.Object.DestroyImmediate(atlas);
            }
            return results;
        }

        /// <summary>Coverage = pixels differing from the flat background; the peak frame becomes the poster.</summary>
        static void TrackPeak(PreviewCell c, byte[] buf, int atlasPx, int size, int x0, int y0, Color32 bg)
        {
            long cov = 0;
            for (int y = 0; y < size; y += 2)
            {
                int row = ((y0 + y) * atlasPx + x0) * 4;
                for (int x = 0; x < size; x += 2)
                {
                    int i = row + x * 4;
                    if (Math.Abs(buf[i] - bg.r) + Math.Abs(buf[i + 1] - bg.g) + Math.Abs(buf[i + 2] - bg.b) > 24) cov++;
                }
            }
            if (cov <= c.PeakCoverage && c.Peak != null) return;
            c.PeakCoverage = cov; c.Peak ??= new byte[size * size * 4];
            for (int y = 0; y < size; y++) Buffer.BlockCopy(buf, ((y0 + y) * atlasPx + x0) * 4, c.Peak, y * size * 4, size * 4);
        }

        static string Poster(PreviewCell c, string webp, int size)
        {
            using var s = new FfmpegSink($"-f rawvideo -pix_fmt rgba -s {size}x{size} -i - -vf vflip -frames:v 1 -c:v libwebp -quality 70 \"{webp}\"");
            s.Write(c.Peak);
            return s.Finish();
        }
    }
}
