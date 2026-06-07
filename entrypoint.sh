#!/bin/sh
# entrypoint.sh — translate environment variables into ubersdr-packet flags
#
# Environment variables:
#   UBERSDR_URL      UberSDR WebSocket URL (required)
#   UBERSDR_PASS     UberSDR bypass password (optional)
#   UI_PASSWORD      Password for write actions in the web UI (optional)
#   WEB_PORT         Port for the web UI server (default: 6096)
#   DATA_DIR         Directory for channels.json (default: /data)
#   REPLAY_BUF_SIZE  Number of recent AX.25 frames buffered per channel for
#                    late-joining browsers (default: 200; set 0 to disable)

set -e

args=""

[ -n "$UBERSDR_URL"     ] && args="$args -url $UBERSDR_URL"
[ -n "$UBERSDR_PASS"    ] && args="$args -password $UBERSDR_PASS"
[ -n "$UI_PASSWORD"     ] && args="$args -ui-password $UI_PASSWORD"
[ -n "$REPLAY_BUF_SIZE" ] && args="$args -replay-buf $REPLAY_BUF_SIZE"

DATA_DIR="${DATA_DIR:-/data}"
args="$args -data $DATA_DIR"

if [ -n "$WEB_PORT" ]; then
    args="$args -listen :$WEB_PORT"
else
    args="$args -listen :6096"
fi

# Append any CLI args passed directly to the container
# shellcheck disable=SC2086
exec /usr/local/bin/ubersdr-packet $args "$@"
