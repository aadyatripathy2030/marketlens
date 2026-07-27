// Zero-dependency Node server for the stock analysis tool.
//   GET  /api/stock?symbol=AAPL   → prices + indicators + signal + forecast
//   POST /api/analyze {symbol,...} → plain-English AI (or rule-based) summary
//
// Config (all optional — the tool runs in demo mode without any of them):
//   STOCK_API_KEY     Twelve Data API key (twelvedata.com — free tier)
//   ANTHROPIC_API_KEY Claude key for the AI summary (else a rule-based summary)
//   ANTHROPIC_MODEL   defaults to claude-opus-4-8; set a cheaper model if you like
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const I = require('./indicators');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
// Strip ALL whitespace — keys are never spaced, and a stray newline pasted into
// a hosting dashboard otherwise produces "Invalid character in header content".
const STOCK_API_KEY = (process.env.STOCK_API_KEY || '').replace(/\s/g, '');
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').replace(/\s/g, '');
const AI_MODEL = (process.env.ANTHROPIC_MODEL || 'claude-opus-4-8').trim();
// Candle intervals, from 1-minute up to monthly. outputsize = how many bars to
// pull (capped at Twelve Data's 5000 free-tier max); the daily/weekly/monthly
// intervals reach back the stock's whole life. INTERVAL_MS spaces demo bars.
const INTERVALS = ['1min', '5min', '15min', '30min', '1h', '4h', '1day', '1week', '1month'];
const OUTPUTSIZE = { '1min': 780, '5min': 780, '15min': 650, '30min': 650, '1h': 840, '4h': 900, '1day': 5000, '1week': 2000, '1month': 600 };
const INTERVAL_MS = { '1min': 60e3, '5min': 300e3, '15min': 900e3, '30min': 1800e3, '1h': 3600e3, '4h': 14400e3, '1day': 86400e3, '1week': 604800e3, '1month': 2629800e3 };
function stratLabel(strategy, direction) {
  if (strategy === 'longterm') return 'long-term investing';
  return direction === 'short' ? 'day trading (sell side)' : 'day trading (buy side)';
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function readBody(req, maxBytes) {
  const cap = maxBytes || 1e6;
  return new Promise((resolve) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > cap) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function httpsJson(options, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(options, resp => {
      let data = ''; resp.on('data', c => data += c);
      resp.on('end', () => { try { resolve({ status: resp.statusCode, json: JSON.parse(data) }); } catch (e) { reject(new Error('bad JSON from upstream')); } });
    });
    r.on('error', reject);
    r.setTimeout(12000, () => r.destroy(new Error('upstream timeout')));
    if (body) r.write(body);
    r.end();
  });
}

// ---- Market data ----
async function fetchLive(symbol, interval) {
  // Twelve Data: /time_series?symbol=AAPL&interval=1day&outputsize=N&apikey=KEY
  const size = OUTPUTSIZE[interval] || 1300;
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${size}&apikey=${STOCK_API_KEY}`;
  const { json: j } = await httpsJson({ method: 'GET', hostname: 'api.twelvedata.com',
    path: url.replace('https://api.twelvedata.com', '') });
  if (!j || j.status === 'error' || !Array.isArray(j.values)) throw new Error(j && j.message ? j.message : 'No data for that symbol');
  // Twelve Data returns newest-first; reverse to oldest-first.
  const rows = j.values.slice().reverse();
  return {
    name: (j.meta && j.meta.symbol) || symbol,
    currency: (j.meta && j.meta.currency) || 'USD',
    prices: rows.map(v => ({
      date: v.datetime,
      open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close),
      volume: Number(v.volume) || 0,
    })).filter(p => Number.isFinite(p.close)),
  };
}
function buildDemo(symbol, interval) {
  const n = OUTPUTSIZE[interval] || 1300;
  const step = INTERVAL_MS[interval] || 86400000;
  const intraday = step < 86400000;
  const candles = I.demoCandles(symbol, n);
  const prices = [];
  const now = Date.now();
  for (let i = 0; i < candles.length; i++) {
    const iso = new Date(now - (candles.length - 1 - i) * step).toISOString();
    const date = intraday ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10);
    const k = candles[i];
    prices.push({ date, open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v });
  }
  return { name: symbol, currency: 'USD', prices };
}

async function handleStock(req, res, symbol, strategy, direction, interval) {
  symbol = String(symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12);
  if (!symbol) return json(res, 400, { error: 'Enter a ticker symbol.' });
  strategy = I.STRAT[strategy] ? strategy : 'daytrade';
  direction = direction === 'short' ? 'short' : 'long';
  interval = INTERVALS.includes(interval) ? interval : '1day';
  let source = 'demo', note = '', data;
  if (STOCK_API_KEY) {
    try { data = await fetchLive(symbol, interval); source = 'live'; }
    catch (e) { data = buildDemo(symbol, interval); note = 'Live data unavailable (' + e.message + ') — showing demo data.'; }
  } else {
    data = buildDemo(symbol, interval);
    note = 'Demo data — set STOCK_API_KEY (twelvedata.com, free) for real prices.';
  }
  const closes = data.prices.map(p => p.close);
  const a = I.analyze(closes, strategy, direction);
  // Deep-analysis suite (only meaningful on daily-or-longer bars with enough history)
  const candles = data.prices.map(p => ({ open: p.open, high: p.high, low: p.low, close: p.close, volume: p.volume || 0 }));
  const tech = I.techReport(candles);
  const rating = I.overallRating(tech);
  const bands = I.forecastBands(closes);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2] || last;
  json(res, 200, {
    symbol, name: data.name, currency: data.currency, source, note,
    strategy, direction: a.direction, strategyLabel: stratLabel(strategy, a.direction), interval,
    prices: data.prices,
    latest: last, change: last - prev, changePct: prev ? ((last - prev) / prev) * 100 : 0,
    maFast: a.maFast, maSlow: a.maSlow,
    indicators: { maFast: a.maFast.value, maSlow: a.maSlow.value, rsi: a.rsi, rsiPeriod: a.rsiPeriod, trendSlope: a.slope },
    signal: a.signal, verdict: a.verdict, risk: a.risk,
    forecast: a.forecast, horizon: a.horizon,
    tech, rating, bands,
  });
}

// ---- AI (or rule-based) summary ----
// Keyed off the comprehensive rating so it never contradicts the headline badge.
function ruleBasedSummary(p) {
  const sym = p.symbol;
  const r = p.rating || {};
  const t = p.tech || {};
  const sma = t.sma || {};
  const trendUp = sma[50] != null && sma[200] != null ? sma[50] > sma[200] : null;
  const rsi = t.rsi14;
  const lead = `${sym} earns an AI technical score of ${r.score}/100 — a "${r.label}" read, with ${r.confidence}% of the signals in agreement. `;
  const trend = trendUp == null ? '' : trendUp ? 'The long-term trend is up (50-day above the 200-day), ' : 'The long-term trend is down (50-day below the 200-day), ';
  const mom = rsi == null ? '' : rsi >= 70 ? `and momentum is hot — RSI at ${rsi} is overbought, so a pullback wouldn't surprise. `
    : rsi <= 30 ? `and momentum is washed out — RSI at ${rsi} is oversold, which can precede a bounce. `
    : rsi >= 50 ? `and momentum is firm (RSI ${rsi}). ` : `but momentum is soft (RSI ${rsi}). `;
  const volTxt = t.volatility ? `Volatility is ${t.volatility.annual < 25 ? 'low' : t.volatility.annual < 45 ? 'moderate' : 'elevated'} (~${Math.round(t.volatility.annual)}% annualized). ` : '';
  const closer = `It's a mechanical blend of trend, momentum, and volatility — a starting point for your research, not a call to act.`;
  return `${lead}${trend}${mom}${volTxt}${closer}`;
}
// Rule-based bull/bear/conclusion from the computed technicals (no AI needed).
function ruleBasedReport(p) {
  const t = p.tech || {}, r = p.rating || {};
  const bull = [], bear = [];
  const sma = t.sma || {}, macd = t.macd, bb = t.bollinger, trend = t.trend;
  if (sma[20] != null && sma[50] != null) (sma[20] > sma[50] ? bull : bear).push(`Short-term trend is ${sma[20] > sma[50] ? 'up' : 'down'} (20-day ${sma[20] > sma[50] ? 'above' : 'below'} 50-day average).`);
  if (sma[50] != null && sma[200] != null) (sma[50] > sma[200] ? bull : bear).push(`Long-term trend is ${sma[50] > sma[200] ? 'up (golden-cross regime)' : 'down (death-cross regime)'}.`);
  if (macd && macd.hist != null) (macd.hist > 0 ? bull : bear).push(`MACD momentum ${macd.hist > 0 ? 'favors buyers (histogram positive)' : 'favors sellers (histogram negative)'}.`);
  if (t.vwap != null && t.price != null) (t.price > t.vwap ? bull : bear).push(`Price is trading ${t.price > t.vwap ? 'above' : 'below'} VWAP.`);
  if (t.rsi14 != null) { if (t.rsi14 >= 70) bear.push(`RSI is overbought (${t.rsi14}) — pullback risk.`); else if (t.rsi14 <= 30) bull.push(`RSI is oversold (${t.rsi14}) — possible bounce.`); else (t.rsi14 >= 50 ? bull : bear).push(`RSI momentum is ${t.rsi14 >= 50 ? 'firm' : 'soft'} (${t.rsi14}).`); }
  if (trend && trend.strength >= 45) (trend.direction === 'up' ? bull : bear).push(`Price is trending ${trend.direction} cleanly (trend strength ${trend.strength}/100).`);
  if (t.volatility) (t.volatility.annual >= 45 ? bear : bull).push(`Volatility is ${t.volatility.annual >= 45 ? 'elevated' : 'contained'} (~${Math.round(t.volatility.annual)}% annualized).`);
  if (!bull.length) bull.push('No clear bullish signals right now.');
  if (!bear.length) bear.push('No glaring red flags in the technicals right now.');
  const conclusion = `The technical model scores ${p.symbol} ${r.score}/100 — a "${r.label}" read with ${r.confidence}% signal agreement and ${String(r.risk).toLowerCase()} risk. This is a mechanical read of price action, not advice; confirm with your own research.`;
  return { summary: ruleBasedSummary(p), bull: bull.slice(0, 4), bear: bear.slice(0, 4), conclusion };
}

async function callClaudeReport(p) {
  const t = p.tech || {}, r = p.rating || {}, sma = t.sma || {};
  const fmt = (x) => x == null ? 'n/a' : (typeof x === 'number' ? x.toFixed(2) : x);
  const system = 'You are a sharp, balanced equity analyst writing for curious beginners. You will be given a stock and a set of already-computed technical indicators plus a mechanical rating. Respond with ONLY a JSON object (no markdown, no prose outside it) of the form: {"summary": string (3-4 lively plain-English sentences on where the stock stands and what is driving the rating), "bull": [3 short bullet strings — the strongest reasons it could go up], "bear": [3 short bullet strings — the strongest risks], "conclusion": string (2 sentences tying it together)}. Ground every point in the numbers provided; do not invent fundamentals, news, or price targets. Be explicit in the conclusion that this is a mechanical technical read, often wrong, and NOT financial advice.';
  const user = `SYMBOL: ${p.symbol} @ ${fmt(p.latest)} ${p.currency} (${p.changePct.toFixed(2)}% today)\n`
    + `RATING: ${r.label} — score ${r.score}/100, confidence ${r.confidence}%, risk ${r.risk}\n`
    + `RSI14: ${fmt(t.rsi14)} | SMA20 ${fmt(sma[20])} / SMA50 ${fmt(sma[50])} / SMA200 ${fmt(sma[200])}\n`
    + `MACD hist: ${fmt(t.macd && t.macd.hist)} | VWAP: ${fmt(t.vwap)} | Bollinger %B: ${fmt(t.bollinger && t.bollinger.pctB)}\n`
    + `ATR: ${fmt(t.atr)} | Volatility(annual %): ${fmt(t.volatility && t.volatility.annual)} | Trend: ${t.trend ? t.trend.strength + '/100 ' + t.trend.direction : 'n/a'}\n`
    + `Support ${fmt(t.supportResistance && t.supportResistance.support)} / Resistance ${fmt(t.supportResistance && t.supportResistance.resistance)}\nReturn the JSON now.`;
  const body = JSON.stringify({ model: AI_MODEL, max_tokens: 700, system, messages: [{ role: 'user', content: user }] });
  const { json: j } = await httpsJson({ method: 'POST', hostname: 'api.anthropic.com', path: '/v1/messages',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) } }, body);
  const text = j && j.content && j.content[0] && j.content[0].text;
  if (!text) throw new Error(j && j.error ? (j.error.message || 'AI error') : 'No AI response');
  const m = text.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(m ? m[0] : text);
  return {
    summary: String(parsed.summary || ''),
    bull: Array.isArray(parsed.bull) ? parsed.bull.map(String).slice(0, 4) : [],
    bear: Array.isArray(parsed.bear) ? parsed.bear.map(String).slice(0, 4) : [],
    conclusion: String(parsed.conclusion || ''),
  };
}
async function handleAnalyze(req, res) {
  const p = await readBody(req);
  if (!p || !p.symbol) return json(res, 400, { error: 'Missing data.' });
  if (ANTHROPIC_API_KEY) {
    try {
      const rep = await callClaudeReport(p);
      if (!rep.summary) throw new Error('empty AI report');
      return json(res, 200, { ...rep, source: 'ai' });
    } catch (e) { return json(res, 200, { ...ruleBasedReport(p), source: 'rule', note: 'AI unavailable (' + e.message + ') — rule-based report.' }); }
  }
  return json(res, 200, { ...ruleBasedReport(p), source: 'rule', note: 'Set ANTHROPIC_API_KEY for an AI-written report.' });
}

// ---- Uploaded-chart analysis (Claude vision) ----
async function callClaudeVision(base64, mediaType) {
  const system = 'You are a cautious technical-analysis assistant reading a stock chart image. Describe what you see: overall trend, notable support/resistance levels, chart patterns, and what the visible momentum suggests. Then give a single mechanical lean — "Buy", "Sell", or "Hold/Neutral" — based ONLY on the visible price action, and explain why in one sentence. Be explicit that this is a mechanical read of one image, is frequently wrong, and is NOT financial advice. Keep it to 4-6 sentences. If the image is not a stock/price chart, say so instead.';
  const user = 'Analyze this chart and give your read plus a Buy/Sell/Hold lean.';
  const body = JSON.stringify({
    model: AI_MODEL, max_tokens: 500, system,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
      { type: 'text', text: user },
    ] }],
  });
  const { json: j } = await httpsJson({ method: 'POST', hostname: 'api.anthropic.com', path: '/v1/messages',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) } }, body);
  const text = j && j.content && j.content[0] && j.content[0].text;
  if (!text) throw new Error(j && j.error ? (j.error.message || 'AI error') : 'No AI response');
  return text.trim();
}
async function handleAnalyzeImage(req, res) {
  const p = await readBody(req, 8e6); // allow up to ~8MB base64 payloads
  const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  if (!p || !p.image || !allowed.includes(p.mediaType)) {
    return json(res, 400, { error: 'Upload a PNG, JPEG, GIF, or WebP image.' });
  }
  // Base64 payload guard: ~5MB decoded is Anthropic's per-image ceiling.
  if (p.image.length > 7e6) return json(res, 413, { error: 'Image too large — please use one under ~5 MB.' });
  if (!ANTHROPIC_API_KEY) {
    return json(res, 200, { source: 'none',
      summary: 'Image analysis needs Claude vision. Set ANTHROPIC_API_KEY on the server to analyze uploaded charts. (Ticker analysis above works without a key.)' });
  }
  try { return json(res, 200, { summary: await callClaudeVision(p.image, p.mediaType), source: 'ai' }); }
  catch (e) { return json(res, 200, { source: 'error', summary: 'Could not analyze the image (' + e.message + ').' }); }
}

// ---- Accounts + watchlist ----
function parseCookies(req) {
  const out = {}; (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function setSessionCookie(req, res, token, clear) {
  const secure = req.headers['x-forwarded-proto'] === 'https';
  const parts = [`session=${clear ? '' : token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${clear ? 0 : 30 * 86400}`];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
async function currentUser(req) { return db.getSessionUser(parseCookies(req).session); }

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
async function handleSignup(req, res) {
  const b = await readBody(req);
  const email = String(b.email || '').toLowerCase().trim();
  if (!validEmail(email)) return json(res, 400, { error: 'Enter a valid email.' });
  if (String(b.password || '').length < 8) return json(res, 400, { error: 'Password must be at least 8 characters.' });
  try {
    const user = await db.createUser(email, b.password);
    const token = await db.createSession(user.id);
    setSessionCookie(req, res, token);
    return json(res, 200, { user });
  } catch (e) {
    if (e.message === 'EMAIL_TAKEN') return json(res, 409, { error: 'That email already has an account — try logging in.' });
    return json(res, 500, { error: 'Could not create account.' });
  }
}
async function handleLogin(req, res) {
  const b = await readBody(req);
  const user = await db.getUserByEmail(b.email || '');
  if (!user || !db.verifyPw(b.password || '', user.pw)) return json(res, 401, { error: 'Wrong email or password.' });
  const token = await db.createSession(user.id);
  setSessionCookie(req, res, token);
  return json(res, 200, { user: { id: user.id, email: user.email, plan: user.plan } });
}
async function handleLogout(req, res) {
  await db.deleteSession(parseCookies(req).session);
  setSessionCookie(req, res, '', true);
  return json(res, 200, { ok: true });
}
async function handleMe(req, res) { return json(res, 200, { user: await currentUser(req), store: db.storeMode(), dbUrlSet: db.hasUrl(), dbError: db.lastError() }); }

async function handleWatchlist(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Please sign in.' });
  if (req.method === 'GET') return json(res, 200, { symbols: await db.listWatch(user.id) });
  const b = await readBody(req);
  const symbol = String(b.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12);
  if (!symbol) return json(res, 400, { error: 'No symbol.' });
  if (b.action === 'remove') await db.removeWatch(user.id, symbol); else await db.addWatch(user.id, symbol);
  return json(res, 200, { symbols: await db.listWatch(user.id) });
}

// ---- Lightweight quotes (for Markets / Watchlist grids) ----
function demoQuote(sym) {
  const c = I.demoCandles(sym, 3);
  const price = c[c.length - 1].c, prev = c[c.length - 2].c;
  return { symbol: sym, price, change: price - prev, changePct: prev ? ((price - prev) / prev) * 100 : 0 };
}
async function fetchQuotes(symbols) {
  if (!STOCK_API_KEY) return symbols.map(demoQuote);
  try {
    const path = `/quote?symbol=${encodeURIComponent(symbols.join(','))}&apikey=${STOCK_API_KEY}`;
    const { json: j } = await httpsJson({ method: 'GET', hostname: 'api.twelvedata.com', path });
    return symbols.map(s => {
      const q = symbols.length === 1 ? j : (j && j[s]);
      if (!q || q.status === 'error' || q.close == null) return demoQuote(s);
      const price = Number(q.close), prev = Number(q.previous_close);
      const pct = q.percent_change != null ? Number(q.percent_change) : (prev ? ((price - prev) / prev) * 100 : 0);
      return { symbol: s, price, change: price - prev, changePct: pct };
    });
  } catch { return symbols.map(demoQuote); }
}
async function handleQuotes(req, res, raw) {
  const symbols = String(raw || '').toUpperCase().split(',').map(s => s.replace(/[^A-Z0-9.\-]/g, '').slice(0, 12)).filter(Boolean).slice(0, 24);
  if (!symbols.length) return json(res, 400, { error: 'No symbols.' });
  return json(res, 200, { quotes: await fetchQuotes(symbols), source: STOCK_API_KEY ? 'live' : 'demo' });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC, urlPath);
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('403'); }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (url === '/api/stock' && req.method === 'GET') {
      const q = new URLSearchParams(req.url.split('?')[1] || '');
      return await handleStock(req, res, q.get('symbol'), q.get('strategy'), q.get('direction'), q.get('interval'));
    }
    if (url === '/api/analyze' && req.method === 'POST') return await handleAnalyze(req, res);
    if (url === '/api/analyze-image' && req.method === 'POST') return await handleAnalyzeImage(req, res);
    if (url === '/api/auth/signup' && req.method === 'POST') return await handleSignup(req, res);
    if (url === '/api/auth/login' && req.method === 'POST') return await handleLogin(req, res);
    if (url === '/api/auth/logout' && req.method === 'POST') return await handleLogout(req, res);
    if (url === '/api/auth/me' && req.method === 'GET') return await handleMe(req, res);
    if (url === '/api/watchlist') return await handleWatchlist(req, res);
    if (url === '/api/quotes' && req.method === 'GET') return await handleQuotes(req, res, new URLSearchParams(req.url.split('?')[1] || '').get('symbols'));
    serveStatic(req, res);
  } catch (e) { console.error('server error:', e); json(res, 500, { error: 'Internal error' }); }
});

db.init().then((storeMode) => {
  server.listen(PORT, () => console.log(`MarketLens running at http://localhost:${PORT}  (data: ${STOCK_API_KEY ? 'live' : 'demo'}, AI: ${ANTHROPIC_API_KEY ? 'on' : 'rule-based'}, accounts: ${storeMode})`));
});
