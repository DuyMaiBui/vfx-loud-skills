using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace VfxPreview
{
    /// <summary>Ensures URP is assigned and colour space is linear on first open (a hand-written
    /// ProjectSettings cannot carry the URP asset GUID before the asset exists).</summary>
    [InitializeOnLoad]
    static class ProjectBootstrap
    {
        const string Dir = "Assets/VfxPreviewSettings";

        static ProjectBootstrap() { EditorApplication.delayCall += Ensure; }

        static void Ensure()
        {
            if (PlayerSettings.colorSpace != ColorSpace.Linear) PlayerSettings.colorSpace = ColorSpace.Linear;
            if (GraphicsSettings.defaultRenderPipeline != null) return;
            if (!AssetDatabase.IsValidFolder(Dir)) AssetDatabase.CreateFolder("Assets", "VfxPreviewSettings");
            var rd = ScriptableObject.CreateInstance<UniversalRendererData>();
            AssetDatabase.CreateAsset(rd, Dir + "/URP-Renderer.asset");
            var rp = UniversalRenderPipelineAsset.Create(rd);
            AssetDatabase.CreateAsset(rp, Dir + "/URP.asset");
            GraphicsSettings.defaultRenderPipeline = rp;
            AssetDatabase.SaveAssets();
            Debug.Log("[VfxPreview] URP asset created and assigned; colour space = " + PlayerSettings.colorSpace);
        }
    }
}
