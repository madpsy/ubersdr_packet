/* app.js — UberSDR Packet frontend */
'use strict';

// BASE_PATH is injected by the Go server from the X-Forwarded-Prefix header.
// When served via UberSDR's addon proxy at /addon/packet/, this will be
// "/addon/packet" so all API calls are correctly prefixed.
const BASE = (window.BASE_PATH || '').replace(/\/$/, '');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Modem type labels — must match the extension's template.html option values exactly.
const MODEM_LABELS = [
  'AFSK AX.25 300bd',           // 0
  'AFSK AX.25 1200bd (Bell 202)', // 1
  'AFSK AX.25 600bd',           // 2
  'AFSK AX.25 2400bd',          // 3
  'BPSK AX.25 1200bd',          // 4
  'BPSK AX.25 600bd',           // 5
  'BPSK AX.25 300bd',           // 6
  'BPSK AX.25 2400bd',          // 7
  'QPSK AX.25 4800bd',          // 8
  'QPSK AX.25 3600bd',          // 9
  'QPSK AX.25 2400bd',          // 10
  'BPSK FEC 4×100bd',           // 11
  'DW QPSK V26A 2400bd',        // 12
  'DW 8PSK V27 4800bd',         // 13
  'DW QPSK V26B 2400bd',        // 14
  'ARDOP Packet',               // 15
];

// RX_SHIFT: approximate half-bandwidth in Hz per modem index (from QtSoundModem sm_main.c)
// Used to draw channel bandwidth bars on the waterfall.
const RX_SHIFT = [
  200,   // 0  AFSK 300bd
  1000,  // 1  AFSK 1200bd (Bell 202)
  450,   // 2  AFSK 600bd
  1805,  // 3  AFSK 2400bd
  1200,  // 4  BPSK 1200bd
  600,   // 5  BPSK 600bd
  300,   // 6  BPSK 300bd
  1200,  // 7  BPSK 2400bd
  2400,  // 8  QPSK 4800bd
  1800,  // 9  QPSK 3600bd
  1200,  // 10 QPSK 2400bd
  525,   // 11 BPSK FEC
  1200,  // 12 DW QPSK V26A
  1600,  // 13 DW 8PSK V27
  1200,  // 14 DW QPSK V26B
  500,   // 15 ARDOP
];

// Approximate TX duration in milliseconds for a typical AX.25 UI frame (~70 bytes = 560 bits)
// at each modem index. Formula: ceil(560 / baud_rate * 1000) + ~100ms preamble.
// Used to estimate the height of the callsign marker bar on the waterfall.
const MODEM_TX_MS = [
  2000,  // 0  AFSK 300bd    560/300  ≈ 1.9s
   570,  // 1  AFSK 1200bd   560/1200 ≈ 0.47s
  1030,  // 2  AFSK 600bd    560/600  ≈ 0.93s
   330,  // 3  AFSK 2400bd   560/2400 ≈ 0.23s
   570,  // 4  BPSK 1200bd
  1030,  // 5  BPSK 600bd
  2000,  // 6  BPSK 300bd
   330,  // 7  BPSK 2400bd
   220,  // 8  QPSK 4800bd   560/4800 ≈ 0.12s
   260,  // 9  QPSK 3600bd   560/3600 ≈ 0.16s
   330,  // 10 QPSK 2400bd
   570,  // 11 BPSK FEC
   330,  // 12 DW QPSK V26A
   220,  // 13 DW 8PSK V27
   330,  // 14 DW QPSK V26B
   800,  // 15 ARDOP (variable, use conservative estimate)
];

const WF_CH_COLORS = ['#29B6F6', '#66BB6A', '#CE93D8', '#FFA726'];
const WF_MAX_FREQ  = 3300;  // Hz — display range matches extension (_wfMaxFreq = 3300)
const WF_HEIGHT    = 120;
const WF_HDR_H     = 22;
const WF_LINE_MS   = 50;    // 20 lines/sec

const CH_NAMES = ['A', 'B', 'C', 'D'];

const MSG_PACKET  = 0x20;
const MSG_ERROR   = 0x21;
const MSG_DCD     = 0x23;
const MSG_MONITOR = 0x24;
const MSG_LOG     = 0x25;

const MAX_FRAMES   = 500;
const MAX_MONITOR  = 200;
const MAX_LOG      = 300;

// ---------------------------------------------------------------------------
// Auth state
// ---------------------------------------------------------------------------

const state = {
  authed: false,
  passwordConfigured: false,
  mqttConfigured: false,
  mqttTopicPrefix: 'ubersdr', // global default; overwritten by /api/config
};

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function fmtFreq(hz) {
  if (hz >= 1e9) return (hz / 1e9).toFixed(6) + ' GHz';
  if (hz >= 1e6) return (hz / 1e6).toFixed(6) + ' MHz';
  if (hz >= 1e3) return (hz / 1e3).toFixed(3) + ' kHz';
  return hz + ' Hz';
}

function fmtTime(d) {
  return d.toTimeString().slice(0, 8);
}

function formatAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r > 0 ? `${m}m${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h${rm}m` : `${h}h`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function api(path, opts = {}) {
  return fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } })
    .then(r => {
      if (!r.ok) return r.text().then(t => Promise.reject(new Error(t || r.statusText)));
      return r.json().catch(() => null);
    });
}

// ---------------------------------------------------------------------------
// Auth UI
// ---------------------------------------------------------------------------

function renderAuthBar() {
  const loginBtn   = document.getElementById('login-btn');
  const authedSpan = document.getElementById('auth-authed');
  const logoutBtn  = document.getElementById('logout-btn');
  const addBtn     = document.getElementById('btn-add-channel');

  // Body-level classes drive CSS for config-pane locking across all cards.
  document.body.classList.toggle('pw-configured', !!state.passwordConfigured);
  document.body.classList.toggle('is-authed',     !!state.authed || !state.passwordConfigured);

  if (!state.passwordConfigured) {
    // No password set — everyone can write
    loginBtn.classList.add('hidden');
    authedSpan.classList.add('hidden');
    logoutBtn.classList.add('hidden');
    addBtn.classList.remove('hidden');
    return;
  }

  if (state.authed) {
    loginBtn.classList.add('hidden');
    authedSpan.classList.remove('hidden');
    logoutBtn.classList.remove('hidden');
    addBtn.classList.remove('hidden');
  } else {
    loginBtn.classList.remove('hidden');
    authedSpan.classList.add('hidden');
    logoutBtn.classList.add('hidden');
    addBtn.classList.add('hidden');
  }
}

function showLoginModal() {
  document.getElementById('login-modal').classList.remove('hidden');
  document.getElementById('login-password').value = '';
  document.getElementById('login-error').classList.add('hidden');
  document.getElementById('login-password').focus();
}

function hideLoginModal() {
  document.getElementById('login-modal').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// API Documentation modal
// ---------------------------------------------------------------------------
function showApiDocs() {
  const modal = document.getElementById('api-docs-modal');
  const body  = document.getElementById('apidocs-body');

  // Derive the base URL from the current page location so curl examples
  // always reflect the actual deployment (e.g. behind a reverse proxy).
  const base = window.location.origin + (BASE || '');

  function section(title) {
    return `<h3 class="apidocs-section">${title}</h3>`;
  }
  function endpoint(method, path, desc, curlLines, notes) {
    const curl = curlLines.map(l => `<div class="apidocs-curl-line">${escHtml(l)}</div>`).join('');
    const noteHtml = notes ? `<p class="apidocs-note">${notes}</p>` : '';
    return `
      <div class="apidocs-endpoint">
        <div class="apidocs-sig">
          <span class="apidocs-method apidocs-method-${method.toLowerCase()}">${method}</span>
          <code class="apidocs-path">${escHtml(path)}</code>
        </div>
        <p class="apidocs-desc">${desc}</p>
        ${noteHtml}
        <pre class="apidocs-pre">${curl}</pre>
      </div>`;
  }
  function rawBlock(lines) {
    return `<div class="apidocs-endpoint"><pre class="apidocs-pre">${
      lines.map(l => `<div class="apidocs-curl-line">${escHtml(l)}</div>`).join('')
    }</pre></div>`;
  }
  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  body.innerHTML = [
    // ── Channels ────────────────────────────────────────────────────────────
    section('Channels'),
    endpoint('GET', '/api/channels',
      'List all configured channels with modem config, connection status, and senders seen. ' +
      'Each channel includes a <code>senders</code> array of unique <code>(callsign, sm_ch)</code> pairs ' +
      'observed in the frame buffer, with <code>frame_count</code>, <code>last_seen</code>, and ' +
      '<code>snr_available</code> (true when at least one frame has SNR data). ' +
      '<code>sm_ch</code> is the modem sub-channel index (0=A, 1=B, 2=C, 3=D).',
      [`curl '${base}/api/channels'`]),
    endpoint('GET', '/api/channels/{label}',
      'Get a single channel by its label. Returns the same structure as the list endpoint.',
      [`curl '${base}/api/channels/7049450_usb'`]),
    endpoint('POST', '/api/channels',
      'Add a new channel. Requires authentication when a UI password is set.',
      [
        `curl -X POST '${base}/api/channels' \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -d '{"freq_hz":7049450,"mode":"usb","name":"20m Packet"}'`,
      ]),
    endpoint('PATCH', '/api/channels/{label}',
      'Update an existing channel (name, modem config, MQTT topic prefix, etc.).',
      [
        `curl -X PATCH '${base}/api/channels/7049450_usb' \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -d '{"name":"HF Packet"}'`,
      ]),
    endpoint('DELETE', '/api/channels/{label}',
      'Remove a channel.',
      [`curl -X DELETE '${base}/api/channels/7049450_usb'`]),

    // ── Status ───────────────────────────────────────────────────────────────
    section('Status'),
    endpoint('GET', '/api/status',
      'Overall system status: all channels with connection state, modem config, and current time.',
      [`curl '${base}/api/status'`]),

    // ── Frames ───────────────────────────────────────────────────────────────
    section('Frames'),
    endpoint('GET', '/api/frames',
      'Query decoded AX.25 frames from the server-side ring buffer (up to 1000). ' +
      'Use <code>channel=*</code> to aggregate across all channels. ' +
      'Use <code>fields=snr</code> to return a minimal projection of only ' +
      '<code>received_at</code> and <code>snr</code> — useful for SNR history charts.',
      [
        `# Last 20 frames on a channel`,
        `curl '${base}/api/frames?channel=7049450_usb&limit=20'`,
        ``,
        `# All channels, newest 50`,
        `curl '${base}/api/frames?channel=*&limit=50'`,
        ``,
        `# Exact sender callsign`,
        `curl '${base}/api/frames?channel=7049450_usb&from_exact=G0ABC-9&limit=100'`,
        ``,
        `# Exact destination callsign`,
        `curl '${base}/api/frames?channel=7049450_usb&to_exact=APRS&limit=50'`,
        ``,
        `# Prefix match on sender`,
        `curl '${base}/api/frames?channel=7049450_usb&from=G0ABC&limit=50'`,
        ``,
        `# Full-text search (from/to/via/info)`,
        `curl '${base}/api/frames?channel=7049450_usb&search=BEACON&limit=100'`,
        ``,
        `# Specific modem sub-channel (0–3)`,
        `curl '${base}/api/frames?channel=7049450_usb&sm_ch=0&limit=50'`,
        ``,
        `# Time range (RFC3339)`,
        `curl '${base}/api/frames?channel=7049450_usb&from=2024-01-01T00:00:00Z&to=2024-01-02T00:00:00Z'`,
        ``,
        `# SNR-only projection (minimal payload for charting)`,
        `curl '${base}/api/frames?channel=7049450_usb&from_exact=G0ABC-9&limit=1000&fields=snr'`,
      ],
      'Response: JSON array of frame objects. Each object: ' +
      '<code>channel</code>, <code>sm_ch</code>, <code>from</code>, <code>to</code>, ' +
      '<code>via</code> (array), <code>info</code> (string), <code>snr</code> (dB float or null), ' +
      '<code>received_at</code> (RFC3339Nano). ' +
      'With <code>fields=snr</code>: only <code>received_at</code> and <code>snr</code> are returned.'),

    // ── Stats ─────────────────────────────────────────────────────────────────
    section('Statistics'),
    endpoint('GET', '/api/stats',
      'Lifetime per-(channel, callsign, sm_ch) frame statistics. Counters accumulate for the ' +
      'process lifetime and are never evicted (unlike the 1000-frame ring buffer). ' +
      'All query parameters are optional.',
      [
        `# All channels, all callsigns`,
        `curl '${base}/api/stats'`,
        ``,
        `# One channel`,
        `curl '${base}/api/stats?channel=7049450_usb'`,
        ``,
        `# One callsign across all channels`,
        `curl '${base}/api/stats?callsign=G0ABC-9'`,
        ``,
        `# One channel + specific modem sub-channel (0=A, 1=B, 2=C, 3=D)`,
        `curl '${base}/api/stats?channel=7049450_usb&sm_ch=0'`,
      ],
      'Response: JSON array sorted by <code>total_frames</code> descending. Each object: ' +
      '<code>channel</code>, <code>callsign</code>, <code>sm_ch</code>, ' +
      '<code>total_frames</code>, <code>first_seen</code>, <code>last_seen</code>, ' +
      '<code>snr_count</code> / <code>snr_min</code> / <code>snr_max</code> / <code>snr_mean</code>, ' +
      '<code>frames_per_day</code> (object: UTC date → count), ' +
      '<code>frames_per_hour</code> (array[24]: UTC hour → count), ' +
      '<code>frame_types</code> (object: type → count), ' +
      '<code>top_destinations</code> (object: callsign → count, top 50).'),

    // ── Live Feed (SSE) ──────────────────────────────────────────────────────
    section('Live Feed — SSE'),
    `<div class="apidocs-endpoint">
      <p class="apidocs-desc">
        Server-Sent Events stream delivering all decoded frames and modem events in real time.
        Each SSE <code>data:</code> line is a JSON envelope:
      </p>
      <pre class="apidocs-pre">` +
      [
        `curl -N '${base}/api/events'`,
        ``,
        `# Filter to one channel (by channel_id UUID):`,
        `curl -N '${base}/api/events?channel_id=<uuid>'`,
        ``,
        `# Each event is a JSON object:`,
        `{`,
        `  "channel_id":  "<uuid>",`,
        `  "received_at": 1704067200000,   // Unix milliseconds`,
        `  "data":        "<base64>"        // binary wire frame (see below)`,
        `}`,
      ].map(l => `<div class="apidocs-curl-line">${escHtml(l)}</div>`).join('') +
      `</pre>
      <p class="apidocs-note">A heartbeat comment (<code>: heartbeat</code>) is sent every 15 s to keep the connection alive.</p>
    </div>`,

    // ── Binary Wire Protocol ─────────────────────────────────────────────────
    section('Binary Wire Protocol (SSE data field)'),
    `<div class="apidocs-endpoint">
      <p class="apidocs-desc">
        The <code>data</code> field in each SSE event is a base64-encoded binary frame.
        The first byte is the message type. All multi-byte integers are big-endian unless noted.
      </p>` +
      rawBlock([
        `┌─ 0x20  MsgPacket — decoded AX.25 frame ──────────────────────────────┐`,
        `│ [0]    0x20  type byte                                                │`,
        `│ [1]    u8    KISS port / modem sub-channel (0–3)                      │`,
        `│ [2..5] f32LE SNR in dB (IEEE 754 little-endian; NaN = unavailable)   │`,
        `│ [6..9] u32BE AX.25 payload length                                    │`,
        `│ [10..] bytes raw AX.25 frame                                         │`,
        `└──────────────────────────────────────────────────────────────────────┘`,
        ``,
        `┌─ 0x21  MsgError — modem error string ────────────────────────────────┐`,
        `│ [0]    0x21  type byte                                                │`,
        `│ [1..4] u32BE message length                                          │`,
        `│ [5..]  UTF-8 error message                                           │`,
        `└──────────────────────────────────────────────────────────────────────┘`,
        ``,
        `┌─ 0x23  MsgDCD — carrier detect signal ───────────────────────────────┐`,
        `│ [0]    0x23  type byte                                                │`,
        `│ [1]    u8    modem sub-channel (0–3)                                  │`,
        `│ [2]    u8    0x01 = DCD on, 0x00 = DCD off                           │`,
        `└──────────────────────────────────────────────────────────────────────┘`,
        ``,
        `┌─ 0x24  MsgMonitor — raw monitor text (TNC monitor port) ─────────────┐`,
        `│ [0]    0x24  type byte                                                │`,
        `│ [1]    u8    modem sub-channel (0–3)                                  │`,
        `│ [2]    u8    0x01 = TX frame, 0x00 = RX frame                        │`,
        `│ [3..6] u32BE text length                                             │`,
        `│ [7..]  UTF-8 decoded frame text                                      │`,
        `└──────────────────────────────────────────────────────────────────────┘`,
        ``,
        `┌─ 0x25  MsgLog — modem log line ──────────────────────────────────────┐`,
        `│ [0]    0x25  type byte                                                │`,
        `│ [1..4] u32BE message length                                          │`,
        `│ [5..]  UTF-8 log line                                                │`,
        `└──────────────────────────────────────────────────────────────────────┘`,
      ]) +
    `</div>`,

    // ── Audio Streaming ──────────────────────────────────────────────────────
    section('Audio Streaming'),
    endpoint('GET', '/api/audio/{label}',
      'Streaming WAV audio preview of the demodulated baseband audio being fed into the modem. ' +
      '12 kHz mono 16-bit PCM. The WAV header uses a max-size data chunk so browsers treat it as a live stream.',
      [
        `# Play with ffplay:`,
        `ffplay '${base}/api/audio/7049450_usb'`,
        ``,
        `# Save to file (Ctrl-C to stop):`,
        `curl '${base}/api/audio/7049450_usb' > recording.wav`,
        ``,
        `# Use in an HTML audio element:`,
        `# <audio src="${base}/api/audio/7049450_usb" controls autoplay></audio>`,
      ],
      'Format: WAV, 12000 Hz, 1 channel, 16-bit signed little-endian PCM. ' +
      'Content-Type: <code>audio/wav</code>. Streams indefinitely until the client disconnects.'),

    // ── MQTT ─────────────────────────────────────────────────────────────────
    section('MQTT'),
    `<div class="apidocs-endpoint">
      <p class="apidocs-desc">
        When an MQTT broker is configured, every decoded AX.25 frame is published to
        <strong>two topics</strong> simultaneously (default prefix: <code>ubersdr</code>):
      </p>
      <p class="apidocs-desc">
        ● <code>&lt;prefix&gt;/&lt;channel&gt;/raw</code> — minimal RF/signal-level payload (no AX.25 addressing)<br>
        ● <code>&lt;prefix&gt;/&lt;channel&gt;/&lt;sm_ch&gt;/&lt;from&gt;/&lt;to&gt;</code> — full decoded payload for targeted subscriptions
      </p>
      <p class="apidocs-note">
        <code>sm_ch</code> is the modem sub-channel letter (A–D).
        Useful wildcard patterns:
        <code>ubersdr/7049450_usb/raw</code> (all frames on a channel) ·
        <code>ubersdr/7049450_usb/+/G0ABC-9/#</code> (all frames from one callsign) ·
        <code>ubersdr/7049450_usb/+/+/APRS</code> (all frames to APRS).
      </p>
    </div>` +
      rawBlock([
        `# Subscribe to everything:`,
        `mosquitto_sub -h broker.example.com -t 'ubersdr/#' -v`,
        ``,
        `# Subscribe to all frames on one channel (raw firehose):`,
        `mosquitto_sub -h broker.example.com -t 'ubersdr/7049450_usb/raw' -v`,
        ``,
        `# Subscribe to all frames from one callsign (any sub-channel):`,
        `mosquitto_sub -h broker.example.com -t 'ubersdr/7049450_usb/+/G0ABC-9/#' -v`,
        ``,
        `# Raw topic payload  (ubersdr/7049450_usb/raw):`,
        `{`,
        `  "channel":        "7049450_usb",`,
        `  "modem_ch":       "A",`,
        `  "snr":            42.3,`,
        `  "received_at":    "2024-01-01T12:00:00.000000000Z",`,
        `  "frame":          "<base64-encoded raw AX.25 bytes>",`,
        `  "freq_hz":        7049450,`,
        `  "mode":           "usb",`,
        `  "freq_offset_hz": 1700,`,
        `  "modem_type":     1,`,
        `  "fx25":           1,`,
        `  "il2p":           2`,
        `}`,
        ``,
        `# Structured topic payload  (ubersdr/7049450_usb/A/G0ABC-9/APRS):`,
        `{`,
        `  "channel":        "7049450_usb",`,
        `  "modem_ch":       "A",`,
        `  "from":           "G0ABC-9",`,
        `  "to":             "APRS",`,
        `  "frame_type":     "aprs",`,
        `  "snr":            42.3,`,
        `  "received_at":    "2024-01-01T12:00:00.000000000Z",`,
        `  "frame":          "<base64-encoded raw AX.25 bytes>",`,
        `  "freq_hz":        7049450,`,
        `  "mode":           "usb",`,
        `  "freq_offset_hz": 1700,`,
        `  "modem_type":     1,`,
        `  "fx25":           1,`,
        `  "il2p":           2`,
        `}`,
        ``,
        `# frame_type: "aprs" | "ui" | "i" | "s" | "u" (empty string if unparseable).`,
        `# snr is null when SNR data is unavailable for the channel.`,
        `# frame is the raw AX.25 bytes, base64-encoded (RFC 4648).`,
        `# freq_hz is the dial (VFO) frequency; freq_offset_hz is the sub-channel centre freq (Hz).`,
        `# modem_type: 0=AFSK 300bd, 1=AFSK 1200bd, 2=AFSK 600bd, 3=AFSK 2400bd, 4=BPSK 1200bd,`,
        `#             5=BPSK 600bd, 6=BPSK 300bd, 7=BPSK 2400bd, 8=QPSK 4800bd, 9=QPSK 3600bd,`,
        `#             10=QPSK 2400bd, 11=BPSK FEC 4x100bd, 12=DW QPSK V26A, 13=DW 8PSK V27,`,
        `#             14=DW QPSK V26B, 15=ARDOP Packet.`,
        `# fx25: 0=off, 1=on.`,
        `# il2p: 0=off, 1=IL2P, 2=IL2P+CRC, 3=both.`,
      ]) +
      `<p class="apidocs-note">
        Configure via env vars: <code>MQTT_BROKER</code> (e.g. <code>tcp://host:1883</code>),
        <code>MQTT_USER</code>, <code>MQTT_PASS</code>, <code>MQTT_TOPIC_PREFIX</code>,
        <code>MQTT_TLS_SKIP_VERIFY</code>. TLS is enabled automatically for <code>ssl://</code>
        or <code>tls://</code> broker URLs.
      </p>
    </div>`,

    // ── Authentication ───────────────────────────────────────────────────────
    section('Authentication'),
    endpoint('POST', '/api/auth/login',
      'Obtain a session cookie. Required for write operations (POST/PATCH/DELETE) when <code>UI_PASSWORD</code> is set.',
      [
        `curl -c cookies.txt -X POST '${base}/api/auth/login' \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -d '{"password":"your-password"}'`,
      ]),
    endpoint('POST', '/api/auth/logout',
      'Invalidate the current session cookie.',
      [`curl -b cookies.txt -X POST '${base}/api/auth/logout'`]),

  ].join('\n');

  modal.classList.remove('hidden');
}

function hideApiDocs() {
  document.getElementById('api-docs-modal').classList.add('hidden');
}

// Close API docs modal on backdrop click
document.addEventListener('click', e => {
  const modal = document.getElementById('api-docs-modal');
  if (modal && !modal.classList.contains('hidden') && e.target === modal) {
    hideApiDocs();
  }
});

function doLogin() {
  const pw = document.getElementById('login-password').value;
  fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  }).then(r => {
    if (!r.ok) throw new Error('bad');
    state.authed = true;
    hideLoginModal();
    renderAuthBar();
    loadChannels();
  }).catch(() => {
    const err = document.getElementById('login-error');
    err.textContent = 'Incorrect password.';
    err.classList.remove('hidden');
  });
}

function doLogout() {
  fetch(BASE + '/api/auth/logout', { method: 'POST' }).finally(() => {
    state.authed = false;
    renderAuthBar();
    loadChannels();
  });
}

function checkAuth() {
  return fetch(BASE + '/api/auth/status')
    .then(r => r.json())
    .then(d => {
      state.passwordConfigured = d.password_configured;
      state.authed = d.authenticated;
      renderAuthBar();
    });
}

// ---------------------------------------------------------------------------
// Frequency presets (mirrors the ka9q_ubersdr soundmodem extension)
// ---------------------------------------------------------------------------

const FREQ_PRESETS = [
  { label: '— Select a preset —', value: '' },
  { group: 'HF Packet', options: [
    { label: '7.049.45 MHz USB (UK Packet)', freq: 7049450, mode: 'usb' },
  ]},
];

// Default modem sub-channel configs matching the extension's HTML defaults:
//   Ch A: AFSK 300bd (modem 0), freq 850, FX.25 on, IL2P+CRC, enabled
//   Ch B: BPSK 300bd (modem 6), freq 850, FX.25 on, IL2P+CRC, enabled
//   Ch C/D: disabled
const DEFAULT_MODEM_CHANNELS = [
  { enabled: true,  modem: 0, freq: 850,  rcvr_pairs: 0, fx25: 1, il2p: 2 },
  { enabled: true,  modem: 6, freq: 2150, rcvr_pairs: 0, fx25: 1, il2p: 2 },
  { enabled: false, modem: 0, freq: 850,  rcvr_pairs: 0, fx25: 1, il2p: 2 },
  { enabled: false, modem: 0, freq: 850,  rcvr_pairs: 0, fx25: 1, il2p: 2 },
];

// ---------------------------------------------------------------------------
// Modem channel config widget
// ---------------------------------------------------------------------------

function buildModemChannelCard(idx, cfg) {
  cfg = cfg || DEFAULT_MODEM_CHANNELS[idx];

  const card = el('div', 'modem-ch-card');

  const hdr = el('div', 'modem-ch-header');
  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.checked = !!cfg.enabled;
  const uid = `mch-${idx}-${Date.now()}`;
  chk.id = uid;
  const lbl = el('label', '', `Channel ${CH_NAMES[idx]}`);
  lbl.htmlFor = uid;
  hdr.appendChild(chk);
  hdr.appendChild(lbl);
  card.appendChild(hdr);

  const params = el('div', 'modem-ch-params' + (cfg.enabled ? '' : ' disabled'));
  card.appendChild(params);

  chk.addEventListener('change', () => {
    params.classList.toggle('disabled', !chk.checked);
  });

  function row(labelText, inputEl) {
    const r = el('div', 'param-row');
    r.appendChild(el('label', '', labelText));
    r.appendChild(inputEl);
    params.appendChild(r);
  }

  const selModem = document.createElement('select');
  MODEM_LABELS.forEach((name, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = name;
    if (i === (cfg.modem ?? 0)) o.selected = true;
    selModem.appendChild(o);
  });
  row('Modem type', selModem);

  const inpFreq = document.createElement('input');
  inpFreq.type = 'number';
  inpFreq.value = cfg.freq ?? 850;
  inpFreq.min = 100; inpFreq.max = 24000;
  row('Centre freq (Hz)', inpFreq);

  const selRcvr = document.createElement('select');
  for (let i = 0; i <= 8; i++) {
    const o = document.createElement('option');
    o.value = i; o.textContent = i === 0 ? '0 (single)' : i;
    if (i === (cfg.rcvr_pairs || 0)) o.selected = true;
    selRcvr.appendChild(o);
  }
  row('Rcvr pairs', selRcvr);

  const selFX25 = document.createElement('select');
  [['0', 'Off'], ['1', 'RX only']].forEach(([v, t]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = t;
    if (parseInt(v) === (cfg.fx25 || 0)) o.selected = true;
    selFX25.appendChild(o);
  });
  row('FX.25', selFX25);

  const selIL2P = document.createElement('select');
  [['0', 'Off'], ['1', 'IL2P'], ['2', 'IL2P+CRC'], ['3', 'Both']].forEach(([v, t]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = t;
    if (parseInt(v) === (cfg.il2p || 0)) o.selected = true;
    selIL2P.appendChild(o);
  });
  row('IL2P', selIL2P);

  card._read = () => ({
    enabled:    chk.checked,
    modem:      parseInt(selModem.value),
    freq:       parseFloat(inpFreq.value) || 1700,
    rcvr_pairs: parseInt(selRcvr.value),
    fx25:       parseInt(selFX25.value),
    il2p:       parseInt(selIL2P.value),
  });

  return card;
}

function readModemChannels(container) {
  const cards = container.querySelectorAll('.modem-ch-card');
  const channels = [null, null, null, null];
  cards.forEach((c, i) => { if (c._read) channels[i] = c._read(); });
  return channels;
}

// ---------------------------------------------------------------------------
// Add-channel panel
// ---------------------------------------------------------------------------

function initAddPanel() {
  const panel   = document.getElementById('add-channel-panel');
  const btnOpen = document.getElementById('btn-add-channel');
  const btnCancel = document.getElementById('btn-add-cancel');
  const btnSubmit = document.getElementById('btn-add-submit');
  const grid    = document.getElementById('add-modem-channels');

  for (let i = 0; i < 4; i++) grid.appendChild(buildModemChannelCard(i, null));

  // Frequency preset dropdown — populates freq + mode fields
  // Split MQTT topic field: read-only prefix badge + editable suffix input.
  // The badge shows the global prefix from the server config (MQTT_TOPIC_PREFIX env,
  // default "ubersdr"). Only the suffix is stored per-channel; the prefix is server-side.
  // The suffix auto-populates from the channel name/label as the user types,
  // unless they've manually edited it.
  const mqttSuffixEl = document.getElementById('add-mqtt-suffix');
  const mqttBadgeEl  = document.getElementById('add-mqtt-prefix-badge');
  let mqttSuffixManual = false;
  const syncMqttSuffix = () => {
    if (!mqttSuffixEl || mqttSuffixManual) return;
    const nameVal = (document.getElementById('add-name').value || '').trim();
    const freqVal = document.getElementById('add-freq').value || '';
    const modeVal = (document.getElementById('add-mode') || {}).value || '';
    mqttSuffixEl.value = nameVal || (freqVal && modeVal ? freqVal + '_' + modeVal : freqVal);
  };
  if (mqttSuffixEl) {
    mqttSuffixEl.addEventListener('input', () => { mqttSuffixManual = true; });
    document.getElementById('add-name').addEventListener('input', syncMqttSuffix);
    document.getElementById('add-freq').addEventListener('input', syncMqttSuffix);
    const modeEl = document.getElementById('add-mode');
    if (modeEl) modeEl.addEventListener('change', syncMqttSuffix);
  }

  const presetSel = document.getElementById('add-freq-preset');
  if (presetSel) {
    let lastVal = '';
    const applyPreset = (val) => {
      if (!val) return;
      const [freqStr, mode] = val.split(',');
      document.getElementById('add-freq').value = freqStr;
      const modeEl = document.getElementById('add-mode');
      if (modeEl) modeEl.value = mode;
      lastVal = val;
      // Programmatic .value= doesn't fire input/change events, so sync manually
      syncMqttSuffix();
    };
    presetSel.addEventListener('change', e => applyPreset(e.target.value));
    // Allow re-clicking the same option to re-apply
    presetSel.addEventListener('click', e => {
      if (e.target.value && e.target.value === lastVal) applyPreset(e.target.value);
    });
  }

  btnOpen.addEventListener('click', () => {
    // Reset preset selector when opening
    if (presetSel) presetSel.value = '';
    panel.classList.toggle('hidden');
  });
  btnCancel.addEventListener('click', () => panel.classList.add('hidden'));

  btnSubmit.addEventListener('click', async () => {
    if (!state.authed && state.passwordConfigured) { showLoginModal(); return; }

    const freqHz = parseInt(document.getElementById('add-freq').value);
    if (!freqHz || freqHz <= 0) { alert('Enter a valid frequency in Hz'); return; }

    const modemChannels = readModemChannels(grid);
    const pfx = state.mqttTopicPrefix;
    const sfx = mqttSuffixEl ? mqttSuffixEl.value.trim() : '';
    const body = {
      freq_hz:           freqHz,
      mode:              document.getElementById('add-mode').value,
      name:              document.getElementById('add-name').value.trim(),
      bandwidth_hz:      parseInt(document.getElementById('add-bw').value) || 0,
      mqtt_topic_prefix: state.mqttConfigured && sfx ? sfx : '',
      modem_config: {
        sample_rate:   0,
        dcd_threshold: 20,
        channels:      modemChannels,
      },
    };

    try {
      const resp = await fetch(BASE + '/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const t = await resp.text();
        if (resp.status === 401) { showLoginModal(); return; }
        alert('Error: ' + t);
        return;
      }
      panel.classList.add('hidden');
      document.getElementById('add-freq').value = '';
      document.getElementById('add-name').value = '';
      document.getElementById('add-bw').value = '0';
      if (mqttSuffixEl) { mqttSuffixEl.value = ''; mqttSuffixManual = false; }
      loadChannels();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  });
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Waterfall — per-channel audio preview + FFT waterfall with channel markers
// ---------------------------------------------------------------------------

function wfColorR(v) {
  if (v < 64)  return 0;
  if (v < 128) return 0;
  if (v < 192) return Math.round((v - 128) * 4);
  return 255;
}
function wfColorG(v) {
  if (v < 64)  return 0;
  if (v < 128) return Math.round((v - 64) * 4);
  if (v < 192) return 255;
  return Math.round(255 - (v - 192) * 4);
}
function wfColorB(v) {
  if (v < 64)  return Math.round(v * 4);
  if (v < 128) return 255;
  if (v < 192) return Math.round(255 - (v - 128) * 4);
  return 0;
}

function drawWaterfallHeader(hdrCtx, channelFreqs) {
  const w = hdrCtx.canvas.width;
  const h = hdrCtx.canvas.height;

  hdrCtx.fillStyle = '#1a1a1a';
  hdrCtx.fillRect(0, 0, w, h);

  // Major ticks every 500 Hz
  hdrCtx.strokeStyle = '#ccc';
  hdrCtx.fillStyle   = '#fff';
  hdrCtx.font        = '9px monospace';
  hdrCtx.textAlign   = 'center';
  hdrCtx.lineWidth   = 1;
  for (let f = 0; f <= WF_MAX_FREQ; f += 500) {
    const x = Math.round((f / WF_MAX_FREQ) * w);
    hdrCtx.beginPath();
    hdrCtx.moveTo(x, h - 6); hdrCtx.lineTo(x, h);
    hdrCtx.stroke();
    if (f > 0 && f < WF_MAX_FREQ) {
      hdrCtx.fillText(f >= 1000 ? (f / 1000).toFixed(1) + 'k' : String(f), x, h - 8);
    }
  }
  // Minor ticks every 100 Hz
  hdrCtx.strokeStyle = '#555';
  for (let f = 100; f < WF_MAX_FREQ; f += 100) {
    if (f % 500 === 0) continue;
    const x = Math.round((f / WF_MAX_FREQ) * w);
    hdrCtx.beginPath();
    hdrCtx.moveTo(x, h - 3); hdrCtx.lineTo(x, h);
    hdrCtx.stroke();
  }

  // Channel markers
  channelFreqs.forEach((ch, i) => {
    if (!ch.enabled || ch.freq <= 0) return;
    const shift = (RX_SHIFT[ch.modem] ?? 1000) / 2;
    const xCtr  = Math.round((ch.freq / WF_MAX_FREQ) * w);
    const xLo   = Math.round(((ch.freq - shift) / WF_MAX_FREQ) * w);
    const xHi   = Math.round(((ch.freq + shift) / WF_MAX_FREQ) * w);
    const color = WF_CH_COLORS[i];

    hdrCtx.fillStyle = color + '33';
    hdrCtx.fillRect(xLo, 0, xHi - xLo, h);

    const barY = Math.round(h / 2);
    hdrCtx.strokeStyle = color;
    hdrCtx.lineWidth   = 1;
    hdrCtx.beginPath();
    hdrCtx.moveTo(xLo, barY); hdrCtx.lineTo(xHi, barY);
    hdrCtx.stroke();

    const capH = Math.round(h * 0.4);
    hdrCtx.beginPath();
    hdrCtx.moveTo(xLo, barY - capH); hdrCtx.lineTo(xLo, barY + capH);
    hdrCtx.moveTo(xHi, barY - capH); hdrCtx.lineTo(xHi, barY + capH);
    hdrCtx.stroke();

    hdrCtx.lineWidth = 2;
    hdrCtx.beginPath();
    hdrCtx.moveTo(xCtr, 0); hdrCtx.lineTo(xCtr, h);
    hdrCtx.stroke();
    hdrCtx.lineWidth = 1;

    hdrCtx.fillStyle = color;
    hdrCtx.font      = 'bold 9px monospace';
    hdrCtx.textAlign = xCtr > w - 20 ? 'right' : 'left';
    hdrCtx.fillText(CH_NAMES[i], xCtr + (xCtr > w - 20 ? -3 : 3), 9);
  });
  hdrCtx.textAlign = 'center';
}

// txEvents: array of { callsign, smCh, startLine, durationLines }
// currentLine: total lines rendered so far (used to compute row position)
function drawWaterfallOverlay(ovlCtx, channelFreqs, mouseX, txEvents, currentLine) {
  const w = ovlCtx.canvas.width;
  const h = ovlCtx.canvas.height;
  ovlCtx.clearRect(0, 0, w, h);

  channelFreqs.forEach((ch, i) => {
    if (!ch.enabled || ch.freq <= 0) return;
    const shift = (RX_SHIFT[ch.modem] ?? 1000) / 2;
    const xCtr  = Math.round((ch.freq / WF_MAX_FREQ) * w);
    const xLo   = Math.round(((ch.freq - shift) / WF_MAX_FREQ) * w);
    const xHi   = Math.round(((ch.freq + shift) / WF_MAX_FREQ) * w);
    const color = WF_CH_COLORS[i];

    ovlCtx.fillStyle = color + '40';
    ovlCtx.fillRect(xLo, 0, xHi - xLo, h);

    ovlCtx.strokeStyle = color + 'cc';
    ovlCtx.lineWidth   = 1.5;
    ovlCtx.setLineDash([]);
    ovlCtx.beginPath();
    ovlCtx.moveTo(xLo, 0); ovlCtx.lineTo(xLo, h);
    ovlCtx.moveTo(xHi, 0); ovlCtx.lineTo(xHi, h);
    ovlCtx.stroke();

    ovlCtx.save();
    ovlCtx.strokeStyle = color;
    ovlCtx.lineWidth   = 2.5;
    ovlCtx.setLineDash([6, 3]);
    ovlCtx.beginPath();
    ovlCtx.moveTo(xCtr, 0); ovlCtx.lineTo(xCtr, h);
    ovlCtx.stroke();
    ovlCtx.restore();

    ovlCtx.save();
    ovlCtx.font         = 'bold 12px monospace';
    ovlCtx.textAlign    = 'center';
    ovlCtx.textBaseline = 'top';
    const lw = ovlCtx.measureText(CH_NAMES[i]).width + 8;
    ovlCtx.fillStyle = 'rgba(0,0,0,0.8)';
    ovlCtx.fillRect(xCtr - lw / 2, 2, lw, 16);
    ovlCtx.fillStyle = color;
    ovlCtx.fillText(CH_NAMES[i], xCtr, 3);
    ovlCtx.restore();
  });

  // ── TX callsign markers ──────────────────────────────────────────────────
  // Each event was recorded at startLine; it scrolls down as currentLine grows.
  if (txEvents && txEvents.length && currentLine != null) {
    txEvents.forEach(ev => {
      // startLine is set to (wfLineCount - durationLines) at decode time, so the
      // bar spans from the start of the transmission (older = larger Y) to the
      // end (decode moment = smaller Y, closer to top of waterfall).
      const rowsAgo   = currentLine - ev.startLine;  // rows since TX started (= durationLines at decode)
      const yBot      = rowsAgo;                      // TX start = older = lower on screen
      const yTop      = rowsAgo - ev.durationLines;   // TX end   = newer = higher on screen
      if (yBot < 0 || yTop > h) return;              // off-screen

      const chIdx = ev.smCh;
      const chCfg = channelFreqs[chIdx];
      if (!chCfg || !chCfg.enabled || chCfg.freq <= 0) return;

      const shift = (RX_SHIFT[chCfg.modem] ?? 1000) / 2;
      const xLo   = Math.round(((chCfg.freq - shift) / WF_MAX_FREQ) * w);
      const xHi   = Math.round(((chCfg.freq + shift) / WF_MAX_FREQ) * w);
      const color = WF_CH_COLORS[chIdx] || '#fff';

      const y1 = Math.max(0, yTop);
      const y2 = Math.min(h, yBot);
      const barH = y2 - y1;
      if (barH <= 0) return;

      // Semi-transparent fill over the channel bandwidth
      ovlCtx.save();
      ovlCtx.fillStyle = color + '30';
      ovlCtx.fillRect(xLo, y1, xHi - xLo, barH);

      // Left/right border lines
      ovlCtx.strokeStyle = color + 'bb';
      ovlCtx.lineWidth = 1.5;
      ovlCtx.setLineDash([]);
      ovlCtx.beginPath();
      ovlCtx.moveTo(xLo, y1); ovlCtx.lineTo(xLo, y2);
      ovlCtx.moveTo(xHi, y1); ovlCtx.lineTo(xHi, y2);
      ovlCtx.stroke();

      // Top edge line (end of transmission = decode moment, newest edge of bar)
      if (yTop >= 0 && yTop <= h) {
        ovlCtx.strokeStyle = color;
        ovlCtx.lineWidth = 1.5;
        ovlCtx.beginPath();
        ovlCtx.moveTo(xLo, yTop); ovlCtx.lineTo(xHi, yTop);
        ovlCtx.stroke();
      }

      // Callsign label — centred on the channel centre frequency
      // Format: "FROM → TO (SNR dB)" or "FROM → TO" if no SNR
      const labelY = Math.max(y1 + 2, 2);
      if (labelY < h - 4) {
        ovlCtx.font         = 'bold 10px monospace';
        ovlCtx.textAlign    = 'center';
        ovlCtx.textBaseline = 'top';
        const snrStr = ev.snr != null ? ` (${Math.round(ev.snr)} dB)` : '';
        const toStr  = ev.to  ? ` \u2192 ${ev.to}` : '';
        const label  = ev.callsign + toStr + snrStr;
        const xCtr   = Math.round((chCfg.freq / WF_MAX_FREQ) * w);
        const tw     = ovlCtx.measureText(label).width;
        // Clamp so the label doesn't overflow the canvas edges
        const cx     = Math.max(tw / 2 + 2, Math.min(w - tw / 2 - 2, xCtr));
        ovlCtx.fillStyle = 'rgba(0,0,0,0.75)';
        ovlCtx.fillRect(cx - tw / 2 - 2, labelY - 1, tw + 4, 12);
        ovlCtx.fillStyle = color;
        ovlCtx.fillText(label, cx, labelY);
      }
      ovlCtx.restore();
    });
  }

  if (mouseX !== null) {
    const audioHz = Math.round((mouseX / w) * WF_MAX_FREQ);
    const label   = `${audioHz} Hz`;

    ovlCtx.save();
    ovlCtx.strokeStyle = 'rgba(255,255,255,0.6)';
    ovlCtx.lineWidth   = 1;
    ovlCtx.setLineDash([3, 3]);
    ovlCtx.beginPath();
    ovlCtx.moveTo(mouseX, 0); ovlCtx.lineTo(mouseX, h);
    ovlCtx.stroke();
    ovlCtx.restore();

    ovlCtx.font = 'bold 10px monospace';
    const tw = ovlCtx.measureText(label).width;
    const bw = tw + 8, bh = 14;
    let bx = mouseX + 6;
    if (bx + bw > w) bx = mouseX - bw - 6;
    ovlCtx.fillStyle = 'rgba(0,0,0,0.75)';
    ovlCtx.beginPath();
    if (ovlCtx.roundRect) ovlCtx.roundRect(bx, 4, bw, bh, 3);
    else ovlCtx.rect(bx, 4, bw, bh);
    ovlCtx.fill();
    ovlCtx.fillStyle = '#fff';
    ovlCtx.textBaseline = 'top';
    ovlCtx.fillText(label, bx + 4, 7);
  }
}

/**
 * Attach a waterfall to a channel card.
 * Returns a { stop } handle.
 * channelFreqs: [{enabled, freq, modem}, ...]
 */
function attachWaterfall(wfWrap, label, channelFreqs) {
  // Build canvas stack
  const wfBody = el('div', 'wf-body');
  const hdrCanvas = document.createElement('canvas');
  hdrCanvas.className = 'wf-hdr-canvas';
  hdrCanvas.height = WF_HDR_H;

  const wfCanvas  = document.createElement('canvas');
  wfCanvas.className = 'wf-canvas';
  wfCanvas.height = WF_HEIGHT;

  const ovlCanvas = document.createElement('canvas');
  ovlCanvas.className = 'wf-ovl-canvas';
  ovlCanvas.height = WF_HEIGHT;

  wfBody.appendChild(hdrCanvas);
  const wfStack = el('div', 'wf-stack');
  wfStack.appendChild(wfCanvas);
  wfStack.appendChild(ovlCanvas);
  wfBody.appendChild(wfStack);
  wfWrap.appendChild(wfBody);

  // Size canvases to container width
  function resize() {
    const w = Math.max(wfBody.getBoundingClientRect().width || 400, 200);
    [hdrCanvas, wfCanvas, ovlCanvas].forEach(c => { c.width = w; });
    hdrCtx.fillStyle = '#000';
    hdrCtx.fillRect(0, 0, w, WF_HEIGHT);
    drawWaterfallHeader(hdrCtx, channelFreqs);
    drawWaterfallOverlay(ovlCtx, channelFreqs, null, txEvents, wfLineCount);
  }

  const hdrCtx = hdrCanvas.getContext('2d');
  const wfCtx  = wfCanvas.getContext('2d');
  const ovlCtx = ovlCanvas.getContext('2d');

  let mouseX = null;
  ovlCanvas.addEventListener('mousemove', e => {
    const rect = ovlCanvas.getBoundingClientRect();
    mouseX = (e.clientX - rect.left) * (ovlCanvas.width / rect.width);
    drawWaterfallOverlay(ovlCtx, channelFreqs, mouseX, txEvents, wfLineCount);
  });
  ovlCanvas.addEventListener('mouseleave', () => {
    mouseX = null;
    drawWaterfallOverlay(ovlCtx, channelFreqs, null, txEvents, wfLineCount);
  });

  // Delay resize until element is in DOM
  requestAnimationFrame(() => resize());
  const ro = new ResizeObserver(() => resize());
  ro.observe(wfBody);

  // TX event ring — each entry: { callsign, smCh, startMs, durationMs }
  // startMs is performance.now() at the moment the frame was decoded.
  const TX_RING_MAX = 40;
  const txEvents = [];

  // Web Audio setup
  let audioCtx = null, analyser = null, gainNode = null, fftBuf = null;
  // fetch-based streaming state (replaces <audio>/createMediaElementSource for Safari compat)
  let audioFetchCtrl = null;   // AbortController for the active fetch
  let audioNextTime  = 0;      // AudioContext time to schedule the next buffer
  let audioSampleRate = 0;     // sample rate parsed from WAV header
  let audioHeaderParsed = false;
  let audioAccum = new Uint8Array(0); // accumulator for partial PCM data
  let audioStreamGen = 0;      // incremented on each startAudio() to invalidate stale callbacks
  // Scheduling constants
  const AUDIO_SCHEDULE_AHEAD_S = 0.1;
  const AUDIO_MAX_LEAD_S       = 0.4;
  const AUDIO_CHUNK_BYTES      = 4410; // ~200 ms at 11025 Hz mono S16LE
  let wfLastLineAt = 0, wfRafId = null, stopped = false;
  // wfLineCount: total lines rendered since start — used to convert time → row position
  let wfLineCount = 0;
  // Map from performance.now() → wfLineCount at that moment (sampled each rendered line)
  // We store the last rendered line's timestamp so we can interpolate.
  let wfLastLineMs = 0;

  function renderLine() {
    if (stopped || !analyser) return;
    wfRafId = requestAnimationFrame(renderLine);

    if (!fftBuf || fftBuf.length !== analyser.frequencyBinCount) {
      fftBuf = new Uint8Array(analyser.frequencyBinCount);
    }
    analyser.getByteFrequencyData(fftBuf);

    const now = performance.now();
    if (now - wfLastLineAt < WF_LINE_MS) return;
    wfLastLineAt = now;
    wfLastLineMs = now;
    wfLineCount++;

    const w = wfCtx.canvas.width;
    const h = wfCtx.canvas.height;
    const nyquist  = audioCtx.sampleRate / 2;
    const totalBins = fftBuf.length;

    // Scroll down 1px
    wfCtx.drawImage(wfCtx.canvas, 0, 0, w, h - 1, 0, 1, w, h - 1);

    // New line at top
    const imgData = wfCtx.createImageData(w, 1);
    const d = imgData.data;
    for (let px = 0; px < w; px++) {
      const freq   = (px / w) * WF_MAX_FREQ;
      const binIdx = Math.min(Math.round((freq / nyquist) * totalBins), totalBins - 1);
      const val    = fftBuf[binIdx];
      d[px * 4]     = wfColorR(val);
      d[px * 4 + 1] = wfColorG(val);
      d[px * 4 + 2] = wfColorB(val);
      d[px * 4 + 3] = 255;
    }
    wfCtx.putImageData(imgData, 0, 0);

    // Redraw overlay to scroll tx markers
    drawWaterfallOverlay(ovlCtx, channelFreqs, mouseX, txEvents, wfLineCount);
  }

  function startAudio() {
    // Abort any previous fetch stream.
    if (audioFetchCtrl) { audioFetchCtrl.abort(); audioFetchCtrl = null; }

    // Reset per-stream state.
    audioSampleRate   = 0;
    audioHeaderParsed = false;
    audioAccum        = new Uint8Array(0);
    audioStreamGen++;

    // Create AudioContext + graph once (reuse across reconnects so
    // currentTime is monotonically increasing and the scheduler stays coherent).
    // This must be called from a user-gesture handler on Safari.
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.6;

      // GainNode sits between analyser and destination so we can silence
      // output (gain=0) without disrupting the analyser's data feed.
      gainNode = audioCtx.createGain();
      gainNode.gain.value = 0.8;
      analyser.connect(gainNode);
      gainNode.connect(audioCtx.destination);
    } else {
      audioCtx.resume().catch(() => {});
    }

    // Start the RAF waterfall loop now that the analyser exists.
    if (!wfRafId) wfRafId = requestAnimationFrame(renderLine);

    const myCtrl = new AbortController();
    audioFetchCtrl = myCtrl;
    const capturedGen = audioStreamGen;

    const url = BASE + '/api/audio/' + encodeURIComponent(label);
    console.log('[waterfall] starting audio fetch:', url);

    fetch(url, { signal: myCtrl.signal })
      .then(resp => {
        if (!resp.ok) throw new Error('audio HTTP ' + resp.status);
        const reader = resp.body.getReader();
        function pump() {
          return reader.read().then(({ done, value }) => {
            if (done || audioFetchCtrl !== myCtrl) return;
            processAudioChunk(value, capturedGen);
            return pump();
          });
        }
        return pump();
      })
      .then(() => {
        if (audioFetchCtrl !== myCtrl || stopped) return;
        console.log('[waterfall] audio stream ended — reconnecting in 500 ms');
        setTimeout(() => { if (!stopped && audioFetchCtrl === myCtrl) startAudio(); }, 500);
      })
      .catch(err => {
        if (err.name === 'AbortError') return;
        console.warn('[waterfall] audio fetch error:', err);
        if (audioFetchCtrl !== myCtrl || stopped) return;
        setTimeout(() => { if (!stopped && audioFetchCtrl === myCtrl) startAudio(); }, 1000);
      });
  }

  // Accumulate incoming bytes; once we have the WAV header + enough PCM,
  // decode and schedule AudioBufferSourceNodes.
  function processAudioChunk(bytes, capturedGen) {
    if (!bytes || bytes.length === 0) return;
    const merged = new Uint8Array(audioAccum.length + bytes.length);
    merged.set(audioAccum);
    merged.set(bytes, audioAccum.length);
    audioAccum = merged;

    // Parse the 44-byte WAV header once.
    if (!audioHeaderParsed) {
      if (audioAccum.length < 44) return;
      const view = new DataView(audioAccum.buffer);
      audioSampleRate   = view.getUint32(24, true);
      audioHeaderParsed = true;
      audioAccum        = audioAccum.slice(44);
    }

    // Decode and schedule complete chunks.
    while (audioAccum.length >= AUDIO_CHUNK_BYTES) {
      const pcm  = audioAccum.slice(0, AUDIO_CHUNK_BYTES);
      audioAccum = audioAccum.slice(AUDIO_CHUNK_BYTES);
      schedulePCMChunk(pcm, capturedGen);
    }
  }

  // Wrap raw S16LE PCM bytes in a minimal WAV container, decode via
  // AudioContext.decodeAudioData, then schedule the resulting AudioBufferSourceNode.
  // Each source node is connected: src → analyser → gainNode → destination
  // so the AnalyserNode receives data for the waterfall FFT.
  function schedulePCMChunk(pcm, capturedGen) {
    if (!audioCtx || !analyser || !gainNode) return;
    const sr = audioSampleRate || 11025;

    // Assign the scheduled start time synchronously before the async decode
    // so that ordering is guaranteed even when decodes complete out of order.
    const now = audioCtx.currentTime;
    if (audioNextTime < now || audioNextTime > now + AUDIO_MAX_LEAD_S) {
      audioNextTime = now + AUDIO_SCHEDULE_AHEAD_S;
    }
    const chunkDuration = pcm.length / 2 / sr; // S16LE mono: 2 bytes/sample
    const startTime = audioNextTime;
    audioNextTime += chunkDuration;

    // Build a minimal WAV container around the raw PCM.
    const wavBuf = new ArrayBuffer(44 + pcm.length);
    const view   = new DataView(wavBuf);
    const enc    = new TextEncoder();
    const wr4    = (off, s) => { const b = enc.encode(s); for (let i = 0; i < 4; i++) view.setUint8(off + i, b[i]); };
    wr4(0,  'RIFF');
    view.setUint32(4,  36 + pcm.length, true);
    wr4(8,  'WAVE');
    wr4(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1,  true); // PCM
    view.setUint16(22, 1,  true); // mono
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * 2, true);
    view.setUint16(32, 2,  true);
    view.setUint16(34, 16, true);
    wr4(36, 'data');
    view.setUint32(40, pcm.length, true);
    new Uint8Array(wavBuf, 44).set(pcm);

    audioCtx.decodeAudioData(wavBuf).then(audioBuf => {
      if (audioStreamGen !== capturedGen) return; // stale — stream was replaced
      const src = audioCtx.createBufferSource();
      src.buffer = audioBuf;
      // Route through analyser so the waterfall FFT sees the audio data.
      src.connect(analyser);
      src.start(startTime);
    }).catch(err => {
      console.warn('[waterfall] decodeAudioData:', err);
    });
  }

  startAudio();

  return {
    stop() {
      stopped = true;
      if (wfRafId) cancelAnimationFrame(wfRafId);
      ro.disconnect();
      if (audioFetchCtrl) { audioFetchCtrl.abort(); audioFetchCtrl = null; }
      audioStreamGen++; // invalidate any in-flight decodeAudioData callbacks
      if (analyser) try { analyser.disconnect(); } catch(_){}
      if (gainNode) try { gainNode.disconnect(); } catch(_){}
      if (audioCtx) audioCtx.close().catch(()=>{});
    },
    toggleMute() {
      if (!gainNode) return false;
      const muted = gainNode.gain.value === 0;
      gainNode.gain.value = muted ? 0.8 : 0;
      return !muted; // returns new muted state
    },
    isMuted() {
      return gainNode ? gainNode.gain.value === 0 : false;
    },
    redrawHeader(newChannelFreqs) {
      channelFreqs = newChannelFreqs;
      drawWaterfallHeader(hdrCtx, channelFreqs);
      drawWaterfallOverlay(ovlCtx, channelFreqs, mouseX, txEvents, wfLineCount);
    },
    // Called by renderChannelCard when a decoded frame arrives.
    // entry: { from, smCh } — the decoded frame entry.
    // modemIdx: the modem type index for this sub-channel (used to look up TX duration).
    notifyFrame(entry, modemIdx) {
      if (!entry.from) return;
      const durationMs    = MODEM_TX_MS[modemIdx] ?? 570;
      const durationLines = Math.max(2, Math.round(durationMs / WF_LINE_MS));

      // Compensate for the audio scheduler's lookahead.
      // audioNextTime is the AudioContext time of the next chunk to be scheduled;
      // audioCtx.currentTime is what is currently playing.  The difference is how
      // far ahead the scheduler is running relative to the playhead — i.e. how
      // many seconds of audio are queued but not yet heard.  Convert to waterfall
      // lines and shift the TX marker forward (down) so it aligns with the audio.
      let bufferLines = 0;
      if (audioCtx) {
        const bufferSec = audioNextTime - audioCtx.currentTime;
        if (bufferSec > 0 && bufferSec < 30) { // sanity-clamp
          bufferLines = Math.round(bufferSec * 1000 / WF_LINE_MS);
        }
      }

      // The decode fires AFTER the full frame has been received, so the
      // transmission already happened durationLines rows ago. Place the bar
      // so its bottom edge aligns with the current waterfall position (decode
      // moment) and its top edge is durationLines rows above (already scrolled).
      // bufferLines shifts the marker forward to compensate for audio buffering.
      txEvents.push({
        callsign:      entry.from,
        to:            entry.to  || '',
        snr:           isNaN(entry.snr) ? null : entry.snr,
        smCh:          entry.smCh,
        startLine:     wfLineCount - durationLines + bufferLines,
        durationLines,
      });
      // Keep ring bounded
      if (txEvents.length > TX_RING_MAX) txEvents.shift();
      // Immediately redraw overlay so the marker appears at the top
      drawWaterfallOverlay(ovlCtx, channelFreqs, mouseX, txEvents, wfLineCount);
    },
  };
}

// ---------------------------------------------------------------------------
// Channel card rendering
// ---------------------------------------------------------------------------

const channelState = {};

function getState(id) {
  if (!channelState[id]) {
    channelState[id] = {
      frames:        [],
      dcd:           [false, false, false, false],
      dcdTimers:     [null, null, null, null],
      filter:        { type: 'all', smCh: 'all', from: '', to: '', search: '', maxFrames: 10 },
      lastFrameTime: null,
      lastCallsign:  null,
      agoTimer:      null,
    };
  }
  return channelState[id];
}

function renderChannelCard(ch) {
  const id = ch.id;
  const state = getState(id);

  const card = el('div', 'channel-card');
  card.dataset.channelId = id;

  // ── Header ──
  const hdr = el('div', 'channel-header');
  const labelEl = el('span', 'channel-label', ch.label);
  const freqEl  = el('span', 'channel-freq',
    fmtFreq(ch.instance.freq_hz) + ' ' + ch.instance.audio_mode.toUpperCase());
  const statusBadge = el('span', 'channel-status-badge ' + (ch.instance.status || ''),
    ch.instance.status || 'stopped');
  // MQTT topic badge — always created; text and visibility updated dynamically
  // via _updateStatus so it reflects the current global prefix from window.state.
  const mqttSuffix = ch.mqtt_topic_prefix || ch.label;
  const mqttBadge = el('span', 'channel-mqtt-badge');
  const updateMqttBadge = () => {
    const as = window.state;
    if (as && as.mqttConfigured) {
      mqttBadge.textContent = '📡 ' + (as.mqttTopicPrefix ? as.mqttTopicPrefix + '/' + mqttSuffix : mqttSuffix);
      mqttBadge.classList.remove('hidden');
    } else {
      mqttBadge.classList.add('hidden');
    }
  };
  updateMqttBadge();

  const dcdSmCh = (ch.modem_config || {}).channels || [];

  function buildDCDTooltip(i) {
    const cfg     = dcdSmCh[i] || {};
    const enabled = cfg.enabled !== false;
    const modemIdx = cfg.modem ?? 0;
    const freq     = cfg.freq  ?? 850;
    const rcvr     = cfg.rcvr_pairs ?? 0;
    const fx25     = cfg.fx25 ?? 1;
    const il2p     = cfg.il2p ?? 2;
    const modemLabel = MODEM_LABELS[modemIdx] ?? `Modem ${modemIdx}`;
    const rcvrLabel  = rcvr === 0 ? '0 (off)' : String(rcvr);
    const fx25Label  = fx25 === 0 ? 'Off' : 'On';
    const il2pLabels = { 0: 'Off', 1: 'IL2P', 2: 'IL2P+CRC', 3: 'Both' };
    const il2pLabel  = il2pLabels[il2p] ?? String(il2p);
    const statusLine = enabled ? '✔ Enabled' : '✘ Disabled';
    return `Ch ${CH_NAMES[i]} — ${statusLine}\nModem: ${modemLabel}\nFreq: ${freq} Hz\nRcvr Pairs: ${rcvrLabel}\nFX.25: ${fx25Label}\nIL2P: ${il2pLabel}`;
  }

  function updateDCDLed(i, on) {
    const led = dcdLeds[i];
    if (!led) return;
    const cfg     = dcdSmCh[i] || {};
    const enabled = cfg.enabled !== false;
    led.classList.toggle('on',       on);
    led.classList.toggle('disabled', !enabled);
    led.title = buildDCDTooltip(i);
  }

  const dcdRow = el('div', 'dcd-indicators');
  const dcdLeds = [];
  for (let i = 0; i < 4; i++) {
    const cfg     = dcdSmCh[i] || {};
    const enabled = cfg.enabled !== false;
    const led = el('div', `dcd-led dcd-led-${i}${state.dcd[i] ? ' on' : ''}${!enabled ? ' disabled' : ''}`);
    led.title = buildDCDTooltip(i);
    dcdLeds.push(led);
    dcdRow.appendChild(led);
  }

  const actions = el('div', 'channel-actions');

  const btnSNR = el('button', 'btn btn-secondary btn-sm btn-snr-history', '📈 SNR');
  btnSNR.title = 'View SNR history for senders on this channel';
  btnSNR.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.SNRHistory) window.SNRHistory.open(ch.label);
  });
  actions.appendChild(btnSNR);

  const btnStats = el('button', 'btn btn-secondary btn-sm btn-stats', '📊 Stats');
  btnStats.title = 'View frame statistics for this channel';
  btnStats.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.StatsModal) window.StatsModal.open(ch.label);
  });
  actions.appendChild(btnStats);

  const btnDel = el('button', 'btn btn-danger btn-sm', 'Remove');
  btnDel.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (window.state && window.state.passwordConfigured && !window.state.authed) {
      showLoginModal(); return;
    }
    if (!confirm(`Remove channel "${ch.label}"?`)) return;
    const resp = await fetch(BASE + '/api/channels/' + encodeURIComponent(ch.label), { method: 'DELETE' });
    if (resp.status === 401) { showLoginModal(); return; }
    if (resp.ok) loadChannels();
    else alert('Error removing channel');
  });
  actions.appendChild(btnDel);

  hdr.appendChild(labelEl);
  hdr.appendChild(freqEl);
  hdr.appendChild(statusBadge);
  hdr.appendChild(mqttBadge);
  hdr.appendChild(dcdRow);
  hdr.appendChild(actions);
  card.appendChild(hdr);

  // ── Waterfall ──
  const wfSection = el('div', 'wf-section');
  card.appendChild(wfSection);

  // Build channel freq list from modem config for the waterfall header
  function getChannelFreqs() {
    const smChannels = (ch.modem_config || {}).channels || [];
    return smChannels.map(c => ({
      enabled: !!(c && c.enabled),
      freq:    (c && c.freq)  || 0,
      modem:   (c && c.modem) || 0,
    }));
  }

  let wfHandle = null;
  const wfWrap = el('div', 'wf-wrap');

  const wfBtnRow = el('div', 'wf-btn-row');
  const btnPreview = el('button', 'btn btn-secondary btn-sm', '▶ Preview');
  const btnMute = el('button', 'btn btn-secondary btn-sm wf-mute-btn', '🔇 Mute');
  btnMute.style.display = 'none';

  // Collapsed-state summary: last decoded frame line (from→to payload)
  // Shown only when the channel body is collapsed (CSS hides it when expanded)
  const collapsedInfo = el('div', 'wf-collapsed-info');
  btnPreview.addEventListener('click', () => {
    if (wfHandle) {
      wfHandle.stop();
      wfHandle = null;
      wfWrap.innerHTML = '';
      btnPreview.textContent = '▶ Preview';
      btnMute.style.display = 'none';
      btnMute.textContent = '🔇 Mute';
    } else {
      btnPreview.textContent = '◼ Stop';
      wfHandle = attachWaterfall(wfWrap, ch.label, getChannelFreqs());
      btnMute.style.display = '';
    }
  });
  btnMute.addEventListener('click', () => {
    if (!wfHandle) return;
    const nowMuted = wfHandle.toggleMute();
    btnMute.textContent = nowMuted ? '🔊 Unmute' : '🔇 Mute';
  });
  wfBtnRow.appendChild(btnPreview);
  wfBtnRow.appendChild(btnMute);
  wfBtnRow.appendChild(collapsedInfo);
  wfSection.appendChild(wfBtnRow);
  wfSection.appendChild(wfWrap);

  // ── Body ──
  const body = el('div', 'channel-body');
  card.appendChild(body);

  hdr.addEventListener('click', (e) => {
    if (e.target.closest('.channel-actions')) return;
    const nowCollapsed = body.classList.toggle('collapsed');
    card.classList.toggle('body-collapsed', nowCollapsed);
  });

  // ── Tabs ──
  const tabs = el('div', 'channel-tabs');
  const panes = {};

  function addTab(key, label) {
    const btn = el('button', 'tab-btn' + (key === 'frames' ? ' active' : ''), label);
    const pane = el('div', 'tab-pane' + (key === 'frames' ? ' active' : ''));
    pane.dataset.tab = key;
    btn.addEventListener('click', () => {
      tabs.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      body.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      pane.classList.add('active');
      // Scroll scrollable lists to bottom when switching to their tab
      const scrollable = pane.querySelector('.frames-list, .log-list, .monitor-list');
      if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
    });
    tabs.appendChild(btn);
    panes[key] = pane;
    return pane;
  }

  const framesPane  = addTab('frames',  'Frames');
  const monitorPane = addTab('monitor', 'Monitor');
  const logPane     = addTab('log',     'Log');
  const configPane  = addTab('config',  'Config');

  body.appendChild(tabs);
  Object.values(panes).forEach(p => body.appendChild(p));

  // ── Frames pane ──
  const toolbar = el('div', 'frames-toolbar');

  // Type filter — matches extension options exactly
  const selType = document.createElement('select');
  [['all','All'],['aprs','APRS'],['ui','UI'],['connected','Connected'],
   ['netrom','NET/ROM'],['control','S-frames'],['ip','IP/ARP']].forEach(([v,t]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = t;
    selType.appendChild(o);
  });
  selType.addEventListener('change', () => { state.filter.type = selType.value; renderFrames(); });

  // Channel filter
  const selSmCh = document.createElement('select');
  [['all','All'],...CH_NAMES.map((n,i) => [String(i), n])].forEach(([v,t]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = t;
    selSmCh.appendChild(o);
  });
  selSmCh.addEventListener('change', () => { state.filter.smCh = selSmCh.value; renderFrames(); });

  // Max frames
  const selMax = document.createElement('select');
  [[10,'10'],[25,'25'],[50,'50'],[100,'100'],[250,'250'],[500,'500'],[0,'∞']].forEach(([v,t]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = t;
    if (v === 10) o.selected = true;
    selMax.appendChild(o);
  });
  selMax.addEventListener('change', () => { state.filter.maxFrames = parseInt(selMax.value) || 0; renderFrames(); });

  const btnClear = el('button', 'btn btn-secondary btn-sm', 'Clear');
  const btnCopy  = el('button', 'btn btn-secondary btn-sm', 'Copy');
  btnCopy.title = 'Copy visible frames to clipboard';
  btnCopy.addEventListener('click', () => {
    // Collect text from each visible frame row
    const rows = Array.from(framesList.children);
    if (!rows.length) return;
    const text = rows.map(r => r.textContent.replace(/\s+/g, ' ').trim()).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      const orig = btnCopy.textContent;
      btnCopy.textContent = '✔ Copied';
      setTimeout(() => { btnCopy.textContent = orig; }, 2000);
    }).catch(err => console.warn('[copy] failed:', err));
  });
  const countEl = el('span', 'frame-count', '0 frames');

  toolbar.appendChild(el('label', 'text-dim', 'Type:'));
  toolbar.appendChild(selType);
  toolbar.appendChild(el('label', 'text-dim', 'Ch:'));
  toolbar.appendChild(selSmCh);
  toolbar.appendChild(el('label', 'text-dim', 'Max:'));
  toolbar.appendChild(selMax);
  toolbar.appendChild(btnClear);
  toolbar.appendChild(btnCopy);
  toolbar.appendChild(countEl);
  framesPane.appendChild(toolbar);

  // ── Search bar (Sender dropdown, Destination dropdown, text search) ──
  const searchBar = el('div', 'frames-search-bar');

  // Sender dropdown (populated dynamically)
  const selFrom = document.createElement('select');
  selFrom.className = 'search-bar-select';
  selFrom.title = 'Filter by sender';
  selFrom.appendChild(Object.assign(document.createElement('option'), { value: '', textContent: 'Sender' }));
  selFrom.addEventListener('change', () => { state.filter.from = selFrom.value; renderFrames(); });

  // Destination dropdown (populated dynamically)
  const selTo = document.createElement('select');
  selTo.className = 'search-bar-select';
  selTo.title = 'Filter by destination';
  selTo.appendChild(Object.assign(document.createElement('option'), { value: '', textContent: 'Destination' }));
  selTo.addEventListener('change', () => { state.filter.to = selTo.value; renderFrames(); });

  // Text search input
  const searchIcon = el('span', 'search-icon', '🔍');
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'search-input';
  searchInput.placeholder = 'Filter by content…';
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;
  searchInput.addEventListener('input', () => {
    state.filter.search = searchInput.value.trim().toLowerCase();
    renderFrames();
  });

  // Clear search button
  const btnSearchClear = el('button', 'btn-search-clear', '✕');
  btnSearchClear.title = 'Clear filter';
  btnSearchClear.addEventListener('click', () => {
    state.filter.from = '';
    state.filter.to = '';
    state.filter.search = '';
    selFrom.value = '';
    selTo.value = '';
    searchInput.value = '';
    renderFrames();
  });

  searchBar.appendChild(selFrom);
  searchBar.appendChild(selTo);
  searchBar.appendChild(searchIcon);
  searchBar.appendChild(searchInput);
  searchBar.appendChild(btnSearchClear);
  framesPane.appendChild(searchBar);

  // ── Stats bar (Frames count + Last callsign / time ago) ──
  const statsBar = el('div', 'frames-stats-bar');
  const statsFrames = el('span', 'frames-stat', '0 frames');
  const statsSep    = el('span', 'frames-stat-sep', '|');
  const statsLastLbl = el('span', 'frames-stat-label', 'Last:');
  const statsLastCall = el('span', 'frames-stat-callsign', '---');
  const statsLastAgo  = el('span', 'frames-stat-ago', '');
  statsBar.appendChild(statsFrames);
  statsBar.appendChild(statsSep);
  statsBar.appendChild(statsLastLbl);
  statsBar.appendChild(statsLastCall);
  statsBar.appendChild(statsLastAgo);
  framesPane.appendChild(statsBar);

  function updateAgoDisplay() {
    if (!state.lastFrameTime) { statsLastAgo.textContent = ''; return; }
    statsLastAgo.textContent = formatAgo(Date.now() - state.lastFrameTime);
  }

  function startAgoTimer() {
    if (state.agoTimer) return;
    state.agoTimer = setInterval(updateAgoDisplay, 1000);
  }

  function stopAgoTimer() {
    if (state.agoTimer) { clearInterval(state.agoTimer); state.agoTimer = null; }
    statsLastAgo.textContent = '';
  }

  // Wire up Clear button now that all elements are in scope
  btnClear.addEventListener('click', () => {
    state.frames = [];
    state.filter.from = ''; state.filter.to = ''; state.filter.search = '';
    // Reset sender/dest dropdowns
    seenFrom.clear(); seenTo.clear();
    while (selFrom.options.length > 1) selFrom.remove(1);
    while (selTo.options.length > 1) selTo.remove(1);
    selFrom.value = ''; selTo.value = '';
    searchInput.value = '';
    // Reset last-callsign stats
    state.lastFrameTime = null;
    state.lastCallsign  = null;
    statsLastCall.textContent = '---';
    stopAgoTimer();
    renderFrames();
  });

  const framesList = el('div', 'frames-list');
  framesPane.appendChild(framesList);

  // Sets for tracking unique callsigns seen in sender/dest dropdowns
  const seenFrom = new Set();
  const seenTo   = new Set();

  function updateCallsignDropdowns(entry) {
    if (entry.from && !seenFrom.has(entry.from)) {
      seenFrom.add(entry.from);
      const o = document.createElement('option'); o.value = entry.from; o.textContent = entry.from;
      selFrom.appendChild(o);
    }
    if (entry.to && !seenTo.has(entry.to)) {
      seenTo.add(entry.to);
      const o = document.createElement('option'); o.value = entry.to; o.textContent = entry.to;
      selTo.appendChild(o);
    }
  }

  const CONNECTED_CSS = new Set(['i','rr','rnr','rej','srej','sabm','sabme','ua','disc','dm','frmr','xid','test']);
  const CONTROL_CSS   = new Set(['rr','rnr','rej','srej']);

  function frameMatchesType(entry, typeFilter) {
    if (typeFilter === 'all') return true;
    const p = entry.parsed;
    const ft = p ? (p.frameType || 'ui') : 'raw';
    const cssType = (ft.startsWith('l4-') || ft === 'netrom' || ft === 'nodes') ? 'netrom' : ft;
    switch (typeFilter) {
      case 'aprs':     return cssType === 'aprs';
      case 'ui':       return cssType === 'ui' || cssType === 'aprs';
      case 'connected':return CONNECTED_CSS.has(cssType);
      case 'netrom':   return cssType === 'netrom' || cssType === 'nodes';
      case 'control':  return CONTROL_CSS.has(cssType);
      case 'ip':       return cssType === 'ip' || cssType === 'arp';
      default:         return true;
    }
  }

  function renderFrames() {
    const f = state.filter;
    let rows = state.frames;
    if (f.smCh !== 'all') rows = rows.filter(r => String(r.smCh) === f.smCh);
    if (f.type  && f.type !== 'all') rows = rows.filter(r => frameMatchesType(r, f.type));
    if (f.from) rows = rows.filter(r => (r.from || '').toLowerCase() === f.from.toLowerCase());
    if (f.to)   rows = rows.filter(r => (r.to   || '').toLowerCase() === f.to.toLowerCase());
    if (f.search) {
      const q = f.search;
      rows = rows.filter(r => {
        const p = r.parsed || {};
        const haystack = [
          r.from || '', r.to || '',
          (p.info || r.raw || ''),
          (p.comment || ''), (p.dest || ''),
          ...(p.digipeaters || []),
        ].join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }
    if (f.maxFrames > 0) rows = rows.slice(-f.maxFrames);
    countEl.textContent = state.frames.length + ' frames';
    statsFrames.textContent = state.frames.length + ' frames';

    const framesAtBottom = framesList.scrollHeight - framesList.scrollTop - framesList.clientHeight < 40;
    framesList.innerHTML = '';
    rows.forEach(r => framesList.appendChild(buildFrameRow(r)));
    if (framesAtBottom) framesList.scrollTop = framesList.scrollHeight;
  }

  // ── Monitor pane ──
  const monitorToolbar = el('div', 'monitor-toolbar');
  const btnMonClear = el('button', 'btn btn-secondary btn-sm', 'Clear');
  btnMonClear.addEventListener('click', () => {
    monitorList.innerHTML = '';
    state.monitor = [];
  });
  monitorToolbar.appendChild(btnMonClear);
  monitorPane.appendChild(monitorToolbar);

  const monitorList = el('div', 'monitor-list');
  monitorPane.appendChild(monitorList);

  let monitorLines = 0;
  function appendMonitor(smCh, isTX, text) {
    const timeStr = new Date().toTimeString().slice(0, 8);
    const line = document.createElement('div');
    line.className = 'monitor-line ' + (isTX ? 'tx' : 'rx');

    const timeEl = el('span', 'monitor-time', timeStr);
    const badge  = el('span', `monitor-ch-badge monitor-ch-badge-${smCh}`, CH_NAMES[smCh] || String(smCh));
    const dirEl  = el('span', 'monitor-dir', isTX ? 'TX' : 'RX');
    const textEl = el('span', 'monitor-text', text);

    line.appendChild(timeEl);
    line.appendChild(badge);
    line.appendChild(dirEl);
    line.appendChild(textEl);
    const monitorAtBottom = monitorList.scrollHeight - monitorList.scrollTop - monitorList.clientHeight < 40;
    monitorList.appendChild(line);
    monitorLines++;

    while (monitorLines > MAX_MONITOR) {
      monitorList.removeChild(monitorList.firstChild);
      monitorLines--;
    }
    if (monitorAtBottom) monitorList.scrollTop = monitorList.scrollHeight;
  }

  // ── Log pane ──
  const logToolbar = el('div', 'log-toolbar');
  const btnLogClear = el('button', 'btn btn-secondary btn-sm', 'Clear');
  btnLogClear.addEventListener('click', () => {
    logList.innerHTML = '';
    logLines = 0;
  });
  logToolbar.appendChild(btnLogClear);
  logPane.appendChild(logToolbar);

  const logList = el('div', 'log-list');
  logPane.appendChild(logList);

  let logLines = 0;
  function appendLog(text) {
    const timeStr = new Date().toTimeString().slice(0, 8);
    const line = document.createElement('div');
    line.className = 'log-line';

    const timeEl = el('span', 'log-time', timeStr);
    const textEl = el('span', 'log-text', text);
    line.appendChild(timeEl);
    line.appendChild(textEl);
    logList.appendChild(line);
    logLines++;

    while (logLines > MAX_LOG) {
      logList.removeChild(logList.firstChild);
      logLines--;
    }
    // Auto-scroll only if already near bottom
    const atBottom = logList.scrollHeight - logList.scrollTop - logList.clientHeight < 40;
    if (atBottom) logList.scrollTop = logList.scrollHeight;
  }

  // ── Config pane ──
  // Locking is driven by body.pw-configured:not(.is-authed) CSS selector,
  // so no per-card isLocked flag is needed here.
  const cfgPane = el('div', 'config-pane');

  // Channel settings row (name, freq, mode, bandwidth)
  const chSettingsRow = el('div', 'ch-settings-row');

  const nameLabel = el('label', 'ch-setting-label', 'Display Name');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'ch-setting-input';
  nameInput.placeholder = ch.label;
  nameInput.value = ch.name || '';
  nameLabel.appendChild(nameInput);
  chSettingsRow.appendChild(nameLabel);

  const freqLabel = el('label', 'ch-setting-label', 'Frequency (Hz)');
  const freqInput = document.createElement('input');
  freqInput.type = 'number';
  freqInput.className = 'ch-setting-input';
  freqInput.min = '1';
  freqInput.value = (ch.instance && ch.instance.freq_hz) || '';
  freqLabel.appendChild(freqInput);
  chSettingsRow.appendChild(freqLabel);

  const modeLabel = el('label', 'ch-setting-label', 'Mode');
  const modeSelect = document.createElement('select');
  modeSelect.className = 'ch-setting-input ch-setting-input-narrow';
  ['usb', 'lsb'].forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m.toUpperCase();
    if ((ch.instance && ch.instance.audio_mode) === m) opt.selected = true;
    modeSelect.appendChild(opt);
  });
  modeLabel.appendChild(modeSelect);
  chSettingsRow.appendChild(modeLabel);

  const bwLabel = el('label', 'ch-setting-label', 'Bandwidth Hz (0=default)');
  const bwInput = document.createElement('input');
  bwInput.type = 'number';
  bwInput.className = 'ch-setting-input ch-setting-input-narrow';
  bwInput.min = '0';
  bwInput.value = ch.bandwidth_hz || 0;
  bwLabel.appendChild(bwInput);
  chSettingsRow.appendChild(bwLabel);

  cfgPane.appendChild(chSettingsRow);

  cfgPane.appendChild(el('h4', '', 'Modem Channel Configuration'));
  const cfgGrid = el('div', 'config-modem-grid');
  cfgPane.appendChild(cfgGrid);

  const smCfg = ch.modem_config || {};
  const smChannels = smCfg.channels || [{}, {}, {}, {}];
  for (let i = 0; i < 4; i++) cfgGrid.appendChild(buildModemChannelCard(i, smChannels[i]));

  // MQTT topic row — always rendered; CSS hides it unless body.mqtt-enabled.
  // Split into read-only prefix badge + editable suffix so the full topic path
  // is always visible: [packet/] [mychannel]
  const globalPfx = state.mqttTopicPrefix;
  // mqtt_topic_prefix stores only the suffix (the part after the global prefix).
  // Default to the channel label when nothing is stored.
  const initSuffix = ch.mqtt_topic_prefix || ch.label;
  const mqttRow = el('div', 'mqtt-prefix-row');
  const mqttLabel = el('label', '', '📡 MQTT Topic');
  const mqttTopicField = el('div', 'mqtt-topic-field');
  const mqttPrefixBadge = el('span', 'mqtt-topic-prefix-badge', globalPfx + '/');
  const mqttSuffixInput = document.createElement('input');
  mqttSuffixInput.type = 'text';
  mqttSuffixInput.className = 'mqtt-prefix-input';
  mqttSuffixInput.placeholder = ch.label;
  mqttSuffixInput.value = initSuffix;
  mqttTopicField.appendChild(mqttPrefixBadge);
  mqttTopicField.appendChild(mqttSuffixInput);
  mqttLabel.appendChild(mqttTopicField);
  mqttRow.appendChild(mqttLabel);
  cfgPane.appendChild(mqttRow);

  const cfgActions = el('div', 'config-actions');
  const btnSave = el('button', 'btn btn-primary', 'Save Config');
  btnSave.addEventListener('click', async () => {
    if (window.state && window.state.passwordConfigured && !window.state.authed) {
      showLoginModal(); return;
    }
    const newChannels = readModemChannels(cfgGrid);
    const newCfg = {
      sample_rate:   smCfg.sample_rate || 0,
      dcd_threshold: smCfg.dcd_threshold || 20,
      channels:      newChannels,
    };
    const patchBody = {
      modem_config:  newCfg,
      name:          nameInput.value.trim(),
      freq_hz:       parseInt(freqInput.value) || 0,
      mode:          modeSelect.value,
      bandwidth_hz:  parseInt(bwInput.value) || 0,
    };
    const sfx = mqttSuffixInput.value.trim();
    // Store only the suffix; the global prefix is server-side (MQTT_TOPIC_PREFIX).
    patchBody.mqtt_topic_prefix = sfx;
    const resp = await fetch(BASE + '/api/channels/' + encodeURIComponent(ch.label), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patchBody),
    });
    if (resp.status === 401) { showLoginModal(); return; }
    if (resp.ok) {
      // Update the local ch object so getChannelFreqs() and the waterfall
      // header reflect the newly-saved modem channel config immediately,
      // without requiring a full page reload.
      ch.modem_config = newCfg;
      if (patchBody.name) ch.name = patchBody.name;
      if (patchBody.freq_hz) ch.instance.freq_hz = patchBody.freq_hz;
      if (patchBody.mode)    ch.instance.audio_mode = patchBody.mode;
      ch.bandwidth_hz = patchBody.bandwidth_hz;
      ch.mqtt_topic_prefix = sfx;
      // Redraw the waterfall header/overlay with the updated channel freqs
      // so newly-enabled sub-channels appear immediately on the next Preview.
      if (wfHandle && wfHandle.redrawHeader) {
        wfHandle.redrawHeader(getChannelFreqs());
      }
      btnSave.textContent = 'Saved ✓';
      setTimeout(() => { btnSave.textContent = 'Save Config'; }, 2000);
    } else {
      alert('Error saving config');
    }
  });
  cfgActions.appendChild(btnSave);
  cfgPane.appendChild(cfgActions);
  configPane.appendChild(cfgPane);

  // ── Frame/event handler ──

  // Callsign validity — same filter as the extension to drop noise bursts
  const VALID_CALL = /^[A-Z0-9]{1,6}(-\d{1,2})?$/i;

  const CONNECTED_TYPES = new Set(['i','rr','rnr','rej','srej','sabm','sabme','ua','disc','dm','frmr','xid','test']);
  const CONTROL_TYPES   = new Set(['rr','rnr','rej','srej']);
  const NETROM_TYPES    = new Set(['netrom','nodes','nodes-poll','l4-connect','l4-connect-ack','l4-disc','l4-disc-ack','l4-info','l4-info-ack','l4-reset','l4-unknown']);

  const TYPE_LABELS = {
    aprs:'APRS', ui:'UI', i:'I', rr:'RR', rnr:'RNR', rej:'REJ', srej:'SREJ',
    sabm:'SABM', sabme:'SABME', ua:'UA', disc:'DISC', dm:'DM',
    frmr:'FRMR', xid:'XID', test:'TEST',
    netrom:'NR', nodes:'NODES', ip:'IP', arp:'ARP', s:'S', u:'U',
  };

  // Parse APRS position from info string (uncompressed format)
  function parseAPRSPos(info) {
    if (!info) return null;
    const re = /(\d{2})(\d{2}\.\d+)([NS])[\/\\](\d{3})(\d{2}\.\d+)([EW])/;
    const m = info.match(re);
    if (!m) return null;
    let lat = parseInt(m[1]) + parseFloat(m[2]) / 60;
    let lon = parseInt(m[4]) + parseFloat(m[5]) / 60;
    if (m[3] === 'S') lat = -lat;
    if (m[6] === 'W') lon = -lon;
    return { lat: lat.toFixed(6), lon: lon.toFixed(6),
             latStr: `${m[1]}${m[2]}${m[3]}`, lonStr: `${m[4]}${m[5]}${m[6]}` };
  }

  // Build a rich frame row DOM element matching the extension's layout
  function buildFrameRow(entry) {
    const p = entry.parsed;
    const ft = p ? (p.frameType || 'ui') : 'raw';
    const cssType = NETROM_TYPES.has(ft) ? 'netrom' : ft;

    const row = document.createElement('div');
    row.className = `frame-row frame-type-${cssType} frame-ch-${entry.smCh}`;
    row.dataset.from = entry.from;
    row.dataset.to   = entry.to;

    // Channel badge — tooltip shows modem config for this sub-channel
    const badge = el('span', `frame-ch-badge frame-ch-badge-${entry.smCh}`, CH_NAMES[entry.smCh] || String(entry.smCh));
    badge.title = buildDCDTooltip(entry.smCh);
    row.appendChild(badge);

    // Timestamp
    row.appendChild(el('span', 'frame-time', fmtTime(entry.time)));

    if (!p) {
      // Raw hex fallback
      row.appendChild(el('span', 'frame-raw', entry.hex));
      return row;
    }

    // FROM→TO [via DIGI,...]
    const digiStr = (p.digipeaters || p.via || []).length
      ? ' via ' + (p.digipeaters || p.via).join(',') : '';
    const pathEl = el('span', 'frame-path', `${p.src || p.from || '?'}→${p.dst || p.to || '?'}${digiStr}`);
    row.appendChild(pathEl);

    // Frame-type tag
    const typeTag = el('span', `frame-type-tag frame-type-tag-${cssType}`,
      TYPE_LABELS[cssType] || cssType.toUpperCase());
    row.appendChild(typeTag);

    // Payload with APRS linkification
    const infoText = p.info !== undefined ? String(p.info) : '';
    const payloadEl = el('span', 'frame-payload');
    payloadEl.title = infoText;

    const aprsPos = p.isAPRS ? parseAPRSPos(infoText) : null;
    if (aprsPos) {
      const coordStr = `${aprsPos.latStr}/${aprsPos.lonStr}`;
      const idx = infoText.indexOf(coordStr);
      if (idx >= 0) {
        if (idx > 0) payloadEl.appendChild(document.createTextNode(infoText.slice(0, idx)));
        const a = document.createElement('a');
        a.href = `https://www.google.com/maps?q=${aprsPos.lat},${aprsPos.lon}`;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'frame-aprs-link';
        a.textContent = coordStr;
        payloadEl.appendChild(a);
        payloadEl.appendChild(document.createTextNode(infoText.slice(idx + coordStr.length)));
      } else {
        payloadEl.textContent = infoText;
      }
    } else {
      // Linkify plain URLs
      const urlRe = /https?:\/\/[^\s]+/g;
      let last = 0, m2;
      while ((m2 = urlRe.exec(infoText)) !== null) {
        if (m2.index > last) payloadEl.appendChild(document.createTextNode(infoText.slice(last, m2.index)));
        const a = document.createElement('a');
        a.href = m2[0]; a.target = '_blank'; a.rel = 'noopener';
        a.className = 'frame-url-link'; a.textContent = m2[0];
        payloadEl.appendChild(a);
        last = m2.index + m2[0].length;
      }
      if (last < infoText.length) payloadEl.appendChild(document.createTextNode(infoText.slice(last)));
    }
    row.appendChild(payloadEl);

    // SNR badge — only shown when a valid SNR value was attached to the frame
    if (!isNaN(entry.snr)) {
      const snrBadge = el('span', 'frame-snr-badge', entry.snr.toFixed(1) + ' dB');
      snrBadge.title = 'Signal-to-noise ratio (DCD-gated average)';
      snrBadge.classList.add(
        entry.snr > 60 ? 'snr-good' : entry.snr > 40 ? 'snr-ok' : 'snr-poor'
      );
      row.appendChild(snrBadge);
    }

    return row;
  }

  card._handleFrame = (data, receivedAt) => {
    if (data.length < 1) return;
    const type = data[0];

    if (type === MSG_PACKET) {
      if (data.length < 10) return;
      const smCh = data[1];
      const view = new DataView(data.buffer, data.byteOffset);
      const snr = view.getFloat32(2, true);           // LE float32 at [2:6]
      const frameLen = view.getUint32(6, false);       // BE uint32 at [6:10]
      const ax25 = data.slice(10, 10 + frameLen);
      let parsed = null;
      try { if (window.AX25Decode) parsed = window.AX25Decode.parse(ax25); } catch (_) {}

      // Drop noise frames with invalid source callsigns.
      // Destination may be blank/null (some beacon software uses empty destinations) — allow it.
      if (parsed && !VALID_CALL.test(parsed.src || parsed.from || '')) {
        parsed = null; // treat as raw
      }

      const entry = {
        time:   receivedAt || new Date(),
        smCh,
        snr:    isNaN(snr) ? NaN : snr,
        hex:    Array.from(ax25).map(b => b.toString(16).padStart(2, '0')).join(' '),
        parsed,
        from:   parsed ? (parsed.src || parsed.from || '') : '',
        to:     parsed ? (parsed.dst || parsed.to   || '') : '',
        via:    parsed ? (parsed.digipeaters || parsed.via || []) : [],
      };
      state.frames.push(entry);
      if (state.frames.length > MAX_FRAMES) state.frames.shift();
      updateCallsignDropdowns(entry);
      // Update last-callsign stats
      state.lastFrameTime = Date.now();
      if (entry.from) {
        state.lastCallsign = entry.from;
        statsLastCall.textContent = entry.from;
      }
      // Update collapsed-state summary with a full frame row (same as expanded view)
      collapsedInfo.innerHTML = '';
      collapsedInfo.appendChild(buildFrameRow(entry));
      updateAgoDisplay();
      startAgoTimer();
      renderFrames();
      // Notify waterfall of the decoded frame so it can draw a callsign marker
      if (wfHandle && wfHandle.notifyFrame) {
        const smChannels = (ch.modem_config || {}).channels || [];
        const modemIdx = (smChannels[smCh] || {}).modem ?? 1;
        wfHandle.notifyFrame(entry, modemIdx);
      }

    } else if (type === MSG_DCD) {
      if (data.length < 3) return;
      const smCh = data[1];
      const dcdOn = data[2] !== 0;
      if (smCh >= 4) return;
      if (dcdOn) {
        // Light the LED and (re)start the 1000ms auto-clear timer
        state.dcd[smCh] = true;
        updateDCDLed(smCh, true);
        if (state.dcdTimers[smCh]) clearTimeout(state.dcdTimers[smCh]);
        state.dcdTimers[smCh] = setTimeout(() => {
          state.dcdTimers[smCh] = null;
          state.dcd[smCh] = false;
          updateDCDLed(smCh, false);
        }, 1000);
      } else {
        // Explicit DCD-off: cancel timer and clear immediately
        if (state.dcdTimers[smCh]) { clearTimeout(state.dcdTimers[smCh]); state.dcdTimers[smCh] = null; }
        state.dcd[smCh] = false;
        updateDCDLed(smCh, false);
      }

    } else if (type === MSG_MONITOR) {
      if (data.length < 7) return;
      const smCh = data[1];
      const isTX = data[2] !== 0;
      const textLen = (data[3] << 24) | (data[4] << 16) | (data[5] << 8) | data[6];
      const text = new TextDecoder().decode(data.slice(7, 7 + textLen));
      appendMonitor(smCh, isTX, text);

    } else if (type === MSG_LOG) {
      if (data.length < 5) return;
      const lineLen = (data[1] << 24) | (data[2] << 16) | (data[3] << 8) | data[4];
      const text = new TextDecoder().decode(data.slice(5, 5 + lineLen));
      appendLog(text);

    } else if (type === MSG_ERROR) {
      if (data.length < 5) return;
      const msgLen = (data[1] << 24) | (data[2] << 16) | (data[3] << 8) | data[4];
      const text = new TextDecoder().decode(data.slice(5, 5 + msgLen));
      appendLog('[ERROR] ' + text);
    }
  };

  card._updateStatus = (inst) => {
    statusBadge.textContent = inst.status || 'stopped';
    statusBadge.className = 'channel-status-badge ' + (inst.status || '');
    updateMqttBadge();
  };

  card._updateMqttBadge = updateMqttBadge;

  return card;
}

// ---------------------------------------------------------------------------
// Channel list rendering
// ---------------------------------------------------------------------------

function renderChannels(list) {
  const container = document.getElementById('channels-container');
  const noChannels = document.getElementById('no-channels');

  const existingIds = new Set(list.map(c => c.id));
  container.querySelectorAll('.channel-card').forEach(card => {
    if (!existingIds.has(card.dataset.channelId)) card.remove();
  });

  if (list.length === 0) {
    noChannels.classList.remove('hidden');
    // Update empty-state message based on auth state
    if (state.passwordConfigured && !state.authed) {
      noChannels.innerHTML = 'No channels configured. <button class="btn btn-primary btn-sm" onclick="showLoginModal()">Login</button> to add channels.';
    } else {
      noChannels.innerHTML = 'No channels configured. Click <strong>+ Add Channel</strong> to get started.';
    }
    return;
  }
  noChannels.classList.add('hidden');

  list.forEach(ch => {
    const existing = container.querySelector(`.channel-card[data-channel-id="${ch.id}"]`);
    if (!existing) {
      container.appendChild(renderChannelCard(ch));
    } else {
      if (existing._updateStatus) existing._updateStatus(ch.instance);
    }
  });
}

async function loadChannels() {
  try {
    const resp = await fetch(BASE + '/api/channels');
    if (!resp.ok) return;
    const channels = await resp.json();
    renderChannels(channels);
  } catch (e) {
    console.error('loadChannels:', e);
  }
}

// ---------------------------------------------------------------------------
// SSE connection
// ---------------------------------------------------------------------------

let sseSource = null;

function connectSSE() {
  const dot = document.getElementById('conn-status');
  if (sseSource) sseSource.close();

  sseSource = new EventSource(BASE + '/api/events');

  sseSource.onopen = () => {
    dot.className = 'conn-status conn-connected';
    dot.title = 'Connected';
  };

  sseSource.onerror = () => {
    dot.className = 'conn-status conn-disconnected';
    dot.title = 'Disconnected — reconnecting…';
  };

  sseSource.onmessage = (e) => {
    let env;
    try { env = JSON.parse(e.data); } catch (_) { return; }

    const channelId = env.channel_id;
    const receivedAt = (env.received_at && env.received_at > 0) ? new Date(env.received_at) : new Date();
    let raw;
    try {
      const bin = atob(env.data);
      raw = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
    } catch (_) { return; }

    const card = document.querySelector(`.channel-card[data-channel-id="${channelId}"]`);
    if (card && card._handleFrame) card._handleFrame(raw, receivedAt);
  };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function loadReceiverInfo() {
  try {
    const resp = await fetch(window.location.origin + '/api/description');
    if (!resp.ok) return;
    const d = await resp.json();
    const rx = d.receiver || {};
    const callsign = rx.callsign || '';
    const name     = rx.name     || '';
    const location = rx.location || '';
    const lat      = rx.gps && rx.gps.lat;
    const lon      = rx.gps && rx.gps.lon;

    if (!callsign && !name && !location) return;

    const el = document.getElementById('rx-info');
    if (!el) return;

    let html = '';
    if (callsign) html += `<span class="rx-callsign">${callsign}</span>`;
    if (name)     html += `<span class="rx-name">${name}</span>`;
    if (location) html += `<span class="rx-location">📍 ${location}</span>`;
    if (lat != null && lon != null) {
      const mapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;
      html += `<a class="btn btn-secondary btn-sm rx-map-btn" href="${mapsUrl}" target="_blank" rel="noopener" title="Open in Google Maps">🗺 Map</a>`;
    }

    el.innerHTML = html;
    el.classList.remove('hidden');
  } catch (e) {
    // Silently ignore — /api/description may not exist on all deployments
  }
}

async function loadConfig() {
  try {
    const resp = await fetch(BASE + '/api/config');
    if (!resp.ok) return;
    const cfg = await resp.json();
    state.mqttConfigured = !!cfg.mqtt_configured;
    state.mqttTopicPrefix = cfg.mqtt_topic_prefix || 'ubersdr';
    // Body class drives CSS visibility of all MQTT rows (add-channel form
    // and per-channel config panes) without needing to re-render cards.
    document.body.classList.toggle('mqtt-enabled', state.mqttConfigured);
    // Show/hide MQTT topic prefix row in the add-channel form
    const row = document.getElementById('add-mqtt-prefix-row');
    if (row) row.classList.toggle('hidden', !state.mqttConfigured);
    // Update the add-panel prefix badge to show the real configured prefix.
    const badge = document.getElementById('add-mqtt-prefix-badge');
    if (badge) badge.textContent = state.mqttTopicPrefix + '/';
    // Refresh MQTT badges on all existing channel cards so they show the
    // correct full topic (prefix/suffix) immediately after config loads.
    document.querySelectorAll('.channel-card').forEach(card => {
      if (card._updateMqttBadge) card._updateMqttBadge();
    });
  } catch (e) {
    console.warn('loadConfig:', e);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Expose state globally so card handlers can check auth
  window.state = state;

  // Login modal wiring
  document.getElementById('login-cancel').onclick = hideLoginModal;
  document.getElementById('login-submit').onclick = doLogin;
  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });

  initAddPanel();
  // Load config (sets state.mqttConfigured etc.) and auth status before
  // rendering channels so the config pane has the correct feature flags.
  await Promise.all([loadConfig(), checkAuth()]);
  loadReceiverInfo(); // fire-and-forget; silently ignored if endpoint absent
  await loadChannels();
  connectSSE();

  // Refresh channel status every 10 s
  setInterval(loadChannels, 10000);
});
