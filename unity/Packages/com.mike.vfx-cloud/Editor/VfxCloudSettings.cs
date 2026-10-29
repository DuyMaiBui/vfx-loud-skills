using UnityEditor;

namespace VfxCloud
{
    public static class VfxCloudSettings
    {
        const string ServerKey = "VfxCloud.Server";
        const string ApiKeyKey = "VfxCloud.ApiKey";
        const string VariantKey = "VfxCloud.Variant";
        const string OnConflictKey = "VfxCloud.OnConflict";
        const string UseLegacyKey = "VfxCloud.UseLegacy";
        const string DefaultServer = "http://127.0.0.1:8787";

        public static string Server
        {
            get
            {
                var value = EditorPrefs.GetString(ServerKey, string.Empty);
                return string.IsNullOrEmpty(value) ? DefaultServer : value;
            }
            set => EditorPrefs.SetString(ServerKey, value ?? string.Empty);
        }

        public static string RootUri => Server.TrimEnd('/');

        /// <summary>Sent as x-vfx-key. Stored in this machine's EditorPrefs only, never in the project.</summary>
        public static string ApiKey
        {
            get => EditorPrefs.GetString(ApiKeyKey, string.Empty);
            set => EditorPrefs.SetString(ApiKeyKey, value ?? string.Empty);
        }

        /// <summary>"urp" (default) or "original".</summary>
        public static string Variant
        {
            get => EditorPrefs.GetString(VariantKey, "urp");
            set => EditorPrefs.SetString(VariantKey, value ?? "urp");
        }

        /// <summary>"refuse" (default), "skip" or "overwrite".</summary>
        public static string OnConflict
        {
            get => EditorPrefs.GetString(OnConflictKey, "refuse");
            set => EditorPrefs.SetString(OnConflictKey, value ?? "refuse");
        }

        /// <summary>Old single-file fetch path (per-resource manifest), kept behind this switch.</summary>
        public static bool UseLegacy
        {
            get => EditorPrefs.GetBool(UseLegacyKey, false);
            set => EditorPrefs.SetBool(UseLegacyKey, value);
        }
    }
}
