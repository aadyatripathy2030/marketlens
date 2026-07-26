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
  window.addEventListener('resize', () => { if (lastData) drawChart(lastData); });

  function sma(a, n) { const out = a.map((_, i) => i >= n - 1 ? a.slice(i - n + 1, i + 1).reduce((x, y) => x + y, 0) / n : null); return out; }

  function drawChart(d) {
    const canvas = $('chart');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = 280;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const closes = d.prices.map(p => p.close);
    const fc = d.forecast || [];
    const all = closes.concat(fc);
    const min = Math.min(...all), max = Math.max(...all);
    const pad = (max - min) * 0.08 || 1;
    const lo = min - pad, hi = max + pad;
    const padL = 46, padR = 10, padT = 12, padB = 22;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const total = closes.length + fc.length;
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
    line(sma(closes, 50), 0, col('--sma50'));
    line(sma(closes, 20), 0, col('--sma20'));
    line(closes, 0, col('--accent'));
    // forecast: connect last real point to projection
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
    $('tiles').innerHTML = `
      <div class="tile"><div class="tile-val ${rsiCls}">${r == null ? '—' : r}</div><div class="tile-lbl">RSI (14)</div></div>
      <div class="tile"><div class="tile-val">${fmt(d.indicators.sma20)}</div><div class="tile-lbl">SMA 20</div></div>
      <div class="tile"><div class="tile-val">${fmt(d.indicators.sma50)}</div><div class="tile-lbl">SMA 50</div></div>
      <div class="tile"><div class="tile-val ${projCls}">${fmt(proj)}</div><div class="tile-lbl">${d.forecast.length}-day proj.</div></div>`;
  }

  async function run(symbol) {
    symbol = (symbol || $('symbol').value || '').trim().toUpperCase();
    if (!symbol) return;
    $('error').classList.add('hidden');
    $('goBtn').disabled = true; $('goBtn').textContent = 'Loading…';
    try {
      const r = await fetch('/api/stock?symbol=' + encodeURIComponent(symbol));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not load');
      lastData = d;
      $('modeTag').textContent = d.source === 'live' ? 'live data' : 'demo data';
      $('symName').textContent = d.symbol + (d.name && d.name !== d.symbol ? ' · ' + d.name : '');
      $('price').textContent = d.latest.toFixed(2) + ' ' + d.currency;
      const up = d.change >= 0;
      $('chg').textContent = (up ? '▲ ' : '▼ ') + Math.abs(d.change).toFixed(2) + ' (' + d.changePct.toFixed(2) + '%)';
      $('chg').className = 'chg ' + (up ? 'up' : 'down');
      $('signal').textContent = d.signal.label; $('signal').className = 'signal ' + d.signal.label;
      $('reason').textContent = d.signal.reason;
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
})();
