using System.Collections.Generic;
using UnityEngine;

namespace VfxCloud.Samples
{
    /// <summary>
    /// Pool ParticleSystem để burst effect không Instantiate/Destroy mỗi lần.
    /// </summary>
    public sealed class VfxPool : MonoBehaviour
    {
        [SerializeField] ParticleSystem prefab;
        [SerializeField] int prewarm = 8;
        [SerializeField] int maxAlive = 32;

        readonly Queue<ParticleSystem> _idle = new Queue<ParticleSystem>();
        readonly List<ParticleSystem> _active = new List<ParticleSystem>();

        void Awake()
        {
            for (var i = 0; i < prewarm; i++)
            {
                var ps = Create();
                ps.gameObject.SetActive(false);
                _idle.Enqueue(ps);
            }
        }

        ParticleSystem Create()
        {
            var ps = Instantiate(prefab, transform);
            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
            return ps;
        }

        public ParticleSystem Play(Vector3 position, Quaternion rotation)
        {
            if (_active.Count >= maxAlive) RecycleOldest();

            ParticleSystem ps;
            if (_idle.Count > 0) ps = _idle.Dequeue();
            else ps = Create();

            ps.transform.SetPositionAndRotation(position, rotation);
            ps.gameObject.SetActive(true);
            ps.Play(true);
            _active.Add(ps);
            return ps;
        }

        void RecycleOldest()
        {
            if (_active.Count == 0) return;
            var oldest = _active[0];
            _active.RemoveAt(0);
            oldest.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
            oldest.gameObject.SetActive(false);
            _idle.Enqueue(oldest);
        }

        void LateUpdate()
        {
            for (var i = _active.Count - 1; i >= 0; i--)
            {
                var ps = _active[i];
                if (ps != null && ps.IsAlive(true)) continue;
                _active.RemoveAt(i);
                if (ps == null) continue;
                ps.gameObject.SetActive(false);
                _idle.Enqueue(ps);
            }
        }
    }
}
