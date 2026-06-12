// main.go — ubersdr-packet: multi-channel AX.25 packet decoder
//
// Each "audio channel" connects to UberSDR at a given frequency/mode and
// feeds the decoded PCM into a QtSoundModem instance.  QtSoundModem supports
// up to 4 simultaneous modem sub-channels (A/B/C/D) per audio channel.
//
// Channels are persisted to channels.json inside the data directory.
//
// Configuration is via environment variables (preferred) or CLI flags (both
// are supported simultaneously; CLI flags take precedence over env vars).
//
// Environment variables:
//
//	UBERSDR_URL           UberSDR WebSocket URL (required)
//	UBERSDR_PASS          UberSDR bypass password
//	UI_PASSWORD           Password for write actions in the web UI
//	WEB_PORT              HTTP listen port (default: 6089)
//	DATA_DIR              Directory for channels.json (default: /data)
//	REPLAY_BUF_SIZE       AX.25 frames buffered per channel for late-joining
//	                      browsers (default: 200)
//	MQTT_BROKER           MQTT broker URL, e.g. tcp://host:1883
//	MQTT_USER             MQTT username
//	MQTT_PASS             MQTT password
//	MQTT_TLS_SKIP_VERIFY  Set to "true" to skip TLS certificate verification
//	MQTT_TOPIC_PREFIX     Default MQTT topic prefix (default: "ubersdr")
//
// Equivalent CLI flags (run with -help for full list):
//
//	ubersdr-packet -url ws://sdr.example.com/ws \
//	               -listen :6089 \
//	               -data /data
package main

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
)

// ---------------------------------------------------------------------------
// SNR helpers
// ---------------------------------------------------------------------------

// snrRingSize is the number of SNR samples kept in the timestamped ring buffer.
// At ~20 ms per v2 packet, 100 samples ≈ 2 seconds — enough headroom for the
// 500 ms lookback window used by takePendingSNR.
const snrRingSize = 100

// snrLookback is the window used when averaging SNR for a decoded frame.
// The AGW monitor frame fires after full decode, so we look back this far
// to capture the samples that arrived during the transmission.
const snrLookback = 500 * time.Millisecond

// snrSample is one timestamped SNR measurement from an UberSDR v2 packet.
type snrSample struct {
	t   time.Time
	snr float32
}

// ---------------------------------------------------------------------------
// Frame store — server-side ring buffer of decoded AX.25 frames
// ---------------------------------------------------------------------------

// frameStoreSize is the maximum number of decoded frames kept per channel.
const frameStoreSize = 1000

// storedFrame is one decoded AX.25 frame with metadata, ready for JSON.
type storedFrame struct {
	ReceivedAt time.Time `json:"received_at"`
	SmCh       int       `json:"sm_ch"`      // modem sub-channel (0–3)
	SNR        *float32  `json:"snr"`        // nil when unavailable
	From       string    `json:"from"`       // source callsign
	To         string    `json:"to"`         // destination callsign
	Via        []string  `json:"via"`        // digipeater path
	FrameType  string    `json:"frame_type"` // "ui", "aprs", "i", etc.
	Info       string    `json:"info"`       // decoded description
	InfoRaw    string    `json:"info_raw"`   // raw payload text
	HexRaw     string    `json:"hex_raw"`    // full AX.25 frame as hex
}

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

	// SNR tracking — all fields guarded by snrMu.
	snrMu     sync.Mutex
	snrRing   [snrRingSize]snrSample // circular buffer of timestamped SNR samples
	snrHead   int                    // next write position
	snrFilled int                    // number of valid entries (0..snrRingSize)

	// Frame store — server-side ring buffer of decoded frames for the REST API.
	frameMu sync.RWMutex
	frames  []storedFrame // circular ring, len grows to frameStoreSize then wraps
	frameW  int           // next write index
}

func newPacketChannel(inst *instance, cfg SMConfig, channelID, mqttTopicPrefix, name string) *packetChannel {
	pc := &packetChannel{
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
	return pc
}

// pushSNR records a new timestamped SNR sample into the ring buffer.
func (pc *packetChannel) pushSNR(snr float32) {
	if math.IsNaN(float64(snr)) {
		return
	}
	pc.snrMu.Lock()
	defer pc.snrMu.Unlock()
	pc.snrRing[pc.snrHead] = snrSample{t: time.Now(), snr: snr}
	pc.snrHead = (pc.snrHead + 1) % snrRingSize
	if pc.snrFilled < snrRingSize {
		pc.snrFilled++
	}
}

// takePendingSNR returns the linear-domain average of SNR samples received
// within the last snrLookback window. Returns NaN if no samples are available.
// The AGW monitor frame fires after full decode, so looking back 500 ms
// captures the samples that arrived during the transmission.
func (pc *packetChannel) takePendingSNR() float32 {
	pc.snrMu.Lock()
	defer pc.snrMu.Unlock()
	if pc.snrFilled == 0 {
		return float32(math.NaN())
	}
	cutoff := time.Now().Add(-snrLookback)
	var sum float64
	var count int
	// Iterate from newest to oldest (head-1 backwards)
	for i := 0; i < pc.snrFilled; i++ {
		idx := (pc.snrHead - 1 - i + snrRingSize) % snrRingSize
		s := pc.snrRing[idx]
		if s.t.Before(cutoff) {
			break // ring is time-ordered; stop once we're past the window
		}
		sum += math.Pow(10, float64(s.snr)/10)
		count++
	}
	if count == 0 {
		return float32(math.NaN())
	}
	return float32(10 * math.Log10(sum/float64(count)))
}

// ---------------------------------------------------------------------------
// Frame store methods
// ---------------------------------------------------------------------------

// ax25CallStr decodes a 7-byte AX.25 address field into a callsign string.
func ax25CallStr(b []byte) string {
	if len(b) < 7 {
		return ""
	}
	var call [6]byte
	n := 0
	for i := 0; i < 6; i++ {
		ch := b[i] >> 1
		if ch != 0x20 && ch != 0x00 {
			call[n] = ch
			n++
		}
	}
	ssid := (b[6] >> 1) & 0x0F
	s := strings.TrimRight(string(call[:n]), " ")
	if ssid > 0 {
		s = fmt.Sprintf("%s-%d", s, ssid)
	}
	return s
}

// parseAX25Addrs extracts from, to, and digipeater callsigns from a raw AX.25
// frame. Returns empty strings on malformed input.
func parseAX25Addrs(ax25 []byte) (from, to string, via []string) {
	if len(ax25) < 14 {
		return "", "", nil
	}
	to = ax25CallStr(ax25[0:7])
	from = ax25CallStr(ax25[7:14])
	offset := 14
	// H-bit (LSB of SSID byte) set on src means no digipeaters follow
	for offset+7 <= len(ax25) {
		digi := ax25CallStr(ax25[offset : offset+7])
		hBit := (ax25[offset+6] & 0x80) != 0
		actioned := hBit
		if actioned {
			digi += "*"
		}
		via = append(via, digi)
		isLast := (ax25[offset+6] & 0x01) != 0
		offset += 7
		if isLast {
			break
		}
	}
	return from, to, via
}

// storeFrame parses a MsgPacket wire frame and appends it to the ring buffer.
// frame layout: [MsgPacket][kissPort][snr:4 LE float32][frameLen:4 BE uint32][ax25...]
func (pc *packetChannel) storeFrame(frame []byte, receivedAt time.Time) *storedFrame {
	if len(frame) < 10 || frame[0] != MsgPacket {
		return nil
	}
	smCh := int(frame[1])
	snrBits := binary.LittleEndian.Uint32(frame[2:6])
	snrVal := math.Float32frombits(snrBits)
	frameLen := binary.BigEndian.Uint32(frame[6:10])
	if uint32(len(frame)) < 10+frameLen {
		return nil
	}
	ax25 := frame[10 : 10+frameLen]

	from, to, via := parseAX25Addrs(ax25)
	if via == nil {
		via = []string{}
	}

	var snrPtr *float32
	if !math.IsNaN(float64(snrVal)) {
		v := snrVal
		snrPtr = &v
	}

	sf := storedFrame{
		ReceivedAt: receivedAt,
		SmCh:       smCh,
		SNR:        snrPtr,
		From:       from,
		To:         to,
		Via:        via,
		HexRaw:     hex.EncodeToString(ax25),
	}

	// Minimal frame-type detection from control byte (after address field).
	// Full decoding happens in the browser; here we just need enough for filtering.
	addrEnd := 14
	for addrEnd+7 <= len(ax25) {
		if (ax25[addrEnd-1] & 0x01) != 0 {
			break
		}
		addrEnd += 7
	}
	if addrEnd < len(ax25) {
		ctrl := ax25[addrEnd]
		ctrlNoPF := ctrl & ^byte(0x10)
		switch {
		case ctrl&0x01 == 0:
			sf.FrameType = "i"
		case ctrl&0x03 == 0x01:
			sf.FrameType = "s"
		case ctrlNoPF == 0x03: // UI
			sf.FrameType = "ui"
			// Check PID for APRS (0xF0 = no layer 3)
			pidOff := addrEnd + 1
			if pidOff < len(ax25) && ax25[pidOff] == 0xF0 {
				sf.FrameType = "aprs"
				infoOff := pidOff + 1
				if infoOff < len(ax25) {
					sf.InfoRaw = strings.Map(func(r rune) rune {
						if r < 0x20 && r != '\r' && r != '\n' {
							return -1
						}
						return r
					}, string(ax25[infoOff:]))
					sf.Info = sf.InfoRaw
				}
			}
		default:
			sf.FrameType = "u"
		}
	}

	pc.frameMu.Lock()
	if len(pc.frames) < frameStoreSize {
		pc.frames = append(pc.frames, sf)
	} else {
		pc.frames[pc.frameW] = sf
		pc.frameW = (pc.frameW + 1) % frameStoreSize
	}
	pc.frameMu.Unlock()

	// Accumulate lifetime statistics (never evicted, unlike the ring buffer).
	globalStats.Record(pc.label, sf.From, sf.To, sf.FrameType, sf.SmCh, sf.SNR, sf.ReceivedAt)
	return &sf
}

// queryFrames returns stored frames matching the given filters.
// smCh < 0 means all sub-channels. limit <= 0 means return all matching.
// from/to are case-insensitive prefix matches (empty = no filter).
// fromExact/toExact are case-insensitive exact matches (empty = no filter).
// search is a case-insensitive substring match against from, to, via, info, infoRaw (empty = no filter).
// Results are returned newest-first.
func (pc *packetChannel) queryFrames(smCh, limit int, from, to, fromExact, toExact, search string) []storedFrame {
	pc.frameMu.RLock()
	n := len(pc.frames)
	// Build ordered slice: oldest→newest
	ordered := make([]storedFrame, n)
	if n < frameStoreSize || pc.frameW == 0 {
		copy(ordered, pc.frames)
	} else {
		// Ring has wrapped: frameW points to oldest entry
		copy(ordered, pc.frames[pc.frameW:])
		copy(ordered[n-pc.frameW:], pc.frames[:pc.frameW])
	}
	pc.frameMu.RUnlock()

	fromLo := strings.ToLower(from)
	toLo := strings.ToLower(to)
	fromExactLo := strings.ToLower(fromExact)
	toExactLo := strings.ToLower(toExact)
	searchLo := strings.ToLower(search)

	// Filter (newest-first traversal)
	var result []storedFrame
	for i := n - 1; i >= 0; i-- {
		f := ordered[i]
		if smCh >= 0 && f.SmCh != smCh {
			continue
		}
		if fromLo != "" && !strings.HasPrefix(strings.ToLower(f.From), fromLo) {
			continue
		}
		if toLo != "" && !strings.HasPrefix(strings.ToLower(f.To), toLo) {
			continue
		}
		if fromExactLo != "" && strings.ToLower(f.From) != fromExactLo {
			continue
		}
		if toExactLo != "" && strings.ToLower(f.To) != toExactLo {
			continue
		}
		if searchLo != "" {
			haystack := strings.ToLower(f.From + " " + f.To + " " + strings.Join(f.Via, " ") + " " + f.Info + " " + f.InfoRaw)
			if !strings.Contains(haystack, searchLo) {
				continue
			}
		}
		result = append(result, f)
		if limit > 0 && len(result) >= limit {
			break
		}
	}
	return result
}

// senderInfo summarises one unique source callsign seen in the frame store,
// broken down per modem sub-channel.
type senderInfo struct {
	Callsign     string    `json:"callsign"`
	SmCh         int       `json:"sm_ch"` // modem sub-channel (0–3)
	FrameCount   int       `json:"frame_count"`
	LastSeen     time.Time `json:"last_seen"`
	SNRAvailable bool      `json:"snr_available"` // true if at least one frame has SNR data
}

// senders returns a deduplicated list of (callsign, sm_ch) pairs seen in the
// frame store, sorted by last-seen descending (most recent first).
func (pc *packetChannel) senders() []senderInfo {
	pc.frameMu.RLock()
	frames := make([]storedFrame, len(pc.frames))
	copy(frames, pc.frames)
	pc.frameMu.RUnlock()

	type key struct {
		callsign string
		smCh     int
	}
	type agg struct {
		count    int
		lastSeen time.Time
		hasSNR   bool
	}
	m := make(map[key]*agg)
	for _, f := range frames {
		if f.From == "" {
			continue
		}
		k := key{f.From, f.SmCh}
		a := m[k]
		if a == nil {
			a = &agg{}
			m[k] = a
		}
		a.count++
		if f.ReceivedAt.After(a.lastSeen) {
			a.lastSeen = f.ReceivedAt
		}
		if f.SNR != nil {
			a.hasSNR = true
		}
	}

	result := make([]senderInfo, 0, len(m))
	for k, a := range m {
		result = append(result, senderInfo{
			Callsign:     k.callsign,
			SmCh:         k.smCh,
			FrameCount:   a.count,
			LastSeen:     a.lastSeen,
			SNRAvailable: a.hasSNR,
		})
	}
	// Sort newest last-seen first
	sort.Slice(result, func(i, j int) bool {
		return result[i].LastSeen.After(result[j].LastSeen)
	})
	return result
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
// defaultPrefix is the global MQTT topic prefix used when the channel has no
// per-channel prefix set.
func (pc *packetChannel) start(ctx context.Context, hub *sseHub, mq *mqttClient, defaultPrefix string) error {
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
		if err := d.Start(pc.audioChan, pc.resultChan, pc); err != nil {
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
				// Store decoded AX.25 frames in the server-side ring buffer.
				var sf *storedFrame
				if len(frame) >= 10 && frame[0] == MsgPacket {
					sf = pc.storeFrame(frame, time.Now())
				}
				// Publish decoded AX.25 frames to MQTT as JSON.
				// Only MsgPacket frames carry actual decoded AX.25 data;
				// MsgDCD / MsgMonitor / MsgLog are UI-only and must not be
				// forwarded to MQTT.
				// Internal wire format: [MsgPacket][kissPort][snr float32 LE][frameLen uint32 LE][ax25...]
				if mq != nil && sf != nil {
					pc.mu.Lock()
					suffix := pc.mqttTopicPrefix
					chLabel := pc.label
					pc.mu.Unlock()
					if defaultPrefix != "" {
						if suffix == "" {
							suffix = chLabel
						}
						topic := defaultPrefix + "/" + suffix
						ax25 := frame[10:]

						pc.inst.mu.Lock()
						instFreqHz := pc.inst.freqHz
						instMode := pc.inst.audioMode
						instCarrierHz := pc.inst.carrierHz
						pc.inst.mu.Unlock()

						type mqttMsg struct {
							Channel      string   `json:"channel"`
							ModemCh      int      `json:"modem_ch"`
							From         string   `json:"from"`
							To           string   `json:"to"`
							FrameType    string   `json:"frame_type"`
							SNR          *float64 `json:"snr"`
							ReceivedAt   string   `json:"received_at"`
							Frame        []byte   `json:"frame"` // base64 by encoding/json
							FreqHz       int      `json:"freq_hz"`
							Mode         string   `json:"mode"`
							FreqOffsetHz int      `json:"freq_offset_hz"`
						}
						msg := mqttMsg{
							Channel:      chLabel,
							ModemCh:      sf.SmCh,
							From:         sf.From,
							To:           sf.To,
							FrameType:    sf.FrameType,
							ReceivedAt:   sf.ReceivedAt.UTC().Format(time.RFC3339Nano),
							Frame:        ax25,
							FreqHz:       instFreqHz,
							Mode:         instMode,
							FreqOffsetHz: instCarrierHz,
						}
						if sf.SNR != nil {
							v := float64(*sf.SNR)
							msg.SNR = &v
						}
						if payload, err := json.Marshal(msg); err == nil {
							mq.Publish(topic, payload)
						}
					}
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

	// Drain SNRCh from the UberSDR instance and push samples into the ring buffer.
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case snr, ok := <-pc.inst.SNRCh:
				if !ok {
					return
				}
				pc.pushSNR(snr)
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
	if err := d.Start(pc.audioChan, pc.resultChan, pc); err != nil {
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
	mu                sync.RWMutex
	wg                sync.WaitGroup
	channels          []*packetChannel
	ubersdrURL        string
	password          string
	hub               *sseHub
	mq                *mqttClient
	mqttDefaultPrefix string // global fallback topic prefix (from MQTT_TOPIC_PREFIX env)
	ctx               context.Context
	configPath        string
}

func newChannelManager(ctx context.Context, ubersdrURL, password string, hub *sseHub, mq *mqttClient, mqttDefaultPrefix, configPath string) *channelManager {
	return &channelManager{
		ubersdrURL:        ubersdrURL,
		password:          password,
		hub:               hub,
		mq:                mq,
		mqttDefaultPrefix: mqttDefaultPrefix,
		ctx:               ctx,
		configPath:        configPath,
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

	if err := pc.start(m.ctx, m.hub, m.mq, m.mqttDefaultPrefix); err != nil {
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
		dataDir    = flag.String("data", envOr("DATA_DIR", "/data"), "Data directory for channels.json (env: DATA_DIR)")
		uiPassword = flag.String("ui-password", envOr("UI_PASSWORD", ""),
			"Password for write actions in the web UI (env: UI_PASSWORD)")
		replayBuf = flag.Int("replay-buf", envIntOr("REPLAY_BUF_SIZE", 200),
			"Number of recent AX.25 frames buffered per channel for late-joining browsers (env: REPLAY_BUF_SIZE)")
		// MQTT flags
		mqttBroker        = flag.String("mqtt-broker", envOr("MQTT_BROKER", ""), "MQTT broker URL, e.g. tcp://host:1883 or ssl://host:8883 (env: MQTT_BROKER)")
		mqttUser          = flag.String("mqtt-user", envOr("MQTT_USER", ""), "MQTT username (env: MQTT_USER)")
		mqttPass          = flag.String("mqtt-pass", envOr("MQTT_PASS", ""), "MQTT password (env: MQTT_PASS)")
		mqttTLSSkipVerify = flag.Bool("mqtt-tls-skip-verify", envOr("MQTT_TLS_SKIP_VERIFY", "") == "true", "Skip TLS certificate verification for MQTT (env: MQTT_TLS_SKIP_VERIFY)")
		mqttTopicPrefix   = flag.String("mqtt-topic-prefix", envOr("MQTT_TOPIC_PREFIX", "ubersdr"), "Default MQTT topic prefix; frames publish to <prefix>/<channel_label> (env: MQTT_TOPIC_PREFIX)")
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
	mgr := newChannelManager(ctx, *ubersdrURL, *password, hub, mq, *mqttTopicPrefix, configPath)
	mgr.load()

	go func() {
		if err := startHTTPServer(*listenAddr, mgr, hub, *uiPassword, mqttConfigured, *mqttTopicPrefix); err != nil {
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
