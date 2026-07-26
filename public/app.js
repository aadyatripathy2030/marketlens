// Frontend for the stock analyzer. Fetches /api/stock, draws the chart, then
// loads the AI summary from /api/analyze.
(function () {
  const $ = (id) => document.getElementById(id);
  const CSS = getComputedStyle(document.documentElement);
  const col = (n) => CSS.getPropertyValue(n).trim();
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  const EXAMPLES = ['AAPL', 'TSLA', 'MSFT', 'NVDA', 'AMZN', 'GOOGL'];
  $('examples').innerHTML = EXAMPLES.map(s => `<button class="chip" data-s="${s}">${s}</button>`).join('');
  $('examples').querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => { $('symbol').value = b.dataset.s; run(b.dataset.s); }));

  let lastData = null;
  let strategy = 'daytrade';
  // Strategy selector — switching re-runs the current ticker through the new lens.
  $('strat').querySelectorAll('.strat-btn').forEach(b => b.addEventListener('click', () => {
    $('strat').querySelectorAll('.strat-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    strategy = b.dataset.mode;
    if (lastData) run(lastData.symbol);
  }));

  window.addEventListener('resize', () => { if (lastData) drawChart(lastData); });

  function sma(a, n) { const out = a.map((_, i) => i >= n - 1 ? a.slice(i - n + 1, i + 1).reduce((x, y) => x + y, 0) / n : null); return out; }

  function drawChart(d) {
    const canvas = $('chart');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = 280;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const bars = d.prices;
    const closes = bars.map(p => p.close);
    const fc = d.forecast || [];
    const min = Math.min(...bars.map(p => p.low), ...fc);
    const max = Math.max(...bars.map(p => p.high), ...fc);
    const pad = (max - min) * 0.08 || 1;
    const lo = min - pad, hi = max + pad;
    const padL = 46, padR = 10, padT = 12, padB = 22;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const total = bars.length + fc.length;
    const X = (i) => padL + (plotW * i) / (total - 1);
    const Y = (v) => padT + plotH * (1 - (v - lo) / (hi - lo));

    // grid + y labels
    ctx.strokeStyle = col('--border'); ctx.fillStyle = col('--muted'); ctx.font = '11px Inter, sans-serif'; ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const val = lo + (hi - lo) * g / 4, y = Y(val);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillText(val.toFixed(0), 6, y + 4);
    }
    function line(vals, offset, color, dashed) {
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dashed ? [5, 4] : []);
      let started = false;
      vals.forEach((v, i) => { if (v == null) return; const x = X(i + offset), y = Y(v); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); });
      ctx.stroke(); ctx.setLineDash([]);
    }

    // candlesticks: wick from high→low, body from open→close (green up / red down)
    const cw = Math.max(1, (plotW / total) * 0.7);
    const upCol = col('--good'), downCol = col('--bad');
    bars.forEach((p, i) => {
      const x = X(i), up = p.close >= p.open, c = up ? upCol : downCol;
      ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, Y(p.high)); ctx.lineTo(x, Y(p.low)); ctx.stroke();
      const yO = Y(p.open), yC = Y(p.close);
      ctx.fillRect(x - cw / 2, Math.min(yO, yC), cw, Math.max(1, Math.abs(yC - yO)));
    });

    const fastN = d.maFast ? d.maFast.period : 20;
    const slowN = d.maSlow ? d.maSlow.period : 50;
    line(sma(closes, slowN), 0, col('--sma50'));
    line(sma(closes, fastN), 0, col('--sma20'));
    // forecast: connect last real close to projection
    if (fc.length) line([closes[closes.length - 1]].concat(fc), closes.length - 1, col('--forecast'), true);

    // x labels (first + last date)
    ctx.fillStyle = col('--muted');
    ctx.fillText(d.prices[0].date, padL, h - 6);
    const lastLbl = d.prices[d.prices.length - 1].date;
    ctx.fillText(lastLbl, w - padR - ctx.measureText(lastLbl).width, h - 6);
  }

  function tiles(d) {
    const r = d.indicators.rsi;
    const rsiCls = r == null ? '' : r >= 70 ? 'hot' : r <= 30 ? 'down' : '';
    const proj = d.forecast && d.forecast.length ? d.forecast[d.forecast.length - 1] : null;
    const projCls = proj == null ? '' : proj > d.latest ? 'up' : 'down';
    const fmt = (v) => v == null ? '—' : v.toFixed(2);
    const fastLbl = d.maFast ? d.maFast.label : 'SMA 20';
    const slowLbl = d.maSlow ? d.maSlow.label : 'SMA 50';
    $('tiles').innerHTML = `
      <div class="tile"><div class="tile-val ${rsiCls}">${r == null ? '—' : r}</div><div class="tile-lbl">RSI (${d.indicators.rsiPeriod})</div></div>
      <div class="tile"><div class="tile-val">${fmt(d.indicators.maFast)}</div><div class="tile-lbl">${fastLbl}</div></div>
      <div class="tile"><div class="tile-val">${fmt(d.indicators.maSlow)}</div><div class="tile-lbl">${slowLbl}</div></div>
      <div class="tile"><div class="tile-val ${projCls}">${fmt(proj)}</div><div class="tile-lbl">${d.forecast.length}-day proj.</div></div>`;
  }

  async function run(symbol) {
    symbol = (symbol || $('symbol').value || '').trim().toUpperCase();
    if (!symbol) return;
    $('error').classList.add('hidden');
    $('goBtn').disabled = true; $('goBtn').textContent = 'Loading…';
    try {
      const r = await fetch('/api/stock?symbol=' + encodeURIComponent(symbol) + '&strategy=' + encodeURIComponent(strategy));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not load');
      lastData = d;
      $('modeTag').textContent = d.source === 'live' ? 'live data' : 'demo data';
      $('symName').textContent = d.symbol + (d.name && d.name !== d.symbol ? ' · ' + d.name : '');
      $('price').textContent = d.latest.toFixed(2) + ' ' + d.currency;
      const up = d.change >= 0;
      $('chg').textContent = (up ? '▲ ' : '▼ ') + Math.abs(d.change).toFixed(2) + ' (' + d.changePct.toFixed(2) + '%)';
      $('chg').className = 'chg ' + (up ? 'up' : 'down');
      const v = d.verdict || { action: d.signal.label, strength: '', tone: d.signal.tone };
      $('vAction').textContent = v.action;
      $('vMeta').textContent = v.strength ? v.strength + ' · ' + v.score : (v.score != null ? 'score ' + v.score : '');
      $('verdict').className = 'verdict ' + (v.tone || 'neutral');
      $('reason').textContent = d.signal.reason + (v.rationale ? '  ·  ' + v.rationale : '');
      $('lgFast').textContent = d.maFast ? d.maFast.label : 'SMA 20';
      $('lgSlow').textContent = d.maSlow ? d.maSlow.label : 'SMA 50';
      if (d.risk) { $('risk').textContent = d.risk; $('risk').className = 'risk' + (d.strategy === 'short' ? ' danger' : ''); }
      else $('risk').className = 'risk hidden';
      $('note').textContent = d.note || '';
      $('result').classList.remove('hidden');
      drawChart(d); tiles(d);
      // AI summary (loads after the chart is visible)
      $('aiBody').textContent = 'Analyzing…'; $('aiTag').textContent = '';
      loadAnalysis(d);
    } catch (e) {
      $('error').textContent = e.message; $('error').classList.remove('hidden'); $('result').classList.add('hidden');
    } finally { $('goBtn').disabled = false; $('goBtn').textContent = 'Analyze'; }
  }

  async function loadAnalysis(d) {
    try {
      const r = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
      const j = await r.json();
      $('aiBody').textContent = j.summary || 'No analysis available.';
      $('aiTag').textContent = j.source === 'ai' ? 'AI-written' : 'rule-based';
    } catch (e) { $('aiBody').textContent = 'Analysis unavailable.'; }
  }

  $('searchForm').addEventListener('submit', (ev) => { ev.preventDefault(); run(); });

  // ---- Image upload: read a chart screenshot, send to Claude vision ----
  let imgData = null; // { base64, mediaType }
  const dz = $('dropzone');
  function loadFile(file) {
    if (!file || !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
      $('imgResult').textContent = 'Please choose a PNG, JPEG, GIF, or WebP image.';
      $('imgResult').classList.remove('hidden'); return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      imgData = { base64: dataUrl.split(',')[1], mediaType: file.type };
      const prev = $('imgPreview'); prev.src = dataUrl; prev.classList.remove('hidden');
      $('dropText').classList.add('hidden');
      $('imgBtn').classList.remove('hidden');
      $('imgResult').classList.add('hidden');
    };
    reader.readAsDataURL(file);
  }
  $('imgInput').addEventListener('change', (e) => loadFile(e.target.files[0]));
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
  $('imgBtn').addEventListener('click', async () => {
    if (!imgData) return;
    $('imgBtn').disabled = true; $('imgBtn').textContent = 'Analyzing…';
    $('imgResult').textContent = ''; $('imgResult').classList.add('hidden');
    try {
      const r = await fetch('/api/analyze-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: imgData.base64, mediaType: imgData.mediaType }) });
      const j = await r.json();
      $('imgResult').textContent = j.summary || j.error || 'No analysis available.';
    } catch (e) { $('imgResult').textContent = 'Analysis unavailable.'; }
    finally { $('imgResult').classList.remove('hidden'); $('imgBtn').disabled = false; $('imgBtn').textContent = 'Analyze image'; }
  });

  // Deep link: /?symbol=AAPL auto-loads that ticker.
  const initial = new URLSearchParams(location.search).get('symbol');
  if (initial) { $('symbol').value = initial.toUpperCase(); run(initial); }
})();
