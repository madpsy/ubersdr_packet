#!/bin/sh
# entrypoint.sh — launch ubersdr-packet
#
# Configuration is read directly from environment variables by the binary.
# Any CLI flags passed to the container are forwarded as-is.
#
# Environment variables (all optional except UBERSDR_URL):
#   UBERSDR_URL           UberSDR WebSocket URL (required)
#   UBERSDR_PASS          UberSDR bypass password
#   UI_PASSWORD           Password for write actions in the web UI
#   WEB_PORT              Port for the web UI server (default: 6089)
#   DATA_DIR              Directory for channels.json (default: /data)
#   REPLAY_BUF_SIZE       Recent AX.25 frames replayed to late-joining browsers
#                         (default: 200; set 0 to disable)
#   MQTT_BROKER           MQTT broker URL, e.g. tcp://host:1883 or ssl://host:8883
#   MQTT_USER             MQTT username
#   MQTT_PASS             MQTT password
#   MQTT_TLS_SKIP_VERIFY  Set to "true" to skip TLS certificate verification
#   MQTT_TOPIC_PREFIX     Default MQTT topic prefix (default: "packet")

set -e

exec /usr/local/bin/ubersdr-packet "$@"
