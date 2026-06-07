#!/bin/sh
# entrypoint.sh — translate environment variables into ubersdr-packet flags
#
# Environment variables:
#   UBERSDR_URL           UberSDR WebSocket URL (required)
#   UBERSDR_PASS          UberSDR bypass password (optional)
#   UI_PASSWORD           Password for write actions in the web UI (optional)
#   WEB_PORT              Port for the web UI server (default: 6089)
#   DATA_DIR              Directory for channels.json (default: /data)
#   REPLAY_BUF_SIZE       Recent AX.25 frames replayed to late-joining browsers
#                         (default: 200; set 0 to disable)
#   MQTT_ENABLED          Set to "true" to enable MQTT publishing (default: false)
#   MQTT_BROKER           MQTT broker URL, e.g. tcp://host:1883 or ssl://host:8883
#                         Use ssl:// for TLS connections.
#   MQTT_USER             MQTT username (optional)
#   MQTT_PASS             MQTT password (optional)
#   MQTT_TLS_SKIP_VERIFY  Set to "true" to skip TLS certificate verification
#                         (useful for self-signed certificates)
#   MQTT_TOPIC_PREFIX     Default MQTT topic prefix (default: "packet").
#                         Frames publish to <prefix>/<channel_label>.
#                         Per-channel overrides take precedence when set.

set -e

args=""

[ -n "$UBERSDR_URL"     ] && args="$args -url $UBERSDR_URL"
[ -n "$UBERSDR_PASS"    ] && args="$args -password $UBERSDR_PASS"
[ -n "$UI_PASSWORD"     ] && args="$args -ui-password $UI_PASSWORD"
[ -n "$REPLAY_BUF_SIZE" ] && args="$args -replay-buf $REPLAY_BUF_SIZE"

# MQTT — only active when MQTT_ENABLED=true AND MQTT_BROKER is set.
if [ "$MQTT_ENABLED" = "true" ] && [ -n "$MQTT_BROKER" ]; then
    args="$args -mqtt-broker $MQTT_BROKER"
    [ -n "$MQTT_USER" ] && args="$args -mqtt-user $MQTT_USER"
    [ -n "$MQTT_PASS" ] && args="$args -mqtt-pass $MQTT_PASS"
    [ "$MQTT_TLS_SKIP_VERIFY" = "true" ] && args="$args -mqtt-tls-skip-verify"
    [ -n "$MQTT_TOPIC_PREFIX" ] && args="$args -mqtt-topic-prefix $MQTT_TOPIC_PREFIX"
fi

DATA_DIR="${DATA_DIR:-/data}"
args="$args -data $DATA_DIR"

if [ -n "$WEB_PORT" ]; then
    args="$args -listen :$WEB_PORT"
else
    args="$args -listen :6089"
fi

# Append any CLI args passed directly to the container
# shellcheck disable=SC2086
exec /usr/local/bin/ubersdr-packet $args "$@"
