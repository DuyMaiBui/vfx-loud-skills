#!/usr/bin/env bash
# Dev: khởi động Postgres+pgvector bằng podman. Deploy thật: dùng compose.yaml.
set -euo pipefail
NAME="${PG_CONTAINER:-vfx-pg}"
IMG="${PG_IMAGE:-docker.io/pgvector/pgvector:pg17}"

if podman container exists "$NAME" 2>/dev/null; then
  if ! podman inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null | grep -q true; then
    podman start "$NAME" >/dev/null
  fi
else
  podman run -d --name "$NAME" \
    -e POSTGRES_USER=vfx -e POSTGRES_PASSWORD=vfx -e POSTGRES_DB=vfxcloud \
    -p 5432:5432 \
    -v vfx-pgdata:/var/lib/postgresql/data \
    "$IMG" >/dev/null
fi

echo "waiting for postgres..."
for _ in $(seq 1 40); do
  if podman exec "$NAME" pg_isready -U vfx -d vfxcloud >/dev/null 2>&1; then
    echo "postgres ready on 127.0.0.1:5432 (db=vfxcloud user=vfx)"
    exit 0
  fi
  sleep 1
done
echo "postgres did not become ready" >&2
exit 1
