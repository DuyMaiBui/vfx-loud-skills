using System;
using Newtonsoft.Json;
using UnityEditor;

namespace VfxCloud.Editor
{
    /// <summary>
    /// Batch install of a bundle (plan.md C10). Run:
    /// -executeMethod VfxCloud.Editor.BatchFetch.Run -vfxUri vfx://recipe/slug/1 [-vfxVariant urp|original] [-vfxOnConflict refuse|skip|overwrite]
    /// [-vfxServer url] [-vfxKey key] [-vfxRoot Assets/X].
    /// Defaults come from env VFX_SERVER, VFX_API_KEY, VFX_VARIANT, VFX_ON_CONFLICT, VFX_ROOT; also VFX_ALLOW_INCOMPLETE=1, VFX_STRICT_REQUIRES=1, VFX_DRY_RUN=1.
    /// Prints ONE line "[VfxCloud] result {json}" and exits with the C7 code (0 ok, 1 network, 2 usage, 3 conflict, 4 sha256, 5 incomplete, 6 requires, 7 guid_changed).
    /// </summary>
    public static class BatchFetch
    {
        public static void Run()
        {
            InstallSummary s;
            try { s = Execute(Environment.GetCommandLineArgs()); }
            catch (Exception ex) { s = new InstallSummary().Fail(ExitCodes.Network, ex.GetType().Name + ": " + ex.Message); }
            Console.WriteLine("[VfxCloud] result " + JsonConvert.SerializeObject(s));
            EditorApplication.Exit(s.Code);
        }

        public static InstallSummary Execute(string[] args)
        {
            var uri = Arg(args, "-vfxUri");
            if (string.IsNullOrEmpty(uri)) return new InstallSummary().Fail(ExitCodes.Usage, "missing -vfxUri <vfx://type/slug/version>");
            var conflict = Arg(args, "-vfxOnConflict") ?? Env("VFX_ON_CONFLICT") ?? "refuse";
            if (conflict != "refuse" && conflict != "skip" && conflict != "overwrite") return new InstallSummary { Uri = uri }.Fail(ExitCodes.Usage, "-vfxOnConflict must be refuse|skip|overwrite: " + conflict);
            return VfxCloudInstaller.Install(uri, new InstallOptions
            {
                Server = Arg(args, "-vfxServer") ?? Env("VFX_SERVER") ?? "http://127.0.0.1:8787",
                ApiKey = Arg(args, "-vfxKey") ?? Env("VFX_API_KEY"),
                Variant = Arg(args, "-vfxVariant") ?? Env("VFX_VARIANT") ?? "urp",
                OnConflict = InstallOptions.ParsePolicy(conflict),
                Root = Arg(args, "-vfxRoot") ?? Env("VFX_ROOT"),
                AllowIncomplete = Env("VFX_ALLOW_INCOMPLETE") == "1",
                StrictRequires = Env("VFX_STRICT_REQUIRES") == "1",
                DryRun = Env("VFX_DRY_RUN") == "1",
            });
        }

        static string Arg(string[] args, string name)
        {
            for (var i = 0; i < args.Length - 1; i++) if (args[i] == name) return args[i + 1];
            return null;
        }

        static string Env(string name)
        {
            var v = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrEmpty(v) ? null : v;
        }
    }
}
