#!/usr/bin/env bash
# docker.sh — build the ubersdr-packet Docker image
#
# All binaries are built from source inside the Docker image.
# No host binaries are required.
#
# Usage:
#   ./docker.sh [build|push|run|arm64]
#
#   build  — build the image for linux/amd64 (default, local load)
#   arm64  — build the image for linux/arm64 (Raspberry Pi, Apple Silicon, etc., local load)
#   push   — build multi-arch (amd64 + arm64) with buildx and push manifest to registry
#   run    — run the image locally (set env vars below)
#
# Environment variables (build):
#   IMAGE      Docker image name/tag   (default: madpsy/ubersdr-packet:latest)
#   PLATFORM   Docker --platform flag  (default: linux/amd64)
#   BUILDER    buildx builder name     (default: ubersdr-multiarch)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IMAGE="${IMAGE:-madpsy/ubersdr-packet:latest}"
PLATFORM="${PLATFORM:-linux/amd64}"
BUILDER="${BUILDER:-ubersdr-multiarch}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

die() { echo "error: $*" >&2; exit 1; }

check_deps() {
    command -v docker >/dev/null || die "docker not found in PATH"
}

# Ensure a buildx builder that supports multi-platform builds exists.
# If it already exists we just use it; we never delete existing builders.
ensure_builder() {
    if ! docker buildx inspect "$BUILDER" &>/dev/null; then
        echo "Creating buildx builder '$BUILDER'..."
        docker buildx create --name "$BUILDER" --driver docker-container --bootstrap
    else
        echo "Using existing buildx builder '$BUILDER'."
    fi
}

stage_context() {
    TMPCTX="$(mktemp -d)"
    trap 'rm -rf "$TMPCTX"' EXIT

    echo "Staging build context in $TMPCTX..."
    rsync -a --exclude='.git' \
              --exclude='data' \
              --exclude='ubersdr-packet' \
              "$SCRIPT_DIR/" "$TMPCTX/"
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

build() {
    check_deps
    stage_context

    echo "Building image $IMAGE (platform=$PLATFORM)..."
    docker build \
        --platform "$PLATFORM" \
        --tag "$IMAGE" \
        "$TMPCTX"

    echo "Built: $IMAGE"
}

push() {
    check_deps
    ensure_builder
    stage_context

    local platforms="linux/amd64,linux/arm64"
    echo "Building and pushing multi-arch image $IMAGE (platforms=$platforms)..."
    docker buildx build \
        --builder "$BUILDER" \
        --platform "$platforms" \
        --tag "$IMAGE" \
        --push \
        "$TMPCTX"

    echo "Pushed multi-arch manifest: $IMAGE"

    echo "Committing and pushing git repository..."
    git add -A
    git diff --cached --quiet || git commit -m "Release $IMAGE"
    git push
}

run_image() {
    local args=()

    [[ -n "${UBERSDR_URL:-}"  ]] && args+=(-e "UBERSDR_URL=$UBERSDR_URL")
    [[ -n "${UBERSDR_PASS:-}" ]] && args+=(-e "UBERSDR_PASS=$UBERSDR_PASS")
    [[ -n "${UI_PASSWORD:-}"  ]] && args+=(-e "UI_PASSWORD=$UI_PASSWORD")
    [[ -n "${WEB_PORT:-}"     ]] && args+=(-e "WEB_PORT=$WEB_PORT")
    [[ -n "${DATA_DIR:-}"     ]] && args+=(-e "DATA_DIR=$DATA_DIR")

    docker run --rm -it \
        --platform "$PLATFORM" \
        --shm-size=256m \
        -p "${WEB_PORT:-6096}:${WEB_PORT:-6096}" \
        "${args[@]}" \
        "$IMAGE" \
        "$@"
}

# ---------------------------------------------------------------------------
# Environment variable reference (for docker run -e ...)
# ---------------------------------------------------------------------------
#
#   UBERSDR_URL   UberSDR WebSocket URL (required)
#   UBERSDR_PASS  UberSDR bypass password (optional)
#   UI_PASSWORD   Password for write actions in the web UI (optional)
#   WEB_PORT      Web UI port (default: 6096)
#   DATA_DIR      Directory for channels.json (default: /data)

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

case "${1:-build}" in
    build) build ;;
    arm64) PLATFORM=linux/arm64 build ;;
    push)  push  ;;
    run)   shift; run_image "$@" ;;
    *)
        echo "Usage: $0 [build|arm64|push|run [args...]]" >&2
        exit 1
        ;;
esac
