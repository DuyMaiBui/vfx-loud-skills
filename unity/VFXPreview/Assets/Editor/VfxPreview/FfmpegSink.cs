using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace VfxPreview
{
    /// <summary>ffmpeg child process fed raw bytes over stdin (no intermediate files).</summary>
    sealed class FfmpegSink : IDisposable
    {
        public static string Exe => Environment.GetEnvironmentVariable("FFMPEG") ?? "/usr/bin/ffmpeg";
        readonly Process _p;
        readonly StringBuilder _err = new();

        public FfmpegSink(string args)
        {
            _p = new Process
            {
                StartInfo = new ProcessStartInfo(Exe, "-hide_banner -loglevel error -y " + args)
                {
                    RedirectStandardInput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
                },
            };
            _p.ErrorDataReceived += (_, e) => { if (e.Data != null) lock (_err) _err.AppendLine(e.Data); };
            _p.Start();
            _p.BeginErrorReadLine();
        }

        public void Write(byte[] buf) => _p.StandardInput.BaseStream.Write(buf, 0, buf.Length);

        /// <summary>Closes stdin, waits, returns null on success or the ffmpeg stderr.</summary>
        public string Finish()
        {
            try { _p.StandardInput.Close(); } catch (IOException) { }
            _p.WaitForExit();
            return _p.ExitCode == 0 ? null : $"ffmpeg exit {_p.ExitCode}: {_err}";
        }

        public void Dispose() { try { if (!_p.HasExited) _p.Kill(); } catch { } _p.Dispose(); }
    }
}
