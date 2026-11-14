#!/usr/bin/env bash
# Builds filegrid-<component>:<tag> for every component folder (backend/, frontend/, simulator/) that has a
# Dockerfile and imports it into k3s containerd (no registry: pods use imagePullPolicy Never).
# Missing Dockerfiles are skipped, so this works before P2/P3 code lands. Tag: $APP_TAG (default git short sha).
set -euo pipefail
cd "$(dirname "$0")/.."

# fixed tag "local" outside a git checkout (tarball) or when git refuses the repo (dubious ownership)
TAG=${APP_TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo local)}
built=0
for c in backend frontend simulator; do
  if [ ! -f "$c/Dockerfile" ]; then
    echo "skip filegrid-$c: no $c/Dockerfile"
    continue
  fi
  command -v docker >/dev/null || {
    echo "docker is required to build $c/Dockerfile (prerequisite of make up / make app-images, not installed by" >&2
    echo "host-bootstrap.sh: install Docker Engine for Ubuntu from docs.docker.com/engine/install/ubuntu, then rerun)" >&2
    exit 1
  }
  img="filegrid-$c:$TAG"
  echo "build $img"
  docker build -q -t "$img" "$c" >/dev/null
  echo "import $img into k3s"
  docker save "$img" | k3s ctr -n k8s.io images import - >/dev/null
  built=$((built + 1))
done
echo "images built: $built (tag $TAG)"
