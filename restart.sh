#!/usr/bin/env bash
# restart.sh — restart the ubersdr-packet service

set -euo pipefail

INSTALL_DIR="${HOME}/ubersdr/packet"

cd "${INSTALL_DIR}"
echo "Stopping ubersdr-packet..."
docker compose down
echo "Starting ubersdr-packet..."
docker compose up -d --remove-orphans
echo "Done."
echo "  View logs : docker compose logs -f"
echo "  Web UI    : http://localhost:6089"
