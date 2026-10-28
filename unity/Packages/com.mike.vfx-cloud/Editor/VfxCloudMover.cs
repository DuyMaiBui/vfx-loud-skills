using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json;

// Pure (System.IO only): journaled move phase of plan.md C7, tested by plain dotnet.
namespace VfxCloud
{
    public class MoveJob
    {
        public string TargetPath;   // project-relative, forward slashes (e.g. Assets/Game/VFX/a.mat)
        public string TempAsset;    // verified temp file
        public string TempMeta;     // verified temp .meta; null = write no .meta (legacy item or KeepMeta)
    }

    public class JournalEntry
    {
        [JsonProperty("path")] public string Path;
        [JsonProperty("replaced")] public bool Replaced;
        [JsonProperty("backup")] public string Backup;
    }

    public static class VfxCloudMover
    {
        /// <summary>Moves every job (.meta first, then the asset). On any failure the journal is undone best-effort
        /// (created files removed, replaced files restored from <paramref name="backupDir"/>) and the exception is rethrown.</summary>
        public static List<JournalEntry> Move(string projectRoot, IList<MoveJob> jobs, string journalPath, string backupDir)
        {
            var journal = new List<JournalEntry>();
            Directory.CreateDirectory(backupDir);
            try
            {
                foreach (var job in jobs)
                {
                    var asset = Full(projectRoot, job.TargetPath);
                    var dir = Path.GetDirectoryName(asset);
                    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                    if (job.TempMeta != null) Place(job.TempMeta, asset + ".meta", journal, journalPath, backupDir);
                    Place(job.TempAsset, asset, journal, journalPath, backupDir);
                }
            }
            catch
            {
                Undo(journal);
                throw;
            }
            return journal;
        }

        static void Place(string temp, string dest, List<JournalEntry> journal, string journalPath, string backupDir)
        {
            var entry = new JournalEntry { Path = dest, Replaced = File.Exists(dest) };
            if (entry.Replaced)
            {
                entry.Backup = Path.Combine(backupDir, journal.Count + "-" + Path.GetFileName(dest));
                File.Copy(dest, entry.Backup, true);
            }
            journal.Add(entry);
            File.WriteAllText(journalPath, JsonConvert.SerializeObject(journal));
            if (entry.Replaced) File.Delete(dest);
            MoveFile(temp, dest);
        }

        // Rename; when temp and target sit on different filesystems copy to a hidden name beside the target, then rename.
        static void MoveFile(string src, string dest)
        {
            try { File.Move(src, dest); }
            catch (IOException) when (File.Exists(src))
            {
                var hidden = Path.Combine(Path.GetDirectoryName(dest), "." + Path.GetFileName(dest) + ".vfxtmp");
                File.Copy(src, hidden, true);
                File.Move(hidden, dest);
                File.Delete(src);
            }
        }

        static void Undo(List<JournalEntry> journal)
        {
            for (var i = journal.Count - 1; i >= 0; i--)
            {
                var e = journal[i];
                try
                {
                    if (File.Exists(e.Path)) File.Delete(e.Path);
                    if (e.Replaced && e.Backup != null && File.Exists(e.Backup)) File.Copy(e.Backup, e.Path, true);
                }
                catch { /* best effort */ }
            }
        }

        static string Full(string root, string rel) => Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar));
    }
}
