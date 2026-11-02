#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

IMAGE="${IMAGE:-adh-server:latest}"
PLATFORM="${PLATFORM:-}"

ARGS=(build -t "$IMAGE")

if [[ -n "$PLATFORM" ]]; then
  ARGS+=(--platform "$PLATFORM")
fi

if [[ "${NO_CACHE:-0}" == "1" ]]; then
  ARGS+=(--no-cache)
fi

echo "==> docker ${ARGS[*]} ."
docker "${ARGS[@]}" .

cat <<EOF

==> built: $IMAGE

run:
  docker run -d --name adh \\
    -p 8080:8080 \\
    -v adh-data:/data \\
    $IMAGE
EOF