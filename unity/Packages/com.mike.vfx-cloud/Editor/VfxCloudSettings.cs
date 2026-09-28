using UnityEditor;

namespace VfxCloud
{
    public static class VfxCloudSettings
    {
        const string ServerKey = "VfxCloud.Server";
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
    }
}
