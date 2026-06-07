// web.go — HTTP server: embedded static files, REST API, SSE live feed.
package main

import (
	"crypto/rand"
	"embed"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html/template"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

//go:embed static
var staticFiles embed.FS

// ---------------------------------------------------------------------------
// SSE hub — fan-out with per-channel replay ring buffer
// ---------------------------------------------------------------------------

type sseEvent struct {
	channelID string
	data      []byte
}

type sseClient struct {
	ch        chan sseEvent
	channelID string // "" = subscribe to all
}

type sseHub struct {
	mu             sync.RWMutex
	clients        map[*sseClient]struct{}
	replayBufSize  int
	// replay ring buffer: channelID → circular slice of recent events
	replay  map[string][]sseEvent
	replayN map[string]int // write index (next slot to overwrite)
}

// newSSEHub creates an SSE hub with a per-channel replay ring buffer of the
// given size. Late-joining browsers will receive up to size recent AX.25
// packet frames immediately on connect. Controlled by REPLAY_BUF_SIZE env var.
func newSSEHub(replayBufSize int) *sseHub {
	if replayBufSize < 0 {
		replayBufSize = 0
	}
	return &sseHub{
		replayBufSize: replayBufSize,
		clients:       make(map[*sseClient]struct{}),
		replay:        make(map[string][]sseEvent),
		replayN:       make(map[string]int),
	}
}

// subscribe registers a new SSE client and immediately queues any buffered
// recent frames for the requested channel (or all channels if channelID=="").
func (h *sseHub) subscribe(channelID string) *sseClient {
	c := &sseClient{ch: make(chan sseEvent, h.replayBufSize+64), channelID: channelID}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	// Replay buffered frames into the new client's channel before unlocking,
	// so they arrive before any live frames that may race in.
	if channelID == "" {
		// Replay all channels in insertion order (oldest first within each ring).
		for cid, buf := range h.replay {
			n := h.replayN[cid]
			l := len(buf)
			for i := 0; i < l; i++ {
				ev := buf[(n+i)%l]
				if ev.data != nil {
					select {
					case c.ch <- ev:
					default:
					}
				}
			}
		}
	} else {
		buf := h.replay[channelID]
		n := h.replayN[channelID]
		l := len(buf)
		for i := 0; i < l; i++ {
			ev := buf[(n+i)%l]
			if ev.data != nil {
				select {
				case c.ch <- ev:
				default:
				}
			}
		}
	}
	h.mu.Unlock()
	return c
}

func (h *sseHub) unsubscribe(c *sseClient) {
	h.mu.Lock()
	delete(h.clients, c)
	h.mu.Unlock()
}

func (h *sseHub) broadcast(channelID string, data []byte) {
	ev := sseEvent{channelID: channelID, data: data}
	h.mu.Lock()
	// Store in ring buffer (only AX.25 packet frames — type byte 0x20).
	// Skip DCD (0x23), monitor (0x24), log (0x25) — those are ephemeral.
	if len(data) > 0 && data[0] == 0x20 && h.replayBufSize > 0 {
		buf := h.replay[channelID]
		if len(buf) < h.replayBufSize {
			h.replay[channelID] = append(buf, ev)
		} else {
			n := h.replayN[channelID]
			buf[n] = ev
			h.replayN[channelID] = (n + 1) % h.replayBufSize
		}
	}
	// Fan-out to live clients.
	for c := range h.clients {
		if c.channelID == "" || c.channelID == channelID {
			select {
			case c.ch <- ev:
			default:
			}
		}
	}
	h.mu.Unlock()
}

func (h *sseHub) broadcastError(channelID, msg string) {
	h.broadcast(channelID, smEncodeErrorFrame(msg))
}

// ---------------------------------------------------------------------------
// Session store — in-memory set of valid session tokens
// ---------------------------------------------------------------------------

type sessionStore struct {
	mu     sync.RWMutex
	tokens map[string]struct{}
}

func newSessionStore() *sessionStore {
	return &sessionStore{tokens: make(map[string]struct{})}
}

func (s *sessionStore) create() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("session token generation failed: " + err.Error())
	}
	tok := hex.EncodeToString(b)
	s.mu.Lock()
	s.tokens[tok] = struct{}{}
	s.mu.Unlock()
	return tok
}

func (s *sessionStore) valid(tok string) bool {
	if tok == "" {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.tokens[tok]
	return ok
}

func (s *sessionStore) delete(tok string) {
	s.mu.Lock()
	delete(s.tokens, tok)
	s.mu.Unlock()
}

const sessionCookieName = "ui_session"

// requiresAuth returns true if the request is authenticated (or no password is
// configured). Writes a 401 and returns false otherwise.
func requiresAuth(w http.ResponseWriter, r *http.Request, uiPassword string, sessions *sessionStore) bool {
	if uiPassword == "" {
		return true
	}
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || !sessions.valid(cookie.Value) {
		http.Error(w, `{"error":"authentication required"}`, http.StatusUnauthorized)
		return false
	}
	return true
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

func startHTTPServer(listenAddr string, mgr *channelManager, hub *sseHub, uiPassword string, mqttConfigured bool) error {
	sessions := newSessionStore()
	mux := http.NewServeMux()

	writeJSON := func(w http.ResponseWriter, v interface{}) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}

	// -----------------------------------------------------------------------
	// GET /api/auth/status
	// -----------------------------------------------------------------------
	mux.HandleFunc("/api/auth/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		configured := uiPassword != ""
		authed := false
		if configured {
			if cookie, err := r.Cookie(sessionCookieName); err == nil {
				authed = sessions.valid(cookie.Value)
			}
		}
		writeJSON(w, map[string]interface{}{
			"password_configured": configured,
			"authenticated":       authed,
		})
	})

	// -----------------------------------------------------------------------
	// POST /api/auth/login
	// -----------------------------------------------------------------------
	mux.HandleFunc("/api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
			return
		}
		if uiPassword == "" || body.Password == uiPassword {
			tok := sessions.create()
			http.SetCookie(w, &http.Cookie{
				Name:     sessionCookieName,
				Value:    tok,
				Path:     "/",
				HttpOnly: true,
				SameSite: http.SameSiteLaxMode,
			})
			writeJSON(w, map[string]bool{"ok": true})
		} else {
			http.Error(w, `{"error":"incorrect password"}`, http.StatusUnauthorized)
		}
	})

	// -----------------------------------------------------------------------
	// POST /api/auth/logout
	// -----------------------------------------------------------------------
	mux.HandleFunc("/api/auth/logout", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if cookie, err := r.Cookie(sessionCookieName); err == nil {
			sessions.delete(cookie.Value)
		}
		http.SetCookie(w, &http.Cookie{
			Name:     sessionCookieName,
			Value:    "",
			Path:     "/",
			MaxAge:   -1,
			HttpOnly: true,
		})
		writeJSON(w, map[string]bool{"ok": true})
	})

	// -----------------------------------------------------------------------
	// GET /api/config — server-side feature flags (e.g. MQTT configured)
	// -----------------------------------------------------------------------
	mux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, map[string]interface{}{
			"mqtt_configured": mqttConfigured,
		})
	})

	// -----------------------------------------------------------------------
	// GET /api/channels — list all channels
	// POST /api/channels — add a channel (auth required)
	// -----------------------------------------------------------------------
	mux.HandleFunc("/api/channels", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			channels := mgr.list()
			out := make([]map[string]interface{}, 0, len(channels))
			for _, ch := range channels {
				out = append(out, channelSnapshot(ch))
			}
			writeJSON(w, out)

		case http.MethodPost:
			if !requiresAuth(w, r, uiPassword, sessions) {
				return
			}
			var body struct {
				FreqHz          int      `json:"freq_hz"`
				Mode            string   `json:"mode"`
				Name            string   `json:"name"`
				BandwidthHz     int      `json:"bandwidth_hz"`
				SMConfig        SMConfig `json:"modem_config"`
				MQTTTopicPrefix string   `json:"mqtt_topic_prefix"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
				return
			}
			if body.FreqHz <= 0 {
				http.Error(w, `{"error":"freq_hz required"}`, http.StatusBadRequest)
				return
			}
			// Only USB and LSB are supported — UberSDR delivers 12 kHz mono for SSB.
			switch strings.ToLower(body.Mode) {
			case "usb", "lsb":
				body.Mode = strings.ToLower(body.Mode)
			default:
				http.Error(w, `{"error":"mode must be usb or lsb"}`, http.StatusBadRequest)
				return
			}
			// Apply defaults if no channels configured
			allDisabled := true
			for _, ch := range body.SMConfig.Channels {
				if ch.Enabled {
					allDisabled = false
					break
				}
			}
			if allDisabled {
				body.SMConfig = defaultSMConfig(0)
			}

			pc, err := mgr.add(body.FreqHz, body.Mode, body.Name, "", body.BandwidthHz, body.SMConfig, body.MQTTTopicPrefix)
			if err != nil {
				http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusConflict)
				return
			}
			mgr.save()
			w.WriteHeader(http.StatusCreated)
			writeJSON(w, channelSnapshot(pc))

		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// -----------------------------------------------------------------------
	// GET/PATCH/DELETE /api/channels/{label}
	// -----------------------------------------------------------------------
	mux.HandleFunc("/api/channels/", func(w http.ResponseWriter, r *http.Request) {
		label := strings.TrimPrefix(r.URL.Path, "/api/channels/")
		label = strings.TrimSuffix(label, "/")
		if label == "" {
			http.NotFound(w, r)
			return
		}

		switch r.Method {
		case http.MethodGet:
			ch := mgr.get(label)
			if ch == nil {
				http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
				return
			}
			writeJSON(w, channelSnapshot(ch))

		case http.MethodPatch:
			if !requiresAuth(w, r, uiPassword, sessions) {
				return
			}
			ch := mgr.get(label)
			if ch == nil {
				http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
				return
			}
			var body struct {
				SMConfig *SMConfig `json:"modem_config,omitempty"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
				return
			}
			if body.SMConfig != nil {
				ch.mu.Lock()
				ch.smCfg = *body.SMConfig
				ch.mu.Unlock()
				mgr.save()
			}
			writeJSON(w, channelSnapshot(ch))

		case http.MethodDelete:
			if !requiresAuth(w, r, uiPassword, sessions) {
				return
			}
			if err := mgr.remove(label); err != nil {
				http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusNotFound)
				return
			}
			mgr.save()
			w.WriteHeader(http.StatusNoContent)

		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// -----------------------------------------------------------------------
	// GET /api/events — SSE stream of decoded frames
	// Query params: channel_id=<id> (optional, subscribe to one channel)
	// -----------------------------------------------------------------------
	mux.HandleFunc("/api/events", func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		channelID := r.URL.Query().Get("channel_id")
		client := hub.subscribe(channelID)
		defer hub.unsubscribe(client)

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		flusher.Flush()

		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				fmt.Fprintf(w, ": heartbeat\n\n")
				flusher.Flush()
			case ev, ok := <-client.ch:
				if !ok {
					return
				}
				// Binary data encoded as base64 inside a JSON envelope.
				env := map[string]interface{}{
					"channel_id": ev.channelID,
					"data":       ev.data, // json.Marshal base64-encodes []byte
				}
				b, _ := json.Marshal(env)
				fmt.Fprintf(w, "data: %s\n\n", b)
				flusher.Flush()
			}
		}
	})

	// -----------------------------------------------------------------------
	// GET /api/status — overall status
	// -----------------------------------------------------------------------
	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		channels := mgr.list()
		out := make([]map[string]interface{}, 0, len(channels))
		for _, ch := range channels {
			out = append(out, channelSnapshot(ch))
		}
		writeJSON(w, map[string]interface{}{
			"channels": out,
			"time":     time.Now().UTC(),
		})
	})

	// -----------------------------------------------------------------------
	// GET /api/audio/{label} — streaming WAV audio preview (12 kHz mono S16LE)
	//
	// Sends a WAV header followed by a continuous stream of raw PCM chunks
	// tapped from the live audio feed going into QtSoundModem.
	// The browser can play this with an <audio> element or the Web Audio API.
	// -----------------------------------------------------------------------
	mux.HandleFunc("/api/audio/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		label := strings.TrimPrefix(r.URL.Path, "/api/audio/")
		label = strings.TrimSuffix(label, "/")
		if label == "" {
			http.NotFound(w, r)
			return
		}
		ch := mgr.get(label)
		if ch == nil {
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			return
		}

		const sampleRate = smSampleRate // 12000 Hz
		const numChannels = 1
		const bitsPerSample = 16
		const byteRate = sampleRate * numChannels * bitsPerSample / 8
		const blockAlign = numChannels * bitsPerSample / 8

		// Write a streaming WAV header with a very large data chunk size
		// (0x7fffffff) so the browser treats it as a live stream.
		w.Header().Set("Content-Type", "audio/wav")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no")
		w.Header().Set("Transfer-Encoding", "chunked")

		flusher, canFlush := w.(http.Flusher)

		// RIFF header
		hdr := make([]byte, 44)
		copy(hdr[0:4], "RIFF")
		binary.LittleEndian.PutUint32(hdr[4:8], 0x7fffffff) // chunk size (streaming)
		copy(hdr[8:12], "WAVE")
		copy(hdr[12:16], "fmt ")
		binary.LittleEndian.PutUint32(hdr[16:20], 16)                    // PCM subchunk size
		binary.LittleEndian.PutUint16(hdr[20:22], 1)                     // PCM format
		binary.LittleEndian.PutUint16(hdr[22:24], uint16(numChannels))
		binary.LittleEndian.PutUint32(hdr[24:28], uint32(sampleRate))
		binary.LittleEndian.PutUint32(hdr[28:32], uint32(byteRate))
		binary.LittleEndian.PutUint16(hdr[32:34], uint16(blockAlign))
		binary.LittleEndian.PutUint16(hdr[34:36], uint16(bitsPerSample))
		copy(hdr[36:40], "data")
		binary.LittleEndian.PutUint32(hdr[40:44], 0x7fffffff) // data chunk size (streaming)
		if _, err := w.Write(hdr); err != nil {
			return
		}
		if canFlush {
			flusher.Flush()
		}

		tap := ch.tapSubscribe()
		defer ch.tapUnsubscribe(tap)

		log.Printf("[web] audio preview started for %s", label)
		defer log.Printf("[web] audio preview ended for %s", label)

		for {
			select {
			case <-r.Context().Done():
				return
			case pcmBytes, ok := <-tap:
				if !ok {
					return
				}
				if _, err := w.Write(pcmBytes); err != nil {
					return
				}
				if canFlush {
					flusher.Flush()
				}
			}
		}
	})

	// -----------------------------------------------------------------------
	// Static files — index.html served as a Go template so BASE_PATH can be
	// injected from the X-Forwarded-Prefix header set by UberSDR's addon proxy.
	// -----------------------------------------------------------------------
	indexTmpl, indexTmplErr := func() (*template.Template, error) {
		data, err := staticFiles.ReadFile("static/index.html")
		if err != nil {
			return nil, err
		}
		return template.New("index").Parse(string(data))
	}()

	basePath := func(r *http.Request) string {
		return strings.TrimRight(r.Header.Get("X-Forwarded-Prefix"), "/")
	}

	sub, err := fs.Sub(staticFiles, "static")
	if err != nil {
		return fmt.Errorf("embed sub: %w", err)
	}
	staticHandler := http.FileServer(http.FS(sub))

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			if indexTmplErr != nil {
				http.Error(w, "template error: "+indexTmplErr.Error(), http.StatusInternalServerError)
				return
			}
			bp := basePath(r)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			indexTmpl.Execute(w, map[string]string{"BasePath": bp}) //nolint:errcheck
			return
		}
		staticHandler.ServeHTTP(w, r)
	})

	log.Printf("[web] listening on %s", listenAddr)
	return http.ListenAndServe(listenAddr, mux)
}

// channelSnapshot returns a JSON-serialisable snapshot of a packetChannel.
func channelSnapshot(ch *packetChannel) map[string]interface{} {
	ch.mu.Lock()
	smCfg := ch.smCfg
	mqttPrefix := ch.mqttTopicPrefix
	ch.mu.Unlock()

	instSnap := ch.inst.statusSnapshot()

	return map[string]interface{}{
		"id":                ch.channelID,
		"label":             ch.label,
		"modem_config":      smCfg,
		"instance":          instSnap,
		"mqtt_topic_prefix": mqttPrefix,
	}
}
