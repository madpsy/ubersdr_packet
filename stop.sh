#!/usr/bin/env bash
# stop.sh — stop the ubersdr-packet service

set -euo pipefail

INSTALL_DIR="${HOME}/ubersdr/packet"

cd "${INSTALL_DIR}"
echo "Stopping ubersdr-packet..."
docker compose down
echo "Done."
