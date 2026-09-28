using UnityEngine;

namespace VfxCloud.Samples
{
    /// <summary>
    /// Bắn VFX theo normal của bề mặt va chạm.
    /// Text-first: sửa được nguyên file này, không cần Unity MCP.
    /// </summary>
    public sealed class SurfaceImpactController : MonoBehaviour
    {
        [SerializeField] ParticleSystem impactPrefab;
        [SerializeField] LayerMask surfaceMask = ~0;
        [SerializeField] float rayDistance = 64f;
        [SerializeField] float positionOffset = 0.02f;

        public ParticleSystem SpawnAt(Vector3 position, Vector3 normal, bool inheritColor = false)
        {
            if (impactPrefab == null) return null;

            var vfx = Instantiate(impactPrefab, position + normal * positionOffset, Quaternion.identity);
            vfx.transform.rotation = Quaternion.LookRotation(normal);
            if (inheritColor) vfx.Play(true);
            else vfx.Play();

            Destroy(vfx.gameObject, vfx.main.duration + vfx.main.startLifetime.constantMax + 0.5f);
            return vfx;
        }

        public ParticleSystem SpawnFromRay(Ray ray)
        {
            if (!Physics.Raycast(ray, out var hit, rayDistance, surfaceMask, QueryTriggerInteraction.Ignore))
                return null;
            return SpawnAt(hit.point, hit.normal);
        }

        void Update()
        {
            if (!Input.GetMouseButtonDown(0)) return;
            var cam = Camera.main;
            if (cam == null) return;
            SpawnFromRay(cam.ScreenPointToRay(Input.mousePosition));
        }
    }
}
