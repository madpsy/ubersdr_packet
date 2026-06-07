// ubersdr.go — Connect to an UberSDR WebSocket stream and receive demodulated
// PCM audio.  Delivers decoded mono S16LE PCM chunks on AudioCh.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const rcvBufSize = 16 * 1024 * 1024 // 16 MiB SO_RCVBUF

var wsDialer = &websocket.Dialer{
	HandshakeTimeout: 10 * time.Second,
	NetDialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		nd := &net.Dialer{}
		conn, err := nd.DialContext(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		if tc, ok := conn.(*net.TCPConn); ok {
			raw, err := tc.SyscallConn()
			if err == nil {
				_ = raw.Control(func(fd uintptr) {
					_ = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF, rcvBufSize)
				})
			}
		}
		return conn, nil
	},
}

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

type connectionCheckRequest struct {
	UserSessionID string `json:"user_session_id"`
	Password      string `json:"password,omitempty"`
}

type connectionCheckResponse struct {
	Allowed        bool     `json:"allowed"`
	Reason         string   `json:"reason,omitempty"`
	ClientIP       string   `json:"client_ip,omitempty"`
	Bypassed       bool     `json:"bypassed"`
	AllowedIQModes []string `json:"allowed_iq_modes,omitempty"`
	MaxSessionTime int      `json:"max_session_time"`
}

type wsMessage struct {
	Type      string `json:"type"`
	Error     string `json:"error,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	Frequency int    `json:"frequency,omitempty"`
	Mode      string `json:"mode,omitempty"`
}

// ---------------------------------------------------------------------------
// instance — one UberSDR channel connection
// ---------------------------------------------------------------------------

type instance struct {
	freqHz      int
	carrierHz   int
	audioMode   string
	label       string
	bandwidthHz int

	ubersdrURL string
	password   string
	sessionID  string

	mu            sync.Mutex
	running       bool
	startedAt     time.Time
	reconnections int
	status        string

	streamMu         sync.RWMutex
	streamSampleRate int
	streamChannels   int

	// AudioCh delivers decoded mono S16LE PCM chunks.
	AudioCh chan []byte
}

func newInstance(freqHz, carrierHz int, audioMode, ubersdrURL, password, labelOverride string, bandwidthHz int) *instance {
	label := labelOverride
	if label == "" {
		label = fmt.Sprintf("%d_%s", freqHz, audioMode)
	}
	log.Printf("[%s] freq %d Hz (%s)", label, freqHz, audioMode)
	return &instance{
		freqHz:      freqHz,
		carrierHz:   carrierHz,
		audioMode:   audioMode,
		label:       label,
		bandwidthHz: bandwidthHz,
		ubersdrURL:  ubersdrURL,
		password:    password,
		sessionID:   uuid.New().String(),
		status:      "stopped",
		AudioCh:     make(chan []byte, 256),
	}
}

func (inst *instance) setBandwidth(hz int) {
	inst.mu.Lock()
	inst.bandwidthHz = hz
	inst.mu.Unlock()
}

func (inst *instance) getBandwidth() int {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	return inst.bandwidthHz
}

func (inst *instance) httpBase() string {
	u, _ := url.Parse(inst.ubersdrURL)
	scheme := u.Scheme
	switch scheme {
	case "ws":
		scheme = "http"
	case "wss":
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s", scheme, u.Host)
}

func bandwidthParams(mode string, bwHz int) (low, high int) {
	if bwHz <= 0 {
		return 0, 0
	}
	switch strings.ToLower(mode) {
	case "usb":
		low = 300
		high = bwHz
		if high < low {
			high = low + 1
		}
	case "lsb":
		low = -bwHz
		high = -300
		if low > high {
			low = high - 1
		}
	case "cw":
		half := bwHz / 2
		low = -half
		high = half
	default:
		half := bwHz / 2
		low = -half
		high = half
	}
	return low, high
}

func (inst *instance) wsURL() string {
	u, _ := url.Parse(inst.ubersdrURL)
	wsScheme := "ws"
	if u.Scheme == "https" || u.Scheme == "wss" {
		wsScheme = "wss"
	}
	path := strings.TrimRight(u.Path, "/")
	if path == "" {
		path = "/ws"
	}
	dialHz := inst.freqHz - inst.carrierHz
	q := url.Values{}
	q.Set("frequency", fmt.Sprintf("%d", dialHz))
	q.Set("mode", inst.audioMode)
	q.Set("format", "pcm-zstd")
	q.Set("version", "2")
	q.Set("user_session_id", inst.sessionID)
	if inst.password != "" {
		q.Set("password", inst.password)
	}
	inst.mu.Lock()
	bwHz := inst.bandwidthHz
	inst.mu.Unlock()
	if bwHz > 0 {
		low, high := bandwidthParams(inst.audioMode, bwHz)
		q.Set("bandwidthLow", fmt.Sprintf("%d", low))
		q.Set("bandwidthHigh", fmt.Sprintf("%d", high))
	}
	return fmt.Sprintf("%s://%s%s?%s", wsScheme, u.Host, path, q.Encode())
}

func (inst *instance) checkConnection() (bool, error) {
	endpoint := inst.httpBase() + "/connection"
	body, _ := json.Marshal(connectionCheckRequest{
		UserSessionID: inst.sessionID,
		Password:      inst.password,
	})
	req, err := http.NewRequest("POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "ubersdr-packet/1.0")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("[%s] connection check failed (%v), attempting anyway", inst.label, err)
		return true, nil
	}
	defer resp.Body.Close()

	var cr connectionCheckResponse
	if err := json.NewDecoder(resp.Body).Decode(&cr); err != nil {
		return false, fmt.Errorf("decode /connection response: %w", err)
	}
	if !cr.Allowed {
		return false, fmt.Errorf("server rejected connection: %s", cr.Reason)
	}
	log.Printf("[%s] connection allowed (IP: %s, bypassed: %v, max session: %ds)",
		inst.label, cr.ClientIP, cr.Bypassed, cr.MaxSessionTime)
	return true, nil
}

func (inst *instance) runOnce(ctx context.Context) (reconnect bool) {
	inst.mu.Lock()
	inst.sessionID = uuid.New().String()
	inst.mu.Unlock()

	allowed, err := inst.checkConnection()
	if err != nil {
		log.Printf("[%s] error: %v", inst.label, err)
		return true
	}
	if !allowed {
		return false
	}

	wsAddr := inst.wsURL()
	log.Printf("[%s] connecting to %s", inst.label, wsAddr)

	hdr := http.Header{}
	hdr.Set("User-Agent", "ubersdr-packet/1.0")
	conn, _, err := wsDialer.Dial(wsAddr, hdr)
	if err != nil {
		log.Printf("[%s] websocket dial: %v", inst.label, err)
		return true
	}
	defer conn.Close()

	log.Printf("[%s] connected — freq=%d Hz, mode=%s", inst.label, inst.freqHz, inst.audioMode)

	dec, err := newPCMDecoder()
	if err != nil {
		log.Printf("[%s] decoder init: %v", inst.label, err)
		return false
	}
	defer dec.close()

	localCtx, localCancel := context.WithCancel(ctx)
	defer localCancel()

	// Keepalive
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-localCtx.Done():
				return
			case <-ticker.C:
				if err := conn.WriteJSON(map[string]string{"type": "ping"}); err != nil {
					return
				}
			}
		}
	}()

	// Context watcher
	go func() {
		select {
		case <-ctx.Done():
			conn.Close()
		case <-localCtx.Done():
		}
	}()

	var totalPackets atomic.Int64
	firstPacket := true

	inst.mu.Lock()
	inst.status = "running"
	inst.startedAt = time.Now()
	inst.mu.Unlock()

	for {
		inst.mu.Lock()
		running := inst.running
		inst.mu.Unlock()
		if !running {
			return false
		}

		msgType, msg, err := conn.ReadMessage()
		if err != nil {
			if ctx.Err() != nil {
				return false
			}
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				log.Printf("[%s] server closed connection", inst.label)
			} else {
				log.Printf("[%s] read error: %v", inst.label, err)
			}
			return true
		}

		switch msgType {
		case websocket.BinaryMessage:
			pkt, err := dec.decode(msg, true)
			if err != nil {
				log.Printf("[%s] decode: %v", inst.label, err)
				continue
			}
			if len(pkt.pcm) == 0 {
				continue
			}
			if firstPacket {
				log.Printf("[%s] receiving audio: %d Hz, %d channel(s)", inst.label, pkt.sampleRate, pkt.channels)
				firstPacket = false
				inst.streamMu.Lock()
				inst.streamSampleRate = pkt.sampleRate
				inst.streamChannels = pkt.channels
				inst.streamMu.Unlock()
			}

			totalPackets.Add(1)

			// Downmix stereo to mono
			pcmData := pkt.pcm
			if pkt.channels == 2 {
				pcmData = downmixStereoToMono(pcmData)
			}

			select {
			case inst.AudioCh <- pcmData:
			default:
				// Drop if consumer is behind
			}

		case websocket.TextMessage:
			var m wsMessage
			if err := json.Unmarshal(msg, &m); err != nil {
				continue
			}
			switch m.Type {
			case "error":
				log.Printf("[%s] server error: %s", inst.label, m.Error)
				return true
			case "status":
				log.Printf("[%s] status: session=%s freq=%d mode=%s",
					inst.label, m.SessionID, m.Frequency, m.Mode)
			}
		}
	}
}

func (inst *instance) start(ctx context.Context) {
	inst.mu.Lock()
	inst.running = true
	inst.status = "reconnecting"
	inst.mu.Unlock()

	retries := 0
	maxBackoff := 60 * time.Second

	for {
		inst.mu.Lock()
		running := inst.running
		inst.mu.Unlock()
		if !running {
			break
		}
		select {
		case <-ctx.Done():
			return
		default:
		}

		inst.mu.Lock()
		inst.status = "reconnecting"
		inst.mu.Unlock()

		reconnect := inst.runOnce(ctx)

		inst.mu.Lock()
		running = inst.running
		inst.mu.Unlock()

		if !reconnect || !running {
			break
		}

		select {
		case <-ctx.Done():
			return
		default:
		}

		retries++
		backoff := time.Duration(1<<uint(retries)) * time.Second
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
		inst.mu.Lock()
		inst.reconnections++
		inst.mu.Unlock()
		log.Printf("[%s] reconnecting in %.0fs (attempt %d)…", inst.label, backoff.Seconds(), retries)

		timer := time.NewTimer(backoff)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return
		}
	}

	inst.mu.Lock()
	inst.status = "stopped"
	inst.mu.Unlock()
	log.Printf("[%s] stopped", inst.label)
}

func (inst *instance) stop() {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	inst.running = false
}

func (inst *instance) statusSnapshot() map[string]interface{} {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	inst.streamMu.RLock()
	sr := inst.streamSampleRate
	ch := inst.streamChannels
	inst.streamMu.RUnlock()
	return map[string]interface{}{
		"freq_hz":       inst.freqHz,
		"audio_mode":    inst.audioMode,
		"label":         inst.label,
		"status":        inst.status,
		"started_at":    inst.startedAt,
		"reconnections": inst.reconnections,
		"sample_rate":   sr,
		"channels":      ch,
		"bandwidth_hz":  inst.bandwidthHz,
	}
}

