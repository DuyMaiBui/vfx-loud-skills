using System;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace VfxCloud
{
    public enum VfxFetchStatus
    {
        Success,
        UpToDate,
        Failed,
    }

    public class VfxFetchResult
    {
        public VfxFetchStatus status;
        public string message;
        public string assetPath;
        public string guid;
        public int version;
        public string license;
    }

    public static class VfxCloudFetcher
    {
        public static VfxFetchResult Fetch(string uri)
        {
            var result = new VfxFetchResult { status = VfxFetchStatus.Failed };

            if (string.IsNullOrWhiteSpace(uri) || !uri.StartsWith("vfx://", StringComparison.Ordinal))
            {
                result.message = $"URI phải bắt đầu bằng vfx:// (nhận: {uri})";
                return result;
            }

            string type, slug, versionText;
            var rest = uri.Substring("vfx://".Length).TrimEnd('/');
            var parts = rest.Split('/');
            if (parts.Length != 3 || string.IsNullOrEmpty(parts[0]) || string.IsNullOrEmpty(parts[1]) || string.IsNullOrEmpty(parts[2]))
            {
                result.message = $"Sai định dạng URI (cần vfx://type/slug/version): {uri}";
                return result;
            }
            type = parts[0];
            slug = parts[1];
            versionText = parts[2];

            var manifestUrl = $"{VfxCloudSettings.RootUri}/v1/resource/{type}/{slug}/{versionText}";
            var manifestJson = GetText(manifestUrl, out var error);
            if (manifestJson == null)
            {
                result.message = $"Không lấy được manifest từ {manifestUrl}: {error}";
                return result;
            }

            VfxCloudManifest manifest;
            try
            {
                manifest = JsonUtility.FromJson<VfxCloudManifest>(manifestJson);
            }
            catch (Exception ex)
            {
                result.message = $"Manifest JSON hỏng: {ex.Message}";
                return result;
            }

            if (manifest == null || string.IsNullOrEmpty(manifest.download_url) || string.IsNullOrEmpty(manifest.file_name))
            {
                result.message = $"Manifest thiếu download_url/file_name: {manifestJson}";
                return result;
            }

            result.assetPath = manifest.TargetPath;
            result.version = manifest.version;
            result.license = manifest.license;

            var bytes = GetBytes(manifest.download_url, out error);
            if (bytes == null)
            {
                result.message = $"Không tải được {manifest.download_url}: {error}";
                return result;
            }

            var actualSha = Sha256Hex(bytes);
            if (!string.IsNullOrEmpty(manifest.sha256) && !string.Equals(actualSha, manifest.sha256, StringComparison.OrdinalIgnoreCase))
            {
                result.message = $"sha256 không khớp server: {actualSha} != {manifest.sha256}";
                return result;
            }

            var guidBefore = AssetDatabase.AssetPathToGUID(manifest.TargetPath);
            var existed = File.Exists(manifest.TargetPath);

            if (existed)
            {
                var existing = File.ReadAllBytes(manifest.TargetPath);
                if (Sha256Hex(existing) == actualSha)
                {
                    result.status = VfxFetchStatus.UpToDate;
                    result.guid = guidBefore;
                    result.message = $"Đã đúng: {manifest.TargetPath} (GUID {guidBefore})";
                    return result;
                }
                Debug.LogWarning($"[VFXCloud] {manifest.TargetPath} đã tồn tại với nội dung khác -> ghi đè nội dung, GIỮ .meta (GUID {guidBefore})");
            }

            var dir = Path.GetDirectoryName(manifest.TargetPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllBytes(manifest.TargetPath, bytes);

            AssetDatabase.ImportAsset(manifest.TargetPath, ImportAssetOptions.ForceUpdate);

            var guidAfter = AssetDatabase.AssetPathToGUID(manifest.TargetPath);
            if (!string.IsNullOrEmpty(guidBefore) && guidBefore != guidAfter)
            {
                result.status = VfxFetchStatus.Failed;
                result.message = $"GUID thay đổi {guidBefore} -> {guidAfter}: .meta đã bị đụng, dừng lại.";
                return result;
            }

            result.status = VfxFetchStatus.Success;
            result.guid = guidAfter;
            result.message = $"{(existed ? "Cập nhật" : "Tải")} {manifest.TargetPath} v{manifest.version} ({bytes.Length} bytes, GUID {guidAfter}, license {manifest.license})";
            return result;
        }

        static string Sha256Hex(byte[] bytes)
        {
            using var sha = SHA256.Create();
            var hash = sha.ComputeHash(bytes);
            var sb = new StringBuilder(hash.Length * 2);
            foreach (var b in hash) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        static string GetText(string url, out string error)
        {
            var bytes = GetBytes(url, out error);
            return bytes == null ? null : Encoding.UTF8.GetString(bytes);
        }

        static byte[] GetBytes(string url, out string error)
        {
            error = null;
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(url);
                request.Method = "GET";
                request.Timeout = 30000;
                using var response = (HttpWebResponse)request.GetResponse();
                using var stream = response.GetResponseStream();
                if (stream == null)
                {
                    error = "empty response";
                    return null;
                }
                using var buffer = new MemoryStream();
                stream.CopyTo(buffer);
                return buffer.ToArray();
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return null;
            }
        }
    }
}
