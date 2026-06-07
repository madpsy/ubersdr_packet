// main.go — ubersdr-packet: multi-channel AX.25 packet decoder
//
// Each "audio channel" connects to UberSDR at a given frequency/mode and
// feeds the decoded PCM into a QtSoundModem instance.  QtSoundModem supports
// up to 4 simultaneous modem sub-channels (A/B/C/D) per audio channel.
//
// Channels are persisted to channels.json inside the data directory.
//
// Usage:
//
//	ubersdr-packet -url ws://sdr.example.com/ws \
//	               -listen :6089 \
//	               -data /data
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envIntOr(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// ---------------------------------------------------------------------------
// channelConfig — one entry in channels.json
// ---------------------------------------------------------------------------

type channelConfig struct {
	ID              string   `json:"id"`
	FreqHz          int      `json:"freq_hz"`
	Mode            string   `json:"mode"`
	Name            string   `json:"name,omitempty"`
	BandwidthHz     int      `json:"bandwidth_hz,omitempty"`
	SMConfig        SMConfig `json:"modem_config"`
	MQTTTopicPrefix string   `json:"mqtt_topic_prefix,omitempty"`
}

// ---------------------------------------------------------------------------
// packetChannel — one live audio+modem channel
// ---------------------------------------------------------------------------

type packetChannel struct {
	inst       *instance
	decoder    *SoundModemDecoder
	label      string
	channelID  string
	resultChan chan []byte
	audioChan  chan AudioSample

	mu              sync.Mutex
	smCfg           SMConfig
	mqttTopicPrefix string
	name            string // custom display name (empty = use label)

	// Audio tap — fan-out raw PCM bytes to preview listeners.
	tapMu   sync.RWMutex
	tapSubs map[chan []byte]struct{}
}

func newPacketChannel(inst *instance, cfg SMConfig, channelID, mqttTopicPrefix, name string) *packetChannel {
	return &packetChannel{
		inst:            inst,
		label:           inst.label,
		channelID:       channelID,
		resultChan:      make(chan []byte, 256),
		audioChan:       make(chan AudioSample, 1024),
		smCfg:           cfg,
		mqttTopicPrefix: mqttTopicPrefix,
		name:            name,
		tapSubs:         make(map[chan []byte]struct{}),
	}
}

// tapSubscribe registers a channel to receive copies of raw PCM bytes.
func (pc *packetChannel) tapSubscribe() chan []byte {
	ch := make(chan []byte, 128)
	pc.tapMu.Lock()
	pc.tapSubs[ch] = struct{}{}
	pc.tapMu.Unlock()
	return ch
}

// tapUnsubscribe removes a previously registered tap channel.
func (pc *packetChannel) tapUnsubscribe(ch chan []byte) {
	pc.tapMu.Lock()
	delete(pc.tapSubs, ch)
	pc.tapMu.Unlock()
}

// tapBroadcast sends a copy of raw PCM bytes to all tap subscribers.
func (pc *packetChannel) tapBroadcast(pcmBytes []byte) {
	pc.tapMu.RLock()
	defer pc.tapMu.RUnlock()
	for ch := range pc.tapSubs {
		cp := make([]byte, len(pcmBytes))
		copy(cp, pcmBytes)
		select {
		case ch <- cp:
		default: // drop if listener is slow
		}
	}
}

// start launches the UberSDR connection and the QtSoundModem decoder.
func (pc *packetChannel) start(ctx context.Context, hub *sseHub, mq *mqttClient) error {
	// startModem creates a fresh SoundModemDecoder and starts it.
	// Returns the decoder so the caller can watch its CrashChan.
	startModem := func() (*SoundModemDecoder, error) {
		pc.mu.Lock()
		cfg := pc.smCfg
		pc.mu.Unlock()

		d, err := NewSoundModemDecoder(cfg)
		if err != nil {
			return nil, err
		}
		if err := d.Start(pc.audioChan, pc.resultChan); err != nil {
			return nil, err
		}
		pc.mu.Lock()
		pc.decoder = d
		pc.mu.Unlock()
		return d, nil
	}

	decoder, err := startModem()
	if err != nil {
		return fmt.Errorf("create decoder: %w", err)
	}

	// Forward decoded frames to the SSE hub and optionally MQTT.
	// Restarts the modem with exponential backoff if it crashes.
	go func() {
		retries := 0
		const maxBackoff = 60 * time.Second
		for {
			select {
			case <-ctx.Done():
				return
			case frame, ok := <-pc.resultChan:
				if !ok {
					return
				}
				hub.broadcast(pc.channelID, frame)
				// Publish raw KISS frame to MQTT if a topic prefix is set.
				if mq != nil && pc.mqttTopicPrefix != "" {
					topic := pc.mqttTopicPrefix + "/" + pc.label
					mq.Publish(topic, frame)
				}
			case crashErr := <-decoder.CrashChan():
				log.Printf("[%s] modem crashed: %v — restarting…", pc.label, crashErr)
				hub.broadcastError(pc.channelID, fmt.Sprintf("modem crashed: %v", crashErr))

				retries++
				backoff := time.Duration(1<<uint(retries)) * time.Second
				if backoff > maxBackoff {
					backoff = maxBackoff
				}
				log.Printf("[%s] modem restart in %.0fs (attempt %d)…", pc.label, backoff.Seconds(), retries)

				select {
				case <-ctx.Done():
					return
				case <-time.After(backoff):
				}

				var restartErr error
				decoder, restartErr = startModem()
				if restartErr != nil {
					log.Printf("[%s] modem restart failed: %v", pc.label, restartErr)
					// Keep retrying — loop will hit CrashChan again on next iteration
					// but decoder is nil; sleep briefly to avoid tight loop.
					select {
					case <-ctx.Done():
						return
					case <-time.After(backoff):
					}
					continue
				}
				log.Printf("[%s] modem restarted successfully", pc.label)
				retries = 0 // reset backoff on successful restart
			}
		}
	}()

	// Feed PCM from the UberSDR instance into the modem and any preview taps.
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case pcmBytes, ok := <-pc.inst.AudioCh:
				if !ok {
					return
				}
				// Fan-out raw bytes to any audio preview listeners.
				pc.tapBroadcast(pcmBytes)
				// Convert []byte (S16LE) to []int16 for the modem.
				samples := bytesToInt16(pcmBytes)
				select {
				case pc.audioChan <- AudioSample{PCMData: samples}:
				default:
					// Drop if modem is behind
				}
			}
		}
	}()

	// Start the UberSDR connection loop.
	go pc.inst.start(ctx)

	return nil
}

func (pc *packetChannel) stop() {
	pc.inst.stop()
	if pc.decoder != nil {
		_ = pc.decoder.Stop()
	}
}

// restartModem stops the current SoundModemDecoder and starts a fresh one
// using the current smCfg. Called after a modem_config PATCH.
func (pc *packetChannel) restartModem() {
	pc.mu.Lock()
	old := pc.decoder
	pc.mu.Unlock()

	if old != nil {
		_ = old.Stop()
	}

	pc.mu.Lock()
	cfg := pc.smCfg
	pc.mu.Unlock()

	d, err := NewSoundModemDecoder(cfg)
	if err != nil {
		log.Printf("[%s] restartModem: create: %v", pc.label, err)
		return
	}
	if err := d.Start(pc.audioChan, pc.resultChan); err != nil {
		log.Printf("[%s] restartModem: start: %v", pc.label, err)
		return
	}
	pc.mu.Lock()
	pc.decoder = d
	pc.mu.Unlock()
	log.Printf("[%s] modem restarted (config updated)", pc.label)
}

func (pc *packetChannel) getSMConfig() SMConfig {
	pc.mu.Lock()
	defer pc.mu.Unlock()
	return pc.smCfg
}

// bytesToInt16 reinterprets a []byte (S16LE) as []int16.
func bytesToInt16(b []byte) []int16 {
	n := len(b) / 2
	if n == 0 {
		return nil
	}
	out := make([]int16, n)
	for i := 0; i < n; i++ {
		out[i] = int16(b[i*2]) | int16(b[i*2+1])<<8
	}
	return out
}

// ---------------------------------------------------------------------------
// channelManager
// ---------------------------------------------------------------------------

type channelManager struct {
	mu         sync.RWMutex
	wg         sync.WaitGroup
	channels   []*packetChannel
	ubersdrURL string
	password   string
	hub        *sseHub
	mq         *mqttClient
	ctx        context.Context
	configPath string
}

func newChannelManager(ctx context.Context, ubersdrURL, password string, hub *sseHub, mq *mqttClient, configPath string) *channelManager {
	return &channelManager{
		ubersdrURL: ubersdrURL,
		password:   password,
		hub:        hub,
		mq:         mq,
		ctx:        ctx,
		configPath: configPath,
	}
}

func (m *channelManager) add(freqHz int, mode, name, channelID string, bwHz int, smCfg SMConfig, mqttTopicPrefix string) (*packetChannel, error) {
	label := name
	if label == "" {
		label = fmt.Sprintf("%d_%s", freqHz, mode)
	}
	if channelID == "" {
		channelID = uuid.New().String()
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	for _, ch := range m.channels {
		if ch.label == label {
			return nil, fmt.Errorf("channel %q already exists", label)
		}
	}

	smCfg.SampleRate = 0 // will be set from stream on first packet

	inst := newInstance(freqHz, 0, mode, m.ubersdrURL, m.password, name, bwHz)
	pc := newPacketChannel(inst, smCfg, channelID, mqttTopicPrefix, name)

	if err := pc.start(m.ctx, m.hub, m.mq); err != nil {
		return nil, fmt.Errorf("start channel: %w", err)
	}

	m.channels = append(m.channels, pc)
	log.Printf("[manager] added channel %s (id %s)", label, channelID[:8])
	return pc, nil
}

func (m *channelManager) remove(label string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, ch := range m.channels {
		if ch.label == label {
			ch.stop()
			m.channels = append(m.channels[:i], m.channels[i+1:]...)
			log.Printf("[manager] removed channel %s", label)
			return nil
		}
	}
	return fmt.Errorf("channel %q not found", label)
}

func (m *channelManager) list() []*packetChannel {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*packetChannel, len(m.channels))
	copy(out, m.channels)
	return out
}

func (m *channelManager) get(label string) *packetChannel {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, ch := range m.channels {
		if ch.label == label {
			return ch
		}
	}
	return nil
}

func (m *channelManager) save() {
	if m.configPath == "" {
		return
	}
	m.mu.RLock()
	cfgs := make([]channelConfig, 0, len(m.channels))
	for _, ch := range m.channels {
		ch.mu.Lock()
		name := ch.name
		mqttPrefix := ch.mqttTopicPrefix
		ch.mu.Unlock()
		// Fall back to label-derived name if no explicit name is set.
		if name == "" {
			autoLabel := fmt.Sprintf("%d_%s", ch.inst.freqHz, ch.inst.audioMode)
			if ch.label != autoLabel {
				name = ch.label
			}
		}
		cfgs = append(cfgs, channelConfig{
			ID:              ch.channelID,
			FreqHz:          ch.inst.freqHz,
			Mode:            ch.inst.audioMode,
			Name:            name,
			BandwidthHz:     ch.inst.getBandwidth(),
			SMConfig:        ch.getSMConfig(),
			MQTTTopicPrefix: mqttPrefix,
		})
	}
	m.mu.RUnlock()

	data, err := json.MarshalIndent(cfgs, "", "  ")
	if err != nil {
		log.Printf("[manager] save: marshal: %v", err)
		return
	}
	tmp := m.configPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		log.Printf("[manager] save: write: %v", err)
		return
	}
	if err := os.Rename(tmp, m.configPath); err != nil {
		log.Printf("[manager] save: rename: %v", err)
		return
	}
	log.Printf("[manager] saved %d channel(s)", len(cfgs))
}

func (m *channelManager) load() {
	if m.configPath == "" {
		return
	}
	data, err := os.ReadFile(m.configPath)
	if os.IsNotExist(err) {
		log.Printf("[manager] no channels.json — starting empty")
		return
	}
	if err != nil {
		log.Printf("[manager] load: %v", err)
		return
	}
	var cfgs []channelConfig
	if err := json.Unmarshal(data, &cfgs); err != nil {
		log.Printf("[manager] load: parse: %v", err)
		return
	}
	for _, cfg := range cfgs {
		if _, err := m.add(cfg.FreqHz, cfg.Mode, cfg.Name, cfg.ID, cfg.BandwidthHz, cfg.SMConfig, cfg.MQTTTopicPrefix); err != nil {
			log.Printf("[manager] load: %v", err)
		}
	}
	log.Printf("[manager] loaded %d channel(s)", len(cfgs))
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

func main() {
	var (
		ubersdrURL = flag.String("url", envOr("UBERSDR_URL", ""), "UberSDR WebSocket URL (env: UBERSDR_URL)")
		password   = flag.String("password", envOr("UBERSDR_PASS", ""), "UberSDR password (env: UBERSDR_PASS)")
		listenAddr = flag.String("listen", ":"+envOr("WEB_PORT", "6089"), "HTTP listen address (env: WEB_PORT)")
		dataDir    = flag.String("data", envOr("DATA_DIR", "./data"), "Data directory for channels.json (env: DATA_DIR)")
		uiPassword = flag.String("ui-password", envOr("UI_PASSWORD", ""),
			"Password for write actions in the web UI (env: UI_PASSWORD)")
		replayBuf = flag.Int("replay-buf", envIntOr("REPLAY_BUF_SIZE", 200),
			"Number of recent AX.25 frames buffered per channel for late-joining browsers (env: REPLAY_BUF_SIZE)")
		// MQTT flags
		mqttBroker        = flag.String("mqtt-broker", envOr("MQTT_BROKER", ""), "MQTT broker URL, e.g. tcp://host:1883 or ssl://host:8883 (env: MQTT_BROKER)")
		mqttUser          = flag.String("mqtt-user", envOr("MQTT_USER", ""), "MQTT username (env: MQTT_USER)")
		mqttPass          = flag.String("mqtt-pass", envOr("MQTT_PASS", ""), "MQTT password (env: MQTT_PASS)")
		mqttTLSSkipVerify = flag.Bool("mqtt-tls-skip-verify", envOr("MQTT_TLS_SKIP_VERIFY", "") == "true", "Skip TLS certificate verification for MQTT (env: MQTT_TLS_SKIP_VERIFY)")
	)
	flag.Parse()

	if *ubersdrURL == "" {
		fmt.Fprintln(os.Stderr, "error: -url (or UBERSDR_URL env) is required")
		flag.Usage()
		os.Exit(1)
	}

	if err := os.MkdirAll(*dataDir, 0o755); err != nil {
		log.Fatalf("[main] create data dir: %v", err)
	}

	configPath := filepath.Join(*dataDir, "channels.json")

	log.Printf("[main] ubersdr-packet starting")
	log.Printf("[main] UberSDR URL:  %s", *ubersdrURL)
	log.Printf("[main] Listen addr:  %s", *listenAddr)
	log.Printf("[main] Data dir:     %s", *dataDir)

	// Connect to MQTT broker if configured.
	// newMQTTClient connects asynchronously with exponential backoff so the
	// process starts immediately even if the broker isn't reachable yet.
	var mq *mqttClient
	if *mqttBroker != "" {
		log.Printf("[main] MQTT broker:  %s", *mqttBroker)
		mq = newMQTTClient(MQTTConfig{
			Broker:        *mqttBroker,
			Username:      *mqttUser,
			Password:      *mqttPass,
			TLSSkipVerify: *mqttTLSSkipVerify,
		})
		defer mq.Close()
	}

	hub := newSSEHub(*replayBuf)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mqttConfigured := *mqttBroker != ""
	mgr := newChannelManager(ctx, *ubersdrURL, *password, hub, mq, configPath)
	mgr.load()

	go func() {
		if err := startHTTPServer(*listenAddr, mgr, hub, *uiPassword, mqttConfigured); err != nil {
			log.Fatalf("[main] HTTP server: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig

	log.Printf("[main] shutting down…")
	cancel()
	mgr.wg.Wait()
	log.Printf("[main] done")
}
