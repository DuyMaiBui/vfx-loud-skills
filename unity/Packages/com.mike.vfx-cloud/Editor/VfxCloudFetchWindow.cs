using UnityEditor;
using UnityEngine;

namespace VfxCloud
{
    public class VfxCloudFetchWindow : EditorWindow
    {
        const string UriKey = "VfxCloud.LastUri";
        string _uri = "";
        string _server = "";
        string _apiKey = "";
        int _variant;
        int _onConflict;
        InstallSummary _summary;
        Vector2 _scroll;
        static readonly string[] Variants = { "urp", "original" };
        static readonly string[] Policies = { "refuse", "skip", "overwrite" };
        string _status = "";
        MessageType _statusType = MessageType.None;

        [MenuItem("TheOne/VFX Cloud/Fetch URI…", priority = 0)]
        public static void Open()
        {
            var window = GetWindow<VfxCloudFetchWindow>(true, "VFX Cloud Fetch", true);
            window.minSize = new Vector2(520f, 360f);
            window.ShowUtility();
            window.Load();
        }

        void Load()
        {
            _uri = EditorPrefs.GetString(UriKey, "vfx://texture/smoke-01/1");
            _server = VfxCloudSettings.Server;
            _apiKey = VfxCloudSettings.ApiKey;
            _variant = Mathf.Max(0, System.Array.IndexOf(Variants, VfxCloudSettings.Variant));
            _onConflict = Mathf.Max(0, System.Array.IndexOf(Policies, VfxCloudSettings.OnConflict));
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

            EditorGUI.BeginChangeCheck();
            _apiKey = EditorGUILayout.PasswordField("API key", _apiKey);
            _variant = EditorGUILayout.Popup("Variant", _variant, Variants);
            _onConflict = EditorGUILayout.Popup("On conflict", _onConflict, Policies);
            if (EditorGUI.EndChangeCheck())
            {
                VfxCloudSettings.ApiKey = _apiKey;
                VfxCloudSettings.Variant = Variants[_variant];
                VfxCloudSettings.OnConflict = Policies[_onConflict];
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
            DrawResults();
        }

        void DrawResults()
        {
            if (_summary == null) return;
            _scroll = EditorGUILayout.BeginScrollView(_scroll);
            foreach (var w in _summary.Warnings) EditorGUILayout.HelpBox(w, MessageType.Warning);
            foreach (var i in _summary.Items)
                EditorGUILayout.LabelField($"{i.Action}  {i.Path}" + (i.Reason != null ? $"  ({i.Reason})" : "") + (i.GuidKept != null ? $"  [GUID kept {i.GuidKept}]" : ""));
            EditorGUILayout.EndScrollView();
        }

        void Run()
        {
            VfxCloudSettings.Server = _server;
            var options = InstallOptions.FromSettings();
            options.Progress = (what, p) => EditorUtility.DisplayProgressBar("VFX Cloud", what, p);
            try { _summary = VfxCloudInstaller.Install(_uri.Trim(), options); }
            finally { EditorUtility.ClearProgressBar(); }
            _status = _summary.Message;
            _statusType = _summary.Ok ? MessageType.Info : MessageType.Error;
            Repaint();

            if (!_summary.Ok)
            {
                Debug.LogError($"[VFXCloud] {_summary.Message}");
                return;
            }

            Debug.Log($"[VFXCloud] {_summary.Message}");
            if (!string.IsNullOrEmpty(_summary.RootPath))
            {
                EditorGUIUtility.PingObject(AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(_summary.RootPath));
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
