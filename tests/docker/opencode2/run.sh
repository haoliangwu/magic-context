#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
IMAGE="mc-e2e-opencode2"

command -v docker >/dev/null || { echo "OpenCode 2 Docker lane requires docker" >&2; exit 1; }
bun run --cwd "$REPO_ROOT/packages/plugin" build

for version in 2.0.22 2.1.0; do
docker build \
    --build-arg "OPENCODE2_VERSION=$version" \
    --platform linux/amd64 \
    -f "$SCRIPT_DIR/Dockerfile" \
    -t "$IMAGE" \
    "$REPO_ROOT"

docker run --rm --platform linux/amd64 "$IMAGE"
done
