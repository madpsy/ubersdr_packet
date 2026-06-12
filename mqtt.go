// mqtt.go — MQTT client for publishing decoded AX.25 frames as JSON.
//
// The broker URL, credentials and TLS settings are global (set once at startup
// via environment variables / CLI flags).  Each audio channel can optionally
// specify a topic prefix; when set, every decoded AX.25 frame for that channel
// is published to <prefix>/<channel_label> as a JSON object:
//
//	{
//	  "channel":        "7049450_usb",   // channel label
//	  "modem_ch":       0,               // QtSoundModem sub-channel (0–3)
//	  "snr":            42.3,            // dB, omitted (null) when unavailable
//	  "received_at":    "2024-01-01T…",  // RFC3339Nano UTC timestamp
//	  "frame":          "<base64>",      // raw AX.25 bytes, base64-encoded
//	  "freq_hz":        7049450,         // dial (VFO) frequency in Hz
//	  "mode":           "usb",           // demodulation mode ("usb" or "lsb")
//	  "freq_offset_hz": 1700             // carrier offset from dial freq in Hz
//	}
//
// TLS is enabled automatically when the broker URL uses the ssl:// or tls://
// scheme.  Set TLSSkipVerify=true to accept self-signed certificates.
//
// If no broker is configured the mqttClient is nil and all Publish calls are
// no-ops.
package main

import (
	"crypto/tls"
	"fmt"
	"log"
	"strings"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// connectWithBackoff attempts to connect to the MQTT broker, retrying with
// exponential backoff (1s → 2s → 4s → … → 60s cap) until successful.
// It logs each attempt so the operator can see what is happening.
func connectWithBackoff(c mqtt.Client, broker string) {
	delay := time.Second
	const maxDelay = 60 * time.Second
	for attempt := 1; ; attempt++ {
		log.Printf("[mqtt] connecting to %s (attempt %d)…", broker, attempt)
		tok := c.Connect()
		tok.Wait()
		if tok.Error() == nil {
			return // connected
		}
		log.Printf("[mqtt] connect attempt %d failed: %v; retrying in %s", attempt, tok.Error(), delay)
		time.Sleep(delay)
		delay *= 2
		if delay > maxDelay {
			delay = maxDelay
		}
	}
}

// MQTTConfig holds the global broker connection settings.
type MQTTConfig struct {
	// Broker URL, e.g.:
	//   "tcp://broker.example.com:1883"   — plain TCP
	//   "ssl://broker.example.com:8883"   — TLS (certificate verified)
	//   "tls://broker.example.com:8883"   — TLS (alias for ssl://)
	Broker        string
	Username      string
	Password      string
	TLSSkipVerify bool // skip certificate verification (self-signed certs)
	ClientID      string
}

// mqttClient wraps a paho MQTT client with a simple Publish helper.
type mqttClient struct {
	c mqtt.Client
}

// isTLSBroker reports whether the broker URL implies a TLS connection.
func isTLSBroker(broker string) bool {
	lower := strings.ToLower(broker)
	return strings.HasPrefix(lower, "ssl://") || strings.HasPrefix(lower, "tls://")
}

// newMQTTClient creates an MQTT client and begins connecting to the broker
// described by cfg using exponential backoff in a background goroutine.
// Returns nil when cfg.Broker is empty (MQTT disabled).
// The returned client can be used immediately — Publish calls are silently
// dropped until the connection is established.
func newMQTTClient(cfg MQTTConfig) *mqttClient {
	if cfg.Broker == "" {
		return nil
	}

	opts := mqtt.NewClientOptions()
	opts.AddBroker(cfg.Broker)

	if cfg.ClientID == "" {
		cfg.ClientID = fmt.Sprintf("ubersdr-packet-%d", time.Now().UnixNano()%100000)
	}
	opts.SetClientID(cfg.ClientID)

	if cfg.Username != "" {
		opts.SetUsername(cfg.Username)
	}
	if cfg.Password != "" {
		opts.SetPassword(cfg.Password)
	}

	// Configure TLS when the broker URL uses ssl:// or tls://, or when
	// TLSSkipVerify is explicitly requested.
	if isTLSBroker(cfg.Broker) || cfg.TLSSkipVerify {
		tlsCfg := &tls.Config{
			InsecureSkipVerify: cfg.TLSSkipVerify, //nolint:gosec
		}
		opts.SetTLSConfig(tlsCfg)
		if cfg.TLSSkipVerify {
			log.Printf("[mqtt] TLS certificate verification disabled")
		}
	}

	// AutoReconnect handles reconnection after a drop with paho's built-in
	// exponential backoff (starts at ConnectRetryInterval, doubles each attempt,
	// caps at MaxReconnectInterval).
	opts.SetAutoReconnect(true)
	opts.SetConnectRetry(false) // we handle initial-connect backoff ourselves
	opts.SetConnectRetryInterval(2 * time.Second)
	opts.SetMaxReconnectInterval(60 * time.Second)
	opts.SetConnectionLostHandler(func(_ mqtt.Client, err error) {
		log.Printf("[mqtt] connection lost: %v — will reconnect automatically", err)
	})
	opts.SetReconnectingHandler(func(_ mqtt.Client, _ *mqtt.ClientOptions) {
		log.Printf("[mqtt] reconnecting to %s…", cfg.Broker)
	})
	opts.SetOnConnectHandler(func(_ mqtt.Client) {
		log.Printf("[mqtt] connected to %s", cfg.Broker)
	})

	c := mqtt.NewClient(opts)
	// Use our own exponential-backoff loop for the initial connection so the
	// process doesn't fail-fast if the broker isn't up yet at startup.
	go connectWithBackoff(c, cfg.Broker)

	return &mqttClient{c: c}
}

// Publish sends payload to topic with QoS 0 (fire-and-forget).
// Safe to call on a nil receiver (MQTT disabled).
func (m *mqttClient) Publish(topic string, payload []byte) {
	if m == nil {
		return
	}
	tok := m.c.Publish(topic, 0, false, payload)
	// Non-blocking: don't wait for ack on QoS 0.
	_ = tok
}

// Close disconnects the client gracefully.
func (m *mqttClient) Close() {
	if m == nil {
		return
	}
	m.c.Disconnect(500)
}
