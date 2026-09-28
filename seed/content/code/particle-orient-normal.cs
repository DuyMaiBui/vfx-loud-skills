using UnityEngine;

namespace VfxCloud.Samples
{
    /// <summary>
    /// Xoay mesh/billboard particle theo normal tại điểm va chạm.
    /// Dùng khi render mode là 3D World (decal) thay vì View billboard.
    /// </summary>
    public static class ParticleOrient
    {
        public static Quaternion ToNormal(Vector3 normal, bool invert = false)
        {
            if (normal.sqrMagnitude < 1e-6f) return Quaternion.identity;
            var dir = invert ? -normal.normalized : normal.normalized;
            return Quaternion.FromToRotation(Vector3.forward, dir);
        }

        public static void Apply(Transform target, Vector3 normal, bool invert = false)
        {
            if (target == null) return;
            target.rotation = ToNormal(normal, invert);
        }

        public static void OffsetFromSurface(ref Vector3 position, Vector3 normal, float distance = 0.02f)
        {
            position += normal.normalized * distance;
        }
    }
}
