/* stats-modal.js — Channel Statistics modal
 *
 * Public API (window.StatsModal):
 *   StatsModal.open(channelLabel)  — open modal pre-filtered to a channel
 *   StatsModal.close()
 *
 * Charts rendered on canvas (no external dependencies):
 *   All senders view:
 *     1. Top Senders bar chart (total frames, coloured by sub-channel)
 *     2. Frames per Day line chart (last 30 days, aggregated)
 *     3. Frames by Hour-of-Day bar chart (0–23 UTC, aggregated)
 *     4. Frame Types bar chart (aggregated)
 *     5. Top Destinations bar chart (aggregated)
 *
 *   Per-sender view (sender selected):
 *     1. Frames by Sub-Channel bar chart
 *     2. Frames per Day line chart (this sender)
 *     3. Frames by Hour-of-Day bar chart (this sender)
 *     4. Frame Types bar chart (this sender)
 *     5. Top Destinations bar chart (this sender)
 */
'use strict';

window.StatsModal = (() => {
  const BASE = () => (window.BASE_PATH || '').replace(/\/$/, '');
  const SM_CH_LABELS = ['A', 'B', 'C', 'D'];
  const SM_CH_COLORS = ['#4a9eff', '#3ecf6e', '#e0b84a', '#e05252'];
  const ACCENT = '#4a9eff';
  const DIM    = '#7a88aa';
  const BG     = '#0f1117';
  const GRID   = '#2a3050';
  const TEXT   = '#c8d0e0';

  // ── State ──────────────────────────────────────────────────────────────────
  let channelLabel = '';
  let selSender    = '';   // '' = all senders
  let allEntries   = [];   // raw statEntry[] from API
  let loading      = false;

  // ── DOM refs ───────────────────────────────────────────────────────────────
  let overlay, modal, titleEl, closeBtn, statusEl, selSnd, senderLabel,
      canvasFirst, canvasDaily, canvasHourly, canvasTypes, canvasDest;

  // ── Build DOM (once) ───────────────────────────────────────────────────────
  function buildDOM() {
    overlay = document.createElement('div');
    overlay.className = 'stm-overlay hidden';
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    modal = document.createElement('div');
    modal.className = 'stm-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'stm-header';
    titleEl = document.createElement('span');
    titleEl.className = 'stm-title';
    titleEl.textContent = 'Channel Statistics';
    closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-secondary btn-sm';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', close);
    hdr.appendChild(titleEl);
    hdr.appendChild(closeBtn);

    // Controls row: sender selector
    const controls = document.createElement('div');
    controls.className = 'stm-controls';

    senderLabel = document.createElement('label');
    senderLabel.className = 'stm-ctrl-label';
    senderLabel.textContent = 'Sender:';

    selSnd = document.createElement('select');
    selSnd.className = 'stm-select';
    selSnd.addEventListener('change', () => {
      selSender = selSnd.value;
      renderAll();
    });

    controls.appendChild(senderLabel);
    controls.appendChild(selSnd);

    // Status line
    statusEl = document.createElement('div');
    statusEl.className = 'stm-status';

    // Chart grid
    const grid = document.createElement('div');
    grid.className = 'stm-grid';

    canvasFirst  = makeChartBox(grid, 'Top Senders');   // title updated dynamically
    canvasDaily  = makeChartBox(grid, 'Frames per Day (last 30 days)');
    canvasHourly = makeChartBox(grid, 'Frames by Hour of Day (UTC)');
    canvasTypes  = makeChartBox(grid, 'Frame Types');
    canvasDest   = makeChartBox(grid, 'Top Destinations');

    modal.appendChild(hdr);
    modal.appendChild(controls);
    modal.appendChild(statusEl);
    modal.appendChild(grid);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
    });

    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (!overlay.classList.contains('hidden')) renderAll();
      }).observe(grid);
    }
  }

  function makeChartBox(parent, title) {
    const box = document.createElement('div');
    box.className = 'stm-chart-box';
    const lbl = document.createElement('div');
    lbl.className = 'stm-chart-title';
    lbl.textContent = title;
    const canvas = document.createElement('canvas');
    canvas.className = 'stm-canvas';
    box.appendChild(lbl);
    box.appendChild(canvas);
    parent.appendChild(box);
    // Store title element for dynamic updates
    canvas._titleEl = lbl;
    return canvas;
  }

  // ── Data fetching ──────────────────────────────────────────────────────────
  async function fetchStats() {
    if (loading) return;
    loading = true;
    statusEl.textContent = 'Loading…';
    try {
      let url = BASE() + '/api/stats';
      if (channelLabel) url += '?channel=' + encodeURIComponent(channelLabel);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      allEntries = await resp.json();
      populateSenderSelect();
      renderAll();
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
    } finally {
      loading = false;
    }
  }

  function populateSenderSelect() {
    // Collect unique callsigns sorted by total frames desc
    const totals = {};
    allEntries.forEach(e => {
      totals[e.callsign] = (totals[e.callsign] || 0) + e.total_frames;
    });
    const senders = Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .map(([cs]) => cs);

    const prev = selSnd.value;
    selSnd.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = '— All senders —';
    selSnd.appendChild(allOpt);

    senders.forEach(cs => {
      const o = document.createElement('option');
      o.value = cs;
      o.textContent = `${cs} (${totals[cs].toLocaleString()} frames)`;
      selSnd.appendChild(o);
    });

    // Restore previous selection if still valid
    if (prev && senders.includes(prev)) {
      selSnd.value = prev;
      selSender = prev;
    } else {
      selSender = '';
      selSnd.value = '';
    }

    const total = allEntries.reduce((s, e) => s + e.total_frames, 0);
    statusEl.textContent = `${senders.length} unique sender${senders.length !== 1 ? 's' : ''} · ${total.toLocaleString()} total frames`;
  }

  // ── Render all charts ──────────────────────────────────────────────────────
  function renderAll() {
    const entries = selSender
      ? allEntries.filter(e => e.callsign === selSender)
      : allEntries;

    if (!allEntries.length) {
      [canvasFirst, canvasDaily, canvasHourly, canvasTypes, canvasDest].forEach(c => {
        drawEmpty(c, 'No data yet');
      });
      return;
    }

    if (selSender) {
      // Per-sender view
      canvasFirst._titleEl.textContent = `Sub-Channel Breakdown — ${selSender}`;
      drawSubChannels(entries);
    } else {
      // All-senders view
      canvasFirst._titleEl.textContent = 'Top Senders';
      drawTopSenders();
    }

    drawDaily(entries);
    drawHourly(entries);
    drawFrameTypes(entries);
    drawTopDest(entries);
  }

  // ── Chart helpers ──────────────────────────────────────────────────────────

  function setupCanvas(canvas) {
    const box = canvas.parentElement;
    const W = box.clientWidth  || 400;
    const H = canvas.clientHeight || 200;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    return { ctx, W, H };
  }

  function drawEmpty(canvas, msg) {
    const { ctx, W, H } = setupCanvas(canvas);
    ctx.fillStyle = DIM;
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg, W / 2, H / 2);
  }

  // Horizontal bar chart
  function drawHBar(canvas, labels, values, colors, opts = {}) {
    const PAD = { top: 8, right: 60, bottom: 8, left: opts.leftPad || 90 };
    const { ctx, W, H } = setupCanvas(canvas);
    const n = labels.length;
    if (!n) { drawEmpty(canvas, 'No data'); return; }

    const gW = W - PAD.left - PAD.right;
    const gH = H - PAD.top  - PAD.bottom;
    const barH = Math.max(4, Math.min(28, (gH / n) - 4));
    const gap  = (gH - barH * n) / Math.max(n - 1, 1);
    const maxVal = Math.max(...values, 1);

    labels.forEach((lbl, i) => {
      const y = PAD.top + i * (barH + gap);
      const bw = (values[i] / maxVal) * gW;
      const col = Array.isArray(colors) ? (colors[i] || ACCENT) : colors;

      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.roundRect(PAD.left, y, Math.max(bw, 2), barH, 3);
      ctx.fill();

      ctx.fillStyle = TEXT;
      ctx.font = '11px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(lbl, PAD.left - 6, y + barH / 2);

      ctx.fillStyle = DIM;
      ctx.textAlign = 'left';
      ctx.fillText(values[i].toLocaleString(), PAD.left + bw + 5, y + barH / 2);
    });
  }

  // Vertical bar chart
  function drawVBar(canvas, labels, values, colors, opts = {}) {
    const PAD = { top: 20, right: 8, bottom: opts.bottomPad || 36, left: 44 };
    const { ctx, W, H } = setupCanvas(canvas);
    const n = labels.length;
    if (!n) { drawEmpty(canvas, 'No data'); return; }

    const gW = W - PAD.left - PAD.right;
    const gH = H - PAD.top  - PAD.bottom;
    const maxVal = Math.max(...values, 1);
    const barW = gW / n;

    const yTicks = 4;
    for (let t = 0; t <= yTicks; t++) {
      const v = (maxVal * t / yTicks);
      const y = PAD.top + gH - (v / maxVal) * gH;
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + gW, y);
      ctx.stroke();
      ctx.fillStyle = DIM;
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(Math.round(v), PAD.left - 3, y);
    }

    values.forEach((v, i) => {
      const bh = (v / maxVal) * gH;
      const x  = PAD.left + i * barW + barW * 0.1;
      const bw = barW * 0.8;
      const y  = PAD.top + gH - bh;
      const col = Array.isArray(colors) ? (colors[i % colors.length] || ACCENT) : colors;

      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.roundRect(x, y, Math.max(bw, 1), Math.max(bh, 1), 2);
      ctx.fill();

      ctx.fillStyle = DIM;
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(labels[i], PAD.left + i * barW + barW / 2, PAD.top + gH + 4);
    });
  }

  // Line chart
  function drawLine(canvas, labels, values, color) {
    const PAD = { top: 20, right: 12, bottom: 40, left: 44 };
    const { ctx, W, H } = setupCanvas(canvas);
    const n = labels.length;
    if (!n) { drawEmpty(canvas, 'No data'); return; }

    const gW = W - PAD.left - PAD.right;
    const gH = H - PAD.top  - PAD.bottom;
    const maxVal = Math.max(...values, 1);

    const yTicks = 4;
    for (let t = 0; t <= yTicks; t++) {
      const v = maxVal * t / yTicks;
      const y = PAD.top + gH - (v / maxVal) * gH;
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + gW, y);
      ctx.stroke();
      ctx.fillStyle = DIM;
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(Math.round(v), PAD.left - 3, y);
    }

    ctx.strokeStyle = color || ACCENT;
    ctx.lineWidth = 2;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = PAD.left + (i / (n - 1 || 1)) * gW;
      const y = PAD.top + gH - (v / maxVal) * gH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = (color || ACCENT) + '22';
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = PAD.left + (i / (n - 1 || 1)) * gW;
      const y = PAD.top + gH - (v / maxVal) * gH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.lineTo(PAD.left + gW, PAD.top + gH);
    ctx.lineTo(PAD.left, PAD.top + gH);
    ctx.closePath();
    ctx.fill();

    values.forEach((v, i) => {
      const x = PAD.left + (i / (n - 1 || 1)) * gW;
      const y = PAD.top + gH - (v / maxVal) * gH;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = color || ACCENT;
      ctx.fill();
    });

    const step = Math.max(1, Math.ceil(n / 8));
    ctx.fillStyle = DIM;
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    labels.forEach((lbl, i) => {
      if (i % step !== 0 && i !== n - 1) return;
      const x = PAD.left + (i / (n - 1 || 1)) * gW;
      ctx.fillText(lbl.slice(5), x, PAD.top + gH + 4); // show MM-DD
    });
  }

  // ── Individual charts ──────────────────────────────────────────────────────

  // All-senders: top 20 by total frames
  function drawTopSenders() {
    const sorted = [...allEntries].sort((a, b) => b.total_frames - a.total_frames).slice(0, 20);
    const labels = sorted.map(e => {
      const ch = SM_CH_LABELS[e.sm_ch] || String(e.sm_ch);
      return `${e.callsign} [${ch}]`;
    });
    const values = sorted.map(e => e.total_frames);
    const colors = sorted.map(e => SM_CH_COLORS[e.sm_ch] || ACCENT);
    drawHBar(canvasFirst, labels, values, colors, { leftPad: 110 });
  }

  // Per-sender: frames broken down by sub-channel
  function drawSubChannels(entries) {
    if (!entries.length) { drawEmpty(canvasFirst, 'No data'); return; }
    const labels = entries.map(e => SM_CH_LABELS[e.sm_ch] !== undefined ? `Ch ${SM_CH_LABELS[e.sm_ch]}` : `Ch ${e.sm_ch}`);
    const values = entries.map(e => e.total_frames);
    const colors = entries.map(e => SM_CH_COLORS[e.sm_ch] || ACCENT);
    drawVBar(canvasFirst, labels, values, colors, { bottomPad: 28 });
  }

  function drawDaily(entries) {
    const today = new Date();
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const totals = {};
    days.forEach(d => { totals[d] = 0; });
    entries.forEach(e => {
      if (!e.frames_per_day) return;
      Object.entries(e.frames_per_day).forEach(([day, cnt]) => {
        if (totals[day] !== undefined) totals[day] += cnt;
      });
    });
    drawLine(canvasDaily, days, days.map(d => totals[d]), ACCENT);
  }

  function drawHourly(entries) {
    const totals = new Array(24).fill(0);
    entries.forEach(e => {
      if (!e.frames_per_hour) return;
      e.frames_per_hour.forEach((cnt, h) => { totals[h] += cnt; });
    });
    const labels = totals.map((_, h) => String(h).padStart(2, '0'));
    const colors = totals.map((_, h) => {
      if (h >= 6  && h < 12) return '#e0b84a';
      if (h >= 12 && h < 18) return '#3ecf6e';
      if (h >= 18 && h < 22) return '#4a9eff';
      return '#4a5580';
    });
    drawVBar(canvasHourly, labels, totals, colors, { bottomPad: 28 });
  }

  function drawFrameTypes(entries) {
    const totals = {};
    entries.forEach(e => {
      if (!e.frame_types) return;
      Object.entries(e.frame_types).forEach(([t, cnt]) => {
        totals[t] = (totals[t] || 0) + cnt;
      });
    });
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    const typeColors = { aprs: '#3ecf6e', ui: '#4a9eff', i: '#e0b84a', s: '#e05252', u: '#9b59b6' };
    const labels = sorted.map(([t]) => t.toUpperCase());
    const values = sorted.map(([, v]) => v);
    const colors = sorted.map(([t]) => typeColors[t] || DIM);
    drawHBar(canvasTypes, labels, values, colors, { leftPad: 60 });
  }

  function drawTopDest(entries) {
    const totals = {};
    entries.forEach(e => {
      if (!e.top_destinations) return;
      Object.entries(e.top_destinations).forEach(([dest, cnt]) => {
        totals[dest] = (totals[dest] || 0) + cnt;
      });
    });
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 15);
    if (!sorted.length) { drawEmpty(canvasDest, 'No data'); return; }
    const labels = sorted.map(([d]) => d);
    const values = sorted.map(([, v]) => v);
    drawHBar(canvasDest, labels, values, ACCENT, { leftPad: 90 });
  }

  // ── Open / close ───────────────────────────────────────────────────────────
  function open(label) {
    if (!overlay) buildDOM();
    channelLabel = label || '';
    selSender    = '';
    titleEl.textContent = label ? `Statistics — ${label}` : 'Statistics — All Channels';
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    allEntries = [];
    selSnd.innerHTML = '<option value="">— Loading… —</option>';
    [canvasFirst, canvasDaily, canvasHourly, canvasTypes, canvasDest].forEach(c => drawEmpty(c, 'Loading…'));
    fetchStats();
  }

  function close() {
    if (overlay) overlay.classList.add('hidden');
    document.body.style.overflow = '';
  }

  return { open, close };
})();
