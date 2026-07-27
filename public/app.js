// Frontend for the stock analyzer. Fetches /api/stock, draws an adjustable
// candlestick chart, then loads the AI summary from /api/analyze.
(function () {
  const $ = (id) => document.getElementById(id);
  const CSS = getComputedStyle(document.documentElement);
  const col = (n) => CSS.getPropertyValue(n).trim();

  const EXAMPLES = ['AAPL', 'TSLA', 'MSFT', 'NVDA', 'AMZN', 'GOOGL'];
  $('examples').innerHTML = EXAMPLES.map(s => `<button class="chip" data-s="${s}">${s}</button>`).join('');
  $('examples').querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => { $('symbol').value = b.dataset.s; run(b.dataset.s); }));

  // ---- Ticker autocomplete ----
  const TICKERS = [
    ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['GOOGL', 'Alphabet (Class A)'], ['GOOG', 'Alphabet (Class C)'],
    ['AMZN', 'Amazon'], ['NVDA', 'NVIDIA'], ['META', 'Meta Platforms'], ['TSLA', 'Tesla'],
    ['BRK.B', 'Berkshire Hathaway'], ['JPM', 'JPMorgan Chase'], ['V', 'Visa'], ['MA', 'Mastercard'],
    ['UNH', 'UnitedHealth'], ['HD', 'Home Depot'], ['PG', 'Procter & Gamble'], ['JNJ', 'Johnson & Johnson'],
    ['XOM', 'Exxon Mobil'], ['CVX', 'Chevron'], ['KO', 'Coca-Cola'], ['PEP', 'PepsiCo'],
    ['BAC', 'Bank of America'], ['WMT', 'Walmart'], ['DIS', 'Walt Disney'], ['NFLX', 'Netflix'],
    ['ADBE', 'Adobe'], ['CRM', 'Salesforce'], ['ORCL', 'Oracle'], ['INTC', 'Intel'],
    ['AMD', 'Advanced Micro Devices'], ['QCOM', 'Qualcomm'], ['CSCO', 'Cisco'], ['IBM', 'IBM'],
    ['TXN', 'Texas Instruments'], ['AVGO', 'Broadcom'], ['MU', 'Micron'], ['PYPL', 'PayPal'],
    ['SHOP', 'Shopify'], ['UBER', 'Uber'], ['ABNB', 'Airbnb'], ['COIN', 'Coinbase'],
    ['PLTR', 'Palantir'], ['SNOW', 'Snowflake'], ['BABA', 'Alibaba'], ['NKE', 'Nike'],
    ['SBUX', 'Starbucks'], ['MCD', "McDonald's"], ['T', 'AT&T'], ['VZ', 'Verizon'],
    ['TMUS', 'T-Mobile'], ['F', 'Ford'], ['GM', 'General Motors'], ['BA', 'Boeing'],
    ['CAT', 'Caterpillar'], ['GE', 'GE Aerospace'], ['MMM', '3M'], ['HON', 'Honeywell'],
    ['UPS', 'United Parcel Service'], ['FDX', 'FedEx'], ['LMT', 'Lockheed Martin'], ['RTX', 'RTX'],
    ['GS', 'Goldman Sachs'], ['MS', 'Morgan Stanley'], ['WFC', 'Wells Fargo'], ['C', 'Citigroup'],
    ['AXP', 'American Express'], ['BLK', 'BlackRock'], ['NOW', 'ServiceNow'], ['INTU', 'Intuit'],
    ['AMAT', 'Applied Materials'], ['LRCX', 'Lam Research'], ['ASML', 'ASML'], ['ARM', 'Arm Holdings'],
    ['MRVL', 'Marvell'], ['SMCI', 'Super Micro'], ['DELL', 'Dell'], ['DDOG', 'Datadog'],
    ['NET', 'Cloudflare'], ['CRWD', 'CrowdStrike'], ['PANW', 'Palo Alto Networks'], ['ABT', 'Abbott'],
    ['PFE', 'Pfizer'], ['MRK', 'Merck'], ['LLY', 'Eli Lilly'], ['TMO', 'Thermo Fisher'],
    ['BMY', 'Bristol Myers Squibb'], ['AMGN', 'Amgen'], ['GILD', 'Gilead'], ['CVS', 'CVS Health'],
    ['COST', 'Costco'], ['TGT', 'Target'], ['LOW', "Lowe's"], ['CMCSA', 'Comcast'],
    ['SPY', 'SPDR S&P 500 ETF'], ['QQQ', 'Invesco QQQ (Nasdaq-100)'], ['DIA', 'SPDR Dow Jones ETF'],
    ['IWM', 'iShares Russell 2000'], ['VTI', 'Vanguard Total Market'], ['VOO', 'Vanguard S&P 500'],
  ];
  const suggestBox = $('suggest');
  let sugItems = [], sugIdx = -1;

  function renderSuggest(qRaw) {
    const q = (qRaw || '').trim().toUpperCase();
    if (!q) return hideSuggest();
    const starts = [], byName = [];
    for (const t of TICKERS) {
      if (t[0].startsWith(q)) starts.push(t);
      else if (t[1].toUpperCase().startsWith(q)) byName.push(t);
    }
    sugItems = starts.concat(byName).slice(0, 8);
    if (!sugItems.length) return hideSuggest();
    sugIdx = -1;
    suggestBox.innerHTML = sugItems.map(([sym, name], i) =>
      `<div class="suggest-item" role="option" data-sym="${sym}" data-i="${i}"><span class="suggest-sym">${sym}</span><span class="suggest-name">${name}</span></div>`).join('');
    suggestBox.classList.remove('hidden');
    $('symbol').setAttribute('aria-expanded', 'true');
    suggestBox.querySelectorAll('.suggest-item').forEach(el =>
      el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(el.dataset.sym); }));
  }
  function hideSuggest() { suggestBox.classList.add('hidden'); suggestBox.innerHTML = ''; sugItems = []; sugIdx = -1; $('symbol').setAttribute('aria-expanded', 'false'); }
  function pick(sym) { $('symbol').value = sym; hideSuggest(); run(sym); }
  function highlight(idx) { suggestBox.querySelectorAll('.suggest-item').forEach((el, i) => el.classList.toggle('active', i === idx)); sugIdx = idx; }

  $('symbol').addEventListener('input', () => renderSuggest($('symbol').value));
  $('symbol').addEventListener('focus', () => { if ($('symbol').value) renderSuggest($('symbol').value); });
  $('symbol').addEventListener('keydown', (e) => {
    if (suggestBox.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(Math.min(sugIdx + 1, sugItems.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(sugIdx - 1, 0)); }
    else if (e.key === 'Enter' && sugIdx >= 0) { e.preventDefault(); pick(sugItems[sugIdx][0]); }
    else if (e.key === 'Escape') hideSuggest();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search-box')) hideSuggest(); });

  let lastData = null;
  let strategy = 'daytrade';
  let direction = 'long';
  let interval = '1day';    // candle size (1min … 1month)
  let rangeDays = 126;      // active range button, in trading days (0 = All)
  let view = null;          // {start, end} indices into prices for zoom/pan
  let chartType = 'candle'; // 'candle' | 'line'
  const show = { fast: true, slow: true, proj: true }; // overlay visibility

  // Approx bars per trading day per interval, so a range like "6M" spans ~6
  // months of history regardless of the candle size.
  const BARS_PER_DAY = { '1min': 390, '5min': 78, '15min': 26, '30min': 13, '1h': 7, '4h': 2, '1day': 1, '1week': 0.2, '1month': 1 / 21 };

  // Strategy tabs (Day trading / Long-term). Long-term is long-only, so the
  // Long/Short toggle only shows for day trading.
  $('strat').querySelectorAll('.strat-btn').forEach(b => b.addEventListener('click', () => {
    $('strat').querySelectorAll('.strat-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    strategy = b.dataset.mode;
    $('direction').style.display = strategy === 'longterm' ? 'none' : '';
    if (lastData) run(lastData.symbol);
  }));
  // Long / Short direction (day trading only)
  $('direction').querySelectorAll('.dir-btn').forEach(b => b.addEventListener('click', () => {
    $('direction').querySelectorAll('.dir-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    direction = b.dataset.dir;
    if (lastData) run(lastData.symbol);
  }));
  // Chart range buttons (how far back to view)
  $('range').querySelectorAll('.range-btn').forEach(b => b.addEventListener('click', () => {
    $('range').querySelectorAll('.range-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    rangeDays = parseInt(b.dataset.days, 10);
    resetView(); drawChart();
  }));
  // Candle interval buttons (each candle = this much time; refetches)
  $('interval').querySelectorAll('.range-btn').forEach(b => b.addEventListener('click', () => {
    $('interval').querySelectorAll('.range-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    interval = b.dataset.iv;
    if (lastData) run(lastData.symbol);
  }));
  // Overlay toggles: candles/line, each SMA, projection (redraw only, no refetch)
  $('overlays').querySelectorAll('.ov').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.k;
    if (k === 'type') {
      chartType = chartType === 'candle' ? 'line' : 'candle';
      $('ovType').textContent = chartType === 'candle' ? '📊 Candles' : '📈 Line';
    } else {
      show[k] = !show[k];
      b.classList.toggle('active', show[k]);
    }
    drawChart();
  }));

  window.addEventListener('resize', drawChart);

  function sma(a, n) { return a.map((_, i) => i >= n - 1 ? a.slice(i - n + 1, i + 1).reduce((x, y) => x + y, 0) / n : null); }

  function resetView() {
    if (!lastData) { view = null; return; }
    const len = lastData.prices.length;
    const bars = Math.round(rangeDays * (BARS_PER_DAY[interval] || 1));
    const n = rangeDays > 0 ? Math.min(Math.max(bars, 10), len) : len;
    view = { start: len - n, end: len };
  }

  function drawChart() {
    const d = lastData; if (!d || !view) return;
    const canvas = $('chart');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight || 440;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const prices = d.prices, len = prices.length;
    let start = Math.max(0, Math.floor(view.start));
    let end = Math.min(len, Math.ceil(view.end));
    if (end - start < 3) return;
    const bars = prices.slice(start, end);
    const showForecast = show.proj && end >= len;
    const fc = showForecast ? (d.forecast || []) : [];

    const fastN = d.maFast ? d.maFast.period : 20;
    const slowN = d.maSlow ? d.maSlow.period : 50;
    const closes = prices.map(p => p.close);
    const visFast = show.fast ? sma(closes, fastN).slice(start, end) : [];
    const visSlow = show.slow ? sma(closes, slowN).slice(start, end) : [];

    // y-range from visible highs/lows, visible SMA values, and forecast
    const vals = [];
    bars.forEach(p => { vals.push(p.high, p.low); });
    visFast.concat(visSlow).forEach(v => { if (v != null) vals.push(v); });
    fc.forEach(v => vals.push(v));
    const min = Math.min(...vals), max = Math.max(...vals);
    const pad = (max - min) * 0.08 || 1;
    const lo = min - pad, hi = max + pad;
    const padL = 52, padR = 12, padT = 12, padB = 24;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const total = bars.length + fc.length;
    const X = (i) => padL + (plotW * i) / (total - 1);
    const Y = (v) => padT + plotH * (1 - (v - lo) / (hi - lo));

    // grid + y labels
    ctx.strokeStyle = col('--border'); ctx.fillStyle = col('--muted'); ctx.font = '11px Inter, sans-serif'; ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const val = lo + (hi - lo) * g / 4, y = Y(val);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillText(val.toFixed(2), 6, y + 4);
    }
    function line(arr, offset, color, dashed) {
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dashed ? [5, 4] : []);
      let started = false;
      arr.forEach((v, i) => { if (v == null) return; const x = X(i + offset), y = Y(v); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); });
      ctx.stroke(); ctx.setLineDash([]);
    }

    if (chartType === 'candle') {
      const cw = Math.max(1, (plotW / total) * 0.7);
      const upCol = col('--good'), downCol = col('--bad');
      bars.forEach((p, j) => {
        const x = X(j), up = p.close >= p.open, c = up ? upCol : downCol;
        ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, Y(p.high)); ctx.lineTo(x, Y(p.low)); ctx.stroke();
        const yO = Y(p.open), yC = Y(p.close);
        ctx.fillRect(x - cw / 2, Math.min(yO, yC), cw, Math.max(1, Math.abs(yC - yO)));
      });
    } else {
      line(bars.map(p => p.close), 0, col('--accent'));
    }

    if (show.slow) line(visSlow, 0, col('--sma50'));
    if (show.fast) line(visFast, 0, col('--sma20'));
    if (fc.length) line([bars[bars.length - 1].close].concat(fc), bars.length - 1, col('--forecast'), true);

    // x labels (first + last visible date)
    ctx.fillStyle = col('--muted');
    ctx.fillText(bars[0].date, padL, h - 6);
    const lastLbl = bars[bars.length - 1].date;
    ctx.fillText(lastLbl, padL + plotW * (bars.length - 1) / (total - 1) - ctx.measureText(lastLbl).width, h - 6);
  }

  // ---- Interactive zoom / pan ----
  (function setupChartInteraction() {
    const canvas = $('chart');
    canvas.addEventListener('wheel', (e) => {
      if (!lastData || !view) return;
      e.preventDefault();
      const len = lastData.prices.length;
      const rect = canvas.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const span = view.end - view.start;
      const newSpan = Math.max(10, Math.min(len, span * (e.deltaY > 0 ? 1.15 : 0.87)));
      const anchor = view.start + frac * span;
      let start = anchor - frac * newSpan, end = start + newSpan;
      if (start < 0) { start = 0; end = newSpan; }
      if (end > len) { end = len; start = len - newSpan; }
      view = { start, end }; drawChart();
    }, { passive: false });

    let dragging = false, dragX = 0;
    canvas.addEventListener('mousedown', (e) => { dragging = true; dragX = e.clientX; });
    window.addEventListener('mousemove', (e) => {
      if (!dragging || !lastData || !view) return;
      const len = lastData.prices.length, rect = canvas.getBoundingClientRect();
      const span = view.end - view.start;
      const dxBars = (e.clientX - dragX) / rect.width * span;
      dragX = e.clientX;
      let start = view.start - dxBars, end = view.end - dxBars;
      if (start < 0) { start = 0; end = span; }
      if (end > len) { end = len; start = len - span; }
      view = { start, end }; drawChart();
    });
    window.addEventListener('mouseup', () => { dragging = false; });
    canvas.addEventListener('dblclick', () => { resetView(); drawChart(); });
  })();

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
      <div class="tile"><div class="tile-val ${projCls}">${fmt(proj)}</div><div class="tile-lbl">${d.forecast.length}-bar proj.</div></div>`;
  }

  async function run(symbol) {
    symbol = (symbol || $('symbol').value || '').trim().toUpperCase();
    if (!symbol) return;
    $('error').classList.add('hidden');
    $('goBtn').disabled = true; $('goBtn').textContent = 'Loading…';
    try {
      const r = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&strategy=${encodeURIComponent(strategy)}&direction=${encodeURIComponent(direction)}&interval=${encodeURIComponent(interval)}`);
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
      $('ovFast').textContent = d.maFast ? d.maFast.label : 'SMA 20';
      $('ovSlow').textContent = d.maSlow ? d.maSlow.label : 'SMA 50';
      if (d.risk) { $('risk').textContent = d.risk; $('risk').className = 'risk' + (d.direction === 'short' ? ' danger' : ''); }
      else $('risk').className = 'risk hidden';
      $('note').textContent = d.note || '';
      $('result').classList.remove('hidden');
      resetView(); drawChart(); tiles(d);
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

  $('searchForm').addEventListener('submit', (ev) => { ev.preventDefault(); hideSuggest(); run(); });

  // ---- Image upload: read a chart screenshot, send to Claude vision ----
  let imgData = null;
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

  // Auto-load a ticker so the chart is visible immediately (deep-link aware).
  const initial = (new URLSearchParams(location.search).get('symbol') || 'AAPL').toUpperCase();
  $('symbol').value = initial;
  run(initial);
})();
