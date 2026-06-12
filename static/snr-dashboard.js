/* snr-dashboard.js — SNR Dashboard page
 *
 * Fetches all channels → all senders with SNR data → renders a responsive
 * grid of mini canvas graphs, one per (channel, sender) pair.
 *
 * Served at /snr (static/snr.html).
 */
'use strict';

const BASE = (window.BASE_PATH || '').replace(/\/$/, '');

// ---------------------------------------------------------------------------
// Graph constants
// ---------------------------------------------------------------------------
const SNR_MIN  = 25;
const SNR_MAX  = 80;
const PAD      = { top: 28, right: 10, bottom: 32, left: 46 };
const CARD_H   = 200; // px — height of each mini-graph card

function snrColor(snr) {
  if (snr > 60) return '#3ecf6e';
  if (snr > 40) return '#e0b84a';
  return '#e05252';
}

function fmtAgo(dateStr) {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60)   return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// ---------------------------------------------------------------------------
// Draw one mini-graph onto a canvas element
// ---------------------------------------------------------------------------
function drawMiniGraph(canvas, frames) {
  const wrap = canvas.parentElement;
  const W    = wrap.clientWidth  || 320;
  const H    = CARD_H;
  const dpr  = window.devicePixelRatio || 1;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Background
  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, W, H);

  const gW = W - PAD.left - PAD.right;
  const gH = H - PAD.top  - PAD.bottom;
  if (gW < 10 || gH < 10) return;

  // Colour bands
  const bands = [
    { lo: SNR_MIN, hi: 40,      color: 'rgba(224,82,82,0.07)' },
    { lo: 40,      hi: 60,      color: 'rgba(224,184,74,0.07)' },
    { lo: 60,      hi: SNR_MAX, color: 'rgba(62,207,110,0.07)' },
  ];
  bands.forEach(b => {
    const y1 = PAD.top + gH - ((b.hi - SNR_MIN) / (SNR_MAX - SNR_MIN)) * gH;
    const y2 = PAD.top + gH - ((b.lo - SNR_MIN) / (SNR_MAX - SNR_MIN)) * gH;
    ctx.fillStyle = b.color;
    ctx.fillRect(PAD.left, y1, gW, y2 - y1);
  });

  // Grid lines + Y labels (sparse: 25, 40, 60, 80)
  ctx.strokeStyle  = '#2a3050';
  ctx.lineWidth    = 1;
  ctx.fillStyle    = '#7a88aa';
  ctx.font         = '9px monospace';
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'middle';
  [25, 40, 60, 80].forEach(v => {
    const y = PAD.top + gH - ((v - SNR_MIN) / (SNR_MAX - SNR_MIN)) * gH;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(PAD.left + gW, y);
    ctx.stroke();
    ctx.fillText(v, PAD.left - 4, y);
  });

  // Axes
  ctx.strokeStyle = '#4a9eff';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(PAD.left, PAD.top);
  ctx.lineTo(PAD.left, PAD.top + gH);
  ctx.lineTo(PAD.left + gW, PAD.top + gH);
  ctx.stroke();

  if (!frames.length) {
    ctx.fillStyle    = '#7a88aa';
    ctx.font         = '11px sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No data', PAD.left + gW / 2, PAD.top + gH / 2);
    return;
  }

  const t0    = new Date(frames[0].received_at).getTime();
  const t1    = new Date(frames[frames.length - 1].received_at).getTime();
  const tSpan = Math.max(t1 - t0, 1);

  // X axis: start + end time labels
  ctx.fillStyle    = '#7a88aa';
  ctx.font         = '9px monospace';
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(new Date(t0).toTimeString().slice(0, 8), PAD.left, PAD.top + gH + 4);
  ctx.textAlign = 'right';
  ctx.fillText(new Date(t1).toTimeString().slice(0, 8), PAD.left + gW, PAD.top + gH + 4);

  // Line
  ctx.lineWidth   = 1.5;
  ctx.strokeStyle = '#4a9eff33';
  ctx.beginPath();
  let first = true;
  frames.forEach(f => {
    const x = PAD.left + (new Date(f.received_at).getTime() - t0) / tSpan * gW;
    const y = PAD.top  + gH - ((Math.min(Math.max(f.snr, SNR_MIN), SNR_MAX) - SNR_MIN) / (SNR_MAX - SNR_MIN)) * gH;
    if (first) { ctx.moveTo(x, y); first = false; }
    else        ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Dots
  frames.forEach(f => {
    const x = PAD.left + (new Date(f.received_at).getTime() - t0) / tSpan * gW;
    const y = PAD.top  + gH - ((Math.min(Math.max(f.snr, SNR_MIN), SNR_MAX) - SNR_MIN) / (SNR_MAX - SNR_MIN)) * gH;
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = snrColor(f.snr);
    ctx.fill();
  });

  // Store for tooltip
  canvas._frames = frames;
  canvas._t0     = t0;
  canvas._tSpan  = tSpan;
  canvas._gW     = gW;
  canvas._gH     = gH;
}

// ---------------------------------------------------------------------------
// Attach hover tooltip to a canvas
// ---------------------------------------------------------------------------
function attachTooltip(canvas, card) {
  const tip = document.createElement('div');
  tip.className = 'snrd-tooltip hidden';
  card.appendChild(tip);

  canvas.addEventListener('mousemove', e => {
    const f = canvas._frames;
    if (!f || !f.length) { tip.classList.add('hidden'); return; }

    const rect  = canvas.getBoundingClientRect();
    const mx    = e.clientX - rect.left;
    const t0    = canvas._t0;
    const tSpan = canvas._tSpan;
    const gW    = canvas._gW;

    let best = null, bestDist = Infinity;
    f.forEach(fr => {
      const x = PAD.left + (new Date(fr.received_at).getTime() - t0) / tSpan * gW;
      const d = Math.abs(mx - x);
      if (d < bestDist) { bestDist = d; best = fr; }
    });

    if (!best || bestDist > 24) { tip.classList.add('hidden'); return; }

    const d = new Date(best.received_at);
    tip.innerHTML = `<strong>${best.snr.toFixed(1)} dB</strong><br>${d.toLocaleTimeString()}`;
    tip.classList.remove('hidden');

    const cRect = card.getBoundingClientRect();
    let tx = e.clientX - cRect.left + 10;
    let ty = e.clientY - cRect.top  - 36;
    if (tx + 100 > cRect.width) tx = e.clientX - cRect.left - 110;
    if (ty < 0) ty = 2;
    tip.style.left = tx + 'px';
    tip.style.top  = ty + 'px';
  });

  canvas.addEventListener('mouseleave', () => tip.classList.add('hidden'));
}

// ---------------------------------------------------------------------------
// Build one card DOM element
// ---------------------------------------------------------------------------
function buildCard(channelName, channelLabel, sender) {
  const card = document.createElement('div');
  card.className = 'snrd-card';
  card.dataset.channel = channelLabel;
  card.dataset.sender  = sender.callsign;

  const hdr = document.createElement('div');
  hdr.className = 'snrd-card-hdr';

  const callEl = document.createElement('span');
  callEl.className = 'snrd-callsign';
  callEl.textContent = sender.callsign;

  const metaEl = document.createElement('span');
  metaEl.className = 'snrd-card-meta';
  metaEl.textContent = channelName + ' · ' + sender.frame_count + ' frames · ' + fmtAgo(sender.last_seen);

  hdr.appendChild(callEl);
  hdr.appendChild(metaEl);

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'snrd-canvas-wrap';

  const canvas = document.createElement('canvas');
  canvas.className = 'snrd-canvas';

  // Loading overlay sits inside the canvas wrap (position: absolute)
  const loadingEl = document.createElement('div');
  loadingEl.className = 'snrd-loading';
  loadingEl.textContent = 'Loading…';

  canvasWrap.appendChild(canvas);
  canvasWrap.appendChild(loadingEl);

  card.appendChild(hdr);
  card.appendChild(canvasWrap);

  attachTooltip(canvas, card);

  card._canvas     = canvas;
  card._loadingEl  = loadingEl;
  return card;
}

// ---------------------------------------------------------------------------
// Fetch frames for one sender and draw
// ---------------------------------------------------------------------------
async function loadCard(card) {
  const channel = card.dataset.channel;
  const sender  = card.dataset.sender;
  try {
    const url = BASE + '/api/frames' +
      '?channel='    + encodeURIComponent(channel) +
      '&from_exact=' + encodeURIComponent(sender) +
      '&limit=1000';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const frames = data
      .filter(f => f.snr !== null && f.snr !== undefined)
      .reverse(); // oldest-first
    drawMiniGraph(card._canvas, frames);
    // Hide loading overlay; update meta with point count
    card._loadingEl.classList.add('hidden');
    const metaEl = card.querySelector('.snrd-card-meta');
    if (metaEl) {
      const base = metaEl.dataset.base || metaEl.textContent;
      metaEl.dataset.base = base;
      metaEl.textContent = base.replace(/·\s*\d+ pts$/, '') + ' · ' + frames.length + ' pts';
    }
  } catch (e) {
    card._loadingEl.textContent = 'Error loading data';
    console.warn('[snr-dashboard] loadCard', sender, e);
  }
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------
const grid    = document.getElementById('snrd-grid');
const empty   = document.getElementById('snrd-empty');
const statusEl = document.getElementById('snrd-status');

async function render() {
  statusEl.textContent = 'Loading…';
  grid.innerHTML = '';

  let channels;
  try {
    const resp = await fetch(BASE + '/api/channels');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    channels = await resp.json();
  } catch (e) {
    statusEl.textContent = 'Error: ' + e.message;
    return;
  }

  // Collect all (channel, sender) pairs with SNR data
  const pairs = [];
  channels.forEach(ch => {
    const name = ch.name || ch.label;
    (ch.senders || [])
      .filter(s => s.snr_available)
      .forEach(s => pairs.push({ ch, name, sender: s }));
  });

  if (pairs.length === 0) {
    empty.classList.remove('hidden');
    statusEl.textContent = '';
    return;
  }
  empty.classList.add('hidden');
  statusEl.textContent = pairs.length + ' sender' + (pairs.length !== 1 ? 's' : '');

  // Build all cards first (so layout is stable before async fetches)
  const cards = pairs.map(({ ch, name, sender }) => {
    const card = buildCard(name, ch.label, sender);
    grid.appendChild(card);
    return card;
  });

  // Fetch all in parallel (browser will naturally throttle concurrent requests)
  await Promise.all(cards.map(loadCard));
  statusEl.textContent = pairs.length + ' sender' + (pairs.length !== 1 ? 's' : '') + ' loaded';
}

// Auto-refresh every 60 s
let autoRefreshTimer = null;
function scheduleRefresh() {
  if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
  autoRefreshTimer = setTimeout(() => { render().then(scheduleRefresh); }, 60000);
}

document.getElementById('btn-refresh').addEventListener('click', () => {
  render().then(scheduleRefresh);
});

// Redraw all canvases on window resize (debounced)
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    grid.querySelectorAll('.snrd-card').forEach(card => {
      if (card._canvas && card._canvas._frames) {
        drawMiniGraph(card._canvas, card._canvas._frames);
      }
    });
  }, 150);
});

// Initial load
render().then(scheduleRefresh);
