// Frontend for the stock analyzer. Fetches /api/stock, draws an adjustable
// candlestick chart, then loads the AI summary from /api/analyze.
(function () {
  const $ = (id) => document.getElementById(id);
  const CSS = getComputedStyle(document.documentElement);
  const col = (n) => CSS.getPropertyValue(n).trim();
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Plain-English technical-indicator grid.
  function renderTech(t) {
    if (!t) { $('techGrid').innerHTML = ''; return; }
    const f2 = (v) => v == null ? '—' : (+v).toFixed(2);
    const items = [];
    const add = (name, val, note, cls) => items.push({ name, val, note, cls: cls || '' });
    if (t.rsi14 != null) add('RSI (14)', t.rsi14, t.rsi14 >= 70 ? 'Overbought — stretched up, pullback risk' : t.rsi14 <= 30 ? 'Oversold — stretched down, possible bounce' : t.rsi14 >= 50 ? 'Firm momentum, buyers in control' : 'Soft momentum, sellers leaning in', t.rsi14 >= 70 ? 'bear' : t.rsi14 <= 30 ? 'bull' : t.rsi14 >= 50 ? 'bull' : 'bear');
    if (t.macd) add('MACD', f2(t.macd.hist), t.macd.hist > 0 ? 'Bullish — MACD above its signal line' : 'Bearish — MACD below its signal line', t.macd.hist > 0 ? 'bull' : 'bear');
    if (t.sma && t.sma[20] != null && t.sma[50] != null) add('SMA 20 / 50', f2(t.sma[20]) + ' / ' + f2(t.sma[50]), t.sma[20] > t.sma[50] ? 'Short-term uptrend (20 above 50)' : 'Short-term downtrend (20 below 50)', t.sma[20] > t.sma[50] ? 'bull' : 'bear');
    if (t.sma && t.sma[200] != null) add('SMA 200', f2(t.sma[200]), t.price > t.sma[200] ? 'Price above 200-day — long-term bullish' : 'Price below 200-day — long-term bearish', t.price > t.sma[200] ? 'bull' : 'bear');
    if (t.ema && t.ema[20] != null && t.ema[50] != null) add('EMA 20 / 50', f2(t.ema[20]) + ' / ' + f2(t.ema[50]), t.ema[20] > t.ema[50] ? 'Fast EMA above slow — momentum up' : 'Fast EMA below slow — momentum down', t.ema[20] > t.ema[50] ? 'bull' : 'bear');
    if (t.bollinger) { const pb = t.bollinger.pctB; add('Bollinger %B', Math.round(pb * 100) + '%', pb > 1 ? 'Above upper band — overextended' : pb < 0 ? 'Below lower band — oversold stretch' : pb > 0.8 ? 'Near upper band' : pb < 0.2 ? 'Near lower band' : 'Mid-range, no extreme', pb > 1 ? 'bear' : pb < 0 ? 'bull' : ''); }
    if (t.vwap != null) add('VWAP', f2(t.vwap), t.price > t.vwap ? 'Price above VWAP — buyers in control' : 'Price below VWAP — sellers in control', t.price > t.vwap ? 'bull' : 'bear');
    if (t.atr != null) add('ATR (14)', f2(t.atr), '~' + (t.atr / t.price * 100).toFixed(1) + '% typical daily move', '');
    if (t.supportResistance) { const s = t.supportResistance; add('Support / Resistance', f2(s.support) + ' / ' + f2(s.resistance), ((t.price - s.support) / t.price * 100).toFixed(1) + '% above support · ' + ((s.resistance - t.price) / t.price * 100).toFixed(1) + '% below resistance', ''); }
    if (t.fibonacci) { const L = t.fibonacci.levels; add('Fibonacci', f2(L['61.8%']) + ' / ' + f2(L['50.0%']) + ' / ' + f2(L['38.2%']), 'Retracement levels (61.8 / 50 / 38.2%)', ''); }
    if (t.volatility) { const a = t.volatility.annual; add('Volatility', a.toFixed(0) + '%', (a < 25 ? 'Low' : a < 45 ? 'Moderate' : a < 70 ? 'High' : 'Very high') + ' — annualized', a >= 45 ? 'bear' : ''); }
    if (t.trend) add('Trend strength', t.trend.strength + '/100', (t.trend.strength >= 60 ? 'Strong' : t.trend.strength >= 35 ? 'Moderate' : 'Weak') + ' ' + t.trend.direction + 'trend', t.trend.strength >= 35 ? (t.trend.direction === 'up' ? 'bull' : 'bear') : '');
    if (t.volume != null && t.avgVolume != null) add('Volume', (t.volume / 1e6).toFixed(1) + 'M', t.volume > t.avgVolume ? 'Above 20-day average — active' : 'Below average — quiet', '');
    $('techGrid').innerHTML = items.map(it => `<div class="tech-item"><div class="tech-top"><span class="tech-name">${esc(it.name)}</span><span class="tech-val">${esc(String(it.val))}</span></div><div class="tech-note ${it.cls}">${esc(it.note)}</div></div>`).join('');
  }

  // One-line rating reason (consistent with the badge/score).
  function ratingReason(d) {
    const t = d.tech || {}, r = d.rating || {};
    const bits = [];
    if (t.sma && t.sma[50] != null && t.sma[200] != null) bits.push(t.sma[50] > t.sma[200] ? 'long-term trend up' : 'long-term trend down');
    if (t.rsi14 != null) bits.push(t.rsi14 >= 70 ? 'overbought' : t.rsi14 <= 30 ? 'oversold' : t.rsi14 >= 50 ? 'firm momentum' : 'soft momentum');
    if (t.macd) bits.push(t.macd.hist > 0 ? 'MACD bullish' : 'MACD bearish');
    if (t.trend) bits.push((t.trend.strength >= 60 ? 'strong' : t.trend.strength >= 35 ? 'moderate' : 'weak') + ' ' + t.trend.direction + 'trend');
    return `Comprehensive read across 13 signals → ${r.label || '—'}${bits.length ? '. ' + bits.join(', ') + '.' : ''}`;
  }

  // Probabilistic forecast bands.
  function renderBands(bands) {
    if (!bands || !bands.length) { $('bands').innerHTML = ''; return; }
    const lo = Math.min(...bands.map(b => b.low)), hi = Math.max(...bands.map(b => b.high));
    const span = (hi - lo) || 1, pct = (v) => (v - lo) / span * 100;
    $('bands').innerHTML = bands.map(b => {
      const l = pct(b.low), w = Math.max(1, pct(b.high) - l), m = pct(b.mid);
      return `<div class="band-row"><span class="band-label">${esc(b.label)}</span><div class="band-track"><div class="band-range" style="left:${l}%;width:${w}%"></div><div class="band-mid" style="left:${m}%"></div></div><span class="band-nums"><b>${b.low.toFixed(2)}</b> – <b>${b.high.toFixed(2)}</b></span></div>`;
    }).join('');
  }

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
  let viewCandles = null;   // when set, view shows exactly this many recent candles
  const DEFAULT_CANDLES = 90; // zoomed-in default when the interval changes
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
    if (lastData) run(lastData.symbol);
  }));
  // Chart range buttons (how far back to view)
  $('range').querySelectorAll('.range-btn').forEach(b => b.addEventListener('click', () => {
    $('range').querySelectorAll('.range-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    rangeDays = parseInt(b.dataset.days, 10);
    viewCandles = null;               // an explicit history range overrides the candle default
    resetView(); drawChart();
  }));
  // Candle interval buttons (each candle = this much time; refetches, resets to a zoomed-in view)
  $('interval').querySelectorAll('.range-btn').forEach(b => b.addEventListener('click', () => {
    $('interval').querySelectorAll('.range-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    interval = b.dataset.iv;
    viewCandles = DEFAULT_CANDLES;    // reset zoom to a sensible in-view amount on every interval change
    $('range').querySelectorAll('.range-btn').forEach(x => x.classList.remove('active'));
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
    let n;
    if (viewCandles) n = Math.min(viewCandles, len);
    else if (rangeDays > 0) n = Math.min(Math.max(Math.round(rangeDays * (BARS_PER_DAY[interval] || 1)), 10), len);
    else n = len;
    view = { start: len - Math.max(n, 10), end: len };
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

  // Fundamentals + news (Financial Modeling Prep) — only refetched per ticker.
  let lastFundSymbol = null;
  async function loadFundamentals(symbol) {
    symbol = (symbol || '').toUpperCase();
    if (symbol === lastFundSymbol) return;
    lastFundSymbol = symbol;
    $('fundCard').classList.add('hidden'); $('newsCard').classList.add('hidden');
    try {
      const d = await (await fetch('/api/fundamentals?symbol=' + encodeURIComponent(symbol))).json();
      if (symbol !== lastFundSymbol) return;      // a newer ticker superseded this
      if (!d.available) return;                   // no FMP key → stay hidden
      if (d.metrics && d.metrics.length) {
        $('fundGrid').innerHTML = d.metrics.map(m => `<div class="tech-item"><div class="tech-top"><span class="tech-name">${esc(m.label)}</span><span class="tech-val">${esc(m.value)}</span></div></div>`).join('');
        $('fundProfile').textContent = d.profile ? [d.profile.sector, d.profile.industry].filter(Boolean).join(' · ') : '';
        $('fundCard').classList.remove('hidden');
      }
      if (d.news && d.news.length) {
        $('newsList').innerHTML = d.news.map(n => `<a class="news-item" href="${esc(n.url)}" target="_blank" rel="noopener noreferrer"><div class="news-title">${esc(n.title)}</div><div class="news-meta">${esc(n.site || '')}${n.date ? ' · ' + esc(String(n.date).slice(0, 10)) : ''}</div></a>`).join('');
        $('newsCard').classList.remove('hidden');
      }
    } catch (e) { /* leave hidden on error */ }
  }

  // Live updating: poll the latest quote every 20s and update the last candle + header.
  let liveTimer = null;
  function startLive() { if (!liveTimer) liveTimer = setInterval(liveTick, 20000); }
  async function liveTick() {
    if (!lastData || document.hidden || $('view-analyze').classList.contains('hidden')) return;
    const sym = lastData.symbol;
    let q; try { q = (await getQuotes([sym]))[0]; } catch { return; }
    if (!q || !lastData || lastData.symbol !== sym) return;
    const prices = lastData.prices; if (!prices.length) return;
    const last = prices[prices.length - 1];
    last.close = q.price;
    if (q.price > last.high) last.high = q.price;
    if (q.price < last.low) last.low = q.price;
    lastData.latest = q.price;
    $('price').textContent = (+q.price).toFixed(2) + ' ' + lastData.currency;
    const up = q.changePct >= 0;
    $('chg').textContent = (up ? '▲ ' : '▼ ') + Math.abs(q.change).toFixed(2) + ' (' + q.changePct.toFixed(2) + '%)';
    $('chg').className = 'chg ' + (up ? 'up' : 'down');
    drawChart();
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
      updateWatchBtn(d.symbol);
      $('price').textContent = d.latest.toFixed(2) + ' ' + d.currency;
      const up = d.change >= 0;
      $('chg').textContent = (up ? '▲ ' : '▼ ') + Math.abs(d.change).toFixed(2) + ' (' + d.changePct.toFixed(2) + '%)';
      $('chg').className = 'chg ' + (up ? 'up' : 'down');
      const rt = d.rating || {};
      const v = d.verdict || {};
      $('vAction').textContent = rt.label || v.action || d.signal.label;
      $('vMeta').textContent = rt.score != null ? rt.score + '/100' : (v.score != null ? 'score ' + v.score : '');
      $('verdict').className = 'verdict ' + (rt.tone || v.tone || 'neutral');
      $('reason').textContent = ratingReason(d);
      const GAUGE_C = 2 * Math.PI * 52;
      $('gaugeArc').style.strokeDasharray = GAUGE_C;
      $('gaugeArc').style.strokeDashoffset = GAUGE_C * (1 - (rt.score || 0) / 100);
      $('gScore').textContent = rt.score != null ? rt.score : '—';
      $('aiRec').textContent = rt.label || '—';
      $('aiRec').className = 'ai-rec ' + (rt.tone || 'neutral');
      $('aiConf').textContent = rt.confidence != null ? rt.confidence + '%' : '—';
      $('aiRisk').textContent = rt.risk || '—';
      $('aiRisk').className = 'risk-' + String(rt.risk || 'neutral').split(' ')[0];
      $('ovFast').textContent = d.maFast ? d.maFast.label : 'SMA 20';
      $('ovSlow').textContent = d.maSlow ? d.maSlow.label : 'SMA 50';
      if (d.risk) { $('risk').textContent = d.risk; $('risk').className = 'risk' + (d.direction === 'short' ? ' danger' : ''); }
      else $('risk').className = 'risk hidden';
      $('note').textContent = d.note || '';
      $('result').classList.remove('hidden');
      resetView(); drawChart(); tiles(d); renderTech(d.tech); renderBands(d.bands);
      $('aiBody').textContent = 'Analyzing…'; $('aiTag').textContent = '';
      $('bullList').innerHTML = '<li>Analyzing…</li>'; $('bearList').innerHTML = '<li>Analyzing…</li>'; $('conclusion').textContent = '';
      loadAnalysis(d);
      loadFundamentals(d.symbol);
      startLive();
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
      $('bullList').innerHTML = (j.bull && j.bull.length ? j.bull : ['—']).map(x => `<li>${esc(x)}</li>`).join('');
      $('bearList').innerHTML = (j.bear && j.bear.length ? j.bear : ['—']).map(x => `<li>${esc(x)}</li>`).join('');
      $('conclusion').textContent = j.conclusion || '';
    } catch (e) { $('aiBody').textContent = 'Analysis unavailable.'; $('bullList').innerHTML = ''; $('bearList').innerHTML = ''; }
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
    finally { $('imgResult').classList.remove('hidden'); $('imgBtn').disabled = false; $('imgBtn').textContent = '✨ Analyze image'; }
  });

  // ---- Accounts + watchlist ----
  let currentUser = null, watchSymbols = [], authMode = 'login';

  function renderAcct() {
    const el = $('acct');
    if (currentUser) {
      el.innerHTML = `<span class="plan">${esc(currentUser.plan)}</span><span class="email">${esc(currentUser.email)}</span><button class="link-btn" id="logoutBtn">Log out</button>`;
      $('logoutBtn').addEventListener('click', logout);
    } else {
      el.innerHTML = `<button class="signin" id="signinBtn">Sign in</button>`;
      $('signinBtn').addEventListener('click', () => openAuth('login'));
    }
  }
  async function checkAuth() {
    try { const j = await (await fetch('/api/auth/me')).json(); currentUser = j.user || null; } catch { currentUser = null; }
    renderAcct();
    $('watchBtn').classList.toggle('hidden', !currentUser);
    if (currentUser) loadWatchlist(); else { watchSymbols = []; renderWatchStrip(); }
  }
  function openAuth(mode) {
    authMode = mode;
    $('authTitle').textContent = mode === 'signup' ? 'Create your account' : 'Sign in';
    $('authSubmit').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
    $('authToggleText').textContent = mode === 'signup' ? 'Already have an account?' : 'New to MarketLens?';
    $('authToggle').textContent = mode === 'signup' ? 'Sign in' : 'Create an account';
    $('authErr').classList.add('hidden');
    $('authModal').classList.remove('hidden');
    $('authEmail').focus();
  }
  const closeAuth = () => $('authModal').classList.add('hidden');
  $('authClose').addEventListener('click', closeAuth);
  $('authModal').addEventListener('click', (e) => { if (e.target === $('authModal')) closeAuth(); });
  $('authToggle').addEventListener('click', (e) => { e.preventDefault(); openAuth(authMode === 'signup' ? 'login' : 'signup'); });
  $('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('authEmail').value.trim(), password = $('authPass').value;
    $('authErr').classList.add('hidden'); $('authSubmit').disabled = true;
    try {
      const r = await fetch('/api/auth/' + authMode, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Something went wrong.');
      currentUser = j.user; closeAuth(); renderAcct();
      $('watchBtn').classList.remove('hidden'); $('authPass').value = '';
      loadWatchlist();
    } catch (err) { $('authErr').textContent = err.message; $('authErr').classList.remove('hidden'); }
    finally { $('authSubmit').disabled = false; }
  });
  async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    currentUser = null; watchSymbols = []; renderAcct(); renderWatchStrip();
    $('watchBtn').classList.add('hidden');
  }
  async function loadWatchlist() {
    try { const j = await (await fetch('/api/watchlist')).json(); watchSymbols = j.symbols || []; } catch { watchSymbols = []; }
    renderWatchStrip();
    if (lastData) updateWatchBtn(lastData.symbol);
  }
  function renderWatchStrip() {
    const el = $('watchStrip');
    if (!currentUser || !watchSymbols.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    el.innerHTML = `<span class="wl-label">★ Watchlist</span>` + watchSymbols.map(s => `<span class="wl-chip" data-s="${esc(s)}">${esc(s)}<span class="x" data-x="${esc(s)}">×</span></span>`).join('');
    el.querySelectorAll('.wl-chip').forEach(c => c.addEventListener('click', (e) => {
      if (e.target.dataset.x) { e.stopPropagation(); toggleWatch(e.target.dataset.x, true); }
      else { $('symbol').value = c.dataset.s; run(c.dataset.s); }
    }));
  }
  function updateWatchBtn(symbol) {
    if (!$('watchBtn')) return;
    const on = currentUser && watchSymbols.includes((symbol || '').toUpperCase());
    $('watchBtn').textContent = on ? '★ Watching' : '☆ Watch';
    $('watchBtn').classList.toggle('on', !!on);
  }
  async function toggleWatch(symbol, forceRemove) {
    if (!currentUser) return openAuth('login');
    symbol = (symbol || '').toUpperCase();
    const remove = forceRemove || watchSymbols.includes(symbol);
    try { const j = await (await fetch('/api/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, action: remove ? 'remove' : 'add' }) })).json(); watchSymbols = j.symbols || watchSymbols; } catch {}
    renderWatchStrip();
    if (lastData) updateWatchBtn(lastData.symbol);
  }
  $('watchBtn').addEventListener('click', () => { if (lastData) toggleWatch(lastData.symbol); });
  checkAuth();

  // ---- Views (Home / Analyze / Markets / Watchlist) ----
  const VIEWS = ['home', 'analyze', 'chat', 'compare', 'screener', 'markets', 'watchlist', 'alerts', 'learn'];
  function showView(name) {
    if (!VIEWS.includes(name)) name = 'home';
    VIEWS.forEach(v => $('view-' + v).classList.toggle('hidden', v !== name));
    document.querySelectorAll('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.view === name));
    window.scrollTo(0, 0);
    if (name === 'markets') loadMarkets();
    if (name === 'watchlist') renderWatchView();
    if (name === 'home') loadHomeSnapshot();
    if (name === 'chat') { renderChat(); renderChatSuggest(); $('chatInput').focus(); }
    if (name === 'learn') renderLearnGrid();
    if (name === 'compare') { renderCompareChips(); if (compareSymbols.length >= 2 && !$('compareResult').innerHTML) loadCompare(); }
    if (name === 'screener' && !$('screenResult').innerHTML) loadScreen();
    if (name === 'alerts') loadAlerts();
  }
  function goAnalyze(sym) { showView('analyze'); if (sym) { $('symbol').value = sym; run(sym); } }
  document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', (e) => { e.preventDefault(); showView(el.dataset.view); }));

  // Hero
  $('heroForm').addEventListener('submit', (e) => { e.preventDefault(); const s = $('heroInput').value.trim().toUpperCase(); if (s) goAnalyze(s); });
  $('heroMarkets').addEventListener('click', () => showView('markets'));
  $('heroExamples').innerHTML = ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'GOOGL'].map(s => `<button class="chip" data-s="${s}">${s}</button>`).join('');
  $('heroExamples').querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => goAnalyze(b.dataset.s)));

  // Markets + quotes
  const INDICES = [['SPY', 'S&P 500'], ['QQQ', 'Nasdaq 100'], ['DIA', 'Dow Jones'], ['IWM', 'Russell 2000']];
  const TRENDING = ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'META', 'GOOGL', 'AMD', 'NFLX', 'COIN', 'PLTR', 'AVGO'];
  const nameOf = {}; TICKERS.forEach(t => nameOf[t[0]] = t[1]); INDICES.forEach(i => nameOf[i[0]] = i[1]);
  async function getQuotes(symbols) {
    try { const j = await (await fetch('/api/quotes?symbols=' + encodeURIComponent(symbols.join(',')))).json(); return j.quotes || []; } catch { return []; }
  }
  function quoteCard(q) {
    const up = q.changePct >= 0;
    return `<div class="quote-card" data-s="${esc(q.symbol)}"><div class="quote-sym">${esc(q.symbol)}</div><div class="quote-name">${esc(nameOf[q.symbol] || '')}</div><div class="quote-price">${(+q.price).toFixed(2)}</div><div class="quote-chg ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(q.changePct).toFixed(2)}%</div></div>`;
  }
  function bindQuoteCards(el) { el.querySelectorAll('.quote-card').forEach(c => c.addEventListener('click', () => goAnalyze(c.dataset.s))); }
  let marketsLoaded = false;
  async function loadMarkets() {
    if (marketsLoaded) return;
    const [idx, trend] = await Promise.all([getQuotes(INDICES.map(i => i[0])), getQuotes(TRENDING)]);
    $('indicesGrid').innerHTML = idx.length ? idx.map(quoteCard).join('') : '<div class="quote-loading">Unavailable right now.</div>';
    $('trendingGrid').innerHTML = trend.length ? trend.map(quoteCard).join('') : '<div class="quote-loading">Unavailable right now.</div>';
    bindQuoteCards($('indicesGrid')); bindQuoteCards($('trendingGrid'));
    if (idx.length) marketsLoaded = true;
  }
  async function loadHomeSnapshot() {
    if ($('homeSnapshot').dataset.loaded) return;
    const idx = await getQuotes(INDICES.map(i => i[0]));
    if (idx.length) { $('homeSnapshot').innerHTML = idx.map(quoteCard).join(''); bindQuoteCards($('homeSnapshot')); $('homeSnapshot').dataset.loaded = '1'; }
    else $('homeSnapshot').innerHTML = '<div class="quote-loading">—</div>';
  }
  async function renderWatchView() {
    const el = $('watchView');
    if (!currentUser) { el.innerHTML = `<div class="view-empty">Sign in to build a watchlist that syncs across your devices.<br><button class="btn btn-primary" id="wvSignin">Sign in</button></div>`; $('wvSignin').addEventListener('click', () => openAuth('login')); return; }
    if (!watchSymbols.length) { el.innerHTML = `<div class="view-empty">No stocks saved yet.<br>Analyze a stock and tap <b>☆ Watch</b> to add it here.</div>`; return; }
    el.innerHTML = `<div class="quote-grid" id="wvGrid"><div class="quote-loading">Loading…</div></div>`;
    const q = await getQuotes(watchSymbols);
    $('wvGrid').innerHTML = (q.length ? q.map(quoteCard).join('') : watchSymbols.map(s => `<div class="quote-card" data-s="${esc(s)}"><div class="quote-sym">${esc(s)}</div></div>`));
    bindQuoteCards($('wvGrid'));
  }

  // ---- AI Analyst chat ----
  const chatHistory = [];
  const CHAT_SUGGEST = ['Should I buy Apple?', 'Compare NVDA vs AMD', 'Explain RSI simply', 'Why can a stock fall on good earnings?'];
  function renderChatSuggest() {
    $('chatSuggest').innerHTML = chatHistory.length ? '' : CHAT_SUGGEST.map(s => `<button type="button" class="chat-chip">${esc(s)}</button>`).join('');
    $('chatSuggest').querySelectorAll('.chat-chip').forEach(b => b.addEventListener('click', () => { $('chatInput').value = b.textContent; sendChat(); }));
  }
  function renderChat() {
    const el = $('chatMsgs');
    if (!chatHistory.length) { el.innerHTML = `<div class="chat-empty">Ask me about any stock or market question.<br>I’ll ground my answer in live prices where I can.</div>`; return; }
    el.innerHTML = chatHistory.map(m => `<div class="bubble ${m.role === 'user' ? 'user' : 'ai'}${m.thinking ? ' thinking' : ''}">${esc(m.content)}</div>`).join('');
    el.scrollTop = el.scrollHeight;
  }
  function chatContext() {
    const d = lastData; if (!d) return '';
    const r = d.rating || {}, t = d.tech || {};
    return `The user is currently viewing ${d.symbol} at ${(+d.latest).toFixed(2)} ${d.currency} (${d.changePct.toFixed(2)}% today). MarketLens AI score ${r.score}/100 = "${r.label}", confidence ${r.confidence}%, risk ${r.risk}. RSI ${t.rsi14}, trend ${t.trend ? t.trend.strength + '/100 ' + t.trend.direction : 'n/a'}.`;
  }
  async function sendChat() {
    const text = $('chatInput').value.trim();
    if (!text) return;
    $('chatInput').value = '';
    chatHistory.push({ role: 'user', content: text });
    const pending = { role: 'assistant', content: 'Thinking…', thinking: true };
    chatHistory.push(pending);
    renderChatSuggest(); renderChat();
    $('chatSend').disabled = true;
    try {
      const payload = { messages: chatHistory.filter(m => !m.thinking).map(m => ({ role: m.role, content: m.content })), context: chatContext() };
      const j = await (await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
      pending.content = j.reply || 'No response.'; pending.thinking = false;
    } catch (e) { pending.content = 'Sorry — something went wrong. Please try again.'; pending.thinking = false; }
    finally { $('chatSend').disabled = false; renderChat(); }
  }
  $('chatForm').addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });

  // ---- Compare ----
  let compareSymbols = ['NVDA', 'AMD'];
  const CMP_ROWS = ['Market cap', 'Revenue (TTM)', 'P/E', 'PEG', 'Net margin', 'Gross margin', 'ROE', 'Debt / Equity', 'Dividend yield', 'Beta'];
  function renderCompareChips() {
    $('compareChips').innerHTML = compareSymbols.map(s => `<span class="wl-chip" data-s="${esc(s)}">${esc(s)}<span class="x" data-x="${esc(s)}">×</span></span>`).join('');
    $('compareChips').querySelectorAll('.wl-chip .x').forEach(x => x.addEventListener('click', () => {
      compareSymbols = compareSymbols.filter(s => s !== x.dataset.x);
      renderCompareChips(); loadCompare();
    }));
  }
  $('compareForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const s = $('compareInput').value.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
    $('compareInput').value = '';
    if (s && !compareSymbols.includes(s) && compareSymbols.length < 4) { compareSymbols.push(s); renderCompareChips(); loadCompare(); }
  });
  function ctRow(label, cells, isHtml) {
    return `<tr><td class="ct-label">${esc(label)}</td>` + cells.map(c => `<td>${isHtml ? c : esc(c)}</td>`).join('') + '</tr>';
  }
  async function loadCompare() {
    if (compareSymbols.length < 2) { $('compareResult').innerHTML = `<p class="compare-note">Add at least two tickers to compare.</p>`; return; }
    $('compareResult').innerHTML = `<p class="compare-note">Loading…</p>`;
    let data;
    try { data = await (await fetch('/api/compare?symbols=' + encodeURIComponent(compareSymbols.join(',')))).json(); } catch { $('compareResult').innerHTML = `<p class="compare-note">Couldn’t load comparison.</p>`; return; }
    const rows = (data.compare || []).filter(r => !r.error);
    if (rows.length < 2) { $('compareResult').innerHTML = `<p class="compare-note">Couldn’t load enough data — check the tickers.</p>`; return; }
    let html = `<div class="compare-scroll"><table class="compare-table"><thead><tr><th></th>` +
      rows.map(r => `<th data-s="${esc(r.symbol)}">${esc(r.symbol)}<span class="ct-name">${esc(r.name || '')}</span></th>`).join('') + `</tr></thead><tbody>`;
    html += ctRow('Price', rows.map(r => '$' + (+r.price).toFixed(2)));
    html += ctRow('Change', rows.map(r => `<span class="${r.changePct >= 0 ? 'up' : 'down'}">${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(2)}%</span>`), true);
    html += ctRow('AI Score', rows.map(r => `<span class="ct-score">${r.rating.score}/100</span>`), true);
    html += ctRow('Recommendation', rows.map(r => `<span class="ct-rec ${r.rating.tone}">${esc(r.rating.label)}</span>`), true);
    html += ctRow('Risk', rows.map(r => esc(r.rating.risk || '—')));
    if (data.hasFundamentals) CMP_ROWS.forEach(label => html += ctRow(label, rows.map(r => r.metrics ? (r.metrics[label] || '—') : '—')));
    html += `</tbody></table></div>`;
    if (!data.hasFundamentals) html += `<p class="compare-note">Add FMP_API_KEY for fundamental rows (P/E, margins, ROE…).</p>`;
    $('compareResult').innerHTML = html;
    $('compareResult').querySelectorAll('thead th[data-s]').forEach(th => th.addEventListener('click', () => goAnalyze(th.dataset.s)));
  }

  // ---- Screener ----
  function fmtCap(n) { n = +n; if (!n) return '—'; return n >= 1e12 ? '$' + (n / 1e12).toFixed(1) + 'T' : n >= 1e9 ? '$' + (n / 1e9).toFixed(1) + 'B' : '$' + (n / 1e6).toFixed(0) + 'M'; }
  function screenCard(x) {
    const meta = [x.sector, fmtCap(x.marketCap)].filter(Boolean).join(' · ') + (x.dividend ? ' · div $' + (+x.dividend).toFixed(2) : '');
    return `<div class="quote-card" data-s="${esc(x.symbol)}"><div class="quote-sym">${esc(x.symbol)}</div><div class="quote-name">${esc(x.name || '')}</div><div class="quote-price">$${(+x.price).toFixed(2)}</div><div class="quote-chg" style="color:var(--muted);font-weight:500">${esc(meta)}</div></div>`;
  }
  async function loadScreen() {
    $('screenResult').innerHTML = `<p class="compare-note">Screening…</p>`;
    const p = new URLSearchParams();
    if ($('scSector').value) p.set('sector', $('scSector').value);
    if ($('scCap').value) p.set('cap', $('scCap').value);
    if ($('scPriceMin').value) p.set('priceMin', $('scPriceMin').value);
    if ($('scPriceMax').value) p.set('priceMax', $('scPriceMax').value);
    if ($('scDivMin').value) p.set('divMin', $('scDivMin').value);
    let d;
    try { d = await (await fetch('/api/screen?' + p.toString())).json(); } catch { $('screenResult').innerHTML = `<p class="compare-note">Couldn’t run the screen.</p>`; return; }
    if (!d.available) { $('screenResult').innerHTML = `<p class="compare-note">${esc(d.message || 'Screener unavailable.')}</p>`; return; }
    if (!d.results.length) { $('screenResult').innerHTML = `<p class="compare-note">No matches — try loosening the filters.</p>`; return; }
    $('screenResult').innerHTML = `<div class="mkt-h">${d.results.length} matches</div><div class="quote-grid">` + d.results.map(screenCard).join('') + `</div>`;
    $('screenResult').querySelectorAll('.quote-card').forEach(c => c.addEventListener('click', () => goAnalyze(c.dataset.s)));
  }
  $('screenForm').addEventListener('submit', (e) => { e.preventDefault(); loadScreen(); });

  // ---- Price alerts ----
  function updateAlertBadge(n) { const b = $('alertBadge'); if (n > 0) { b.textContent = n; b.classList.remove('hidden'); } else b.classList.add('hidden'); }
  async function loadAlerts() {
    if (!currentUser) { $('alertList').innerHTML = `<div class="view-empty">Sign in to create price alerts that watch your stocks for you.<br><button class="btn btn-primary" id="alSignin">Sign in</button></div>`; $('alSignin').addEventListener('click', () => openAuth('login')); return; }
    $('alertList').innerHTML = `<p class="compare-note">Loading…</p>`;
    let d; try { d = await (await fetch('/api/alerts')).json(); } catch { $('alertList').innerHTML = `<p class="compare-note">Couldn’t load alerts.</p>`; return; }
    const alerts = d.alerts || [];
    updateAlertBadge(alerts.filter(a => a.triggered).length);
    if (!alerts.length) { $('alertList').innerHTML = `<div class="view-empty">No alerts yet. Add one above — e.g. <b>AAPL rises above 250</b>.</div>`; return; }
    $('alertList').innerHTML = alerts.map(a => {
      const hit = !!a.triggered;
      return `<div class="alert-item ${hit ? 'triggered' : ''}"><span class="alert-sym" data-s="${esc(a.symbol)}">${esc(a.symbol)}</span><span class="alert-cond">${a.direction === 'above' ? 'rises above' : 'falls below'} <b>$${(+a.target).toFixed(2)}</b></span><span class="alert-now">${a.price != null ? 'now $' + (+a.price).toFixed(2) : ''}</span><span class="spacer"></span><span class="alert-status ${hit ? 'hit' : 'active'}">${hit ? '✓ Triggered' : 'Active'}</span><button class="alert-del" data-id="${esc(a.id)}" title="Delete">×</button></div>`;
    }).join('');
    $('alertList').querySelectorAll('.alert-sym').forEach(s => s.addEventListener('click', () => goAnalyze(s.dataset.s)));
    $('alertList').querySelectorAll('.alert-del').forEach(b => b.addEventListener('click', async () => { await fetch('/api/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'remove', id: b.dataset.id }) }); loadAlerts(); }));
  }
  $('alertForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUser) return openAuth('login');
    const symbol = $('alSymbol').value.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, ''), direction = $('alDir').value, target = +$('alTarget').value;
    if (!symbol || !(target > 0)) return;
    await fetch('/api/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, direction, target }) });
    $('alSymbol').value = ''; $('alTarget').value = '';
    loadAlerts();
  });

  // ---- Learn center ----
  const LESSONS = window.LESSONS || [];
  function renderLearnGrid() {
    $('learnHost').innerHTML = `<div class="learn-grid">` + LESSONS.map(l =>
      `<div class="learn-card" data-id="${l.id}"><div class="learn-icon">${l.icon}</div><div class="learn-title">${esc(l.title)}</div><div class="learn-meta">${esc(l.level)} · ${l.minutes} min · ${l.quiz.length} Q</div><p class="learn-desc">${esc(l.intro)}</p></div>`).join('') + `</div>`;
    $('learnHost').querySelectorAll('.learn-card').forEach(c => c.addEventListener('click', () => openLesson(c.dataset.id)));
  }
  function openLesson(id) {
    const l = LESSONS.find(x => x.id === id); if (!l) return renderLearnGrid();
    window.scrollTo(0, 0);
    let html = `<div class="learn-detail"><button type="button" class="link-btn learn-back" id="learnBack">← All lessons</button>`;
    html += `<h2 class="learn-h">${l.icon} ${esc(l.title)}</h2><div class="learn-meta">${esc(l.level)} · ${l.minutes} min read</div>`;
    html += l.sections.map(s => `<div class="learn-section"><h3>${esc(s.h)}</h3><p>${esc(s.p)}</p></div>`).join('');
    html += `<div class="card quiz" id="quiz"></div>`;
    html += `<button type="button" class="btn btn-ai learn-ask" id="learnAsk">✨ Ask the AI Analyst about this</button></div>`;
    $('learnHost').innerHTML = html;
    $('learnBack').addEventListener('click', renderLearnGrid);
    $('learnAsk').addEventListener('click', () => { showView('chat'); $('chatInput').value = `Explain "${l.title}" simply, with an example.`; sendChat(); });
    renderQuiz(l);
  }
  function renderQuiz(l) {
    const host = $('quiz');
    const score = { right: 0, done: 0 };
    host.innerHTML = `<div class="quiz-h">📝 Quick quiz</div>` + l.quiz.map((q, qi) =>
      `<div class="quiz-q" data-qi="${qi}"><div class="quiz-question">${qi + 1}. ${esc(q.q)}</div><div class="quiz-opts">${q.options.map((o, oi) => `<button type="button" class="quiz-opt" data-qi="${qi}" data-oi="${oi}">${esc(o)}</button>`).join('')}</div><div class="quiz-why hidden" data-why="${qi}"></div></div>`).join('') + `<div class="quiz-score hidden" id="quizScore"></div>`;
    host.querySelectorAll('.quiz-opt').forEach(btn => btn.addEventListener('click', () => {
      const qi = +btn.dataset.qi, oi = +btn.dataset.oi, q = l.quiz[qi];
      const qEl = host.querySelector(`.quiz-q[data-qi="${qi}"]`);
      if (qEl.classList.contains('answered')) return;
      qEl.classList.add('answered');
      qEl.querySelectorAll('.quiz-opt').forEach((b, i) => { if (i === q.correct) b.classList.add('correct'); else if (i === oi) b.classList.add('wrong'); b.disabled = true; });
      const why = host.querySelector(`[data-why="${qi}"]`);
      why.textContent = (oi === q.correct ? '✓ Correct. ' : '✗ Not quite. ') + q.why; why.classList.remove('hidden');
      score.done++; if (oi === q.correct) score.right++;
      if (score.done === l.quiz.length) { const s = $('quizScore'); s.textContent = `You scored ${score.right} / ${l.quiz.length}.`; s.classList.remove('hidden'); }
    }));
  }

  // Initial view: deep-link → analyze; otherwise the homepage.
  const deep = new URLSearchParams(location.search).get('symbol');
  if (deep) goAnalyze(deep.toUpperCase()); else showView('home');
})();
