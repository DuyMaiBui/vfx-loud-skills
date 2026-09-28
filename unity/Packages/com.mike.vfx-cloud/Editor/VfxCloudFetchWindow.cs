using UnityEditor;
using UnityEngine;

namespace VfxCloud
{
    public class VfxCloudFetchWindow : EditorWindow
    {
        const string UriKey = "VfxCloud.LastUri";
        string _uri = "";
        string _server = "";
        string _status = "";
        MessageType _statusType = MessageType.None;

        [MenuItem("TheOne/VFX Cloud/Fetch URI…", priority = 0)]
        public static void Open()
        {
            var window = GetWindow<VfxCloudFetchWindow>(true, "VFX Cloud Fetch", true);
            window.minSize = new Vector2(460f, 190f);
            window.ShowUtility();
            window.Load();
        }

        void Load()
        {
            _uri = EditorPrefs.GetString(UriKey, "vfx://texture/smoke-01/1");
            _server = VfxCloudSettings.Server;
        }

        void OnFocus()
        {
            if (string.IsNullOrEmpty(_uri)) Load();
        }

        void OnGUI()
        {
            EditorGUILayout.LabelField("Server", EditorStyles.boldLabel);
            EditorGUI.BeginChangeCheck();
            var server = EditorGUILayout.TextField("Base URL", _server);
            if (EditorGUI.EndChangeCheck())
            {
                _server = server;
                VfxCloudSettings.Server = server;
            }

            EditorGUILayout.Space(6f);
            EditorGUILayout.LabelField("Resource", EditorStyles.boldLabel);
            _uri = EditorGUILayout.TextField("URI", _uri);

            EditorGUILayout.Space(8f);
            using (new EditorGUILayout.HorizontalScope())
            {
                using (new EditorGUI.DisabledScope(string.IsNullOrEmpty(_uri)))
                {
                    if (GUILayout.Button("Fetch", GUILayout.Height(26f)))
                    {
                        EditorPrefs.SetString(UriKey, _uri);
                        Run();
                    }
                }
                if (GUILayout.Button("Refresh server", GUILayout.Height(26f)))
                {
                    VfxCloudSettings.Server = _server;
                }
            }

            if (!string.IsNullOrEmpty(_status))
            {
                EditorGUILayout.Space(6f);
                EditorGUILayout.HelpBox(_status, _statusType);
            }
        }

        void Run()
        {
            VfxCloudSettings.Server = _server;
            var result = VfxCloudFetcher.Fetch(_uri.Trim());
            _status = result.message;
            _statusType = result.status == VfxFetchStatus.Failed ? MessageType.Error : MessageType.Info;
            Repaint();

            if (result.status == VfxFetchStatus.Failed)
            {
                Debug.LogError($"[VFXCloud] {result.message}");
                return;
            }

            Debug.Log($"[VFXCloud] {result.message}");
            if (!string.IsNullOrEmpty(result.assetPath))
            {
                EditorGUIUtility.PingObject(AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(result.assetPath));
            }
        }
    }

    public static class VfxCloudMenu
    {
        [MenuItem("TheOne/VFX Cloud/Reveal Assets/VFXCloud", priority = 20)]
        static void Reveal()
        {
            if (!AssetDatabase.IsValidFolder("Assets/VFXCloud"))
            {
                AssetDatabase.CreateFolder("Assets", "VFXCloud");
                AssetDatabase.Refresh();
            }
            var folder = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>("Assets/VFXCloud");
            if (folder != null) EditorGUIUtility.PingObject(folder);
        }

        public static VfxFetchResult Fetch(string uri)
        {
            var result = VfxCloudFetcher.Fetch(uri);
            if (result.status == VfxFetchStatus.Failed) Debug.LogError($"[VFXCloud] {result.message}");
            else Debug.Log($"[VFXCloud] {result.message}");
            return result;
        }
    }
}
