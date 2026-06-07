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
    const body = {
      freq_hz:      freqHz,
      mode:         document.getElementById('add-mode').value,
      name:         document.getElementById('add-name').value.trim(),
      bandwidth_hz: parseInt(document.getElementById('add-bw').value) || 0,
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

function drawWaterfallOverlay(ovlCtx, channelFreqs, mouseX) {
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
    drawWaterfallOverlay(ovlCtx, channelFreqs, null);
  }

  const hdrCtx = hdrCanvas.getContext('2d');
  const wfCtx  = wfCanvas.getContext('2d');
  const ovlCtx = ovlCanvas.getContext('2d');

  let mouseX = null;
  ovlCanvas.addEventListener('mousemove', e => {
    const rect = ovlCanvas.getBoundingClientRect();
    mouseX = (e.clientX - rect.left) * (ovlCanvas.width / rect.width);
    drawWaterfallOverlay(ovlCtx, channelFreqs, mouseX);
  });
  ovlCanvas.addEventListener('mouseleave', () => {
    mouseX = null;
    drawWaterfallOverlay(ovlCtx, channelFreqs, null);
  });

  // Delay resize until element is in DOM
  requestAnimationFrame(() => resize());
  const ro = new ResizeObserver(() => resize());
  ro.observe(wfBody);

  // Web Audio setup
  let audioCtx = null, analyser = null, source = null, fftBuf = null;
  let wfLastLineAt = 0, wfRafId = null, stopped = false;

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
  }

  async function startAudio() {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.6;
      analyser.connect(audioCtx.destination);

      // Point an <audio> element directly at the streaming WAV URL.
      // Browsers handle streaming WAV natively; MediaSource does not support
      // audio/wav in Firefox so we avoid it entirely.
      const audioEl = document.createElement('audio');
      audioEl.src = BASE + '/api/audio/' + encodeURIComponent(label);
      audioEl.crossOrigin = 'anonymous';
      audioEl.volume = 0.8;

      source = audioCtx.createMediaElementSource(audioEl);
      source.connect(analyser);
      await audioEl.play();
      wfRafId = requestAnimationFrame(renderLine);
    } catch (err) {
      console.warn('[waterfall] audio start failed:', err);
      // Waterfall-only mode: still run the RAF loop but with no audio data
      // (fftBuf stays null, renderLine is a no-op until analyser is set)
    }
  }

  startAudio();

  return {
    stop() {
      stopped = true;
      if (wfRafId) cancelAnimationFrame(wfRafId);
      ro.disconnect();
      if (source) try { source.disconnect(); } catch(_){}
      if (analyser) try { analyser.disconnect(); } catch(_){}
      if (audioCtx) audioCtx.close().catch(()=>{});
    },
    redrawHeader(newChannelFreqs) {
      channelFreqs = newChannelFreqs;
      drawWaterfallHeader(hdrCtx, channelFreqs);
      drawWaterfallOverlay(ovlCtx, channelFreqs, mouseX);
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
      filter:        { type: 'all', smCh: 'all', from: '', to: '', maxFrames: 100 },
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
  btnPreview.addEventListener('click', () => {
    if (wfHandle) {
      wfHandle.stop();
      wfHandle = null;
      wfWrap.innerHTML = '';
      btnPreview.textContent = '▶ Preview';
    } else {
      btnPreview.textContent = '◼ Stop';
      wfHandle = attachWaterfall(wfWrap, ch.label, getChannelFreqs());
    }
  });
  wfBtnRow.appendChild(btnPreview);
  wfSection.appendChild(wfBtnRow);
  wfSection.appendChild(wfWrap);

  // ── Body ──
  const body = el('div', 'channel-body');
  card.appendChild(body);

  hdr.addEventListener('click', (e) => {
    if (e.target.closest('.channel-actions')) return;
    body.classList.toggle('collapsed');
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
      const scrollable = pane.querySelector('.log-list, .monitor-list');
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

  // Sender dropdown (populated dynamically)
  const selFrom = document.createElement('select');
  selFrom.appendChild(Object.assign(document.createElement('option'), { value: '', textContent: 'From: All' }));
  selFrom.addEventListener('change', () => { state.filter.from = selFrom.value; renderFrames(); });

  // Destination dropdown (populated dynamically)
  const selTo = document.createElement('select');
  selTo.appendChild(Object.assign(document.createElement('option'), { value: '', textContent: 'To: All' }));
  selTo.addEventListener('change', () => { state.filter.to = selTo.value; renderFrames(); });

  // Max frames
  const selMax = document.createElement('select');
  [[10,'10'],[25,'25'],[50,'50'],[100,'100'],[250,'250'],[500,'500'],[0,'∞']].forEach(([v,t]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = t;
    if (v === 100) o.selected = true;
    selMax.appendChild(o);
  });
  selMax.addEventListener('change', () => { state.filter.maxFrames = parseInt(selMax.value) || 0; renderFrames(); });

  const btnClear = el('button', 'btn btn-secondary btn-sm', 'Clear');
  btnClear.addEventListener('click', () => {
    state.frames = [];
    // Reset dropdowns
    while (selFrom.options.length > 1) selFrom.remove(1);
    while (selTo.options.length > 1) selTo.remove(1);
    state.filter.from = ''; state.filter.to = '';
    selFrom.value = ''; selTo.value = '';
    // Reset last-callsign stats
    state.lastFrameTime = null;
    state.lastCallsign  = null;
    statsLastCall.textContent = '---';
    stopAgoTimer();
    renderFrames();
  });

  const countEl = el('span', 'frame-count', '0 frames');

  toolbar.appendChild(el('label', 'text-dim', 'Type:'));
  toolbar.appendChild(selType);
  toolbar.appendChild(el('label', 'text-dim', 'Ch:'));
  toolbar.appendChild(selSmCh);
  toolbar.appendChild(selFrom);
  toolbar.appendChild(selTo);
  toolbar.appendChild(el('label', 'text-dim', 'Max:'));
  toolbar.appendChild(selMax);
  toolbar.appendChild(btnClear);
  toolbar.appendChild(countEl);
  framesPane.appendChild(toolbar);

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
    if (f.maxFrames > 0) rows = rows.slice(-f.maxFrames);
    countEl.textContent = state.frames.length + ' frames';
    statsFrames.textContent = state.frames.length + ' frames';

    framesList.innerHTML = '';
    rows.forEach(r => framesList.appendChild(buildFrameRow(r)));
    framesList.scrollTop = framesList.scrollHeight;
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
    monitorList.appendChild(line);
    monitorLines++;

    while (monitorLines > MAX_MONITOR) {
      monitorList.removeChild(monitorList.firstChild);
      monitorLines--;
    }
    monitorList.scrollTop = monitorList.scrollHeight;
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
  const cfgPane = el('div', 'config-pane');
  cfgPane.appendChild(el('h4', '', 'Modem Channel Configuration'));
  const cfgGrid = el('div', 'config-modem-grid');
  cfgPane.appendChild(cfgGrid);

  const smCfg = ch.modem_config || {};
  const smChannels = smCfg.channels || [{}, {}, {}, {}];
  for (let i = 0; i < 4; i++) cfgGrid.appendChild(buildModemChannelCard(i, smChannels[i]));

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
    const resp = await fetch(BASE + '/api/channels/' + encodeURIComponent(ch.label), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modem_config: newCfg }),
    });
    if (resp.status === 401) { showLoginModal(); return; }
    if (resp.ok) {
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
    return row;
  }

  card._handleFrame = (data) => {
    if (data.length < 1) return;
    const type = data[0];

    if (type === MSG_PACKET) {
      if (data.length < 6) return;
      const smCh = data[1];
      const frameLen = (data[2] << 24) | (data[3] << 16) | (data[4] << 8) | data[5];
      const ax25 = data.slice(6, 6 + frameLen);
      let parsed = null;
      try { if (window.AX25Decode) parsed = window.AX25Decode.parse(ax25); } catch (_) {}

      // Drop noise frames with invalid callsigns (same as extension)
      if (parsed && (!VALID_CALL.test(parsed.src || parsed.from || '') ||
                     !VALID_CALL.test(parsed.dst || parsed.to   || ''))) {
        parsed = null; // treat as raw
      }

      const entry = {
        time:   new Date(),
        smCh,
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
      updateAgoDisplay();
      startAgoTimer();
      renderFrames();

    } else if (type === MSG_DCD) {
      if (data.length < 3) return;
      const smCh = data[1];
      const dcdOn = data[2] !== 0;
      if (smCh >= 4) return;
      if (dcdOn) {
        // Light the LED and (re)start the 500ms auto-clear timer
        state.dcd[smCh] = true;
        updateDCDLed(smCh, true);
        if (state.dcdTimers[smCh]) clearTimeout(state.dcdTimers[smCh]);
        state.dcdTimers[smCh] = setTimeout(() => {
          state.dcdTimers[smCh] = null;
          state.dcd[smCh] = false;
          updateDCDLed(smCh, false);
        }, 500);
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
  };

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
    let raw;
    try {
      const bin = atob(env.data);
      raw = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
    } catch (_) { return; }

    const card = document.querySelector(`.channel-card[data-channel-id="${channelId}"]`);
    if (card && card._handleFrame) card._handleFrame(raw);
  };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  // Expose state globally so card handlers can check auth
  window.state = state;

  // Login modal wiring
  document.getElementById('login-cancel').onclick = hideLoginModal;
  document.getElementById('login-submit').onclick = doLogin;
  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });

  initAddPanel();
  checkAuth().then(() => loadChannels());
  connectSSE();

  // Refresh channel status every 10 s
  setInterval(loadChannels, 10000);
});
