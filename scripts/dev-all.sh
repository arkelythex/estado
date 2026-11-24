#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT INT TERM

echo "[dev-all] starting Rust critical engine (${ENGINE_BIND_ADDR:-127.0.0.1:8090})"
cargo run -p civictech-engine &
PIDS+=("$!")

echo "[dev-all] starting Go backend API (${API_BIND_ADDR:-0.0.0.0:8080})"
(cd "$ROOT_DIR/services/api" && go run ./cmd/api) &
PIDS+=("$!")

echo "[dev-all] starting apps/web (http://localhost:3000)"
(cd "$ROOT_DIR/apps/web" && bun run dev) &
PIDS+=("$!")

echo "[dev-all] starting apps/admin (http://localhost:3001)"
(cd "$ROOT_DIR/apps/admin" && bun run dev) &
PIDS+=("$!")

wait
