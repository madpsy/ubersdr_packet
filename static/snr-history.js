/* snr-history.js — SNR History modal panel
 *
 * Public API (attached to window.SNRHistory):
 *   SNRHistory.open(channelLabel)  — open modal, pre-select given channel
 *   SNRHistory.open()              — open modal with no pre-selection
 *
 * Depends on:
 *   window.BASE_PATH  (set by the Go template in index.html / snr.html)
 */
'use strict';

window.SNRHistory = (() => {
  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  const BASE = () => (window.BASE_PATH || '').replace(/\/$/, '');

  // Sub-channel index → label
  const SM_CH_LABELS = ['A', 'B', 'C', 'D'];

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  let channels    = [];   // [{label, name, modemChannels:[{enabled,label}], senders:[{callsign,sm_ch,...}]}]
  let selChannel  = '';   // currently selected channel label
  let selSmCh     = -1;   // currently selected modem sub-channel (-1 = all)
  let selSender   = '';   // currently selected callsign
  let frames      = [];   // [{received_at, snr}] newest-first from API
  let loading     = false;
  let autoRefresh = false;
  let autoTimer   = null;

  const AUTO_INTERVAL_MS = 5000;

  // -------------------------------------------------------------------------
  // DOM refs (populated on first open)
  // -------------------------------------------------------------------------
  let modal, overlay, selCh, selSm, selSnd, canvas, ctx,
      statusEl, titleEl, countEl, refreshBtn, closeBtn,
      smRow, autoChk;

  // -------------------------------------------------------------------------
  // Build DOM (once)
  // -------------------------------------------------------------------------
  function buildDOM() {
    overlay = document.createElement('div');
    overlay.className = 'snrh-overlay hidden';
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    modal = document.createElement('div');
    modal.className = 'snrh-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'SNR History');

    // ── Header ──
    const hdr = document.createElement('div');
    hdr.className = 'snrh-header';

    titleEl = document.createElement('span');
    titleEl.className = 'snrh-title';
    titleEl.textContent = 'SNR History';

    closeBtn = document.createElement('button');
    closeBtn.className = 'snrh-close btn btn-secondary btn-sm';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', close);

    hdr.appendChild(titleEl);
    hdr.appendChild(closeBtn);

    // ── Controls ──
    const controls = document.createElement('div');
    controls.className = 'snrh-controls';

    // Channel selector
    const lbCh = document.createElement('label');
    lbCh.className = 'snrh-label';
    lbCh.textContent = 'Channel:';

    selCh = document.createElement('select');
    selCh.className = 'snrh-select';
    selCh.addEventListener('change', () => {
      selChannel = selCh.value;
      selSmCh    = -1;
      selSender  = '';
      populateSmChannels();
      populateSenders();
      loadData();
    });

    // Modem sub-channel selector (A/B/C/D)
    smRow = document.createElement('span');
    smRow.className = 'snrh-sm-row hidden';

    const lbSm = document.createElement('label');
    lbSm.className = 'snrh-label';
    lbSm.textContent = 'Sub-ch:';

    selSm = document.createElement('select');
    selSm.className = 'snrh-select snrh-select-sm';
    selSm.addEventListener('change', () => {
      selSmCh   = parseInt(selSm.value, 10);
      selSender = '';
      populateSenders();
      loadData();
    });

    smRow.appendChild(lbSm);
    smRow.appendChild(selSm);

    // Sender selector
    const lbSnd = document.createElement('label');
    lbSnd.className = 'snrh-label';
    lbSnd.textContent = 'Sender:';

    selSnd = document.createElement('select');
    selSnd.className = 'snrh-select';
    selSnd.addEventListener('change', () => {
      selSender = selSnd.value;
      loadData();
    });

    refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn btn-secondary btn-sm';
    refreshBtn.textContent = '↻ Refresh';
    refreshBtn.addEventListener('click', () => {
      fetchChannels().then(loadData);
    });

    // Auto-refresh checkbox
    const autoWrap = document.createElement('label');
    autoWrap.className = 'snrh-auto-label';
    autoChk = document.createElement('input');
    autoChk.type = 'checkbox';
    autoChk.className = 'snrh-auto-chk';
    autoChk.checked = false;
    autoChk.addEventListener('change', () => {
      autoRefresh = autoChk.checked;
      if (autoRefresh) startAutoRefresh();
      else             stopAutoRefresh();
    });
    autoWrap.appendChild(autoChk);
    autoWrap.appendChild(document.createTextNode(' Auto (5s)'));

    controls.appendChild(lbCh);
    controls.appendChild(selCh);
    controls.appendChild(smRow);
    controls.appendChild(lbSnd);
    controls.appendChild(selSnd);
    controls.appendChild(refreshBtn);
    controls.appendChild(autoWrap);

    // ── Status / count ──
    const meta = document.createElement('div');
    meta.className = 'snrh-meta';

    statusEl = document.createElement('span');
    statusEl.className = 'snrh-status';

    countEl = document.createElement('span');
    countEl.className = 'snrh-count';

    meta.appendChild(statusEl);
    meta.appendChild(countEl);

    // ── Canvas ──
    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'snrh-canvas-wrap';

    canvas = document.createElement('canvas');
    canvas.className = 'snrh-canvas';
    canvasWrap.appendChild(canvas);

    // ── Legend ──
    const legend = document.createElement('div');
    legend.className = 'snrh-legend';
    legend.innerHTML =
      '<span class="snrh-leg snrh-leg-good">● &gt;60 dB</span>' +
      '<span class="snrh-leg snrh-leg-ok">● 40–60 dB</span>' +
      '<span class="snrh-leg snrh-leg-poor">● &lt;40 dB</span>';

    // Assemble
    modal.appendChild(hdr);
    modal.appendChild(controls);
    modal.appendChild(meta);
    modal.appendChild(canvasWrap);
    modal.appendChild(legend);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Keyboard close
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
    });

    // Resize observer — redraw when modal resizes
    if (window.ResizeObserver) {
      new ResizeObserver(() => { if (!overlay.classList.contains('hidden')) draw(); })
        .observe(canvasWrap);
    }
  }

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------
  async function fetchChannels() {
    try {
      const resp = await fetch(BASE() + '/api/channels');
      if (!resp.ok) return;
      const list = await resp.json();
      channels = list.map(ch => {
        // Build modem sub-channel list from modem_config
        const smChannels = ((ch.modem_config || {}).channels || []);
        const modemChannels = smChannels
          .map((c, i) => ({ idx: i, enabled: c.enabled !== false, label: SM_CH_LABELS[i] || String(i) }))
          .filter(c => c.enabled);
        return {
          label:         ch.label,
          name:          ch.name || ch.label,
          modemChannels,
          senders:       (ch.senders || []).filter(s => s.snr_available),
        };
      });
      populateChannels();
    } catch (e) {
      console.warn('[snr-history] fetchChannels:', e);
    }
  }

  function populateChannels() {
    const prev = selCh.value;
    selCh.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— select channel —';
    selCh.appendChild(blank);

    channels.forEach(ch => {
      const o = document.createElement('option');
      o.value = ch.label;
      o.textContent = ch.name + (ch.senders.length ? ` (${ch.senders.length})` : '');
      o.disabled = ch.senders.length === 0;
      selCh.appendChild(o);
    });

    // Restore previous selection if still valid
    if (prev && channels.find(c => c.label === prev)) {
      selCh.value = prev;
      selChannel  = prev;
    } else {
      selChannel = '';
    }
    populateSmChannels();
    populateSenders();
  }

  function populateSmChannels() {
    const ch = channels.find(c => c.label === selChannel);
    const modemChannels = ch ? ch.modemChannels : [];

    // Only show sub-channel selector when there are multiple modem channels
    if (modemChannels.length <= 1) {
      smRow.classList.add('hidden');
      selSmCh = modemChannels.length === 1 ? modemChannels[0].idx : -1;
      return;
    }

    smRow.classList.remove('hidden');
    selSm.innerHTML = '';

    const allOpt = document.createElement('option');
    allOpt.value = '-1';
    allOpt.textContent = 'All';
    selSm.appendChild(allOpt);

    modemChannels.forEach(mc => {
      const o = document.createElement('option');
      o.value = String(mc.idx);
      o.textContent = mc.label;
      selSm.appendChild(o);
    });

    // Restore or default to All
    selSm.value = String(selSmCh);
    if (selSm.value === '') { selSm.value = '-1'; selSmCh = -1; }
  }

  function populateSenders() {
    const ch = channels.find(c => c.label === selChannel);
    // Filter senders by selected sub-channel
    const senders = ch
      ? ch.senders.filter(s => selSmCh === -1 || s.sm_ch === selSmCh)
      : [];

    const prev = selSnd.value;
    selSnd.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— select sender —';
    selSnd.appendChild(blank);

    senders.forEach(s => {
      const o = document.createElement('option');
      o.value = s.callsign + ':' + s.sm_ch;  // unique key: callsign + sm_ch
      const ago = s.last_seen ? ' · ' + fmtAgo(new Date(s.last_seen)) : '';
      const chLabel = SM_CH_LABELS[s.sm_ch] !== undefined ? ' [' + SM_CH_LABELS[s.sm_ch] + ']' : '';
      o.textContent = `${s.callsign}${chLabel} (${s.frame_count} frames${ago})`;
      selSnd.appendChild(o);
    });

    if (prev && senders.find(s => (s.callsign + ':' + s.sm_ch) === prev)) {
      selSnd.value = prev;
      selSender    = prev;
    } else {
      selSender = '';
      selSnd.value = '';
    }
  }

  // Parse the composite sender key back into {callsign, smCh}
  function parseSenderKey(key) {
    if (!key) return null;
    const lastColon = key.lastIndexOf(':');
    if (lastColon === -1) return { callsign: key, smCh: -1 };
    return {
      callsign: key.slice(0, lastColon),
      smCh:     parseInt(key.slice(lastColon + 1), 10),
    };
  }

  async function loadData() {
    const parsed = parseSenderKey(selSender);
    if (!selChannel || !parsed) {
      frames = [];
      setStatus('');
      draw();
      return;
    }
    if (loading) return;
    loading = true;
    setStatus('Loading…');
    try {
      let url = BASE() +
        '/api/frames?channel=' + encodeURIComponent(selChannel) +
        '&from_exact=' + encodeURIComponent(parsed.callsign) +
        '&limit=1000' +
        '&fields=snr';
      if (parsed.smCh >= 0) {
        url += '&sm_ch=' + parsed.smCh;
      }
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      // Keep only frames with valid SNR, oldest-first for the graph
      frames = data
        .filter(f => f.snr !== null && f.snr !== undefined)
        .reverse();
      setStatus('', frames.length + ' data points');
      draw();
    } catch (e) {
      setStatus('Error: ' + e.message);
      frames = [];
      draw();
    } finally {
      loading = false;
    }
  }

  // -------------------------------------------------------------------------
  // Graph drawing
  // -------------------------------------------------------------------------
  const PAD = { top: 24, right: 16, bottom: 48, left: 52 };
  const SNR_MIN = 25;
  const SNR_MAX = 80;

  function snrColor(snr) {
    if (snr > 60) return '#3ecf6e';
    if (snr > 40) return '#e0b84a';
    return '#e05252';
  }

  function draw() {
    const wrap = canvas.parentElement;
    const W = wrap.clientWidth  || 600;
    const H = wrap.clientHeight || 300;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#0f1117';
    ctx.fillRect(0, 0, W, H);

    const gW = W - PAD.left - PAD.right;
    const gH = H - PAD.top  - PAD.bottom;

    if (gW < 10 || gH < 10) return;

    // Grid lines + Y axis labels
    ctx.strokeStyle = '#2a3050';
    ctx.lineWidth   = 1;
    ctx.fillStyle   = '#7a88aa';
    ctx.font        = '11px monospace';
    ctx.textAlign   = 'right';
    ctx.textBaseline = 'middle';

    const yTicks = [25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80];
    yTicks.forEach(v => {
      const y = PAD.top + gH - ((v - SNR_MIN) / (SNR_MAX - SNR_MIN)) * gH;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + gW, y);
      ctx.stroke();
      ctx.fillText(v + ' dB', PAD.left - 6, y);
    });

    // Colour band backgrounds (poor/ok/good zones)
    const bands = [
      { lo: SNR_MIN, hi: 40,      color: 'rgba(224,82,82,0.06)' },
      { lo: 40,      hi: 60,      color: 'rgba(224,184,74,0.06)' },
      { lo: 60,      hi: SNR_MAX, color: 'rgba(62,207,110,0.06)' },
    ];
    bands.forEach(b => {
      const y1 = PAD.top + gH - ((b.hi - SNR_MIN) / (SNR_MAX - SNR_MIN)) * gH;
      const y2 = PAD.top + gH - ((b.lo - SNR_MIN) / (SNR_MAX - SNR_MIN)) * gH;
      ctx.fillStyle = b.color;
      ctx.fillRect(PAD.left, y1, gW, y2 - y1);
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
      ctx.fillStyle   = '#7a88aa';
      ctx.font        = '13px sans-serif';
      ctx.textAlign   = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        selChannel && selSender ? 'No SNR data for this sender' : 'Select a channel and sender',
        PAD.left + gW / 2, PAD.top + gH / 2
      );
      return;
    }

    // X axis: time range
    const t0 = new Date(frames[0].received_at).getTime();
    const t1 = new Date(frames[frames.length - 1].received_at).getTime();
    const tSpan = Math.max(t1 - t0, 1);

    // X axis labels (up to 6 ticks)
    ctx.fillStyle    = '#7a88aa';
    ctx.font         = '10px monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    const xTicks = 6;
    for (let i = 0; i <= xTicks; i++) {
      const t = t0 + (tSpan * i / xTicks);
      const x = PAD.left + (t - t0) / tSpan * gW;
      const d = new Date(t);
      const label = d.toTimeString().slice(0, 8);
      ctx.fillText(label, x, PAD.top + gH + 6);
    }

    // Line + dots
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#4a9eff44';
    ctx.beginPath();
    let first = true;
    frames.forEach(f => {
      const snr = f.snr;
      const t   = new Date(f.received_at).getTime();
      const x   = PAD.left + (t - t0) / tSpan * gW;
      const y   = PAD.top  + gH - ((Math.min(Math.max(snr, SNR_MIN), SNR_MAX) - SNR_MIN) / (SNR_MAX - SNR_MIN)) * gH;
      if (first) { ctx.moveTo(x, y); first = false; }
      else        ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Dots coloured by SNR band
    frames.forEach(f => {
      const snr = f.snr;
      const t   = new Date(f.received_at).getTime();
      const x   = PAD.left + (t - t0) / tSpan * gW;
      const y   = PAD.top  + gH - ((Math.min(Math.max(snr, SNR_MIN), SNR_MAX) - SNR_MIN) / (SNR_MAX - SNR_MIN)) * gH;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = snrColor(snr);
      ctx.fill();
    });

    // Hover tooltip (mouse tracking)
    canvas._frames = frames;
    canvas._t0     = t0;
    canvas._tSpan  = tSpan;
    canvas._gW     = gW;
    canvas._gH     = gH;
  }

  // -------------------------------------------------------------------------
  // Hover tooltip
  // -------------------------------------------------------------------------
  function attachTooltip() {
    const tip = document.createElement('div');
    tip.className = 'snrh-tooltip hidden';
    modal.appendChild(tip);

    canvas.addEventListener('mousemove', e => {
      const f = canvas._frames;
      if (!f || !f.length) { tip.classList.add('hidden'); return; }

      const rect = canvas.getBoundingClientRect();
      const mx   = e.clientX - rect.left;
      const my   = e.clientY - rect.top;

      // Find nearest point
      const t0    = canvas._t0;
      const tSpan = canvas._tSpan;
      const gW    = canvas._gW;
      let best = null, bestDist = Infinity;
      f.forEach(fr => {
        const t = new Date(fr.received_at).getTime();
        const x = PAD.left + (t - t0) / tSpan * gW;
        const d = Math.abs(mx - x);
        if (d < bestDist) { bestDist = d; best = { fr, x }; }
      });

      if (!best || bestDist > 30) { tip.classList.add('hidden'); return; }

      const d   = new Date(best.fr.received_at);
      const snr = best.fr.snr.toFixed(1);
      tip.innerHTML = `<strong>${snr} dB</strong><br>${d.toLocaleTimeString()}<br>${d.toLocaleDateString()}`;
      tip.classList.remove('hidden');

      // Position tip so it stays inside modal
      const mRect = modal.getBoundingClientRect();
      let tx = e.clientX - mRect.left + 12;
      let ty = e.clientY - mRect.top  - 40;
      if (tx + 120 > mRect.width)  tx = e.clientX - mRect.left - 130;
      if (ty < 0) ty = 4;
      tip.style.left = tx + 'px';
      tip.style.top  = ty + 'px';
    });

    canvas.addEventListener('mouseleave', () => tip.classList.add('hidden'));
  }

  // -------------------------------------------------------------------------
  // Auto-refresh
  // -------------------------------------------------------------------------
  function startAutoRefresh() {
    stopAutoRefresh();
    autoTimer = setInterval(() => {
      fetchChannels().then(loadData);
    }, AUTO_INTERVAL_MS);
  }

  function stopAutoRefresh() {
    if (autoTimer !== null) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  function setStatus(msg, count) {
    statusEl.textContent = msg;
    if (count !== undefined) {
      countEl.textContent = count;
    } else if (msg) {
      countEl.textContent = '';
    }
  }

  function fmtAgo(date) {
    const s = Math.floor((Date.now() - date.getTime()) / 1000);
    if (s < 60)   return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }

  // -------------------------------------------------------------------------
  // Open / close
  // -------------------------------------------------------------------------
  function open(channelLabel) {
    if (!overlay) {
      buildDOM();
      attachTooltip();
    }
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    fetchChannels().then(() => {
      if (channelLabel) {
        selChannel = channelLabel;
        selCh.value = channelLabel;
        populateSmChannels();
        populateSenders();
      }
      loadData();
    });

    // Resume auto-refresh if checkbox was left checked
    if (autoRefresh) startAutoRefresh();
  }

  function close() {
    stopAutoRefresh();
    if (overlay) overlay.classList.add('hidden');
    document.body.style.overflow = '';
  }

  return { open, close };
})();
