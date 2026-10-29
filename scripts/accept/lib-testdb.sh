#!/usr/bin/env bash
# Scratch-DB harness for the self-contained VFX fetch (plan.md D15, phase-1 step 2). SOURCED, never executed.
#
#   testdb_create <lane>   creates vfxcloud_test_<lane> (drops a stale one of the same name first), exports
#                          DATABASE_URL and a fresh DATA_DIR (a temp dir), and traps EXIT to drop both.
#   testdb_drop            drops the scratch DB and removes DATA_DIR (also called by the EXIT trap).
#
# The lane must match ^[a-z0-9]+$, so the name always carries the `_test_` marker that
# server/src/test-fixtures/scratch-db.ts requires; the live `vfxcloud` DB is never a target.
# Env: VFX_PG_CONTAINER (vfx-pg), VFX_TEST_PG_USER (vfx), VFX_TEST_PG_PASSWORD (vfx),
#      VFX_TEST_PG_HOST (127.0.0.1), VFX_TEST_PG_PORT (5432).

testdb_create() {
  local lane="${1:-}"
  if [[ ! "$lane" =~ ^[a-z0-9]+$ ]]; then
    echo "testdb: lane must match [a-z0-9]+, got '${lane}'" >&2
    return 2
  fi
  local user="${VFX_TEST_PG_USER:-vfx}"
  local container="${VFX_PG_CONTAINER:-vfx-pg}"
  VFX_TESTDB_NAME="vfxcloud_test_${lane}"
  export VFX_TESTDB_NAME
  podman exec "$container" dropdb -U "$user" --if-exists "$VFX_TESTDB_NAME" >/dev/null 2>&1 || return 1
  podman exec "$container" createdb -U "$user" "$VFX_TESTDB_NAME" >/dev/null || return 1
  DATABASE_URL="postgres://${user}:${VFX_TEST_PG_PASSWORD:-vfx}@${VFX_TEST_PG_HOST:-127.0.0.1}:${VFX_TEST_PG_PORT:-5432}/${VFX_TESTDB_NAME}"
  export DATABASE_URL
  VFX_TESTDB_DATA_DIR="$(mktemp -d)" || return 1
  DATA_DIR="$VFX_TESTDB_DATA_DIR"
  export DATA_DIR VFX_TESTDB_DATA_DIR
  trap testdb_drop EXIT
}

testdb_drop() {
  local user="${VFX_TEST_PG_USER:-vfx}"
  local container="${VFX_PG_CONTAINER:-vfx-pg}"
  if [[ -n "${VFX_TESTDB_NAME:-}" ]]; then
    podman exec "$container" dropdb -U "$user" --if-exists "$VFX_TESTDB_NAME" >/dev/null 2>&1 || true
  fi
  if [[ -n "${VFX_TESTDB_DATA_DIR:-}" && -d "$VFX_TESTDB_DATA_DIR" ]]; then
    rm -rf -- "$VFX_TESTDB_DATA_DIR"
  fi
}
