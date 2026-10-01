// Frontend for the stock analyzer. Fetches /api/stock, draws an adjustable
// candlestick chart, then loads the AI summary from /api/analyze.
(function () {
  const $ = (id) => document.getElementById(id);
  const CSS = getComputedStyle(document.documentElement);
  const col = (n) => CSS.getPropertyValue(n).trim();
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // new Date(bad).toISOString() throws a RangeError, which used to take the
  // whole admin dashboard down over a single malformed timestamp.
  function ymd(v) { const d = new Date(v); return Number.isNaN(d.getTime()) ? '\u2014' : d.toISOString().slice(0, 10); }
  function hms(v) { const d = new Date(v); return Number.isNaN(d.getTime()) ? '\u2014' : d.toISOString().slice(11, 19); }

  // How much of the indicator panel points the same way, as a percentage.
  // There are only five groups, so this lands on multiples of 20 — that is the
  // real resolution of the measure, and rounding it to a percent does not add
  // precision that isn't there.
  function agreePct(agreeing, groupCount) {
    if (agreeing == null || !groupCount) return null;
    return Math.round((agreeing / groupCount) * 100);
  }

  // ---- Analytics consent ----
  // Google Analytics is loaded here rather than injected into the document, so
  // that nothing is requested from Google and no cookie is set until the
  // visitor accepts. Declining is remembered and never asked again.
  const CONSENT_KEY = 'chartgauge_consent';
  const readConsent = () => { try { return localStorage.getItem(CONSENT_KEY); } catch (e) { return null; } };
  const writeConsent = (v) => { try { localStorage.setItem(CONSENT_KEY, v); } catch (e) {} };

  let analyticsLoaded = false;
  function loadAnalytics() {
    if (analyticsLoaded) return;
    const meta = document.querySelector('meta[name="ga-id"]');
    const id = meta && meta.content;
    if (!id) return;
    analyticsLoaded = true;
    const tag = document.createElement('script');
    tag.async = true;
    tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
    document.head.appendChild(tag);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', id);
  }

  // Fire-and-forget event. Silently does nothing when analytics never loaded —
  // which is the case for anyone who declined the consent banner, and is the
  // point: no event should ever be the reason a click fails.
  function track(name, params) {
    try { if (typeof window.gtag === 'function') window.gtag('event', name, params || {}); }
    catch (e) { /* analytics must never break the app */ }
  }

  function initConsent() {
    const bar = $('consent');
    if (!bar) return;
    const choice = readConsent();
    if (choice === 'granted') { loadAnalytics(); return; }
    if (choice === 'denied') return;
    bar.classList.remove('hidden');
    const decide = (v) => { writeConsent(v); bar.classList.add('hidden'); if (v === 'granted') loadAnalytics(); };
    $('consentYes').addEventListener('click', () => decide('granted'));
    $('consentNo').addEventListener('click', () => decide('denied'));
  }
  initConsent();

  // First-visit gate. The overlay is opaque, but covering the chart is not the
  // same as withholding it: before this, a deep link like /stock/AAPL fetched
  // and drew the whole chart underneath, so anything that removed the overlay —
  // a stylesheet that failed to load, an element deleted in devtools — revealed
  // a working chart nobody had agreed to. Nothing is fetched or drawn now until
  // the box is ticked.
  // Pages with no market data on them stay readable without an account: the
  // policy pages, which must be reachable to be agreed to, and the lessons,
  // which are the site's search-visible writing and would otherwise meet
  // arrivals from Google with a sign-in wall.
  const ON_OPEN_PAGE = /^\/(terms|privacy|refunds|contact|learn|accuracy)(\/|$)/.test(location.pathname);
  // Versioned, so a future change to the terms can ask again. The old key still
  // counts: the substance of what it accepted has not changed.
  const AGREE_KEY = 'chartgauge_agreed_v1';
  const LEGACY_AGREE_KEY = 'marketlens_agreed';
  function hasAgreed() {
    try { return !!(localStorage.getItem(AGREE_KEY) || localStorage.getItem(LEGACY_AGREE_KEY)); }
    catch (e) { return false; }   // storage blocked → treat as not agreed
  }
  function setAgreed() { try { localStorage.setItem(AGREE_KEY, '1'); } catch (e) {} }

  // Hidden immediately only on the legal pages. Everywhere else it waits for
  // checkAuth to say whether there is a session, so the chart is never briefly
  // reachable on the strength of a localStorage flag alone.
  if (ON_OPEN_PAGE) document.getElementById('gate').classList.add('hidden');
  function hideGate() { const g = document.getElementById('gate'); if (g) g.classList.add('hidden'); }
  function showGate() { const g = document.getElementById('gate'); if (g) g.classList.remove('hidden'); }

  // A symbol asked for before agreeing, loaded once the gate is cleared.
  let pendingSymbol = null;

  // Gating run() stopped the candlestick chart, but every other market-data
  // loader still ran behind the overlay — the home snapshot pulled live index
  // quotes, the watchlist pulled prices — so the numbers were on the page
  // before anyone agreed to anything. Rather than guard fourteen call sites
  // and hope the fifteenth remembers, this shadows fetch for the whole module:
  // no market data is requested until the terms are accepted.
  //
  // Auth and billing stay open. The gate's own sign-in needs auth, checkAuth
  // runs on every page, and the legal pages deliberately bypass the gate.
  const PRE_AGREEMENT_OK = /^\/api\/(auth|billing)\b/;
  const rawFetch = window.fetch.bind(window);
  const fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.startsWith('/api/') && !PRE_AGREEMENT_OK.test(url) && !(hasAgreed() && isSignedIn())) {
      showGate();
      // Tagged, so a caller can tell "the gate stopped this" from a real
      // failure. Checking the signed-in state inside the caller's catch does
      // not work: auth can land between the rejection and the catch running,
      // and the check then reads the new state and reports a failure that has
      // already retried successfully.
      const gateErr = new Error('Sign in and accept the terms before loading market data.');
      gateErr.gated = true;
      return Promise.reject(gateErr);
    }
    return rawFetch(input, init);
  };
  // Mirrors the server, which is the authority: both must hold to load data.
  function isSignedIn() { return !!currentUser; }

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
    if (r.insufficient) return `Only ${r.groupCount} of ${r.groupsPossible} indicator groups have enough history here, so no score is shown.`;
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

  // The measured base rate, stated next to the score it is judging. If the
  // setup did not beat simply being invested, that is the interesting fact and
  // it gets said first.
  function renderEdge(e, rt) {
    const el = $('edgeLine');
    if (!el) return;
    if (!e) { el.textContent = 'Not enough history on this symbol to check whether this setup has meant anything before.'; return; }
    const diff = e.winRate - e.baseWinRate;
    const verdict = diff > 3
      ? `<b>beat</b> simply being invested by ${diff.toFixed(1)} points`
      : diff < -3
        ? `<span class="none">did worse than</span> simply being invested, by ${Math.abs(diff).toFixed(1)} points`
        : `<span class="none">made no difference</span> versus simply being invested`;
    el.innerHTML = `<a class="edge-more" href="/accuracy">What is this?</a>`
      + `Measured on this symbol's own history: at scores near <b>${rt.score}</b>, it was higher `
      + `${e.horizon} bars later <b>${e.winRate}%</b> of the time across <b>${e.n}</b> past occurrences. `
      + `On any bar it was higher <b>${e.baseWinRate}%</b> of the time — so this setup ${verdict}.`;
  }

  function renderLevels(d) {
    const L = d && d.levels;
    if (!L) { $('levelsCard').classList.add('hidden'); return; }
    const ccy = d.currency || '';
    const f = (v) => (+v).toFixed(2);
    const dirWord = L.direction === 'short' ? 'short' : 'long';
    $('levelsSub').textContent = `${dirWord} from ${f(L.entry)} ${ccy} · stop placed by ${L.method === 'structure' ? 'recent swing level' : 'ATR'}`;

    const cell = (name, val, cls, note) =>
      `<div class="lv"><div class="lv-top"><span class="lv-name">${esc(name)}</span><span class="lv-val ${cls || ''}">${esc(val)}</span></div>${note ? `<div class="lv-note">${esc(note)}</div>` : ''}</div>`;

    const rows = [
      cell('Entry (last)', f(L.entry), '', `ATR ${f(L.atr)} — the average daily range this is sized from`),
      cell('Stop loss', f(L.stop), 'stop',
        `${f(L.stopPct)}% away · risk ${f(L.riskPerShare)} ${ccy} per share · ` +
        (L.method === 'structure'
          ? `just beyond the 60-bar ${dirWord === 'long' ? 'low' : 'high'} (ATR method would say ${f(L.stopAtr)})`
          : `${L.atrMult}x ATR (swing level at ${f(L.stopStructure)} was too far to use)`)),
    ];
    for (const t of targetsFor(L)) {
      rows.push(cell(`Take profit ${t.r}R`, f(t.price), 'target', `${f(t.pct)}% away · ${t.r}x the risk taken`));
    }
    rows.push(L.structureTarget
      ? cell('Swing level ahead', f(L.structureTarget.price), 'target',
          `${f(L.structureTarget.pct)}% away · ${f(L.structureTarget.r)}R — the 60-bar ${dirWord === 'long' ? 'high' : 'low'}, where price has turned before`)
      : cell('Swing level ahead', 'none', '',
          `Price is already outside its 60-bar range, so there is no prior level ahead of it to aim at`));

    // Locked levels stay visible and say why, rather than silently vanishing.
    const cap = maxTp();
    const shown = Math.min(tpCount, cap);
    const tpBtns = [1, 2, 3, 4, 5].map(n => {
      const locked = n > cap;
      return `<button type="button" class="tp-btn${n === shown ? ' active' : ''}${locked ? ' locked' : ''}" data-tp="${n}"`
        + `${locked ? ' title="More take-profit levels are part of Pro"' : ''}>${n}</button>`;
    }).join('');
    $('levelsBody').innerHTML =
      `<div class="tp-row"><span class="tp-label">Take-profit levels</span><div class="tp-group">${tpBtns}</div></div>` +
      `<div class="levels-grid">${rows.join('')}</div>`;
    $('levelsBody').querySelectorAll('.tp-btn').forEach(b => b.addEventListener('click', () => {
      const n = parseInt(b.dataset.tp, 10);
      if (n > maxTp()) { showView('pricing'); return; }
      tpCount = n;
      try { localStorage.setItem(TP_KEY, String(tpCount)); } catch (e) {}
      renderLevels(d); drawChart();
    }));
    $('levelsCard').classList.remove('hidden');
  }

  const EXAMPLES = ['AAPL', 'TSLA', 'MSFT', 'NVDA', 'AMZN', 'GOOGL'];
  $('examples').innerHTML = EXAMPLES.map(s => `<button class="chip" data-s="${s}">${s}</button>`).join('');
  $('examples').querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => { $('symbol').value = b.dataset.s; run(b.dataset.s); }));

  // ---- Ticker autocomplete ----
  // Twelve Data quotes crypto as a pair. Listed here so the picker surfaces
  // them the same way it does equities.
  const CRYPTO = [
    ['BTC/USD', 'Bitcoin'], ['ETH/USD', 'Ethereum'], ['SOL/USD', 'Solana'], ['XRP/USD', 'XRP'],
    ['ADA/USD', 'Cardano'], ['DOGE/USD', 'Dogecoin'], ['AVAX/USD', 'Avalanche'], ['LINK/USD', 'Chainlink'],
    ['DOT/USD', 'Polkadot'], ['MATIC/USD', 'Polygon'], ['LTC/USD', 'Litecoin'], ['BCH/USD', 'Bitcoin Cash'],
    ['UNI/USD', 'Uniswap'], ['ATOM/USD', 'Cosmos'], ['ETC/USD', 'Ethereum Classic'], ['XLM/USD', 'Stellar'],
  ];

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
  // One matcher for both pickers, so the hero search and the practice ticket
  // can never offer different things for the same letters.
  //
  // The name is matched on WORD STARTS, not anywhere inside it. Matching
  // anywhere made "ea" return UnitedHealth, Lam Research and Gilead, and "on"
  // return Amazon, Johnson, Exxon and Chevron — which reads as the picker
  // showing random stocks. camelCase counts as a word boundary, so UnitedHealth
  // is United + Health and "health" still finds it.
  function nameWords(n) {
    return n.split(/[^A-Za-z0-9]+/)
      .flatMap(w => w.split(/(?=[A-Z])/))
      .filter(Boolean)
      .map(w => w.toUpperCase());
  }
  function matchTickers(qRaw, limit) {
    const q = (qRaw || '').trim().toUpperCase();
    if (!q) return [];
    const starts = [], byName = [];
    for (const t of TICKERS.concat(CRYPTO)) {
      // "BTC" should find BTC/USD, so match the base of a pair as well.
      if (t[0].startsWith(q) || t[0].split('/')[0] === q) starts.push(t);
      else if (nameWords(t[1]).some(w => w.startsWith(q))) byName.push(t);
    }
    return starts.concat(byName).slice(0, limit || 8);
  }

  const suggestBox = $('suggest');
  let sugItems = [], sugIdx = -1;

  function renderSuggest(qRaw) {
    sugItems = matchTickers(qRaw, 8);
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
  // Each strategy opens on the candle size it is actually about: day trading on
  // 5-minute candles, long-term on daily ones. Switching strategy moves the
  // candle size with it, since a 50/200-day trend read off 5-minute candles is
  // not the thing the tab is offering.
  const STRATEGY_INTERVAL = { daytrade: '5min', longterm: '1day' };
  const INTRADAY = new Set(['1min', '5min', '15min', '30min', '1h', '4h']);
  let strategy = 'daytrade';
  let direction = 'long';
  let interval = STRATEGY_INTERVAL[strategy];   // candle size (1min … 1month)
  let rangeDays = 126;      // active range button, in trading days (0 = All)
  let view = null;          // {start, end} indices into prices for zoom/pan
  const DEFAULT_CANDLES = 90; // zoomed-in default when the interval changes
  // Intraday opens zoomed to a readable number of candles; a 126-day range of
  // 5-minute bars would otherwise arrive as a wall of them.
  let viewCandles = INTRADAY.has(interval) ? DEFAULT_CANDLES : null;
  let chartType = 'candle'; // 'candle' | 'line'
  // Overlay visibility. The chart opens on price alone: the moving averages
  // and the projection are readings laid over it, and someone learning to
  // read a chart should see the bars before anything is drawn on them.
  const show = { fast: false, slow: false, proj: false, levels: false, volume: false };

  // Display mode. Simple keeps the chart and the exit levels and hides the rest;
  // it changes what is rendered, never what is computed.
  // ---- Display preferences ----
  // Replaces the old Simple/Advanced pair. Two presets could never match what
  // any particular reader wanted; these are the same switches, individually.
  const PREFS_KEY = 'chartgauge_prefs';
  const PREF_DEFS = [
    { k: 'baserate',     on: true,  sel: '.edge-line',      name: 'Measured base rate',
      desc: 'What actually happened, historically, at scores like today’s on this symbol.' },
    { k: 'score',        on: true,  sel: '.ai-score-card',  name: 'Indicator score',
      desc: 'The 0–100 composite and its bullish / bearish reading.' },
    { k: 'reason',       on: true,  sel: '.reason',         name: 'One-line summary',
      desc: 'The sentence under the price that sums up the read.' },
    { k: 'levels',       on: true,  sel: '#levelsCard',     name: 'Stop loss and take profit',
      desc: 'Exit levels derived from ATR and recent swing highs and lows.' },
    { k: 'tiles',        on: true,  sel: '.tiles',          name: 'Key figures',
      desc: 'The row of headline numbers above the indicator grid.' },
    { k: 'tech',         on: true,  sel: '#techCard',       name: 'Technical readings',
      desc: 'All thirteen indicators in a grid, each in plain English.' },
    { k: 'projection',   on: true,  sel: '#bandsCard',      name: 'Price projection',
      desc: 'The forecast cone. It is a volatility band, not a prediction.' },
    { k: 'thesis',       on: true,  sel: '#thesisCard',     name: 'Bull and bear case',
      desc: 'The strongest points either way, drawn from the indicators.' },
    { k: 'fundamentals', on: true,  sel: '#fundCard',       name: 'Fundamentals',
      desc: 'Revenue, margins, valuation ratios and company profile.' },
    { k: 'news',         on: true,  sel: '#newsCard',       name: 'News',
      desc: 'Recent headlines for the symbol.' },
    { k: 'summary',      on: true,  sel: '.ai-card:not(.upload-card)', name: 'Written summary',
      desc: 'The paragraph describing what the indicators say.' },
    { k: 'upload',       on: true,  sel: '.upload-card',    name: 'Read a chart screenshot',
      desc: 'Upload a chart image and have it read.' },
    { k: 'overlays',     on: true,  sel: '#overlays',       name: 'Chart layer buttons',
      desc: 'The Candles / SMA / Projection toggles above the chart.' },
    { k: 'ranges',       on: true,  sel: '.tf-group',       name: 'Candle size and history',
      desc: 'The interval and history buttons under the chart.' },
  ];
  let prefs = {};
  PREF_DEFS.forEach(d => { prefs[d.k] = d.on; });
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    PREF_DEFS.forEach(d => { if (typeof saved[d.k] === 'boolean') prefs[d.k] = saved[d.k]; });
  } catch (e) {}
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} };

  function applyPrefs() {
    PREF_DEFS.forEach(d => {
      document.querySelectorAll(d.sel).forEach(el => el.classList.toggle('pref-off', !prefs[d.k]));
    });
    // With the whole right-hand column off, the grid should not leave a gap
    // where it used to be.
    const sideOff = !prefs.summary && !prefs.upload;
    document.body.classList.toggle('no-sidebar', sideOff);
    const side = document.querySelector('.sidebar');
    if (side) side.classList.toggle('pref-off', sideOff);
  }

  function renderSettings(hostId) {
    const host = $(hostId || 'settingsHost');
    if (!host) return;
    host.innerHTML = PREF_DEFS.map(d =>
      `<label class="set-row"><span class="set-text"><span class="set-name">${esc(d.name)}</span>`
      + `<span class="set-desc">${esc(d.desc)}</span></span>`
      + `<input type="checkbox" class="set-box" data-k="${d.k}"${prefs[d.k] ? ' checked' : ''} />`
      + `<span class="set-switch" aria-hidden="true"></span></label>`).join('');
    host.querySelectorAll('.set-box').forEach(b => b.addEventListener('change', () => {
      prefs[b.dataset.k] = b.checked;
      savePrefs(); applyPrefs();
      // The same switches exist in two places; keep the other one honest.
      syncSettingBoxes();
    }));
  }
  // Reflects the current prefs into every rendered switch without re-rendering,
  // so toggling in the drawer does not rebuild the settings page under you.
  function syncSettingBoxes() {
    document.querySelectorAll('.set-box').forEach(b => {
      if (typeof prefs[b.dataset.k] === 'boolean') b.checked = prefs[b.dataset.k];
    });
  }

  function setAllPrefs(on) {
    PREF_DEFS.forEach(d => { prefs[d.k] = on; });
    savePrefs(); applyPrefs(); syncSettingBoxes();
  }
  function resetPrefs() {
    PREF_DEFS.forEach(d => { prefs[d.k] = d.on; });
    savePrefs(); applyPrefs(); syncSettingBoxes();
  }

  // Axis gutters, TradingView-style: price scale down the right edge, time
  // scale along the bottom. Dragging either one rescales that axis.
  let AXIS_W = 58;            // price gutter, re-measured per draw
  const AXIS_H = 26;
  // Decimals that suit the magnitude: 2dp is noise on BTC and far too few on
  // a sub-cent coin.
  const pxFmt = (v) => {
    const a = Math.abs(v);
    return a >= 1000 ? v.toFixed(0) : a >= 1 ? v.toFixed(2) : a >= 0.01 ? v.toFixed(4) : v.toFixed(6);
  };
  // The price axis auto-fits the visible bars until you scale or drag it
  // vertically; from then on it holds an explicit window, like TradingView,
  // until a double-click hands it back to auto-fit.
  let yManual = null;       // {lo, hi} in price units, or null for auto-fit
  let lastY = null;         // last drawn {lo, hi, plotH, top} so drags can do maths

  // Watchlist rows live up here because the renderer below reads them to draw
  // the entry/stop/target lines. They were declared further down, guarded with
  // `typeof wlRow === 'function'`, which is not the guard it looks like: a
  // const in its temporal dead zone throws on typeof rather than reporting
  // undefined, so the guard would have raised the very error it was avoiding.
  // Up here because the renderer draws the open position on the chart.
  let paperState = null;
  let watchRows = [];            // [{symbol, created, entry, stop, target}]
  let wlSym = null, wlQuote = null;
  const wlRow = (sym) => watchRows.find(r => r.symbol === sym) || null;
  // Filled by the renderer each frame: where the watchlist levels landed,
  // so a pointer can be matched to one.
  let wlLevelBands = [];
  let hover = null;         // {x, y} in CSS px for the crosshair, or null
  let liveBar = null;       // index of the bar currently being formed by ticks

  // How many take-profit levels to show. Each is a multiple of the risk the
  // stop implies, so they are derived here rather than refetched — changing
  // the count is instant.
  const TP_KEY = 'chartgauge_tp_count';
  let tpCount = 3;
  try { const n = parseInt(localStorage.getItem(TP_KEY), 10); if (n >= 1 && n <= 6) tpCount = n; } catch (e) {}
  // Filled from /api/auth/me. Until it arrives, assume the free ceiling so the
  // interface never briefly offers something it will then take away.
  let limits = { pro: false, takeProfits: 1, aiPerDay: 3, aiUsed: 0, watchMax: 10, alertMax: 3 };
  let launch = { free: false, until: null };
  // Formatted in UTC from the last free day, so the date shown is the date
  // promised rather than shifting a day backwards in western timezones.
  const launchDate = () => launch.lastFree
    ? new Date(launch.lastFree).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    : '';
  const maxTp = () => (limits.pro ? 5 : Math.max(1, limits.takeProfits || 1));
  // A 402 from the server means the feature is Pro-only. One shape for the
  // message everywhere, with a link that actually goes to the Plans page.
  const isProGate = (j) => j && j.error === 'pro_required';
  const proGateHtml = (j) => `<p class="pro-gate">${esc(j.message || 'This is part of Pro.')}`
    + ` <button type="button" class="link-btn" data-goto-pricing>See plans</button></p>`;
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-goto-pricing]');
    if (b) { e.preventDefault(); showView('pricing'); }
  });
  function targetsFor(L) {
    if (!L || !(L.riskPerShare > 0)) return [];
    const long = L.direction !== 'short';
    return Array.from({ length: Math.min(tpCount, maxTp()) }, (_, i) => {
      const r = i + 1;
      const price = long ? L.entry + r * L.riskPerShare : L.entry - r * L.riskPerShare;
      return { r, price, pct: Math.abs(price - L.entry) / L.entry * 100 };
    });
  }

  // Candle colours are user-adjustable per element (body / border / wick) and
  // persist locally. Unset entries fall back to the theme's up/down colours.
  const CANDLE_KEY = 'chartgauge_candle_colors';
  let candleOverrides = null;
  try { candleOverrides = JSON.parse(localStorage.getItem(CANDLE_KEY) || 'null'); } catch (e) {}
  function defaultCandleColors() {
    const g = col('--good'), b = col('--bad');
    return { upBody: g, upBorder: g, upWick: g, downBody: b, downBorder: b, downWick: b };
  }
  const candleColors = () => Object.assign(defaultCandleColors(), candleOverrides || {});

  // Approx bars per trading day per interval, so a range like "6M" spans ~6
  // months of history regardless of the candle size.
  const BARS_PER_DAY = { '1min': 390, '5min': 78, '15min': 26, '30min': 13, '1h': 7, '4h': 2, '1day': 1, '1week': 0.2, '1month': 1 / 21 };
  // How long one bar covers, so a live tick can tell "still this candle" from
  // "a new candle has started".
  const INTERVAL_MS = { '1min': 60e3, '5min': 300e3, '15min': 900e3, '30min': 1800e3, '1h': 3600e3, '4h': 144e5, '1day': 864e5, '1week': 6048e5, '1month': 26298e5 };
  // API dates are "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS"; parse as local time so
  // bucket maths lines up with the series already on screen.
  function barTime(dateStr) {
    const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
    if (!m) return NaN;
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime();
  }
  const fmtBarDate = (ms, iv) => {
    const d = new Date(ms), p2 = (n) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    return (INTERVAL_MS[iv] || 864e5) < 864e5 ? `${day} ${p2(d.getHours())}:${p2(d.getMinutes())}:00` : day;
  };

  // Strategy tabs (Day trading / Long-term). Long-term is long-only, so the
  // Long/Short toggle only shows for day trading.
  $('strat').querySelectorAll('.strat-btn').forEach(b => b.addEventListener('click', () => {
    $('strat').querySelectorAll('.strat-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    strategy = b.dataset.mode;
    const iv = STRATEGY_INTERVAL[strategy];
    if (iv && iv !== interval) {
      interval = iv;
      viewCandles = INTRADAY.has(interval) ? DEFAULT_CANDLES : null;
      syncIntervalButtons();
      $('range').querySelectorAll('.range-btn').forEach(x => x.classList.remove('active'));
    }
    if (lastData) run(lastData.symbol);
  }));
  // The markup ships one interval marked active; this is what keeps that
  // marker true after the state changes it.
  function syncIntervalButtons() {
    $('interval').querySelectorAll('.range-btn').forEach(x =>
      x.classList.toggle('active', x.dataset.iv === interval));
  }
  syncIntervalButtons();
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
    if (!k) return;                   // the Colors pill opens a panel instead
    if (k === 'type') {
      chartType = chartType === 'candle' ? 'line' : 'candle';
      $('ovType').textContent = chartType === 'candle' ? 'Candles' : 'Line';
    } else {
      show[k] = !show[k];
      b.classList.toggle('active', show[k]);
    }
    drawChart();
  }));

  // Candle colour controls (body / border / wick, per direction)
  const cpInputs = () => $('colorPanel').querySelectorAll('input[data-c]');
  function syncColorInputs() {
    const c = candleColors();
    cpInputs().forEach(i => { if (/^#[0-9a-f]{6}$/i.test(c[i.dataset.c] || '')) i.value = c[i.dataset.c]; });
  }
  $('ovColors').addEventListener('click', () => {
    const open = $('colorPanel').classList.toggle('hidden') === false;
    $('ovColors').classList.toggle('active', open);
    if (open) syncColorInputs();
  });
  cpInputs().forEach(i => i.addEventListener('input', () => {
    candleOverrides = Object.assign(candleColors(), { [i.dataset.c]: i.value });
    try { localStorage.setItem(CANDLE_KEY, JSON.stringify(candleOverrides)); } catch (e) {}
    if (chartType !== 'candle') { chartType = 'candle'; $('ovType').textContent = 'Candles'; }
    drawChart();
  }));
  $('cpReset').addEventListener('click', () => {
    candleOverrides = null;
    try { localStorage.removeItem(CANDLE_KEY); } catch (e) {}
    syncColorInputs(); drawChart();
  });

  // ---- Slide-out menu ----
  // Thirteen destinations plus fourteen display switches is too much to sit
  // across the top, so everything that changes what you see lives behind one
  // control. The top strip stays on wide screens, where there is room for it.
  const drawer = $('drawer'), scrim = $('drawerScrim');
  let drawerOpen = false, lastFocus = null;

  // The destinations, with a line each saying what they are for. This is now
  // the only navigation, so a label alone is not enough — someone opening
  // "Movers" or "Accuracy" for the first time should not have to guess.
  const DESTINATIONS = [
    { v: 'home', c: '#4c9eff',      t: 'Home',      d: 'Look up any ticker, and see where the major indices sit today.' },
    { v: 'analyze', c: '#5ac8fa',   t: 'Analyze',   d: 'The full read on one symbol: candlestick chart, thirteen indicators, exit levels and the measured base rate.' },
    { v: 'compare', c: '#a78bfa',   t: 'Compare',   d: 'Put two or more companies side by side on valuation, margins, growth and debt.' },
    { v: 'screener', c: '#2dd4bf',  t: 'Screener',  d: 'Filter a curated list of stocks by sector, market capitalization and price.' },
    { v: 'markets', c: '#f0b429',   t: 'Markets',   d: 'Live quotes for the major US indices and the most active stocks.' },
    { v: 'movers', c: '#ff8a3d',    t: 'Movers',    d: 'What is actually moving right now, ranked by how unusual the volume and the day\u2019s range are.' },
    { v: 'accuracy', c: '#3ddc84',  t: 'Accuracy',  d: 'The measured record of how this site\u2019s own readings have performed, published whether or not it flatters them.' },
    { v: 'watchlist', c: '#ffcf5c', t: 'Watchlist', d: 'The tickers you follow, with live prices and one-click analysis.' },
    { v: 'alerts', c: '#ff5f56',    t: 'Alerts',    d: 'Set a target above or below the current price and get flagged when a stock crosses it.', badge: 'alertBadge' },
    { v: 'practice', c: '#c084fc',  t: 'Practice',  d: 'A practice account with pretend money, so you can rehearse position sizing against your own risk limits. Nothing here touches a broker.' },
    { v: 'learn', c: '#38bdf8',     t: 'Learn',     d: 'Nineteen plain-English lessons with quizzes, split by whether they apply to day trading or long-term investing.' },
    { v: 'pricing', c: '#e0a33e',   t: 'Billing',   d: 'What a free account includes, what Pro adds, and what each billing period works out to per month.' },
    { v: 'settings', c: '#8a94a3',  t: 'Settings',  d: 'Turn any part of the analysis on or off \u2014 the score, the indicators, the projection, the summary.' },
    { v: 'admin', c: '#6b7484',     t: 'Admin',     d: 'Registered accounts, service status, usage and recent errors.', admin: true },
  ];

  function buildDrawerNav() {
    const host = $('drawerNav');
    if (!host) return;
    const isAdmin = !!(currentUser && currentUser.admin);
    host.innerHTML = '';
    DESTINATIONS.forEach(dst => {
      if (dst.admin && !isAdmin) return;
      const a = document.createElement('a');
      a.className = 'drawer-link' + (dst.v === currentView ? ' active' : '');
      a.dataset.view = dst.v;
      if (dst.c) a.style.setProperty('--dl', dst.c);
      a.innerHTML = `<span class="drawer-link-top"><span class="dl-dot" aria-hidden="true"></span>`
        + `<span class="drawer-link-name">${esc(dst.t)}</span>`
        + (dst.badge ? `<span class="nav-badge hidden" id="${dst.badge}"></span>` : '')
        + `</span><span class="drawer-link-desc">${esc(dst.d)}</span>`;
      a.addEventListener('click', () => { showView(dst.v); closeDrawer(); });
      host.appendChild(a);
    });
    // The badge element is rebuilt with the menu, so restore what it was showing.
    if (typeof lastAlertCount === 'number') updateAlertBadge(lastAlertCount);
  }

  function openDrawer() {
    if (!drawer) return;
    buildDrawerNav();
    lastFocus = document.activeElement;
    drawerOpen = true;
    document.body.classList.add('drawer-open');
    drawer.setAttribute('aria-hidden', 'false');
    scrim.hidden = false;
    $('navToggle').setAttribute('aria-expanded', 'true');
    const first = drawer.querySelector('.drawer-close');
    if (first) first.focus();
  }
  function closeDrawer() {
    if (!drawer) return;
    drawerOpen = false;
    document.body.classList.remove('drawer-open');
    drawer.setAttribute('aria-hidden', 'true');
    scrim.hidden = true;
    $('navToggle').setAttribute('aria-expanded', 'false');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  if ($('navToggle')) $('navToggle').addEventListener('click', () => drawerOpen ? closeDrawer() : openDrawer());
  if ($('drawerClose')) $('drawerClose').addEventListener('click', closeDrawer);
  if (scrim) scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerOpen) closeDrawer(); });

  if ($('setAllOn')) $('setAllOn').addEventListener('click', () => setAllPrefs(true));
  if ($('setAllOff')) $('setAllOff').addEventListener('click', () => setAllPrefs(false));
  if ($('setReset')) $('setReset').addEventListener('click', resetPrefs);
  applyPrefs();

  window.addEventListener('resize', drawChart);

  function sma(a, n) { return a.map((_, i) => i >= n - 1 ? a.slice(i - n + 1, i + 1).reduce((x, y) => x + y, 0) / n : null); }

  function resetView() {
    yManual = null;
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
    // Auto-fit the visible bars unless the user has taken manual control of
    // the price axis by scaling or dragging it.
    let lo = min - pad, hi = max + pad;
    if (yManual && yManual.hi > yManual.lo) { lo = yManual.lo; hi = yManual.hi; }
    const AXF0 = '11.5px ui-sans-serif, system-ui, -apple-system, sans-serif';
    ctx.font = AXF0;
    let widest = Math.max(ctx.measureText(pxFmt(hi)).width, ctx.measureText(pxFmt(lo)).width);
    // The open position's running result sits in this gutter rather than over
    // the candles, so the gutter has to be measured wide enough to take it.
    const posNow = (paperState && paperState.account && lastData)
      ? paperState.account.positions.find(p => p.symbol === lastData.symbol) : null;
    if (posNow) widest = Math.max(widest, ctx.measureText('+$000,000.00').width);
    AXIS_W = Math.round(Math.max(56, Math.min(132, widest + 26)));
    const padL = 8, padR = AXIS_W, padT = 12, padB = AXIS_H;
    // Volume gets its own pane below the price, so turning it on shortens the
    // candles rather than drawing bars across them.
    const volH = show.volume ? Math.max(28, Math.round((h - padT - AXIS_H) * 0.18)) : 0;
    const volGap = show.volume ? 8 : 0;
    const plotW = w - padL - padR, plotH = h - padT - padB - volH - volGap;
    const total = bars.length + fc.length;
    // Breathing room between the newest candle and the price scale. Without
    // it the last bar lands hard against the gutter and the price and P&L
    // tags sit on top of exactly the candles being watched. The scale itself
    // does not move: only the bars are laid out inside the narrower span.
    const RIGHT_GAP = Math.max(16, Math.min(96, plotW * 0.07));
    const barsW = Math.max(1, plotW - RIGHT_GAP);
    const X = (i) => padL + (barsW * i) / (total - 1);
    const Y = (v) => padT + plotH * (1 - (v - lo) / (hi - lo));
    const axX = padL + plotW, axY = padT + plotH;
    // The time axis belongs under everything, not under the price plot:
    // with a volume pane between them, axY is the top of the volume.
    const timeY = axY + volH + volGap;
    lastY = { lo, hi, plotH, top: padT };

    const AXF = '11px ui-sans-serif, system-ui, -apple-system, sans-serif';
    const NUMF = '11.5px ui-sans-serif, system-ui, -apple-system, sans-serif';
    ctx.font = NUMF; ctx.lineWidth = 1;

    // A rounded tag on an axis, which is how prices and times read on a modern
    // chart — far quieter than text floating over the plot.
    const roundRect = (x, y, rw, rh, r) => {
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, rw, rh, r); return; }
      ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + rw, y, x + rw, y + rh, r);
      ctx.arcTo(x + rw, y + rh, x, y + rh, r); ctx.arcTo(x, y + rh, x, y, r); ctx.arcTo(x, y, x + rw, y, r); ctx.closePath();
    };
    const axisTagY = [];   // centres of tags already placed in the price gutter
    const priceTag = (text, y, bg, fg) => {
      ctx.font = NUMF;
      const tw = Math.min(ctx.measureText(text).width, AXIS_W - 14);
      const bw = tw + 11, bh = 16, bx = axX + 4, by = Math.max(padT, Math.min(axY - bh, y - bh / 2));
      ctx.fillStyle = bg; roundRect(bx, by, bw, bh, 4); ctx.fill();
      ctx.fillStyle = fg; ctx.fillText(text, bx + 5.5, by + 11.5);
      axisTagY.push(by + bh / 2);
      return by;
    };

    // Horizontal grid only, and faint: vertical rules made it read as paper.
    // The numbers are drawn last, once tags have claimed their positions.
    const gridLabels = [];
    ctx.strokeStyle = col('--border');
    for (let g = 0; g <= 4; g++) {
      const val = lo + (hi - lo) * g / 4, y = Y(val);
      ctx.globalAlpha = .55;
      ctx.beginPath(); ctx.moveTo(padL, Math.round(y) + .5); ctx.lineTo(axX, Math.round(y) + .5); ctx.stroke();
      ctx.globalAlpha = 1;
      gridLabels.push({ text: pxFmt(val), y });
    }

    // Dates sit in the gutter with no tick marks.
    const ticks = Math.max(2, Math.min(6, Math.floor(barsW / 130)));
    ctx.font = AXF; ctx.fillStyle = col('--muted');
    for (let t = 0; t < ticks; t++) {
      const j = Math.round((bars.length - 1) * t / (ticks - 1));
      const lbl = bars[j].date, lw = ctx.measureText(lbl).width;
      ctx.fillText(lbl, Math.max(padL, Math.min(axX - lw, X(j) - lw / 2)), timeY + 18);
    }
    function line(arr, offset, color, dashed) {
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dashed ? [5, 4] : []);
      let started = false;
      arr.forEach((v, i) => { if (v == null) return; const x = X(i + offset), y = Y(v); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); });
      ctx.stroke(); ctx.setLineDash([]);
    }

    if (chartType === 'candle') {
      const cw = Math.max(1, (barsW / total) * 0.68);
      const cc = candleColors();
      if (show.volume && volH > 0) {
        // Scaled to the largest bar in view, so the shape of activity reads the
        // same whether the window is a week or five years.
        const vTop = padT + plotH + volGap, vBase = vTop + volH;
        let maxV = 0;
        bars.forEach(p => { const v = Number(p.volume) || 0; if (v > maxV) maxV = v; });
        if (maxV > 0) {
          ctx.save();
          bars.forEach((p, j) => {
            const v = Number(p.volume) || 0;
            if (!v) return;
            const rise = p.close >= p.open;
            const bh = Math.max(1, (v / maxV) * (volH - 2));
            ctx.globalAlpha = 0.42;
            ctx.fillStyle = rise ? cc.upBody : cc.downBody;
            ctx.fillRect(X(j) - cw / 2, vBase - bh, Math.max(1, cw), bh);
          });
          ctx.restore();
          ctx.strokeStyle = col('--border'); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(padL, Math.round(vBase) + .5);
          ctx.lineTo(padL + plotW, Math.round(vBase) + .5); ctx.stroke();
          ctx.fillStyle = col('--muted');
          ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
          ctx.textAlign = 'left'; ctx.textBaseline = 'top';
          ctx.fillText('Volume', padL + 3, vTop + 2);
        }
      }
      bars.forEach((p, j) => {
        const x = X(j), up = p.close >= p.open;
        ctx.lineWidth = Math.min(2, Math.max(1, cw * 0.16));
        ctx.strokeStyle = up ? cc.upWick : cc.downWick;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, Y(p.high)); ctx.lineTo(Math.round(x) + .5, Y(p.low)); ctx.stroke();
        const yO = Y(p.open), yC = Y(p.close);
        const top = Math.min(yO, yC), hgt = Math.max(1.5, Math.abs(yC - yO));
        ctx.fillStyle = up ? cc.upBody : cc.downBody;
        ctx.fillRect(x - cw / 2, top, cw, hgt);
        if (cw >= 5 && hgt >= 4) {
          ctx.strokeStyle = up ? cc.upBorder : cc.downBorder; ctx.lineWidth = 1;
          ctx.strokeRect(Math.round(x - cw / 2) + .5, Math.round(top) + .5, Math.round(cw) - 1, Math.round(hgt) - 1);
        }
        if (liveBar != null && start + j === liveBar && cw >= 3) {
          ctx.strokeStyle = col('--accent'); ctx.lineWidth = 1;
          ctx.strokeRect(Math.round(x - cw / 2) - 1.5, Math.round(top) - 1.5, Math.round(cw) + 3, Math.round(hgt) + 3);
        }
      });
    } else {
      // Area fill under the line, fading out — the single biggest visual
      // difference between a plotted line and a chart people expect today.
      const cl = bars.map(p => p.close);
      const grad = ctx.createLinearGradient(0, padT, 0, axY);
      grad.addColorStop(0, 'rgba(76,158,255,.26)');
      grad.addColorStop(1, 'rgba(76,158,255,0)');
      ctx.beginPath();
      cl.forEach((v, i) => { const x = X(i), y = Y(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.lineTo(X(cl.length - 1), axY); ctx.lineTo(X(0), axY); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
      line(cl, 0, col('--accent'));
    }

    // Stop / target lines, drawn across the plot with a label in the gutter.
    if (show.slow) line(visSlow, 0, col('--sma50'));
    if (show.fast) line(visFast, 0, col('--sma20'));
    if (fc.length) line([bars[bars.length - 1].close].concat(fc), bars.length - 1, col('--forecast'), true);

    if (show.levels && d.levels) {
      const L = d.levels;
      const usedY = [];
      const mark = (price, color, label, dashed) => {
        if (!Number.isFinite(price) || price < lo || price > hi) return;
        const y = Y(price);
        ctx.save();
        ctx.strokeStyle = color; ctx.globalAlpha = .75; ctx.lineWidth = 1;
        ctx.setLineDash(dashed ? [5, 5] : []);
        ctx.beginPath(); ctx.moveTo(padL, Math.round(y) + .5); ctx.lineTo(axX, Math.round(y) + .5); ctx.stroke();
        ctx.restore();
        // Tag sits on the axis; nudge it clear of tags already placed.
        let ty = y;
        for (let g = 0; g < 14 && usedY.some(u => Math.abs(u - ty) < 17); g++) ty -= 17;
        if (ty < padT + 8) return;
        usedY.push(ty);
        priceTag(label, ty, color, '#0b0e12');
      };
      mark(L.stop, col('--bad'), pxFmt(L.stop), false);
      targetsFor(L).forEach(t => mark(t.price, col('--good'), pxFmt(t.price), true));
      if (L.structureTarget) mark(L.structureTarget.price, col('--sma20'), pxFmt(L.structureTarget.price), true);
    }

    // The latest price in the data, not the last one that happens to be in
    // view. `bars` is the visible slice, so reading its final close made the
    // marker -- and the position's result below -- change every time the
    // chart was dragged sideways, as though panning back through history
    // moved the market.
    const lastClose = prices[len - 1].close;
    if (lastClose >= lo && lastClose <= hi) {
      const ly = Y(lastClose);
      ctx.save();
      ctx.strokeStyle = col('--muted'); ctx.globalAlpha = .5; ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(padL, Math.round(ly) + .5); ctx.lineTo(axX, Math.round(ly) + .5); ctx.stroke();
      ctx.restore();
    }

    // Crosshair + OHLC readout for the bar under the cursor.
    // The levels the user set on this symbol from the watchlist. Drawn on
    // whichever view the panel is mounted in, and draggable by the handle on
    // the right. wlLevelBands is read by the pointer handlers.
    wlLevelBands = [];
    const wlR = lastData ? wlRow(lastData.symbol) : null;
    if (wlR) {
      [['entry', wlR.entry, col('--muted'), 'entry'],
       ['stop', wlR.stop, col('--bad'), 'stop'],
       ['target', wlR.target, col('--good'), 'target']].forEach(([key, v, c, label]) => {
        if (!Number.isFinite(v) || v < lo || v > hi) return;
        const y = Y(v);
        ctx.save();
        ctx.setLineDash([6, 4]); ctx.strokeStyle = c; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(padL, Math.round(y) + .5); ctx.lineTo(axX, Math.round(y) + .5); ctx.stroke();
        ctx.restore();
        ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
        const t = label + ' ' + v.toFixed(2);
        const tw = ctx.measureText(t).width;
        ctx.fillStyle = c; ctx.globalAlpha = .16;
        roundRect(padL + 4, y - 8, tw + 10, 16, 4); ctx.fill();
        ctx.globalAlpha = 1; ctx.fillStyle = c;
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(t, padL + 9, y);
        // a grab handle on the price gutter
        ctx.fillStyle = c; ctx.globalAlpha = .9;
        roundRect(axX + 2, y - 6, 10, 12, 3); ctx.fill();
        ctx.globalAlpha = 1;
        wlLevelBands.push({ key, y, price: v });
      });
    }

    // The open practice position, drawn the way a broker draws it: a line at
    // what you paid, and what it is worth right now against that line.
    const pos = (paperState && paperState.account && lastData)
      ? paperState.account.positions.find(p => p.symbol === lastData.symbol) : null;
    if (pos && Number.isFinite(pos.avgPrice) && pos.avgPrice >= lo && pos.avgPrice <= hi) {
      const short = pos.qty < 0;
      // Priced at the market, which panning does not move.
      const mark = Number.isFinite(lastClose) ? lastClose : pos.mark;
      const live = Number.isFinite(mark)
        ? (short ? (pos.avgPrice - mark) : (mark - pos.avgPrice)) * Math.abs(pos.qty)
        : pos.pnl;
      const good = live >= 0;
      const y = Y(pos.avgPrice);
      // Thin, dashed and faint. A solid rule at full strength cut the candles
      // in half and the price action could not be read through it.
      ctx.save();
      ctx.strokeStyle = col('--accent'); ctx.globalAlpha = .55;
      ctx.lineWidth = 1; ctx.setLineDash([4, 5]);
      ctx.beginPath(); ctx.moveTo(padL, Math.round(y) + .5); ctx.lineTo(axX, Math.round(y) + .5); ctx.stroke();
      ctx.restore();
      // The side and size sit above the line in plain text, with no filled
      // box behind them, so they label the line instead of hiding a candle.
      ctx.font = '600 ' + NUMF;
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = col('--accent'); ctx.globalAlpha = .9;
      ctx.fillText((short ? 'SHORT ' : 'LONG ') + Math.abs(pos.qty) + ' @ ' + pxFmt(pos.avgPrice),
                   padL + 3, y - 5);
      ctx.globalAlpha = 1;
      // The running result goes in the price gutter, where the other tags
      // live, rather than over the newest candles.
      const money = (good ? '+' : '\u2212') + '$' + Math.abs(live)
        .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      priceTag(money, y, good ? col('--good') : col('--bad'), '#0b0e12');
    }

    if (hover && hover.x > padL && hover.x < axX && hover.y > padT && hover.y < axY) {
      const j = Math.max(0, Math.min(bars.length - 1, Math.round((hover.x - padL) / barsW * (total - 1))));
      const b = bars[j], hx = X(j);
      ctx.save();
      ctx.strokeStyle = col('--border-strong'); ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(hx) + .5, padT); ctx.lineTo(Math.round(hx) + .5, axY); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(padL, Math.round(hover.y) + .5); ctx.lineTo(axX, Math.round(hover.y) + .5); ctx.stroke();
      ctx.restore();
      const atCursor = lo + (1 - (hover.y - padT) / plotH) * (hi - lo);
      priceTag(pxFmt(atCursor), hover.y, col('--border-strong'), col('--text'));
      // date tag on the time axis
      ctx.font = AXF;
      const dl = b.date, dw = ctx.measureText(dl).width + 12;
      const dx = Math.max(padL, Math.min(axX - dw, hx - dw / 2));
      ctx.fillStyle = col('--border-strong'); roundRect(dx, timeY + 5, dw, 17, 4); ctx.fill();
      ctx.fillStyle = col('--text'); ctx.fillText(dl, dx + 6, timeY + 17);
      // floating OHLC panel
      const up = b.close >= b.open;
      const rows = [['O', b.open], ['H', b.high], ['L', b.low], ['C', b.close]];
      ctx.font = NUMF;
      ctx.font = NUMF;
      const widestVal = Math.max(...rows.map(r => ctx.measureText(pxFmt(+r[1])).width));
      const bw = Math.max(112, Math.round(widestVal + 46)), bh = 26 + rows.length * 15;
      const bx = hx < padL + plotW / 2 ? Math.min(axX - bw - 8, hx + 14) : Math.max(padL + 8, hx - bw - 14);
      const by = padT + 8;
      ctx.globalAlpha = .96; ctx.fillStyle = col('--card-hi'); roundRect(bx, by, bw, bh, 8); ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = col('--muted'); ctx.font = AXF; ctx.fillText(b.date, bx + 10, by + 15);
      ctx.font = NUMF;
      rows.forEach((r, i) => {
        const ry = by + 32 + i * 15;
        ctx.fillStyle = col('--muted'); ctx.fillText(r[0], bx + 10, ry);
        const t = pxFmt(+r[1]);
        ctx.fillStyle = i === 3 ? (up ? col('--good') : col('--bad')) : col('--text');
        ctx.fillText(t, bx + bw - 10 - ctx.measureText(t).width, ry);
      });
    }

    // Axis numbers last, and only where no tag has taken the space — a pill
    // half-covering a number was the messiest thing on the old axis.
    ctx.font = NUMF; ctx.fillStyle = col('--muted');
    gridLabels.forEach(g => {
      if (axisTagY.some(t => Math.abs(t - g.y) < 11)) return;
      ctx.fillText(g.text, axX + 9, g.y + 4);
    });
  }

  // ---- Interactive zoom / pan ----
  // Three zones, as in TradingView: the plot pans, the right gutter scales
  // price, the bottom gutter scales time.
  (function setupChartInteraction() {
    const canvas = $('chart');
    const PAD_L = 8;
    const zoneOf = (e) => {
      const r = canvas.getBoundingClientRect();
      if (e.clientX - r.left >= r.width - AXIS_W) return 'price';
      if (e.clientY - r.top >= r.height - AXIS_H) return 'time';
      return 'plot';
    };
    const plotWidth = (r) => {
      const inner = Math.max(1, r.width - AXIS_W - PAD_L);
      return Math.max(1, inner - Math.max(16, Math.min(96, inner * 0.07)));
    };
    // Leaving auto-fit: seed the manual window from whatever is on screen now,
    // so the first pixel of a drag doesn't make the chart jump.
    const ensureManual = () => {
      if (!yManual && lastY) yManual = { lo: lastY.lo, hi: lastY.hi };
      return !!yManual;
    };
    // Shared with the touch handlers below so both input paths behave alike.
    const panBy = (dxPx, dyPx, r) => {
      const len = lastData.prices.length, span = view.end - view.start;
      view = clampView(view.start - (dxPx / plotWidth(r)) * span, view.end - (dxPx / plotWidth(r)) * span, len);
      if (dyPx && lastY && lastY.plotH > 0 && ensureManual()) {
        const shift = dyPx * (yManual.hi - yManual.lo) / lastY.plotH;
        yManual = { lo: yManual.lo + shift, hi: yManual.hi + shift };
      }
    };
    const scaleTime = (factor, pinEnd) => {
      const len = lastData.prices.length;
      const newSpan = Math.max(10, Math.min(len, (view.end - view.start) * factor));
      view = pinEnd ? clampView(view.end - newSpan, view.end, len)
                    : clampView(view.start, view.start + newSpan, len);
    };
    const scaleY = (factor) => {
      if (!ensureManual()) return;
      const mid = (yManual.lo + yManual.hi) / 2;
      const half = Math.max(1e-6, ((yManual.hi - yManual.lo) / 2) * factor);
      yManual = { lo: mid - half, hi: mid + half };
    };
    const clampView = (start, end, len) => {
      const span = end - start;
      if (start < 0) { start = 0; end = Math.min(len, span); }
      if (end > len) { end = len; start = Math.max(0, len - span); }
      return { start, end };
    };

    // Wheel deltas vary wildly by device (a line-mode mouse reports 3, a
    // trackpad reports hundreds), so normalise to pixels, clamp momentum
    // spikes, and scale exponentially — ~6% per notch instead of the old 15%.
    canvas.addEventListener('wheel', (e) => {
      if (!lastData || !view) return;
      e.preventDefault();
      const raw = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const step = Math.max(-60, Math.min(60, raw));
      if (zoneOf(e) === 'price') { scaleY(Math.pow(1.0009, step)); drawChart(); return; }
      const len = lastData.prices.length, r = canvas.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - r.left - PAD_L) / plotWidth(r)));
      const span = view.end - view.start;
      const newSpan = Math.max(10, Math.min(len, span * Math.pow(1.0006, step)));
      const anchor = view.start + frac * span;
      view = clampView(anchor - frac * newSpan, anchor - frac * newSpan + newSpan, len);
      drawChart();
    }, { passive: false });

    let drag = null;
    // Grabbing a level takes priority over panning: the handles sit in the
    // price gutter, which is also the zoom zone.
    function levelAt(e) {
      if (!wlLevelBands.length) return null;
      const r = canvas.getBoundingClientRect();
      const y = e.clientY - r.top;
      let best = null;
      wlLevelBands.forEach(b => {
        const d = Math.abs(b.y - y);
        if (d <= 7 && (!best || d < best.d)) best = { key: b.key, d };
      });
      return best;
    }
    canvas.addEventListener('mousedown', (e) => {
      if (!lastData || !view) return;
      e.preventDefault();
      const lv = levelAt(e);
      if (lv && lastY) { drag = { level: lv.key }; return; }
      drag = { zone: zoneOf(e), x: e.clientX, y: e.clientY, span: view.end - view.start,
               man: yManual ? { lo: yManual.lo, hi: yManual.hi } : null };
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag || !lastData || !view) return;
      if (drag.level) {
        // Convert the pointer back into a price using the same mapping the
        // renderer used for this frame.
        const r0 = canvas.getBoundingClientRect();
        const y = e.clientY - r0.top;
        const f = (y - lastY.top) / lastY.plotH;
        const price = lastY.hi - f * (lastY.hi - lastY.lo);
        if (Number.isFinite(price) && price > 0) {
          const row = wlRow(lastData.symbol);
          if (row) {
            row[drag.level] = price;
            // The P&L readout belongs to the panel's symbol, not the chart's.
            if (lastData.symbol === wlSym) wlRenderPl();
            drawChart();
          }
        }
        return;
      }
      const len = lastData.prices.length, r = canvas.getBoundingClientRect();
      if (drag.zone === 'price') {                    // drag down = zoom out
        if (!drag.man) { ensureManual(); drag.man = yManual ? { lo: yManual.lo, hi: yManual.hi } : null; }
        if (drag.man) {
          const f = Math.pow(1.005, e.clientY - drag.y);
          const mid = (drag.man.lo + drag.man.hi) / 2;
          const half = Math.max(1e-6, ((drag.man.hi - drag.man.lo) / 2) * f);
          yManual = { lo: mid - half, hi: mid + half };
        }
        drawChart(); return;
      }
      if (drag.zone === 'time') {                     // drag left = more history
        const newSpan = Math.max(10, Math.min(len, drag.span * Math.pow(1.005, drag.x - e.clientX)));
        view = clampView(view.end - newSpan, view.end, len);
        drawChart(); return;
      }
      // Pan both axes; dragging down raises the price window, moving bars down.
      panBy(e.clientX - drag.x, e.clientY - drag.y, r);
      drag.x = e.clientX; drag.y = e.clientY;
      drawChart();
    });
    window.addEventListener('mouseup', () => {
      if (drag && drag.level) {
        const sym = lastData && lastData.symbol;
        const row = wlRow(sym);
        // Round to cents: a dragged level should read like a price.
        if (row && Number.isFinite(row[drag.level])) {
          const v = Math.round(row[drag.level] * 100) / 100;
          row[drag.level] = v;
          // The boxes show the panel's symbol, so only write to them when the
          // line that was dragged is that symbol's.
          if (sym === wlSym) {
            const box = $('wl' + drag.level.charAt(0).toUpperCase() + drag.level.slice(1));
            if (box) box.value = v;
          }
          saveWatchLevels({ [drag.level]: v }, sym);
        }
        drag = null;
        return;
      } drag = null; });
    let raf = 0;
    canvas.addEventListener('mousemove', (e) => {
      const z = zoneOf(e);
      // A level line can be dragged from anywhere along it, which is invisible
      // unless the cursor says so — and without the cue it just reads as the
      // chart refusing to pan.
      if (!drag) canvas.style.cursor = levelAt(e) ? 'grab'
        : z === 'price' ? 'ns-resize' : z === 'time' ? 'ew-resize' : 'crosshair';
      const r = canvas.getBoundingClientRect();
      hover = drag ? null : { x: e.clientX - r.left, y: e.clientY - r.top };
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; drawChart(); });
    });
    canvas.addEventListener('mouseleave', () => { hover = null; drawChart(); });
    canvas.addEventListener('dblclick', (e) => {
      if (zoneOf(e) === 'price') yManual = null; else resetView();   // back to auto-fit
      drawChart();
    });

    // ---- Touch ----
    // One finger pans (or scales, if it starts on a gutter); two fingers pinch
    // — horizontal spread zooms time, vertical spread zooms price, so the same
    // gesture does whichever the user actually meant. Double-tap re-fits.
    const spread = (t) => ({
      x: Math.abs(t[0].clientX - t[1].clientX),
      y: Math.abs(t[0].clientY - t[1].clientY),
    });
    let touch = null, lastTap = 0;
    canvas.addEventListener('touchstart', (e) => {
      if (!lastData || !view) return;
      if (e.touches.length === 1) {
        const t = e.touches[0], now = Date.now();
        if (now - lastTap < 300) {                       // double-tap
          if (zoneOf(t) === 'price') yManual = null; else resetView();
          drawChart(); lastTap = 0; touch = null; e.preventDefault(); return;
        }
        lastTap = now;
        touch = { mode: 'one', zone: zoneOf(t), x: t.clientX, y: t.clientY,
                  span: view.end - view.start, man: yManual ? { lo: yManual.lo, hi: yManual.hi } : null };
      } else if (e.touches.length === 2) {
        touch = { mode: 'pinch', s0: spread(e.touches) };
        lastTap = 0;
      }
      e.preventDefault();
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      if (!touch || !lastData || !view) return;
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      if (touch.mode === 'pinch' && e.touches.length === 2) {
        const s = spread(e.touches);
        if (touch.s0.x > 12 && s.x > 12) scaleTime(touch.s0.x / s.x, false);
        if (touch.s0.y > 12 && s.y > 12) scaleY(touch.s0.y / s.y);
        touch.s0 = s;
        drawChart(); return;
      }
      if (touch.mode !== 'one' || !e.touches.length) return;
      const t = e.touches[0];
      if (touch.zone === 'price') {
        if (!touch.man) { ensureManual(); touch.man = yManual ? { lo: yManual.lo, hi: yManual.hi } : null; }
        if (touch.man) {
          const f = Math.pow(1.005, t.clientY - touch.y);
          const mid = (touch.man.lo + touch.man.hi) / 2;
          const half = Math.max(1e-6, ((touch.man.hi - touch.man.lo) / 2) * f);
          yManual = { lo: mid - half, hi: mid + half };
        }
      } else if (touch.zone === 'time') {
        const len = lastData.prices.length;
        const newSpan = Math.max(10, Math.min(len, touch.span * Math.pow(1.005, touch.x - t.clientX)));
        view = clampView(view.end - newSpan, view.end, len);
      } else {
        panBy(t.clientX - touch.x, t.clientY - touch.y, r);
        touch.x = t.clientX; touch.y = t.clientY;
      }
      drawChart();
    }, { passive: false });

    const endTouch = () => { touch = null; };
    canvas.addEventListener('touchend', endTouch);
    canvas.addEventListener('touchcancel', endTouch);
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
      // Third-party URLs: esc() can't stop a javascript: scheme, so allow only http(s)
      const safeNews = (d.news || []).filter(n => /^https?:\/\//i.test(String(n.url || '')));
      if (safeNews.length) {
        $('newsList').innerHTML = safeNews.map(n => `<a class="news-item" href="${esc(n.url)}" target="_blank" rel="noopener noreferrer"><div class="news-title">${esc(n.title)}</div><div class="news-meta">${esc(n.site || '')}${n.date ? ' · ' + esc(String(n.date).slice(0, 10)) : ''}</div></a>`).join('');
        $('newsCard').classList.remove('hidden');
      }
    } catch (e) { /* leave hidden on error */ }
  }

  // Live updating: poll the latest quote every 20s and update the last candle + header.
  let liveTimer = null;
  // 8s: fast enough that the forming candle visibly moves, slow enough to stay
  // inside the upstream rate limit once the server-side quote cache absorbs
  // repeats. A new ticker resets the forming-bar marker.
  // Three seconds, matching how long the server holds a single symbol's
  // quote. Asking faster than that only re-reads the same number.
  function startLive() {
    ensureStream();
    if (!liveTimer) liveTimer = setInterval(liveTick, 3000);
  }
  // The chart panel is one element that moves between analyze, practice and
  // the watchlist, so the forming candle should keep forming in all three
  // rather than only on the page it started on.
  const chartOnScreen = () => {
    const panel = $('chartPanel');
    if (!panel) return false;
    const host = panel.closest('.view');
    return !!host && !host.classList.contains('hidden');
  };
  // One price in, the forming candle updated. Shared by the three-second
  // poll and the live trade stream so a tick does the same thing whichever
  // way it arrived.
  function applyTick(price) {
    if (!lastData) return false;
    const prices = lastData.prices; if (!prices.length) return false;
    const last = prices[prices.length - 1];
    // A tick more than 25% from the last close is mismatched data, not a move.
    if (!Number.isFinite(price) || price <= 0) return false;
    if (last.close > 0 && Math.abs(price - last.close) / last.close > 0.25) return false;

    // If the clock has moved past the end of the last bar, the tick opens a new
    // one rather than stretching the old one forever.
    const step = INTERVAL_MS[interval] || 864e5;
    const lastT = barTime(last.date);
    const rolled = Number.isFinite(lastT) && Date.now() >= lastT + step;
    if (rolled) {
      const startedAt = lastT + Math.floor((Date.now() - lastT) / step) * step;
      const atEnd = view && view.end >= prices.length;          // following the right edge?
      prices.push({ date: fmtBarDate(startedAt, interval), open: last.close,
                    high: Math.max(last.close, price), low: Math.min(last.close, price),
                    close: price, volume: 0 });
      if (atEnd) { view = { start: view.start + 1, end: prices.length }; }
      liveBar = prices.length - 1;
    } else {
      last.close = price;
      if (price > last.high) last.high = price;
      if (price < last.low) last.low = price;
      if (liveBar == null) liveBar = prices.length - 1;
    }
    lastData.latest = price;
    $('price').textContent = price.toFixed(2) + ' ' + lastData.currency;
    if ($('cLast') && chartSym === lastData.symbol) $('cLast').textContent = pMoney(price);
    if ($('wlLast') && wlSym === lastData.symbol) $('wlLast').textContent = pMoney(price);
    drawChart();
    return true;
  }

  let pollSkips = 0;
  async function liveTick() {
    if (!lastData || document.hidden || !chartOnScreen()) return;
    // Trades are arriving, so the price is already live. Poll once in seven
    // -- about every twenty seconds -- purely to refresh the change figures,
    // which a trade tick cannot supply. Asking every three seconds as well
    // spends the upstream budget twice over for the same number, and when
    // that budget runs out the chart stops loading entirely.
    if (streaming() && (++pollSkips % 7) !== 0) return;
    const sym = lastData.symbol;
    let q; try { q = (await getQuotes([sym]))[0]; } catch { return; }
    if (!q || !lastData || lastData.symbol !== sym) return;
    if (q.source && lastData.source && q.source !== lastData.source) return;   // demo vs live
    if (!applyTick(Number(q.price))) return;
    // The change figures only come from a quote: a trade tick carries a price
    // and nothing to measure it against, so the poll keeps these honest.
    const up = q.changePct >= 0;
    $('chg').textContent = (up ? '▲ ' : '▼ ') + Math.abs(q.change).toFixed(2) + ' (' + q.changePct.toFixed(2) + '%)';
    $('chg').className = 'chg ' + (up ? 'up' : 'down');
  }

  // ---- Live trade stream ----
  // Every trade as it prints, rather than a snapshot every few seconds. The
  // server holds one socket upstream and fans it out over SSE, so the key
  // stays on the server and the browser only listens. If the stream is not
  // available -- no key, an old runtime, a proxy that will not hold the
  // connection -- nothing breaks: the poll underneath carries on.
  let tickStream = null, tickStreamSym = null, lastTickAt = 0;
  // True while trades are actually arriving. The poll exists to carry the
  // change figures and to stand in when there is no stream; while the stream
  // is feeding, polling three times a minute is plenty and the rest of the
  // upstream budget is better spent elsewhere.
  const streaming = () => Date.now() - lastTickAt < 20000;
  function closeStream() {
    if (tickStream) { try { tickStream.close(); } catch (e) {} }
    tickStream = null; tickStreamSym = null; lastTickAt = 0;
  }
  function ensureStream() {
    if (typeof EventSource === 'undefined') return;
    const sym = lastData && lastData.symbol;
    if (!sym || lastData.source === 'demo') { closeStream(); return; }
    if (tickStreamSym === sym && tickStream) return;        // already on it
    closeStream();
    tickStreamSym = sym;
    let es;
    try { es = new EventSource('/api/stream?symbol=' + encodeURIComponent(sym)); }
    catch (e) { tickStreamSym = null; return; }
    tickStream = es;
    es.onmessage = (ev) => {
      if (!lastData || lastData.symbol !== sym) return;
      let t; try { t = JSON.parse(ev.data); } catch (e) { return; }
      if (!t || String(t.symbol).toUpperCase() !== sym) return;
      lastTickAt = Date.now();
      if (document.hidden || !chartOnScreen()) return;      // hold the socket, skip the paint
      applyTick(Number(t.price));
    };
    es.onerror = () => {
      // EventSource reconnects on its own after a dropped connection. Closed
      // means the server refused -- no live feed to give -- so stop asking
      // and leave it to the poll.
      if (es.readyState === EventSource.CLOSED) closeStream();
    };
  }

  // Shown over the chart panel wherever it is mounted, so a failure is
  // legible on the page the reader is actually on.
  function chartFailed(msg) {
    const panel = $('chartPanel');
    if (!panel) return;
    let el = $('chartErr');
    if (!el) {
      el = document.createElement('div');
      el.id = 'chartErr'; el.className = 'chart-err';
      panel.insertBefore(el, panel.firstChild);
    }
    el.textContent = msg || 'Could not load this chart.';
    el.hidden = false;
  }
  function chartOk() { const el = $('chartErr'); if (el) el.hidden = true; }

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

  let runSeq = 0;           // guards against a slow request landing after a newer one
  async function run(symbol) {
    symbol = (symbol || $('symbol').value || '').trim().toUpperCase();
    if (!symbol) return;
    // No account and no agreement, no chart — not even the request for data.
    if (!hasAgreed() || !isSignedIn()) { pendingSymbol = symbol; showGate(); return; }
    $('error').classList.add('hidden');
    $('goBtn').disabled = true; $('goBtn').textContent = 'Loading…';
    const seq = ++runSeq;
    try {
      const r = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&strategy=${encodeURIComponent(strategy)}&direction=${encodeURIComponent(direction)}&interval=${encodeURIComponent(interval)}`);
      const d = await r.json();
      if (seq !== runSeq) return;                    // superseded by a newer ticker
      if (!r.ok) throw new Error(d.error || 'Could not load');
      lastData = d; liveBar = null;
      chartOk();
      // The activation moment: a chart the visitor asked for actually drew.
      // After the ok-check and the sequence guard, so a failed lookup or a
      // superseded request is never counted as one.
      track('analyze', { symbol: d.symbol, strategy, interval });
      // The server just extended the streak; pick the new number up so the
      // badge moves on the visit that earned it, not the next page load.
      refreshStreak();
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
      // Falling back to the older per-strategy score here would print a
      // confident number directly beside "Not enough history".
      $('vMeta').textContent = rt.score != null ? rt.score + '/100'
        : rt.insufficient ? '' : (v.score != null ? 'score ' + v.score : '');
      $('verdict').className = 'verdict ' + (rt.tone || v.tone || 'neutral');
      $('reason').textContent = ratingReason(d);
      const GAUGE_C = 2 * Math.PI * 52;
      $('gaugeArc').style.strokeDasharray = GAUGE_C;
      $('gaugeArc').style.strokeDashoffset = GAUGE_C * (1 - (rt.score || 0) / 100);
      $('gScore').textContent = rt.score != null ? rt.score : '—';
      $('aiRec').textContent = rt.label || '—';
      $('aiRec').className = 'ai-rec ' + (rt.tone || 'neutral');
      const conf = agreePct(rt.agreeing, rt.groupCount);
      $('aiConf').textContent = conf != null ? conf + '%' : (rt.confidence != null ? rt.confidence + '%' : '—');
      renderEdge(d.edge, rt);
      $('aiRisk').textContent = rt.risk || '—';
      $('aiRisk').className = 'risk-' + String(rt.risk || 'neutral').split(' ')[0];
      $('ovFast').textContent = d.maFast ? d.maFast.label : 'SMA 20';
      $('ovSlow').textContent = d.maSlow ? d.maSlow.label : 'SMA 50';
      if (d.risk) { $('risk').textContent = d.risk; $('risk').className = 'risk' + (d.direction === 'short' ? ' danger' : ''); }
      else $('risk').className = 'risk hidden';
      $('note').textContent = d.note || '';
      $('result').classList.remove('hidden');
      try {
        const want = '/stock/' + d.symbol;
        // Only when analyze is the view on screen. The practice page loads
        // symbols through this same function, and rewriting the URL to
        // /stock/XXXX there would send a refresh to the wrong page.
        if (currentView === 'analyze' && location.pathname !== want) {
          history.replaceState({ view: 'analyze' }, '', want);
        }
      } catch (e) {}
      resetView(); drawChart(); tiles(d); renderTech(d.tech); renderBands(d.bands); renderLevels(d);
      setAnalysisPending();
      loadAnalysis(d);
      loadFundamentals(d.symbol);
      startLive();
    } catch (e) {
      if (seq !== runSeq) return;                    // a newer request owns the UI now
      $('error').textContent = e.message; $('error').classList.remove('hidden'); $('result').classList.add('hidden');
      // #error lives inside the analyze view. The chart panel also hangs in
      // practice and the watchlist, and on those a failed load wrote the
      // reason into a hidden element: the chart just went blank and said
      // nothing. Put it where the chart actually is.
      chartFailed(e.message);
    } finally { if (seq === runSeq) { $('goBtn').disabled = false; $('goBtn').textContent = 'Analyze'; } }
  }

  // The summary takes several seconds (indicators, then a Claude call that is
  // waited out in full), so say so rather than showing a bare spinner-word
  // that looks identical to a dead request.
  function setAnalysisPending() {
    $('aiBody').textContent = 'Writing the summary — this usually takes a few seconds.';
    $('aiTag').textContent = '';
    $('bullList').innerHTML = '<li>Working…</li>';
    $('bearList').innerHTML = '<li>Working…</li>';
    $('conclusion').textContent = '';
  }

  // A plain fetch has no deadline, so a stalled request would leave the panel
  // waiting forever with no error and no way back.
  async function fetchTimeout(url, opts, ms) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try { return await fetch(url, Object.assign({}, opts, { signal: ac.signal })); }
    finally { clearTimeout(timer); }
  }

  function analysisFailed(msg, d) {
    $('aiBody').textContent = msg + ' ';
    const retry = document.createElement('button');
    retry.type = 'button'; retry.className = 'link-btn'; retry.textContent = 'Try again';
    retry.addEventListener('click', () => { setAnalysisPending(); loadAnalysis(d); });
    $('aiBody').appendChild(retry);
    $('aiTag').textContent = '';
    $('bullList').innerHTML = ''; $('bearList').innerHTML = ''; $('conclusion').textContent = '';
  }

  const stale = (d) => !lastData || lastData.symbol !== d.symbol;

  const SOURCE_LABEL = {
    ai: 'written by Claude',
    'ai-partial': 'written by Claude — reply was cut short',
    rule: 'rule-based fallback — no model key set',
  };
  function applyReport(j) {
    $('aiBody').textContent = j.summary || 'No analysis available.';
    $('aiTag').textContent = SOURCE_LABEL[j.source] || SOURCE_LABEL.rule;
    $('bullList').innerHTML = (j.bull && j.bull.length ? j.bull : ['—']).map(x => `<li>${esc(x)}</li>`).join('');
    $('bearList').innerHTML = (j.bear && j.bear.length ? j.bear : ['—']).map(x => `<li>${esc(x)}</li>`).join('');
    $('conclusion').textContent = j.conclusion || '';
  }

  // Streams the summary so the panel fills as Claude writes rather than sitting
  // blank for ~8s. Returns false if streaming is unavailable, so the caller can
  // fall back to the buffered endpoint (some proxies will not pass a stream).
  async function streamAnalysis(d) {
    const ac = new AbortController();
    let idle = setTimeout(() => ac.abort(), 45000);
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(), 30000); };
    let started = false, done = null, shown = '';
    try {
      const r = await fetch('/api/analyze-stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d), signal: ac.signal });
      if (!r.ok || !r.body || !r.body.getReader) return false;
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: fin } = await reader.read();
        if (fin) break;
        touch();
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (stale(d)) { ac.abort(); return true; }        // superseded; stop quietly
          if (msg.t === 'd') { started = true; shown += msg.v; $('aiBody').textContent = shown; }
          else if (msg.t === 'done') done = msg;
        }
      }
      if (!done) throw new Error('stream ended early');
      if (!stale(d)) applyReport(done);                     // final parse corrects the stream
      return true;
    } catch (e) {
      if (started || (e && e.name === 'AbortError')) throw e;  // mid-stream: real failure
      return false;                                           // never started: let caller fall back
    } finally { clearTimeout(idle); }
  }

  async function loadAnalysis(d) {
    try {
      if (await streamAnalysis(d)) return;
      const r = await fetchTimeout('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) }, 45000);
      const j = await r.json();
      if (stale(d)) return;                                 // user moved on; don't clobber
      applyReport(j);
    } catch (e) {
      if (stale(d)) return;                                 // stale failure, ignore
      analysisFailed(e && e.name === 'AbortError'
        ? 'The summary took too long to come back (the server may have been asleep).'
        : 'Analysis unavailable.', d);
    }
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
      const r = await fetchTimeout('/api/analyze-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: imgData.base64, mediaType: imgData.mediaType }) }, 60000);
      const j = await r.json();
      if (isProGate(j)) { $('imgResult').innerHTML = proGateHtml(j); $('imgResult').classList.remove('hidden'); return; }
      $('imgResult').textContent = j.summary || j.error || 'No analysis available.';
    } catch (e) {
      $('imgResult').textContent = e && e.name === 'AbortError'
        ? 'Reading the image took too long. Try again, or use a smaller screenshot.'
        : 'Analysis unavailable.';
    }
    finally { $('imgResult').classList.remove('hidden'); $('imgBtn').disabled = false; $('imgBtn').textContent = 'Analyze image'; }
  });

  // ---- Accounts + watchlist ----
  let currentUser = null, currentStreak = null, watchSymbols = [], authMode = 'login', billingOn = false, billingPlans = {};
  // Days of trial this visitor would get on a first subscription; 0 for
  // anyone who has subscribed before, so the page never offers one twice.
  let trialDays = 0;

  // Cheap and quiet: the streak only ever changes once a day, so a failure
  // here just leaves the badge as it was.
  async function refreshStreak() {
    try {
      const j = await (await fetch('/api/auth/me')).json();
      const before = currentStreak && currentStreak.count;
      currentStreak = j.streak || null;
      if ((currentStreak && currentStreak.count) !== before) renderAcct();
    } catch (e) { /* the badge is decoration */ }
  }

  // ---- Practice account ----
  // Pretend money, real prices. The chart is the analyze chart, moved into this
  // view rather than reimplemented, so its layers, colours, intervals and
  // interactions are the same ones.
  let chartSym = null, chartQuote = null;
  let livePoll = null;            // quote poll, only while this view is on screen

  const pMoney = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(Number(n) || 0)
    .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pPct = (n) => (Number(n) || 0).toFixed(1) + '%';
  async function loadPaper() {
    try {
      const j = await (await fetch('/api/paper')).json();
      paperState = j;
      paperMsg('');          // clear anything left over from an earlier attempt
      renderPaper();
      if (j.account) {
        const first = (j.account.positions[0] || {}).symbol || chartSym || 'AAPL';
        // The chart panel is shared, so analyze or the watchlist may have
        // loaded a different symbol into it since this view was last open.
        // Without the second branch the header named one stock while the bars
        // under it belonged to another, and the ticket traded the header's.
        if (!chartSym) selectChart(first);
        else if (!lastData || lastData.symbol !== chartSym) selectChart(chartSym);
        else refreshQuote();
        startPaperLive();
      }
    } catch (e) {
      // Before sign-in the shared fetch wrapper rejects every /api call and
      // shows the gate instead. routeFromPath runs again once auth lands, so
      // this first rejection is the gate working, not a failure — reporting it
      // left "Could not load the practice account" sitting on a page that had
      // in fact loaded fine a moment later.
      if (e && e.gated) return;      // the gate is handling it; a retry follows
      console.error('practice: loadPaper failed', e);
      paperMsg('Could not load the practice account — ' + (e && e.message ? e.message : e), true);
    }
  }

  function paperMsg(text, bad) {
    const el = $('pMsg');
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false; el.textContent = text;
    el.className = 'paper-msg' + (bad ? ' bad' : ' ok');
  }

  // ---- the chart ----
  // The practice view does not draw its own chart. The analyze chart is moved
  // into it, so every layer, colour, interval, range and interaction is the
  // same thing rather than a second implementation that drifts.
  function mountChart(viewName) {
    const panel = $('chartPanel');
    if (!panel) return;
    const slotId = viewName === 'practice' ? 'chartSlotPractice'
      : viewName === 'watchlist' ? 'chartSlotWatchlist' : 'chartSlotAnalyze';
    const slot = $(slotId);
    if (!slot || panel.parentElement === slot) return;
    slot.appendChild(panel);
    // The canvas sizes itself from its parent, which just changed.
    requestAnimationFrame(() => { try { drawChart(); } catch (e) {} });
  }

  async function selectChart(sym) {
    sym = String(sym || '').toUpperCase().trim();
    if (!sym) return;
    chartSym = sym;
    $('cSym').textContent = sym;
    $('cName').textContent = '';
    // Keep the ticket on the symbol the chart is showing. They were separate,
    // so the chart opened on a stock while the ticket sat empty: the cost
    // estimate stayed blank and the 25/50/Max buttons had nothing to size
    // against until you retyped the symbol that was already on screen.
    if ($('pSym') && $('pSym').value.trim().toUpperCase() !== sym) $('pSym').value = sym;
    // run() is the analyze pipeline: it loads the bars, sets lastData and
    // draws. Reusing it means the practice chart is the analyze chart.
    try { await run(sym); } catch (e) {}
    if (lastData && lastData.symbol === sym) {
      $('cName').textContent = (lastData.name && lastData.name !== sym) ? lastData.name : '';
    }
    await refreshQuote();
  }

  async function refreshQuote() {
    if (!chartSym) return;
    try {
      const j = await (await fetch('/api/quotes?symbols=' + encodeURIComponent(chartSym))).json();
      const q = (j.quotes || [])[0];
      if (!q || !Number.isFinite(Number(q.price))) return;
      chartQuote = q;
      setLive('cLast', pMoney(q.price), Number(q.price));
      const up = Number(q.changePct) >= 0;
      $('cChg').textContent = (up ? '+' : '') + Number(q.change || 0).toFixed(2)
        + '  (' + (up ? '+' : '') + Number(q.changePct || 0).toFixed(2) + '%)';
      $('cChg').className = 'chart-chg ' + (up ? 'up' : 'down');
      $('cLive').hidden = false;
    } catch (e) { /* a missed poll is not worth surfacing */ }
  }

  // Only poll while the view is on screen. A timer left running in the
  // background would keep hitting the quotes endpoint for nothing.
  // Figures that move get flashed so a change is noticed rather than found.
  const lastVals = {};
  function setLive(id, text, num) {
    const el = $(id);
    if (!el || el.textContent === text) return;
    const before = lastVals[id];
    el.textContent = text;
    if (Number.isFinite(num) && Number.isFinite(before) && num !== before) {
      el.classList.remove('tick-up', 'tick-down');
      void el.offsetWidth;                    // restart the animation
      el.classList.add(num > before ? 'tick-up' : 'tick-down');
    }
    if (Number.isFinite(num)) lastVals[id] = num;
  }

  let paperTick = 0;
  // Named apart from the analyze chart's startLive. Both were called
  // startLive in the same scope, so this one quietly replaced that one and
  // the forming candle on the analyze page stopped updating entirely.
  function startPaperLive() {
    stopPaperLive();
    // The chart's own poll already keeps the header price current, and the
    // stream keeps it current faster than that. This one only needs to cover
    // the case where neither is running, so it goes every third tick.
    livePoll = setInterval(() => {
      if (currentView !== 'practice' || document.hidden) return;
      if (++paperTick % 3 === 0) { refreshQuote(); loadPaperQuiet(); }
    }, 3000);
    if ($('pLive')) $('pLive').hidden = false;
  }
  function stopPaperLive() {
    if (livePoll) { clearInterval(livePoll); livePoll = null; }
    if ($('pLive')) $('pLive').hidden = true;
  }

  async function loadPaperQuiet() {
    try {
      const j = await (await fetch('/api/paper')).json();
      if (j && j.account) { paperState = j; renderPaper(); }
    } catch (e) {}
  }

  function renderPaper() {
    const has = !!(paperState && paperState.account);
    const setup = $('paperSetup'), book = $('paperBook');
    if (!setup || !book) return;
    setup.classList.toggle('hidden', has);
    book.classList.toggle('hidden', !has);
    if (!has) {
      const d = (paperState && paperState.defaults) || {};
      if (d.startBalance) $('paperStart').value = d.startBalance;
      stopPaperLive();
      return;
    }
    const a = paperState.account, r = a.risk, lim = a.limits || { maxPosition: 20, perTrade: 2 };

    setLive('pEquity', pMoney(a.equity), a.equity);
    setLive('pCash', pMoney(a.cash), a.cash);
    setLive('pInvested', pMoney(a.invested), a.invested);
    $('pCount').textContent = a.positions.length;
    const pn = $('pPnl');
    const dir = a.pnl > 0 ? '▲ ' : a.pnl < 0 ? '▼ ' : '';
    pn.textContent = dir + pMoney(Math.abs(a.pnl))
      + '  (' + (a.pnlPct >= 0 ? '+' : '−') + pPct(Math.abs(a.pnlPct)) + ')';
    pn.className = 'pstat-sub ' + (a.pnl > 0 ? 'up' : a.pnl < 0 ? 'down' : '');

    // Every figure says what it is a share of. A balance on its own tells you
    // nothing about whether the account is overcommitted.
    const start = Number(a.startBalance);
    $('pStartNote').textContent = Number.isFinite(start)
      ? 'Started at ' + pMoney(start) : '';
    const shareOf = (v) => a.equity > 0 ? pPct((v / a.equity) * 100) + ' of the account' : '';
    $('pCashNote').textContent = shareOf(a.cash);
    $('pInvNote').textContent = a.invested > 0 ? shareOf(a.invested) : 'Nothing at risk';
    $('pCountNote').textContent = a.positions.length
      ? 'Largest is ' + pPct(r.largestPct)
      : 'Nothing open';
    $('tkCash').textContent = pMoney(a.cash);

    $('pBand').textContent = r.band;
    $('pBand').className = 'risk-band ' + r.band;
    $('pRiskFill').style.width = Math.max(2, r.score) + '%';
    $('pRiskFill').className = r.band;
    $('pInvPct').textContent = pPct(r.investedPct);
    $('pLargest').textContent = pPct(r.largestPct);
    $('pCashPct').textContent = pPct(r.cashPct);
    $('pFlags').innerHTML = (r.flags || []).map(f =>
      '<div class="risk-flag ' + esc(f.level) + '">' + esc(f.text) + '</div>').join('');

    $('rMaxPos').value = lim.maxPosition;
    $('rPerTrade').value = lim.perTrade;
    $('rMaxPosV').textContent = lim.maxPosition + '%';
    $('rPerTradeV').textContent = lim.perTrade + '%';

    $('pPositions').innerHTML = a.positions.length
      ? '<div class="pos-grid">' + a.positions.map(p =>
          '<div class="pos' + (p.symbol === chartSym ? ' on' : '') + (p.short ? ' short' : '') + '" data-sym="' + esc(p.symbol) + '">'
          + '<div class="pos-top"><b>' + esc(p.symbol) + '</b>'
          + (p.short ? '<span class="pos-side short">SHORT</span>' : '')
          + (p.stale ? '<span class="stale" title="No live quote; held at your entry price">stale</span>' : '')
          + '<span class="pos-pnl ' + (p.pnl > 0 ? 'up' : p.pnl < 0 ? 'down' : '') + '">'
          + (p.pnl >= 0 ? '+' : '−') + pMoney(p.pnl).replace('-', '') + '</span></div>'
          + '<div class="pos-mid">' + Math.abs(p.qty) + ' @ ' + pMoney(p.avgPrice) + '</div>'
          + '<div class="pos-bot"><span>' + pMoney(p.value) + '</span>'
          + '<span class="' + (p.pnlPct > 0 ? 'up' : p.pnlPct < 0 ? 'down' : '') + '">'
          + (p.pnlPct >= 0 ? '+' : '−') + pPct(Math.abs(p.pnlPct)) + '</span></div>'
          + '<button type="button" class="pos-close p-close" data-sym="' + esc(p.symbol) + '" data-qty="' + Math.abs(p.qty) + '" data-side="' + (p.short ? 'buy' : 'sell') + '">Close</button>'
          + '<i class="pos-share" style="width:' + (a.equity > 0 ? Math.max(2, Math.min(100, (Math.abs(p.value) / a.equity) * 100)) : 0) + '%"></i>'
          + '</div>').join('') + '</div>'
      : '<p class="muted empty">Nothing open. Buy something to start.</p>';

    const posN = $('pPosN');
    posN.hidden = !a.positions.length;
    posN.textContent = a.positions.length;

    const fills = paperState.fills || [];
    const fillN = $('pFillN');
    fillN.hidden = !fills.length;
    fillN.textContent = fills.length;
    $('pFills').innerHTML = fills.length
      ? '<div class="scroll-x"><table class="ptable"><thead><tr><th>When</th><th>Symbol</th><th>Side</th>'
        + '<th>Qty</th><th>Price</th><th>Realized</th></tr></thead><tbody>'
        + fills.map(f =>
          '<tr><td class="muted">' + new Date(f.ts).toLocaleString() + '</td><td><b>' + esc(f.symbol) + '</b></td>'
          + '<td class="' + (f.side === 'buy' ? 'up' : 'down') + '">' + esc(f.side) + '</td>'
          + '<td>' + f.qty + '</td><td>' + pMoney(f.price) + '</td>'
          + '<td class="' + (f.realized > 0 ? 'up' : f.realized < 0 ? 'down' : '') + '">'
          + (f.realized == null ? '—' : (f.realized >= 0 ? '+' : '−') + pMoney(f.realized).replace('-', '')) + '</td></tr>'
        ).join('') + '</tbody></table></div>'
      : '<p class="muted empty">No fills yet.</p>';

    document.querySelectorAll('.pos').forEach(el => el.addEventListener('click', (ev) => {
      if (ev.target.closest('.p-close')) return;
      $('pSym').value = el.dataset.sym; selectChart(el.dataset.sym); estimate();
    }));
    document.querySelectorAll('.p-close').forEach(b => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      $('pSym').value = b.dataset.sym; $('pQty').value = b.dataset.qty;
      trade(b.dataset.side || 'sell');            // a short is closed by buying
    }));
  }

  // ---- Symbol picker on the ticket ----
  // Reuses the same TICKERS and CRYPTO lists the main search uses, so the two
  // pickers can never offer different things.
  let tkItems = [], tkIdx = -1;

  function tkSuggest(raw) {
    const box = $('pSuggest'), input = $('pSym');
    if (!box) return;
    tkItems = matchTickers(raw, 7);
    if (!tkItems.length) return tkHide();
    tkIdx = -1;
    box.innerHTML = tkItems.map(([sym, name], i) =>
      '<div class="suggest-item" role="option" aria-selected="false" data-sym="' + esc(sym) + '" data-i="' + i + '">'
      + '<span class="suggest-sym">' + esc(sym) + '</span>'
      + '<span class="suggest-name">' + esc(name) + '</span></div>').join('');
    box.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
    // mousedown, not click: the input's blur would close the list first
    box.querySelectorAll('.suggest-item').forEach(el =>
      el.addEventListener('mousedown', (e) => { e.preventDefault(); tkPick(el.dataset.sym); }));
  }
  function tkHide() {
    const box = $('pSuggest');
    if (!box) return;
    box.classList.add('hidden'); box.innerHTML = '';
    tkItems = []; tkIdx = -1;
    $('pSym').setAttribute('aria-expanded', 'false');
  }
  function tkPick(sym) {
    $('pSym').value = sym;
    tkHide();
    selectChart(sym);
    estimate();
    $('pQty').focus();
  }
  function tkHighlight(i) {
    const box = $('pSuggest');
    box.querySelectorAll('.suggest-item').forEach((el, n) => {
      const on = n === i;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    });
    tkIdx = i;
  }

  function estimate() {
    const el = $('pEst'); if (!el) return;
    const q = Number($('pQty').value);
    const px = chartQuote && Number(chartQuote.price);
    const sym = ($('pSym').value || '').toUpperCase().trim();
    if (!(q > 0) || !Number.isFinite(px) || sym !== chartSym) { el.innerHTML = '&nbsp;'; return; }
    const cash = paperState && paperState.account ? paperState.account.cash : 0;
    const cost = q * px;
    el.innerHTML = 'About <b>' + pMoney(cost) + '</b> at ' + pMoney(px)
      + (cost > cash ? ' <span class="over">— more than your cash</span>' : '');
  }

  // The server checks cash against what it read before fetching a quote, so
  // two trades in flight at once can both pass that check and overdraw the
  // account. One at a time is enough to stop it, and a double-clicked Buy is
  // the only way anyone reached it.
  let tradeBusy = false;
  async function trade(side) {
    if (tradeBusy) return;
    const symbol = ($('pSym').value || '').trim().toUpperCase();
    const qty = Number($('pQty').value);
    if (!symbol) return paperMsg('Enter a symbol.', true);
    if (!(qty > 0)) return paperMsg('Enter a quantity above zero.', true);
    tradeBusy = true;
    if ($('pBuy')) $('pBuy').disabled = true;
    if ($('pSell')) $('pSell').disabled = true;
    paperMsg('Working…');
    try {
      const res = await fetch('/api/paper/trade', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol, side, qty }) });
      const j = await res.json();
      if (!res.ok) return paperMsg(j.message || j.error || 'That did not go through.', true);
      paperState = { account: j.account, fills: j.fills, defaults: paperState && paperState.defaults };
      renderPaper();
      const f = j.filled;
      paperMsg((f.side === 'buy' ? 'Bought ' : 'Sold ') + f.qty + ' ' + f.symbol + ' at ' + pMoney(f.price));
      $('pQty').value = ''; estimate();
      if (f.symbol !== chartSym) selectChart(f.symbol);
    } catch (e) { paperMsg('That did not go through.', true); }
    finally {
      tradeBusy = false;
      if ($('pBuy')) $('pBuy').disabled = false;
      if ($('pSell')) $('pSell').disabled = false;
    }
  }

  function wirePractice() {
    if (!$('paperOpen')) return;
    const markPreset = () => {
      const v = String(Number($('paperStart').value) || '');
      document.querySelectorAll('.paper-preset').forEach(b => b.classList.toggle('on', b.dataset.amt === v));
    };
    document.querySelectorAll('.paper-preset').forEach(b =>
      b.addEventListener('click', () => { $('paperStart').value = b.dataset.amt; markPreset(); }));
    $('paperStart').addEventListener('input', markPreset);
    markPreset();
    $('paperOpen').addEventListener('click', async () => {
      const startBalance = Number($('paperStart').value);
      try {
        const res = await fetch('/api/paper/open', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startBalance }) });
        const j = await res.json();
        // Without this a rejected open just redrew the setup screen, so the
        // button looked like it had done nothing at all.
        if (!res.ok || !j.account) return paperMsg(j.message || j.error || 'Could not start the account.', true);
        paperState = { account: j.account, fills: j.fills || [], defaults: paperState && paperState.defaults };
        renderPaper(); paperMsg('');
        selectChart(chartSym || 'AAPL'); startPaperLive();
      } catch (e) { paperMsg('Could not start the account.', true); }
    });
    // Actually clears the server, which the old one did not.
    // Resetting throws away every position and fill, so it asks first.
    $('paperReset').addEventListener('click', async () => {
      const a = paperState && paperState.account;
      const n = a ? a.positions.length : 0;
      const what = n ? n + (n === 1 ? ' open position' : ' open positions') + ' and every fill' : 'every fill';
      if (!window.confirm('Reset the practice account?\n\nThis clears ' + what
        + ', and lets you pick a new starting balance. It cannot be undone.')) return;
      try {
        const res = await fetch('/api/paper/reset', { method: 'POST' });
        if (!res.ok) return paperMsg('Could not reset the account. Nothing was changed.', true);
      } catch (e) { return paperMsg('Could not reset the account. Nothing was changed.', true); }
      paperState = { account: null, fills: [], defaults: paperState && paperState.defaults };
      stopPaperLive(); renderPaper();
    });
    $('pBuy').addEventListener('click', () => trade('buy'));
    $('pSell').addEventListener('click', () => trade('sell'));
    $('pQty').addEventListener('input', estimate);
    $('pSym').addEventListener('input', () => {
      const el = $('pSym'), at = el.selectionStart;
      el.value = el.value.toUpperCase();
      try { el.setSelectionRange(at, at); } catch (e) {}
      tkSuggest(el.value);
      estimate();
    });
    $('pQty').addEventListener('keydown', (e) => { if (e.key === 'Enter') trade('buy'); });
    $('pSym').addEventListener('change', () => { selectChart($('pSym').value); });
    $('pSym').addEventListener('focus', () => { if ($('pSym').value) tkSuggest($('pSym').value); });
    $('pSym').addEventListener('blur', () => setTimeout(tkHide, 120));
    $('pSym').addEventListener('keydown', (e) => {
      const open = !$('pSuggest').classList.contains('hidden');
      if (open && e.key === 'ArrowDown') { e.preventDefault(); tkHighlight(Math.min(tkIdx + 1, tkItems.length - 1)); return; }
      if (open && e.key === 'ArrowUp') { e.preventDefault(); tkHighlight(Math.max(tkIdx - 1, 0)); return; }
      if (open && e.key === 'Escape') { tkHide(); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (open && tkIdx >= 0) tkPick(tkItems[tkIdx][0]);
        else { tkHide(); selectChart($('pSym').value); }
      }
    });

    // Size by a share of what is actually spendable. When the symbol is one you
    // already hold, Max means the whole position, because at that point the
    // useful question is how much of it to close.
    document.querySelectorAll('#pQuick button').forEach(b => b.addEventListener('click', () => {
      const f = Number(b.dataset.f) || 0;
      const sym = ($('pSym').value || '').toUpperCase().trim();
      const acct = paperState && paperState.account;
      if (!acct) return;
      const held = acct.positions.find(p => p.symbol === sym);
      const px = chartQuote && sym === chartSym ? Number(chartQuote.price) : null;
      let q;
      if (held) {
        q = Math.abs(held.qty) * f;               // a share of what is open
      } else if (Number.isFinite(px) && px > 0) {
        // Nothing open, so size against what the account could carry either
        // way. Buying is limited by cash; selling short is limited by the
        // same two-to-one exposure rule the server applies.
        const room = Math.max(acct.cash, Math.max(0, acct.equity * 2 - (acct.gross || 0)));
        q = Math.floor((room * f) / px * 1e4) / 1e4;
      } else {
        return paperMsg('Pick a symbol first so there is a price to size against.', true);
      }
      q = Math.floor(q * 1e4) / 1e4;
      if (!(q > 0)) return paperMsg('Not enough cash for that share of the account.', true);
      $('pQty').value = q;
      estimate();
    }));

    // The chart's own controls live on the shared panel, so there is nothing
    // extra to wire here, and resize is already handled once for every view.

    const live = (id, label) => {
      const el = $(id);
      el.addEventListener('input', () => { $(label).textContent = el.value + '%'; });
      el.addEventListener('change', saveRiskLimits);
    };
    live('rMaxPos', 'rMaxPosV');
    live('rPerTrade', 'rPerTradeV');
  }

  async function saveRiskLimits() {
    try {
      const res = await fetch('/api/risk', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxPosition: Number($('rMaxPos').value), perTrade: Number($('rPerTrade').value) }) });
      if (res.ok) loadPaperQuiet();
    } catch (e) { /* the slider already shows the intent */ }
  }

  // Drawn rather than an emoji: the emoji renders a different colour and
  // weight on every platform, and this one has to sit inside a small pill
  // and take its colour from the text.
  const FLAME = '<svg class="streak-i" viewBox="0 0 12 14" aria-hidden="true" focusable="false">'
    + '<path d="M6 0c2.3 2.6 1 4 2.3 4.9.6.4 1.1-.3 1.2-1 1.2 1.5 1.6 2.9 1.6 4.2a5.1 5.1 0 0 1-10.2 0c0-2.7 1.7-4.4 2.9-5.8C4.9 1.6 5.6.7 6 0Z" fill="currentColor"/>'
    + '<path d="M6 13a2.4 2.4 0 0 1-2.4-2.4c0-1.3 1-2 1.7-3 .5.8 1 1.1 1.5 1.4.9.5 1.6 1 1.6 1.9A2.4 2.4 0 0 1 6 13Z" fill="currentColor" opacity=".38"/>'
    + '</svg>';

  function renderAcct() {
    const el = $('acct');
    if (currentUser) {
      const isPro = currentUser.plan === 'pro';
      const badge = `<span class="plan ${isPro ? 'pro' : ''}">${isPro ? 'PRO' : 'FREE'}</span>`;
      const upgrade = (!isPro && billingOn) ? `<button class="upgrade" id="upgradeNav">Upgrade</button>` : '';
      // Only worth showing once there is one. The tooltip carries the rule,
      // because "why didn't my streak break over the weekend" is the obvious
      // question, and the answer belongs next to the number.
      const st = currentStreak;
      const plural = (st && st.count === 1) ? '' : 's';
      const flame = (st && st.count > 0)
        ? `<span class="streak" data-tip="Streak: ${st.count} trading day${plural} in a row`
          + `${st.best > st.count ? '. Best so far, ' + st.best : ''}.`
          + ` Weekends and market holidays do not break it.">${FLAME}${st.count}</span>`
        : '';
      el.innerHTML = flame + badge + upgrade + `<span class="email">${esc(currentUser.email)}</span><button class="link-btn" id="logoutBtn">Log out</button>`;
      $('logoutBtn').addEventListener('click', logout);
      if ($('upgradeNav')) $('upgradeNav').addEventListener('click', () => showView('pricing'));
    } else {
      el.innerHTML = `<button class="signin" id="signinBtn">Sign in</button>`;
      $('signinBtn').addEventListener('click', () => openAuth('login'));
    }
  }
  async function checkAuth() {
    try { const j = await (await fetch('/api/auth/me')).json(); currentUser = j.user || null; currentStreak = j.streak || null; billingPlans = j.billing || {}; if (j.limits) limits = j.limits; trialDays = Number(j.trialDays) || 0; launch = j.launch || launch; showGoogleButtons(!!j.googleAuth); billingOn = !!(billingPlans.weekly || billingPlans.monthly || billingPlans.yearly); } catch { currentUser = null; currentStreak = null; }
    renderAcct();
    $('watchBtn').classList.toggle('hidden', !currentUser);
    // The gate comes down only for a signed-in visitor who has agreed on this
    // device; anything else leaves it up, including a stale agreement flag
    // with no session behind it.
    renderLaunchBar();
    const dz = $('dangerZone');
    if (dz) dz.classList.toggle('hidden', !currentUser);
    if (currentUser && hasAgreed()) { hideGate(); releasePending(); loadWatchlist(); }
    else if (!ON_OPEN_PAGE) showGate();
    else { watchSymbols = []; renderWatchStrip(); }
    // The initial route renders before this resolves, so a direct load of
    // /pricing would otherwise show no price and "Sign in to upgrade" to
    // someone who is already signed in. Re-render once the answer arrives.
    if (!$('view-pricing').classList.contains('hidden')) renderPricing();
  }
  function openAuth(mode) {
    authMode = mode;
    $('authTitle').textContent = mode === 'signup' ? 'Create your account' : 'Sign in';
    $('authSubmit').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
    $('authToggleText').textContent = mode === 'signup' ? 'Already have an account?' : 'New to ChartGauge?';
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
  function absorbWatch(j) {
    if (!j) return;
    if (Array.isArray(j.rows)) watchRows = j.rows;
    if (Array.isArray(j.symbols)) watchSymbols = j.symbols;
  }
  async function loadWatchlist() {
    try { absorbWatch(await (await fetch('/api/watchlist')).json()); }
    catch { watchSymbols = []; watchRows = []; }
    renderWatchStrip();
    // showView can run before this resolves — at boot the route is decided
    // while auth is still settling — so the list redraws itself once the
    // symbols actually arrive, instead of sitting on "No stocks saved yet".
    if (currentView === 'watchlist') renderWatchView();
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
    try {
      absorbWatch(await (await fetch('/api/watchlist', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, action: remove ? 'remove' : 'add' }) })).json());
    } catch {}
    renderWatchStrip();
    if (lastData) updateWatchBtn(lastData.symbol);
  }
  $('watchBtn').addEventListener('click', () => { if (lastData) toggleWatch(lastData.symbol); });
  wirePractice();
  wireWatchlist();
  checkAuth();

  // ---- Views (Home / Analyze / Markets / Watchlist) ----
  let currentView = 'home';
  const VIEWS = ['home', 'analyze', 'compare', 'screener', 'markets', 'movers', 'accuracy', 'watchlist', 'alerts', 'practice', 'learn', 'settings', 'pricing', 'admin', 'legal'];
  const LEGAL_PATHS = ['terms', 'privacy', 'refunds', 'contact'];
  // Each view has a real URL now, so navigation updates the address bar and
  // the back button works. pushUrl is skipped when we are *reacting* to a URL
  // (initial load, popstate) to avoid pushing a duplicate entry.
  function urlForView(name) {
    if (name === 'home') return '/';
    if (name === 'legal') return location.pathname;     // already on /terms, /privacy, ...
    if (name === 'analyze' && lastData && lastData.symbol) return '/stock/' + lastData.symbol;
    return '/' + name;
  }
  function syncUrl(name, replace) {
    const want = urlForView(name);
    try {
      if (location.pathname === want) return;
      history[replace ? 'replaceState' : 'pushState']({ view: name }, '', want);
    } catch (e) {}
  }

  function showView(name, opts) {
    if (!VIEWS.includes(name)) name = 'home';
    if (!opts || !opts.fromUrl) syncUrl(name, !!(opts && opts.replace));
    VIEWS.forEach(v => $('view-' + v).classList.toggle('hidden', v !== name));
    currentView = name;
    document.querySelectorAll('.drawer-link').forEach(l => l.classList.toggle('active', l.dataset.view === name));
    window.scrollTo(0, 0);
    if (name === 'markets') loadMarkets();
    if (name === 'movers') loadMovers();
    if (name === 'accuracy') loadAccuracy();
    if (name === 'settings') renderSettings();
    if (name === 'watchlist') renderWatchView();
    if (name === 'home') { loadHomeSnapshot(); loadRanked(); }
    if (name === 'learn') renderLearnGrid();
    if (name === 'compare') { renderCompareChips(); if (compareSymbols.length >= 2 && !$('compareResult').innerHTML) loadCompare(); }
    if (name === 'screener' && !$('screenResult').innerHTML) loadScreen();
    if (name === 'alerts') loadAlerts();
    // The chart panel is a single element shared by both views, so it moves
    // to whichever one is on screen.
    mountChart(name);
    if (name === 'practice') loadPaper();
    if (name === 'admin') loadAdmin();
    if (name === 'pricing') renderPricing();
  }
  function goAnalyze(sym) { showView('analyze'); if (sym) { $('symbol').value = sym; run(sym); } }
  document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', (e) => { e.preventDefault(); showView(el.dataset.view); }));

  // The server renders the lesson into the document so it indexes without
  // JavaScript. Once the app is running it renders the same lesson itself, so
  // drop the static copy rather than showing both.
  (function dropServerRenderedLesson() {
    const el = document.getElementById('ssrLesson');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  })();

  // Open whatever the URL asks for, including a ticker or a single lesson.
  function routeFromPath(replace) {
    const parts = decodeURIComponent(location.pathname).replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (!parts.length) return showView('home', { fromUrl: true, replace });
    if (parts[0] === 'stock' && parts[1]) {
      const sym = parts.slice(1).join('/').toUpperCase();
      showView('analyze', { fromUrl: true, replace });
      $('symbol').value = sym;
      run(sym);
      return;
    }
    if (parts[0] === 'learn' && parts[1]) {
      showView('learn', { fromUrl: true, replace });
      if (typeof openLesson === 'function') openLesson(parts[1].toLowerCase());
      return;
    }
    if (LEGAL_PATHS.includes(parts[0])) return showView('legal', { fromUrl: true, replace });
    showView(VIEWS.includes(parts[0]) ? parts[0] : 'home', { fromUrl: true, replace });
  }
  window.addEventListener('popstate', () => routeFromPath(true));

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
    try {
      const j = await (await fetch('/api/quotes?symbols=' + encodeURIComponent(symbols.join(',')))).json();
      const qs = j.quotes || [];
      qs.forEach(q => { q.source = j.source; });
      return qs;
    } catch { return []; }
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
  // ---- Ranked panel on the home screen ----
  // The labels are this app\u2019s own score, the same one shown on every chart.
  // The note under it is not decoration: the score was measured over 36,524
  // past setups and did not predict direction, and a panel that headlines
  // "Strong Buy" without that sitting next to it would be the site arguing
  // against itself.
  function rankedCard(r) {
    const up = (r.changePct || 0) >= 0;
    // Coloured by the rating, not by which column it landed in: a Hold that
    // happens to be the weakest of six is still a Hold, and printing its score
    // in red would overstate what the score actually says.
    const tint = r.tone === 'bullish' ? 'good' : r.tone === 'bearish' ? 'bad' : '';
    return `<div class="rk" data-s="${esc(r.symbol)}">`
      + `<div class="rk-top"><span class="rk-sym">${esc(r.symbol)}</span>`
      + `<span class="rk-score ${tint}">${r.score}</span></div>`
      + `<div class="rk-label ${esc(r.tone || 'neutral')}">${esc(r.label || '')}</div>`
      + `<div class="rk-meta"><span class="${up ? 'up' : 'down'}">${up ? '+' : ''}${(r.changePct || 0).toFixed(2)}%</span>`
      + ` <span>\u00b7 ${agreePct(r.agreeing, r.groupCount) != null ? agreePct(r.agreeing, r.groupCount) + '% agreement' : '\u2014'}</span></div>`
      + `</div>`;
  }

  async function loadRanked() {
    const body = $('rankedBody'), note = $('rankedNote');
    if (!body) return;
    if (body.dataset.loaded) return;
    body.innerHTML = `<p class="compare-note">Loading ratings\u2026</p>`;
    let d;
    try { d = await (await fetch('/api/ranked')).json(); }
    catch { body.innerHTML = ''; note.textContent = ''; return; }
    if (!d.available) {
      body.innerHTML = `<p class="compare-note">${esc(d.message || 'Unavailable.')}</p>`;
      // Still gathering: come back for it rather than leaving a dead panel.
      if (d.building) setTimeout(() => { delete body.dataset.loaded; loadRanked(); }, 20000);
      return;
    }
    body.dataset.loaded = '1';
    body.innerHTML =
      `<div class="ranked-col"><div class="ranked-h good">Scoring highest</div>`
      + d.strong.map(rankedCard).join('') + `</div>`
      + `<div class="ranked-col"><div class="ranked-h bad">Scoring lowest</div>`
      + d.weak.map(rankedCard).join('') + `</div>`;
    note.innerHTML = `Highest and lowest of ${d.scanned || ''} stocks scanned. `
      + `These are ChartGauge\u2019s own indicator scores, not advice. `
      + `Measured across 36,524 past setups, this score did not predict which way price went next \u2014 `
      + `open any symbol to see the base rate for its own history. Nothing here is a recommendation to buy or sell.`;
    body.querySelectorAll('.rk').forEach(el =>
      el.addEventListener('click', () => goAnalyze(el.dataset.s)));
  }

  async function loadHomeSnapshot() {
    if ($('homeSnapshot').dataset.loaded) return;
    const idx = await getQuotes(INDICES.map(i => i[0]));
    if (idx.length) { $('homeSnapshot').innerHTML = idx.map(quoteCard).join(''); bindQuoteCards($('homeSnapshot')); $('homeSnapshot').dataset.loaded = '1'; }
    else $('homeSnapshot').innerHTML = '<div class="quote-loading">—</div>';
  }
  // ---- Watchlist ----
  // A saved symbol behaves like a position you have not funded: the price it
  // was added at, how it has done since, and your own stop and target. The
  // chart is the shared panel, moved in here.

  async function renderWatchView() {
    const el = $('watchView');
    if (!currentUser) {
      $('wlChartWrap').classList.add('hidden');
      el.innerHTML = `<div class="view-empty">Sign in to build a watchlist that syncs across your devices.<br><button class="btn btn-primary" id="wvSignin">Sign in</button></div>`;
      $('wvSignin').addEventListener('click', () => openAuth('login'));
      return;
    }
    if (!watchSymbols.length) {
      $('wlChartWrap').classList.add('hidden');
      el.innerHTML = `<div class="view-empty">No stocks saved yet.<br>Analyze a stock and tap <b>☆ Watch</b> to add it here.</div>`;
      return;
    }
    el.innerHTML = `<div class="quote-grid" id="wvGrid"><div class="quote-loading">Loading…</div></div>`;
    const q = await getQuotes(watchSymbols);
    const byS = {};
    q.forEach(x => { byS[String(x.symbol).toUpperCase()] = x; });

    $('wvGrid').innerHTML = watchSymbols.map(sym => {
      const r = wlRow(sym) || {};
      const quote = byS[sym];
      const px = quote && Number(quote.price);
      const hasEntry = Number.isFinite(r.entry) && r.entry > 0 && Number.isFinite(px);
      const chg = hasEntry ? ((px - r.entry) / r.entry) * 100 : null;
      const cls = chg == null ? '' : chg > 0 ? 'up' : chg < 0 ? 'down' : '';
      return '<div class="wl-card' + (sym === wlSym ? ' on' : '') + '" data-s="' + esc(sym) + '">'
        + '<div class="wl-card-top"><b>' + esc(sym) + '</b>'
        + ((r.stop || r.target) ? '<span class="wl-flag" title="You have levels set">levels</span>' : '')
        + '</div>'
        + '<div class="wl-card-px">' + (Number.isFinite(px) ? pMoney(px) : '—') + '</div>'
        + '<div class="wl-card-chg ' + cls + '">'
        + (chg == null ? '<span class="muted">no entry recorded</span>'
            : (chg >= 0 ? '+' : '−') + Math.abs(chg).toFixed(2) + '% since entry')
        + '</div></div>';
    }).join('');

    document.querySelectorAll('#wvGrid .wl-card').forEach(c =>
      c.addEventListener('click', () => selectWatch(c.dataset.s)));

    if (!wlSym || !watchSymbols.includes(wlSym)) wlSym = watchSymbols[0];
    selectWatch(wlSym);
  }

  async function selectWatch(sym) {
    sym = String(sym || '').toUpperCase();
    if (!sym) return;
    wlSym = sym;
    $('wlChartWrap').classList.remove('hidden');
    $('wlSym').textContent = sym;
    $('wlName').textContent = '';
    document.querySelectorAll('#wvGrid .wl-card').forEach(c =>
      c.classList.toggle('on', c.dataset.s === sym));
    const r = wlRow(sym) || {};
    $('wlEntry').value = Number.isFinite(r.entry) ? r.entry : '';
    $('wlStop').value = Number.isFinite(r.stop) ? r.stop : '';
    $('wlTarget').value = Number.isFinite(r.target) ? r.target : '';
    // run() is the analyze pipeline, so the chart here is the analyze chart.
    try { await run(sym); } catch (e) {}
    if (lastData && lastData.symbol === sym) {
      $('wlName').textContent = (lastData.name && lastData.name !== sym) ? lastData.name : '';
    }
    await wlRefreshQuote();
    drawChart();
  }

  async function wlRefreshQuote() {
    if (!wlSym) return;
    try {
      const j = await (await fetch('/api/quotes?symbols=' + encodeURIComponent(wlSym))).json();
      const q = (j.quotes || [])[0];
      if (q && Number.isFinite(Number(q.price))) {
        wlQuote = q;
        $('wlLast').textContent = pMoney(q.price);
        const up = Number(q.changePct) >= 0;
        $('wlChg').textContent = (up ? '+' : '') + Number(q.change || 0).toFixed(2)
          + '  (' + (up ? '+' : '') + Number(q.changePct || 0).toFixed(2) + '%)';
        $('wlChg').className = 'chart-chg ' + (up ? 'up' : 'down');
      }
    } catch (e) {}
    wlRenderPl();
  }

  function wlRenderPl() {
    const r = wlRow(wlSym) || {};
    const px = wlQuote && Number(wlQuote.price);
    const el = $('wlPl'), rr = $('wlRr');
    if (!el) return;
    if (!Number.isFinite(r.entry) || !Number.isFinite(px)) {
      el.textContent = '—'; el.className = 'wl-pl-v'; rr.textContent = '';
      return;
    }
    const diff = px - r.entry, pct = (diff / r.entry) * 100;
    el.textContent = (diff >= 0 ? '+' : '−') + pMoney(Math.abs(diff))
      + '  (' + (pct >= 0 ? '+' : '−') + Math.abs(pct).toFixed(2) + '%)';
    el.className = 'wl-pl-v ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : '');
    // Reward against risk, which is the number that decides whether the trade
    // was worth taking at all.
    if (Number.isFinite(r.stop) && Number.isFinite(r.target) && r.stop < r.entry && r.target > r.entry) {
      const risk = r.entry - r.stop, reward = r.target - r.entry;
      rr.textContent = 'Risking ' + pMoney(risk) + ' to make ' + pMoney(reward)
        + ' — ' + (reward / risk).toFixed(2) + ':1';
      rr.className = 'wl-rr muted';
    } else if (Number.isFinite(r.stop) && r.stop >= r.entry) {
      // Easy to do by dragging, and the ratio just vanishing explains nothing.
      rr.textContent = 'Your stop is at or above your entry, so there is no risk to measure.';
      rr.className = 'wl-rr warn';
    } else if (Number.isFinite(r.target) && r.target <= r.entry) {
      rr.textContent = 'Your target is at or below your entry.';
      rr.className = 'wl-rr warn';
    } else { rr.textContent = ''; rr.className = 'wl-rr muted'; }
  }

  // null clears a level. `sym` defaults to the symbol the panel is showing,
  // but a level dragged on the chart belongs to whatever the chart is showing,
  // and those are not always the same: analyzing one watchlisted name while
  // the panel sat on another saved the dragged level onto the panel's symbol.
  async function saveWatchLevels(patch, sym) {
    const symbol = String(sym || wlSym || '').toUpperCase();
    if (!symbol) return;
    try {
      const res = await fetch('/api/watchlist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ symbol, action: 'levels' }, patch)),
      });
      const j = await res.json();
      if (j.rows) { watchRows = j.rows; watchSymbols = j.symbols || watchSymbols; }
      wlRenderPl();
      drawChart();
    } catch (e) {}
  }

  function wireWatchlist() {
    if (!$('wlStop')) return;
    const read = (el) => {
      if (el.value === '') return null;                  // cleared
      const n = Number(el.value);
      return Number.isFinite(n) && n > 0 ? n : undefined; // nonsense: ignore
    };
    const bind = (id, key) => $(id).addEventListener('change', () => {
      const v = read($(id));
      if (v === undefined) {
        // Put back what is actually stored. Leaving the typed text sitting
        // there made the box disagree with the level on the chart.
        const cur = wlRow(wlSym);
        $(id).value = (cur && Number.isFinite(cur[key])) ? cur[key] : '';
        return;
      }
      const r = wlRow(wlSym); if (r) r[key] = v;
      saveWatchLevels({ [key]: v });
    });
    bind('wlEntry', 'entry'); bind('wlStop', 'stop'); bind('wlTarget', 'target');
    $('wlFull').addEventListener('click', () => { if (wlSym) goAnalyze(wlSym); });
  }

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
    if (isProGate(data)) { $('compareResult').innerHTML = proGateHtml(data); return; }
    const rows = (data.compare || []).filter(r => !r.error);
    if (rows.length < 2) { $('compareResult').innerHTML = `<p class="compare-note">Couldn’t load enough data — check the tickers.</p>`; return; }
    let html = `<div class="compare-scroll"><table class="compare-table"><thead><tr><th></th>` +
      rows.map(r => `<th data-s="${esc(r.symbol)}">${esc(r.symbol)}<span class="ct-name">${esc(r.name || '')}</span></th>`).join('') + `</tr></thead><tbody>`;
    html += ctRow('Price', rows.map(r => '$' + (+r.price).toFixed(2)));
    html += ctRow('Change', rows.map(r => `<span class="${r.changePct >= 0 ? 'up' : 'down'}">${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(2)}%</span>`), true);
    html += ctRow('Indicator score', rows.map(r => `<span class="ct-score">${r.rating && r.rating.score != null ? r.rating.score + '/100' : '\u2014'}</span>`), true);
    html += ctRow('Recommendation', rows.map(r => `<span class="ct-rec ${r.rating.tone}">${esc(r.rating.label)}</span>`), true);
    html += ctRow('Risk', rows.map(r => esc(r.rating.risk || '—')));
    if (data.hasFundamentals) CMP_ROWS.forEach(label => html += ctRow(label, rows.map(r => r.metrics ? (r.metrics[label] || '—') : '—')));
    html += `</tbody></table></div>`;
    if (!data.hasFundamentals) html += `<p class="compare-note">Add FMP_API_KEY for fundamental rows (P/E, margins, ROE…).</p>`;
    $('compareResult').innerHTML = html;
    $('compareResult').querySelectorAll('thead th[data-s]').forEach(th => th.addEventListener('click', () => goAnalyze(th.dataset.s)));
  }

  // ---- Screener ----
  const CAP_LABEL = { mega: 'Mega cap', large: 'Large cap', mid: 'Mid cap', small: 'Small cap' };
  function screenCard(x) {
    const up = (x.changePct || 0) >= 0;
    return `<div class="quote-card" data-s="${esc(x.symbol)}"><div class="quote-sym">${esc(x.symbol)}</div><div class="quote-name">${esc(x.name || '')}</div><div class="quote-price">$${(+x.price).toFixed(2)}</div><div class="quote-chg ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(x.changePct || 0).toFixed(2)}%</div><div class="quote-name" style="margin-top:5px">${esc(x.sector || '')} · ${esc(CAP_LABEL[x.cap] || '')}</div></div>`;
  }
  async function loadScreen() {
    $('screenResult').innerHTML = `<p class="compare-note">Screening…</p>`;
    const p = new URLSearchParams();
    if ($('scSector').value) p.set('sector', $('scSector').value);
    if ($('scCap').value) p.set('cap', $('scCap').value);
    if ($('scPriceMin').value) p.set('priceMin', $('scPriceMin').value);
    if ($('scPriceMax').value) p.set('priceMax', $('scPriceMax').value);
    let d;
    try { d = await (await fetch('/api/screen?' + p.toString())).json(); } catch { $('screenResult').innerHTML = `<p class="compare-note">Couldn’t run the screen.</p>`; return; }
    if (isProGate(d)) { $('screenResult').innerHTML = proGateHtml(d); return; }
    if (!d.available) { $('screenResult').innerHTML = `<p class="compare-note">${esc(d.message || 'Screener unavailable.')}</p>`; return; }
    if (!d.results.length) { $('screenResult').innerHTML = `<p class="compare-note">No matches — try loosening the filters.</p>`; return; }
    $('screenResult').innerHTML = `<div class="mkt-h">${d.results.length} matches</div><div class="quote-grid">` + d.results.map(screenCard).join('') + `</div><p class="compare-note">Screening a curated list of popular US stocks with live prices. Full-market screening needs a paid data plan.</p>`;
    $('screenResult').querySelectorAll('.quote-card').forEach(c => c.addEventListener('click', () => goAnalyze(c.dataset.s)));
  }
  $('screenForm').addEventListener('submit', (e) => { e.preventDefault(); loadScreen(); });

  // ---- Price alerts ----
  let lastAlertCount = 0;
  function updateAlertBadge(n) {
    lastAlertCount = n;
    const b = $('alertBadge');            // only exists while the menu is built
    if (!b) return;
    if (n > 0) { b.textContent = n; b.classList.remove('hidden'); } else b.classList.add('hidden');
  }
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

  // ---- Pricing / Stripe billing ----
  // Every period is shown with what it costs per month, so a yearly price can
  // be compared with a weekly one without doing arithmetic in your head.
  const money = (cents, cur) => {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: (cur || 'usd').toUpperCase(),
        minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
    } catch (e) { return '$' + (cents / 100).toFixed(2); }
  };
  const PERIOD_MONTHS = { week: 12 / 52, month: 1, year: 12 };
  function perMonth(p) {
    const months = (PERIOD_MONTHS[p.interval] || 1) * (p.intervalCount || 1);
    return months ? p.amount / months : null;
  }
  // Each billing period is its own card, sitting beside Free in one row, so
  // the four are read as four choices rather than as options nested inside a
  // fifth thing. Someone already on Pro sees a single Pro card instead.
  const INTERVAL_WORD = { week: 'per week', month: 'per month', year: 'per year' };
  // The day charging begins, for "from <date>" phrasing.
  const launchDateAfter = () => launch.until
    ? new Date(launch.until).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })
    : '';
  // What the daily allowance becomes once the launch period ends. The server
  // reports null while everything is open, so this cannot be read from limits.
  const AI_FALLBACK_N = 3;
  const PRICING_LEAD_AFTER = 'The chart, every indicator, the stop-loss and take-profit levels and the measured base rate are free for everyone with an account. Pro adds the parts that cost money to run each time: unlimited written reports, chart-image reading, the screener and side-by-side compare, and more take-profit levels.';
  function renderPricing() {
    const pro = !!(currentUser && currentUser.plan === 'pro');
    const li = (arr) => arr.map(([t, on]) => `<li class="${on ? '' : 'off'}">${esc(t)}</li>`).join('');
    const aiN = limits.aiPerDay || AI_FALLBACK_N;
    const freeList = [
      ['Full charts, every indicator, stocks and crypto', 1],
      ['Free account — email and password', 1],
      [launch.free ? `Stop-loss and take-profit levels — one from ${launchDateAfter()}` : 'Stop-loss and one take-profit level', 1],
      ['The score and the measured base rate', 1],
      // During the launch period these rows described the limits that start
      // later, which read as if they were already in force.
      [launch.free
        ? `Written reports, no daily limit — ${AI_FALLBACK_N} a day from ${launchDateAfter()}`
        : `${aiN} written reports a day, then the rule-based read`, 1],
      [launch.free
        ? `Watchlist and price alerts, no limit — capped from ${launchDateAfter()}`
        : `Watchlist up to ${limits.watchMax || 10}, ${limits.alertMax || 3} price alerts`, 1],
      ['Every lesson', 1],
      // Open right now, but saying so without saying they change would be the
      // kind of small dishonesty people notice on the day it changes.
      ['Chart-image reading' + (launch.free ? ` — Pro from ${launchDateAfter()}` : ''), launch.free ? 1 : 0],
      ['Screener and side-by-side compare' + (launch.free ? ` — Pro from ${launchDateAfter()}` : ''), launch.free ? 1 : 0],
    ];
    const periods = [['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']].filter(([k]) => billingPlans && billingPlans[k]);
    // Cheapest per month gets the tag, computed rather than hardcoded.
    const priced = periods.map(([k]) => billingPlans[k]).filter(p => p && p.amount != null);
    const best = priced.length ? Math.min(...priced.map(perMonth)) : null;

    const freeCard = `<div class="plan-card"><div class="plan-name">Free</div><div class="plan-price">$0</div>`
      + `<ul class="plan-list">${li(freeList)}</ul>`
      + `${pro ? '' : '<div class="plan-current">Your current plan</div>'}</div>`;

    let proCards;
    if (pro) {
      proCards = `<div class="plan-card pro period"><div class="plan-name">Pro</div>`
        + `<div class="plan-price">Active</div>`
        + `<div class="period-sub">Thank you for supporting ChartGauge.</div>`
        + `<button class="btn btn-ghost btn-block" id="manageBtn">Manage subscription</button></div>`;
    } else if (periods.length) {
      proCards = periods.map(([k, label]) => {
        const p = billingPlans[k];
        const amount = (p && p.amount != null) ? money(p.amount, p.currency) : 'Pro';
        const word = (p && p.amount != null) ? (INTERVAL_WORD[p.interval] || '') : 'billed via Stripe';
        const pm = (p && p.amount != null) ? perMonth(p) : null;
        // A monthly plan would repeat itself, so it gets no per-month line.
        const sub = (pm != null && !(p.interval === 'month' && (p.intervalCount || 1) === 1))
          ? `${esc(money(Math.round(pm), p.currency))} per month` : '';
        const isBest = pm != null && best != null && pm <= best + 0.5 && priced.length > 1;
        const trial = trialDays > 0
          ? `<div class="period-trial">${trialDays} days free, then ${esc(amount)} ${esc(word)}</div>` : '';
        return `<div class="plan-card pro period"><div class="plan-name">Pro · ${esc(label)}</div>`
          + `<div class="plan-price">${esc(amount)}<small>${esc(word)}</small></div>`
          + trial
          + `<div class="period-sub">${sub}</div>`
          + `<div class="period-tag">${isBest ? '<span class="pb-best">best value</span>' : ''}</div>`
          + `<button class="btn btn-ai btn-block plan-btn" data-plan="${k}">`
          + `${currentUser ? 'Subscribe' : 'Sign in to subscribe'}</button></div>`;
      }).join('');
    } else {
      proCards = `<div class="plan-card pro period"><div class="plan-name">Pro</div>`
        + `<div class="plan-price">Pro <small>billed via Stripe</small></div>`
        + `<div class="period-sub">Billing isn\u2019t set up yet.</div></div>`;
    }

    // During the launch period the page has to be explicit: everything below
    // is open to everyone right now, and exactly what changes, and when.
    $('pricingLead').innerHTML = launch.free
      ? `<strong>Everything is free for everyone through ${esc(launchDate())}.</strong> `
        + `Every feature listed below is open on a free account until then — no subscription, no daily limits. `
        + `From ${esc(launchDateAfter())}, unlimited written reports, chart-image reading, the screener, `
        + `side-by-side compare and extra take-profit levels become part of Pro. The chart, every indicator, the `
        + `stop-loss and take-profit levels and the measured base rate stay free after that date too.`
      : PRICING_LEAD_AFTER;
    $('pricingBody').innerHTML = freeCard + proCards;
    // Two cards (a Pro subscriber, or billing not configured) should not sit in
    // a four-column grid leaving two empty tracks.
    $('pricingBody').style.setProperty('--cards', String($('pricingBody').children.length || 1));
    if ($('manageBtn')) $('manageBtn').addEventListener('click', openPortal);
    // Signed out, the same button opens the sign-in modal rather than checkout.
    $('pricingBody').querySelectorAll('.plan-btn').forEach(b => b.addEventListener('click',
      () => currentUser ? startCheckout(b.dataset.plan, b) : openAuth('login')));
  }
  async function startCheckout(plan, b) {
    if (b) { b.disabled = true; b.textContent = 'Redirecting…'; }
    track('begin_checkout', { plan });
    try { const j = await (await fetch('/api/billing/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) })).json(); if (j.url) { location.href = j.url; return; } alert(j.error || 'Could not start checkout.'); } catch (e) { alert('Could not start checkout.'); }
    renderPricing();
  }
  async function openPortal() {
    const b = $('manageBtn'); if (b) { b.disabled = true; b.textContent = 'Opening…'; }
    try { const j = await (await fetch('/api/billing/portal', { method: 'POST' })).json(); if (j.url) { location.href = j.url; return; } alert(j.error || 'Could not open the billing portal.'); } catch (e) { alert('Could not open the billing portal.'); }
    if (b) { b.disabled = false; b.textContent = 'Manage subscription'; }
  }

  // ---- Admin dashboard ----
  async function loadAdmin() {
    if (!currentUser || !currentUser.admin) { $('adminBody').innerHTML = `<div class="view-empty">Admin access only.</div>`; return; }
    $('adminBody').innerHTML = `<p class="compare-note">Loading…</p>`;
    let d; try { d = await (await fetch('/api/admin')).json(); } catch { $('adminBody').innerHTML = `<p class="compare-note">Couldn’t load.</p>`; return; }
    if (d.error) { $('adminBody').innerHTML = `<div class="view-empty">${esc(d.error)}</div>`; return; }
    const c = d.counts || {};
    let html = `<div class="admin-stats">
      <div class="admin-stat"><div class="n">${c.users || 0}</div><div class="l">Users</div></div>
      <div class="admin-stat"><div class="n">${c.watch || 0}</div><div class="l">Watchlist items</div></div>
      <div class="admin-stat"><div class="n">${c.alerts || 0}</div><div class="l">Alerts</div></div>
      <div class="admin-stat"><div class="n">${(d.usage && d.usage.total) || 0}</div><div class="l">API calls (since restart)</div></div>
    </div>`;
    html += `<div class="admin-sec"><div class="mkt-h">Services</div>` + Object.entries(d.services || {}).map(([k, v]) => `<span class="svc-pill ${v ? 'svc-on' : 'svc-off'}">${esc(k)}: ${v ? 'on' : 'off'}</span>`).join('') + `<span class="svc-pill ${d.store === 'postgres' ? 'svc-on' : 'svc-off'}">store: ${esc(d.store || '')}</span></div>`;
    const usageEntries = Object.entries(d.usage || {}).filter(([k]) => k !== 'total').sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (usageEntries.length) html += `<div class="admin-sec"><div class="mkt-h">Top endpoints</div><div class="compare-scroll"><table class="admin-table"><thead><tr><th>Endpoint</th><th>Calls</th></tr></thead><tbody>` + usageEntries.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('') + `</tbody></table></div></div>`;
    html += `<div class="admin-sec"><div class="mkt-h">Users (${(d.users || []).length})</div><div class="compare-scroll"><table class="admin-table"><thead><tr><th>Email</th><th>Plan</th><th>Joined</th></tr></thead><tbody>` + (d.users || []).map(u => {
      const plan = u.plan === 'pro' ? 'pro (paying)' : u.comp ? 'pro (comp)' : 'free';
      return `<tr><td>${esc(u.email)}${u.admin ? ' <span class="svc-pill svc-on">admin</span>' : ''}</td><td>${esc(plan)}</td><td>${esc(ymd(u.created))}</td></tr>`;
    }).join('') + `</tbody></table></div></div>`;
    html += `<div class="admin-sec"><div class="mkt-h">Recent errors (${(d.errors || []).length})</div>` + ((d.errors || []).length ? d.errors.map(e => `<div class="err-line">${esc(hms(e.t))} \u2014 ${esc(e.msg)}</div>`).join('') : `<p class="compare-note">No errors logged.</p>`) + `</div>`;
    $('adminBody').innerHTML = html;
  }

  // ---- Movers ----
  // Deliberately reports observations, not a ranking of what to buy. Each row
  // says what is unusual about the symbol right now and links to its chart,
  // where the measured base rate for that setup is shown.
  const relVolWord = (r) => r == null ? '—'
    : r >= 3 ? 'far above normal' : r >= 1.8 ? 'well above normal'
    : r >= 1.2 ? 'above normal' : r >= 0.8 ? 'about normal' : 'below normal';
  const rangeWord = (p) => p == null ? '—'
    : p >= 0.9 ? 'at the day\u2019s high' : p >= 0.66 ? 'upper part of the day\u2019s range'
    : p >= 0.34 ? 'middle of the day\u2019s range' : p > 0.1 ? 'lower part of the day\u2019s range'
    : 'at the day\u2019s low';

  function moverRow(r) {
    const up = (r.changePct || 0) >= 0;
    const pct = r.changePct == null ? '—' : `${up ? '+' : ''}${r.changePct.toFixed(2)}%`;
    const rv = r.relVol == null ? '—' : `${r.relVol.toFixed(1)}\u00d7`;
    return `<div class="mover" data-s="${esc(r.symbol)}">`
      + `<div class="mover-head"><span class="mover-sym">${esc(r.symbol)}</span>`
      + `<span class="mover-pct ${up ? 'up' : 'down'}">${pct}</span></div>`
      + `<div class="mover-facts">`
      + `<span><b>${rv}</b> volume — ${esc(relVolWord(r.relVol))}</span>`
      + `<span>${esc(rangeWord(r.rangePos))}</span>`
      + `<span>day range ${r.rangePct == null ? '—' : r.rangePct.toFixed(1) + '%'}</span>`
      + `</div></div>`;
  }

  // The accuracy figures are already in the document, server-rendered. This
  // only refreshes them when the view is reached by in-app navigation, where
  // the server-rendered copy belongs to whichever page was loaded first.
  async function loadAccuracy() {
    const host = $('accuracySsr');
    if (!host || host.dataset.loaded) return;
    try {
      const d = await fetch('/api/accuracy').then(r => r.json());
      if (!d.graded) {
        host.innerHTML = `<p class="compare-note">`
          + (d.recorded ? `${d.recorded} readings recorded so far; none have` : 'No readings have')
          + ` reached their ${d.horizon}-day outcome yet, so there is nothing to report. This page fills in on its own.</p>`;
        return;
      }
      const pc = (v) => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
      const ORDER = ['Very bullish', 'Bullish', 'Mixed', 'Bearish', 'Very bearish'];
      const rows = ORDER.map(l => d.labels.find(x => x.label === l)).filter(Boolean).map(x =>
        `<tr><td>${esc(x.label)}</td><td>${x.n}</td><td>${pc(x.mean)}</td>`
        + `<td>${x.mean == null || d.baseline == null ? '—' : pc(x.mean - d.baseline)}</td>`
        + `<td>${x.winRate == null ? '—' : x.winRate.toFixed(0) + '%'}</td></tr>`).join('');
      host.innerHTML = `<p><strong>${d.graded}</strong> of ${d.recorded} recorded readings have reached their `
        + `${d.horizon}-trading-day outcome. Across all of them the average return was <strong>${pc(d.baseline)}</strong> — `
        + `what you would have had without consulting the score at all.</p>`
        + `<div class="compare-scroll"><table class="acc-table"><thead><tr><th>Reading</th><th>Count</th>`
        + `<th>Average return</th><th>vs doing nothing</th><th>Higher after</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      host.dataset.loaded = '1';
    } catch (e) { /* the server-rendered copy stays */ }
  }

  // ---- Install as an app ----
  // Two very different platforms. Chrome and Android fire beforeinstallprompt
  // and let a button do it; iOS has no such API at all, so the only honest
  // thing there is to describe the two taps Apple requires.
  let deferredInstall = null;
  const INSTALL_KEY = 'chartgauge_install_dismissed';

  const standalone = () => window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);   // iPadOS reports as Mac
  const isSafari = () => /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|Chrome/.test(navigator.userAgent);

  function showInstallBar(html, withButton) {
    const bar = $('installBar');
    if (!bar) return;
    try { if (localStorage.getItem(INSTALL_KEY) === '1') return; } catch (e) {}
    if (standalone()) return;                      // already installed
    $('installText').innerHTML = html;
    $('installBtn').classList.toggle('hidden', !withButton);
    bar.classList.remove('hidden');
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();                            // we choose when to ask
    deferredInstall = e;
    showInstallBar('<b>Install ChartGauge</b> &mdash; add it to your device and it opens like an app, full screen.', true);
  });

  if ($('installBtn')) $('installBtn').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch (e) {}
    deferredInstall = null;
    $('installBar').classList.add('hidden');
  });

  if ($('installClose')) $('installClose').addEventListener('click', () => {
    $('installBar').classList.add('hidden');
    try { localStorage.setItem(INSTALL_KEY, '1'); } catch (e) {}
  });

  window.addEventListener('appinstalled', () => {
    $('installBar').classList.add('hidden');
    try { localStorage.setItem(INSTALL_KEY, '1'); } catch (e) {}
  });

  // iOS never fires the event, so it gets the instructions instead — and only
  // in Safari, since Add to Home Screen does not exist in Chrome on iOS.
  if (isIOS() && isSafari() && !standalone()) {
    setTimeout(() => showInstallBar(
      '<b>Add ChartGauge to your Home Screen</b> &mdash; tap the Share button, then <b>Add to Home Screen</b>.', false), 2500);
  }

  // The worker only provides installability and an offline page; it caches no
  // data. Registered after load so it never competes with the first render.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  // ---- Launch countdown ----
  // Everyone drops to the free tier at the same moment on 18 October. Saying
  // so in advance is the difference between a planned change and a surprise.
  function renderLaunchBar() {
    const bar = $('launchBar');
    if (!bar || !launch.free || !launch.until) return;
    try { if (localStorage.getItem('chartgauge_launch_dismissed') === String(launch.until)) return; } catch (e) {}
    const ms = launch.until - Date.now();
    if (ms <= 0) return;
    const days = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    const left = days >= 2 ? `${days} days left`
      : days === 1 ? `1 day, ${hours} hours left`
      : hours >= 1 ? `${hours} hours left` : 'less than an hour left';
    const until = new Date(launch.lastFree || launch.until)
      .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
    $('launchText').innerHTML = `<b>Everything is free until ${esc(until)}</b> &mdash; ${esc(left)}. `
      + `After that, written reports, chart reading, the screener and compare become part of Pro.`;
    bar.classList.remove('hidden');
  }
  if ($('launchClose')) $('launchClose').addEventListener('click', () => {
    $('launchBar').classList.add('hidden');
    // Keyed to this deadline, so a future promotion is not silently suppressed.
    try { localStorage.setItem('chartgauge_launch_dismissed', String(launch.until)); } catch (e) {}
  });

  // ---- Delete account ----
  async function deleteAccount() {
    const err = $('delErr'), btn = $('delBtn');
    err.classList.add('hidden');
    const confirmText = ($('delConfirm').value || '').trim();
    if (confirmText.toUpperCase() !== 'DELETE') {
      err.textContent = 'Type DELETE in the box to confirm.'; err.classList.remove('hidden'); return;
    }
    if (!window.confirm('Delete your account permanently? This cannot be undone.')) return;
    btn.disabled = true; btn.textContent = 'Deleting…';
    try {
      const r = await fetch('/api/auth/delete', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: confirmText }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not delete the account.');
      alert('Your account has been deleted.');
      location.href = '/';
    } catch (e) {
      err.textContent = e.message; err.classList.remove('hidden');
      btn.disabled = false; btn.textContent = 'Delete my account';
    }
  }
  if ($('delBtn')) $('delBtn').addEventListener('click', deleteAccount);

  let lastMoversAsOf = 0;
  async function loadMovers() {
    const body = $('moversBody'), status = $('moversStatus');
    body.innerHTML = `<p class="compare-note">Scanning…</p>`;
    let d;
    try { d = await (await fetch('/api/movers')).json(); }
    catch { body.innerHTML = `<p class="compare-note">Couldn\u2019t run the scan.</p>`; return; }
    if (isProGate(d)) { body.innerHTML = proGateHtml(d); return; }
    if (!d.available) { body.innerHTML = `<p class="compare-note">${esc(d.message || 'Scan unavailable.')}</p>`; return; }
    if (!d.rows.length) { body.innerHTML = `<p class="compare-note">Nothing to show.</p>`; return; }
    // The scan is shared and cached, so Refresh often returns the same reading.
    // Saying how old it is, and that a repeat press changed nothing, is better
    // than a button that appears to do nothing at all.
    const age = Math.round((Date.now() - d.asOf) / 60000);
    const same = lastMoversAsOf === d.asOf;
    lastMoversAsOf = d.asOf;
    status.textContent = (d.marketOpen ? 'Market open' : 'Market closed — showing the last session')
      + ' · ' + (age < 1 ? 'just updated' : `updated ${age} min ago`)
      + (same ? ' · already current, the scan refreshes every 15 minutes' : '');
    body.innerHTML = `<div class="movers-grid">` + d.rows.map(moverRow).join('') + `</div>`;
    body.querySelectorAll('.mover').forEach(el =>
      el.addEventListener('click', () => goAnalyze(el.dataset.s)));
  }
  if ($('moversRefresh')) $('moversRefresh').addEventListener('click', loadMovers);

  // ---- Learn center ----
  const LESSONS = window.LESSONS || [];
  // Which style of investing a lesson is for. A filter asks "what applies to
  // me", so picking Day trading includes the lessons marked for both — the
  // point is relevance, not exclusivity.
  const APPLIES_LABEL = { day: 'Day trading', long: 'Long-term', both: 'Both' };
  let learnFilter = 'all';
  try { const f = localStorage.getItem('chartgauge_learn_filter'); if (f) learnFilter = f; } catch (e) {}
  const lessonMatches = (l) => learnFilter === 'all' || l.applies === 'both' || l.applies === learnFilter;

  function renderLearnGrid() {
    const shown = LESSONS.filter(lessonMatches);
    const tabs = [['all', 'All lessons'], ['day', 'Day trading'], ['long', 'Long-term']].map(([k, label]) => {
      const n = LESSONS.filter(l => k === 'all' || l.applies === 'both' || l.applies === k).length;
      return `<button type="button" class="learn-tab${k === learnFilter ? ' active' : ''}" data-f="${k}">${esc(label)} <span class="learn-tab-n">${n}</span></button>`;
    }).join('');
    $('learnHost').innerHTML = `<div class="learn-tabs">${tabs}</div>`
      + `<div class="learn-grid">` + shown.map(l =>
      `<a class="learn-card" href="/learn/${encodeURIComponent(l.id)}" data-id="${l.id}">`
      + `<div class="learn-card-top"><div class="learn-title">${esc(l.title)}</div>`
      + `<span class="applies applies-${esc(l.applies)}">${esc(APPLIES_LABEL[l.applies] || '')}</span></div>`
      + `<div class="learn-meta">${esc(l.level)} · ${l.minutes} min · ${l.quiz.length} Q</div>`
      + `<p class="learn-desc">${esc(l.intro)}</p></a>`).join('') + `</div>`;
    $('learnHost').querySelectorAll('.learn-tab').forEach(b => b.addEventListener('click', () => {
      learnFilter = b.dataset.f;
      try { localStorage.setItem('chartgauge_learn_filter', learnFilter); } catch (e) {}
      renderLearnGrid();
    }));
    $('learnHost').querySelectorAll('.learn-card').forEach(c => c.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button > 0) return;   // let the browser open it
      e.preventDefault();
      try { history.pushState({ view: 'learn' }, '', '/learn/' + c.dataset.id); } catch (err) {}
      openLesson(c.dataset.id);
    }));
  }
  function openLesson(id) {
    const l = LESSONS.find(x => x.id === id); if (!l) return renderLearnGrid();
    window.scrollTo(0, 0);
    let html = `<div class="learn-detail"><button type="button" class="link-btn learn-back" id="learnBack">← All lessons</button>`;
    html += `<h2 class="learn-h">${esc(l.title)}</h2>`
      + `<div class="learn-meta"><span class="applies applies-${esc(l.applies)}">${esc(APPLIES_LABEL[l.applies] || '')}</span>`
      + ` ${esc(l.level)} · ${l.minutes} min read · ${l.quiz.length} question quiz</div>`;
    html += l.sections.map(s => `<div class="learn-section"><h3>${esc(s.h)}</h3><p>${esc(s.p)}</p></div>`).join('');
    html += `<div class="card quiz" id="quiz"></div>`;
    html += `</div>`;
    $('learnHost').innerHTML = html;
    $('learnBack').addEventListener('click', renderLearnGrid);
    renderQuiz(l);
  }
  function renderQuiz(l) {
    const host = $('quiz');
    const score = { right: 0, done: 0 };
    host.innerHTML = `<div class="quiz-h">Quick quiz</div>` + l.quiz.map((q, qi) =>
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
      if (score.done === l.quiz.length) finishQuiz(l, score);
    }));
  }

  // Shown once every question is answered. "Next" follows the filter the
  // reader is browsing under, so someone working through the day-trading track
  // is handed the next day-trading lesson rather than the next one in the file.
  function finishQuiz(l, score) {
    const s = $('quizScore');
    const list = LESSONS.filter(lessonMatches);
    const at = list.findIndex(x => x.id === l.id);
    // A lesson opened by direct link may sit outside the current filter; fall
    // back to the full library so there is always a sensible next step.
    const seq = at === -1 ? LESSONS : list;
    const pos = at === -1 ? LESSONS.findIndex(x => x.id === l.id) : at;
    const next = pos > -1 ? seq[pos + 1] : null;
    // Engagement signal for the /learn pages, which are the SEO surface.
    track('lesson_complete', { lesson: l.id, score: score.right, of: l.quiz.length });
    s.innerHTML = `<div class="quiz-result">You scored ${score.right} / ${l.quiz.length}.</div>`
      + (next
        ? `<div class="quiz-next-wrap"><div class="quiz-next-label">Next: ${esc(next.title)}`
          + `<span class="applies applies-${esc(next.applies)}">${esc(APPLIES_LABEL[next.applies] || '')}</span></div>`
          + `<button type="button" class="btn btn-primary" id="quizNext">Move on to the next topic</button></div>`
        : `<div class="quiz-next-wrap"><div class="quiz-next-label">That is the last lesson in this track.</div>`
          + `<button type="button" class="btn btn-ghost" id="quizAll">Back to all lessons</button></div>`);
    s.classList.remove('hidden');
    if ($('quizNext')) $('quizNext').addEventListener('click', () => {
      try { history.pushState({ view: 'learn' }, '', '/learn/' + next.id); } catch (e) {}
      openLesson(next.id);
    });
    if ($('quizAll')) $('quizAll').addEventListener('click', () => {
      try { history.pushState({ view: 'learn' }, '', '/learn'); } catch (e) {}
      renderLearnGrid();
    });
  }

  // ---- Sign in with Google ----
  // The buttons stay hidden until the server confirms it is configured, so a
  // deployment without Google credentials never shows a button that 404s.
  function showGoogleButtons(on) {
    ['gateGoogle', 'gateGoogleOr', 'authGoogle'].forEach(id => {
      const el = $(id); if (el) el.classList.toggle('hidden', !on);
    });
  }
  function goGoogle(fromGate) {
    // Leaving the page for Google, so the agreement has to be recorded first
    // or the reader comes back and is asked again.
    if (fromGate) setAgreed();
    const next = location.pathname + location.search;
    location.href = '/api/auth/google?next=' + encodeURIComponent(next);
  }
  if ($('gateGoogle')) $('gateGoogle').addEventListener('click', () => goGoogle(true));
  if ($('authGoogle')) $('authGoogle').addEventListener('click', () => goGoogle(false));

  // Report what happened on the way back, then tidy the URL.
  (function readGoogleResult() {
    const p = new URLSearchParams(location.search);
    const err = p.get('google_error');
    if (!err && !p.get('google')) return;
    const MSG = {
      cancelled: 'Google sign-in was cancelled.',
      expired: 'That sign-in link expired. Please try again.',
      unverified_email: 'That Google account has no verified email address, so it cannot be used to sign in.',
      no_code: 'Google did not complete the sign-in. Please try again.',
      failed: 'Could not complete Google sign-in. Please try again.',
    };
    if (err) window.setTimeout(() => alert(MSG[err] || MSG.failed), 100);
    p.delete('google'); p.delete('google_error');
    const qs = p.toString();
    try { history.replaceState({}, '', location.pathname + (qs ? '?' + qs : '')); } catch (e) {}
  })();

  // ---- First-visit gate (terms agreement + sign in) ----
  const gateAuthEl = document.querySelector('.gate-auth');
  $('gateAgree').addEventListener('change', () => gateAuthEl.classList.toggle('disabled', !$('gateAgree').checked));
  // The Terms and Privacy links live inside the checkbox label, where a click
  // would otherwise tick the box as a side effect of opening the document.
  document.querySelectorAll('.gate-check a').forEach(a =>
    a.addEventListener('click', (e) => e.stopPropagation()));
  function gateErr(m) { $('gateErr').textContent = m; $('gateErr').classList.remove('hidden'); }
  async function gateGo(mode) {
    if (!$('gateAgree').checked) return gateErr('Please tick the box to agree to the Terms of Service and Privacy Policy.');
    setAgreed();
    const email = $('gateEmail').value.trim(), password = $('gatePass').value;
    if (!email || password.length < 8) return gateErr('Enter your email and a password (8+ characters).');
    try {
      const r = await fetch('/api/auth/' + mode, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Something went wrong.');
      currentUser = j.user; renderAcct();
      track(mode === 'signup' ? 'sign_up' : 'login', { method: 'password' });
      $('watchBtn').classList.remove('hidden');
      loadWatchlist(); hideGate(); releasePending();
    } catch (e) { gateErr(e.message); }
  }
  // Everything the current view wanted was refused while the gate was up, so
  // agreeing has to ask for it again — otherwise the page sits on the empty
  // state it fell back to (a market snapshot showing a dash, say).
  function releasePending() {
    if (pendingSymbol) {
      const sym = pendingSymbol; pendingSymbol = null;
      $('symbol').value = sym; run(sym);
      return;
    }
    routeFromPath(true);
  }
  $('gateSignin').addEventListener('click', () => gateGo('login'));
  $('gateSignup').addEventListener('click', () => gateGo('signup'));


  // Initial view: deep-link → analyze; billing return → pricing; else home.
  const params = new URLSearchParams(location.search);
  const deep = params.get('symbol'), billing = params.get('billing');
  if (billing === 'success') {
    track('purchase', { currency: 'USD' });
    showView('pricing');
    $('pricingLead').textContent = 'Thanks for upgrading. Your Pro plan is activating; this can take a few seconds.';
    let tries = 0;
    const iv = setInterval(async () => {
      await checkAuth(); tries++;
      if ((currentUser && currentUser.plan === 'pro') || tries > 6) {
        clearInterval(iv); renderPricing();
        if (currentUser && currentUser.plan === 'pro') $('pricingLead').textContent = 'You’re on Pro. Thank you for supporting ChartGauge.';
      }
    }, 2500);
  } else if (billing === 'cancel') {
    showView('pricing');
  } else if (deep) { goAnalyze(deep.toUpperCase()); }
  else routeFromPath(true);          // the path decides the opening view
})();
