// mqtt.go — MQTT client for publishing raw KISS frames.
//
// The broker URL, credentials and TLS settings are global (set once at startup
// via environment variables / CLI flags).  Each audio channel can optionally
// specify a topic prefix; when set, every raw KISS frame decoded for that
// channel is published to  <prefix>/<channel_label>.
//
// If no broker is configured the mqttClient is nil and all Publish calls are
// no-ops.
package main

import (
	"crypto/tls"
	"fmt"
	"log"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// MQTTConfig holds the global broker connection settings.
type MQTTConfig struct {
	Broker        string // e.g. "tcp://broker.example.com:1883" or "ssl://…:8883"
	Username      string
	Password      string
	TLSSkipVerify bool
	ClientID      string
}

// mqttClient wraps a paho MQTT client with a simple Publish helper.
type mqttClient struct {
	c mqtt.Client
}

// newMQTTClient connects to the broker described by cfg and returns a client.
// Returns nil (not an error) when cfg.Broker is empty so callers can treat
// a nil client as "MQTT disabled".
func newMQTTClient(cfg MQTTConfig) (*mqttClient, error) {
	if cfg.Broker == "" {
		return nil, nil
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

	if cfg.TLSSkipVerify {
		opts.SetTLSConfig(&tls.Config{InsecureSkipVerify: true}) //nolint:gosec
	}

	opts.SetAutoReconnect(true)
	opts.SetConnectRetry(true)
	opts.SetConnectRetryInterval(5 * time.Second)
	opts.SetMaxReconnectInterval(60 * time.Second)
	opts.SetConnectionLostHandler(func(_ mqtt.Client, err error) {
		log.Printf("[mqtt] connection lost: %v", err)
	})
	opts.SetOnConnectHandler(func(_ mqtt.Client) {
		log.Printf("[mqtt] connected to %s", cfg.Broker)
	})

	c := mqtt.NewClient(opts)
	tok := c.Connect()
	tok.Wait()
	if err := tok.Error(); err != nil {
		return nil, fmt.Errorf("mqtt connect: %w", err)
	}

	return &mqttClient{c: c}, nil
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
