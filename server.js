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
const FMP_API_KEY = (process.env.FMP_API_KEY || '').replace(/\s/g, ''); // Financial Modeling Prep — fundamentals
const FINNHUB_API_KEY = (process.env.FINNHUB_API_KEY || '').replace(/\s/g, ''); // Finnhub — company news
const GA_ID = (process.env.GA_MEASUREMENT_ID || 'G-4GG1NXEE2E').trim();         // Google Analytics 4 (public Measurement ID; env can override)
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'atriuminstitutereal@gmail.com').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const isAdmin = (u) => !!(u && ADMIN_EMAILS.includes(String(u.email || '').toLowerCase()));
const usage = { total: 0 };            // per-endpoint request counters (reset on restart)
const errorLog = [];                   // recent server errors (ring buffer)
function logError(e) { errorLog.push({ t: Date.now(), msg: String((e && e.message) || e).slice(0, 200) }); if (errorLog.length > 60) errorLog.shift(); }
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
async function fetchLive(symbol, interval, sizeOverride) {
  // Twelve Data: /time_series?symbol=AAPL&interval=1day&outputsize=N&apikey=KEY
  const size = sizeOverride || OUTPUTSIZE[interval] || 1300;
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
async function handleMe(req, res) {
  const u = await currentUser(req);
  return json(res, 200, { user: u ? { ...u, admin: isAdmin(u) } : null, store: db.storeMode() });
}
async function handleAdmin(req, res) {
  const u = await currentUser(req);
  if (!isAdmin(u)) return json(res, 403, { error: 'Admin access only.' });
  const users = await db.listUsers(200);
  return json(res, 200, {
    counts: await db.counts(),
    users,
    usage,
    errors: errorLog.slice(-25).reverse(),
    store: db.storeMode(),
    services: { prices: !!STOCK_API_KEY, ai: !!ANTHROPIC_API_KEY, fundamentals: !!FMP_API_KEY, news: !!FINNHUB_API_KEY, analytics: !!GA_ID },
  });
}

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

// ---- AI Analyst chat (grounded with live quotes for mentioned tickers) ----
const KNOWN_TICKERS = new Set(('AAPL MSFT GOOGL GOOG AMZN NVDA META TSLA BRK.B JPM V MA UNH HD PG JNJ XOM CVX KO PEP BAC WMT DIS NFLX ADBE CRM ORCL INTC AMD QCOM CSCO IBM TXN AVGO MU PYPL SHOP UBER ABNB COIN PLTR SNOW BABA NKE SBUX MCD T VZ TMUS F GM BA CAT GE MMM HON UPS FDX LMT RTX GS MS WFC C AXP BLK NOW INTU AMAT LRCX ASML ARM MRVL SMCI DELL DDOG NET CRWD PANW ABT PFE MRK LLY TMO BMY AMGN GILD CVS COST TGT LOW CMCSA SPY QQQ DIA IWM VTI VOO').split(' '));
const NAME_TO_TICKER = { apple: 'AAPL', tesla: 'TSLA', nvidia: 'NVDA', microsoft: 'MSFT', amazon: 'AMZN', google: 'GOOGL', alphabet: 'GOOGL', meta: 'META', facebook: 'META', netflix: 'NFLX', 'coca cola': 'KO', disney: 'DIS', walmart: 'WMT', nike: 'NKE', starbucks: 'SBUX', boeing: 'BA', coinbase: 'COIN', palantir: 'PLTR', broadcom: 'AVGO', servicenow: 'NOW' };
// Common all-caps words that are also tickers but rarely meant as such.
const TICKER_STOP = new Set('AI US USA CEO IPO ETF SEC EPS RSI PE EV OK TV NOW ALL ON OR SO BY GO AT IS IT AM PM AN AS BE DO IF IN NO OF TO UP WE ALL A I'.split(' '));
function extractTickers(text) {
  const found = new Set();
  const t = String(text || '');
  // Only tokens already UPPERCASE in the source (that's how tickers are written).
  (t.match(/\b[A-Z]{1,5}(?:\.[A-Z])?\b/g) || []).forEach(w => { if (KNOWN_TICKERS.has(w) && !TICKER_STOP.has(w)) found.add(w); });
  const low = t.toLowerCase();
  for (const [name, sym] of Object.entries(NAME_TO_TICKER)) if (low.includes(name)) found.add(sym);
  return [...found].slice(0, 4);
}
async function handleChat(req, res) {
  const b = await readBody(req, 2e6);
  const msgs = (Array.isArray(b.messages) ? b.messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-12).map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!msgs.length) return json(res, 400, { error: 'No message.' });
  if (!ANTHROPIC_API_KEY) return json(res, 200, { reply: 'The AI Analyst needs a Claude key (ANTHROPIC_API_KEY) configured on the server. The stock analysis features work without it.', source: 'none' });

  const lastUser = [...msgs].reverse().find(m => m.role === 'user');
  const tickers = extractTickers(lastUser && lastUser.content);
  let liveCtx = b.context ? String(b.context).slice(0, 600) : '';
  if (tickers.length) {
    try {
      const qs = await fetchQuotes(tickers);
      liveCtx += ' Live quotes — ' + qs.map(q => `${q.symbol} $${(+q.price).toFixed(2)} (${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%)`).join(', ') + '.';
    } catch {}
  }
  const system = 'You are the MarketLens AI Analyst — a sharp, friendly finance assistant for beginners and enthusiasts. Discuss stocks, markets, and investing concepts in clear plain English; explain what indicators or ratings suggest, compare companies, and lay out balanced bull/bear cases. Use any LIVE DATA provided. ALWAYS stay balanced, note uncertainty, and be explicit that this is educational information, NOT personalized financial advice — never tell the user what they personally should do with their money, and never promise returns. Keep replies concise: a short paragraph or a few tight bullets.'
    + (liveCtx ? ('\n\nLIVE DATA (as of now): ' + liveCtx) : '');
  const body = JSON.stringify({ model: AI_MODEL, max_tokens: 800, system, messages: msgs });
  try {
    const { json: j } = await httpsJson({ method: 'POST', hostname: 'api.anthropic.com', path: '/v1/messages',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) } }, body);
    const text = j && j.content && j.content[0] && j.content[0].text;
    if (!text) throw new Error(j && j.error ? (j.error.message || 'AI error') : 'No AI response');
    return json(res, 200, { reply: text.trim(), source: 'ai', grounded: tickers });
  } catch (e) { return json(res, 200, { reply: 'Sorry — I hit an error reaching the AI (' + e.message + '). Please try again.', source: 'error' }); }
}

// ---- Fundamentals + news (Financial Modeling Prep) ----
async function fetchFMP(pathNoKey) {
  const path = pathNoKey + (pathNoKey.includes('?') ? '&' : '?') + 'apikey=' + FMP_API_KEY;
  const { json: j } = await httpsJson({ method: 'GET', hostname: 'financialmodelingprep.com', path });
  return j;
}
const fmpSafe = (p) => fetchFMP(p).catch(() => null);
const arr0 = (x) => Array.isArray(x) ? x[0] : null;

// Finnhub company news (free tier), last ~14 days.
async function fetchFinnhubNews(symbol) {
  if (!FINNHUB_API_KEY) return null;
  const to = new Date(), from = new Date(to.getTime() - 14 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const path = `/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${fmt(from)}&to=${fmt(to)}&token=${FINNHUB_API_KEY}`;
  const { json: j } = await httpsJson({ method: 'GET', hostname: 'finnhub.io', path });
  if (!Array.isArray(j)) return [];
  return j.slice(0, 10).map(n => ({ title: n.headline, site: n.source, url: n.url, date: n.datetime ? new Date(n.datetime * 1000).toISOString().slice(0, 10) : '' })).filter(n => n.title && n.url);
}
const fmtMoney = (n) => { n = Number(n); if (!Number.isFinite(n) || n === 0) return '—'; const a = Math.abs(n); const s = n < 0 ? '-' : ''; if (a >= 1e12) return s + '$' + (a / 1e12).toFixed(2) + 'T'; if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(2) + 'M'; return s + '$' + a.toFixed(0); };
const fmtPct = (n) => Number.isFinite(Number(n)) ? (Number(n) * 100).toFixed(1) + '%' : '—';
const fmtNum = (n) => Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '—';
const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; return undefined; };
function buildMetrics(r, k, inc, p) {
  r = r || {}; k = k || {}; inc = inc || {}; p = p || {};
  return [
    { label: 'Market cap', value: fmtMoney(pick(p, 'marketCap') ?? pick(k, 'marketCap')) },
    { label: 'Revenue (TTM)', value: fmtMoney(pick(inc, 'revenue')) },
    { label: 'Net income', value: fmtMoney(pick(inc, 'netIncome')) },
    { label: 'EPS', value: (pick(inc, 'eps', 'epsDiluted') != null) ? '$' + fmtNum(pick(inc, 'eps', 'epsDiluted')) : '—' },
    { label: 'P/E', value: fmtNum(pick(r, 'priceToEarningsRatioTTM', 'peRatioTTM')) },
    { label: 'PEG', value: fmtNum(pick(r, 'priceToEarningsGrowthRatioTTM', 'pegRatioTTM')) },
    { label: 'P/S', value: fmtNum(pick(r, 'priceToSalesRatioTTM')) },
    { label: 'P/B', value: fmtNum(pick(r, 'priceToBookRatioTTM')) },
    { label: 'Gross margin', value: fmtPct(pick(r, 'grossProfitMarginTTM')) },
    { label: 'Operating margin', value: fmtPct(pick(r, 'operatingProfitMarginTTM')) },
    { label: 'Net margin', value: fmtPct(pick(r, 'netProfitMarginTTM')) },
    { label: 'ROE', value: fmtPct(pick(k, 'returnOnEquityTTM') ?? pick(r, 'returnOnEquityTTM')) },
    { label: 'Debt / Equity', value: fmtNum(pick(r, 'debtToEquityRatioTTM', 'debtEquityRatioTTM')) },
    { label: 'Current ratio', value: fmtNum(pick(r, 'currentRatioTTM')) },
    { label: 'Dividend yield', value: fmtPct(pick(r, 'dividendYieldTTM', 'dividendYielTTM')) },
    { label: 'Beta', value: fmtNum(pick(p, 'beta')) },
  ];
}
async function handleFundamentals(req, res, symbol) {
  symbol = String(symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12);
  if (!symbol) return json(res, 400, { error: 'No symbol.' });
  const enc = encodeURIComponent(symbol);
  if (!FMP_API_KEY && !FINNHUB_API_KEY) return json(res, 200, { available: false, message: 'Set FMP_API_KEY / FINNHUB_API_KEY on the server for fundamentals & news.' });
  if (!FMP_API_KEY) return json(res, 200, { available: false, message: 'Set FMP_API_KEY (financialmodelingprep.com) on the server for fundamentals & news.' });
  const [prof, rat, km, inc, fmpNews, finnhubNews] = await Promise.all([
    fmpSafe(`/stable/profile?symbol=${enc}`),
    fmpSafe(`/stable/ratios-ttm?symbol=${enc}`),
    fmpSafe(`/stable/key-metrics-ttm?symbol=${enc}`),
    fmpSafe(`/stable/income-statement?symbol=${enc}&limit=1`),
    fmpSafe(`/stable/news/stock?symbols=${enc}&limit=8`),
    fetchFinnhubNews(symbol).catch(() => null),
  ]);
  const p = arr0(prof), r = arr0(rat), k = arr0(km), i = arr0(inc);
  let news = (finnhubNews && finnhubNews.length) ? finnhubNews
    : (Array.isArray(fmpNews) ? fmpNews.slice(0, 8).map(n => ({ title: n.title, site: n.site || n.publisher, url: n.url, date: n.publishedDate || n.date })) : []);
  return json(res, 200, {
    available: true,
    profile: p ? { name: p.companyName, sector: p.sector, industry: p.industry, exchange: p.exchange, ceo: p.ceo, description: p.description } : null,
    metrics: buildMetrics(r, k, i, p),
    news,
  });
}

// ---- Compare (side-by-side stocks) ----
function buildCompareMetrics(r, k, inc, p) {
  return {
    'Market cap': fmtMoney(pick(p, 'marketCap') ?? pick(k, 'marketCap')),
    'Revenue (TTM)': fmtMoney(pick(inc, 'revenue')),
    'P/E': fmtNum(pick(r, 'priceToEarningsRatioTTM', 'peRatioTTM')),
    'PEG': fmtNum(pick(r, 'priceToEarningsGrowthRatioTTM')),
    'Net margin': fmtPct(pick(r, 'netProfitMarginTTM')),
    'Gross margin': fmtPct(pick(r, 'grossProfitMarginTTM')),
    'ROE': fmtPct(pick(k, 'returnOnEquityTTM') ?? pick(r, 'returnOnEquityTTM')),
    'Debt / Equity': fmtNum(pick(r, 'debtToEquityRatioTTM', 'debtEquityRatioTTM')),
    'Dividend yield': fmtPct(pick(r, 'dividendYieldTTM', 'dividendYielTTM')),
    'Beta': fmtNum(pick(p, 'beta')),
  };
}
async function handleCompare(req, res, raw) {
  const symbols = String(raw || '').toUpperCase().split(',').map(s => s.replace(/[^A-Z0-9.\-]/g, '').slice(0, 12)).filter(Boolean).filter((s, i, a) => a.indexOf(s) === i).slice(0, 4);
  if (symbols.length < 2) return json(res, 400, { error: 'Add at least two tickers to compare.' });
  const rows = await Promise.all(symbols.map(async (sym) => {
    try {
      const enc = encodeURIComponent(sym);
      const [data, prof, rat, km, inc] = await Promise.all([
        (async () => { if (STOCK_API_KEY) { try { return await fetchLive(sym, '1day', 260); } catch { return buildDemo(sym, '1day'); } } return buildDemo(sym, '1day'); })(),
        FMP_API_KEY ? fmpSafe(`/stable/profile?symbol=${enc}`) : null,
        FMP_API_KEY ? fmpSafe(`/stable/ratios-ttm?symbol=${enc}`) : null,
        FMP_API_KEY ? fmpSafe(`/stable/key-metrics-ttm?symbol=${enc}`) : null,
        FMP_API_KEY ? fmpSafe(`/stable/income-statement?symbol=${enc}&limit=1`) : null,
      ]);
      const prices = data.prices.slice(-260);
      const candles = prices.map(x => ({ open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume || 0 }));
      const closes = candles.map(c => c.close);
      const rating = I.overallRating(I.techReport(candles));
      const last = closes[closes.length - 1], prev = closes[closes.length - 2] || last;
      const p = arr0(prof);
      return { symbol: sym, name: (p && p.companyName) || data.name || sym, price: last, changePct: prev ? ((last - prev) / prev) * 100 : 0, rating: { score: rating.score, label: rating.label, tone: rating.tone, risk: rating.risk, confidence: rating.confidence }, metrics: FMP_API_KEY ? buildCompareMetrics(arr0(rat), arr0(km), arr0(inc), p) : null };
    } catch (e) { return { symbol: sym, error: true }; }
  }));
  return json(res, 200, { compare: rows, hasFundamentals: !!FMP_API_KEY });
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

// ---- Price alerts ----
async function handleAlerts(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Please sign in.' });
  if (req.method === 'GET') {
    const alerts = await db.listAlerts(user.id);
    const syms = [...new Set(alerts.map(a => a.symbol))];
    const quotes = syms.length ? await fetchQuotes(syms) : [];
    const qmap = {}; quotes.forEach(q => { qmap[q.symbol] = q.price; });
    const now = Date.now();
    for (const a of alerts) {
      if (!a.triggered) {
        const price = qmap[a.symbol];
        if (price != null && ((a.direction === 'above' && price >= a.target) || (a.direction === 'below' && price <= a.target))) {
          await db.markTriggered(user.id, a.id, now); a.triggered = now;
        }
      }
    }
    return json(res, 200, { alerts: alerts.map(a => ({ ...a, price: qmap[a.symbol] ?? null })) });
  }
  const b = await readBody(req);
  if (b.action === 'remove') { await db.removeAlert(user.id, String(b.id || '')); return json(res, 200, { ok: true }); }
  const symbol = String(b.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12);
  const direction = b.direction === 'below' ? 'below' : 'above';
  const target = Number(b.target);
  if (!symbol || !Number.isFinite(target) || target <= 0) return json(res, 400, { error: 'Enter a ticker and a target price above 0.' });
  const a = await db.addAlert(user.id, symbol, direction, target);
  return json(res, 200, { alert: a });
}

// ---- Screener over a curated universe (works on the free tier; live prices) ----
// [symbol, name, sector, capBand]. FMP's full-market screener is a paid endpoint,
// so we screen popular US stocks by sector/cap/price with live quotes.
const SCREEN_UNIVERSE = [
  ['AAPL', 'Apple', 'Technology', 'mega'], ['MSFT', 'Microsoft', 'Technology', 'mega'], ['NVDA', 'NVIDIA', 'Technology', 'mega'], ['AVGO', 'Broadcom', 'Technology', 'mega'],
  ['ORCL', 'Oracle', 'Technology', 'large'], ['CRM', 'Salesforce', 'Technology', 'large'], ['AMD', 'Advanced Micro Devices', 'Technology', 'large'], ['ADBE', 'Adobe', 'Technology', 'large'],
  ['CSCO', 'Cisco', 'Technology', 'large'], ['INTC', 'Intel', 'Technology', 'large'], ['QCOM', 'Qualcomm', 'Technology', 'large'], ['TXN', 'Texas Instruments', 'Technology', 'large'],
  ['IBM', 'IBM', 'Technology', 'large'], ['NOW', 'ServiceNow', 'Technology', 'large'], ['PLTR', 'Palantir', 'Technology', 'large'], ['SMCI', 'Super Micro', 'Technology', 'mid'],
  ['GOOGL', 'Alphabet', 'Communication Services', 'mega'], ['META', 'Meta Platforms', 'Communication Services', 'mega'], ['NFLX', 'Netflix', 'Communication Services', 'large'],
  ['DIS', 'Walt Disney', 'Communication Services', 'large'], ['CMCSA', 'Comcast', 'Communication Services', 'large'], ['T', 'AT&T', 'Communication Services', 'large'], ['VZ', 'Verizon', 'Communication Services', 'large'],
  ['AMZN', 'Amazon', 'Consumer Cyclical', 'mega'], ['TSLA', 'Tesla', 'Consumer Cyclical', 'mega'], ['HD', 'Home Depot', 'Consumer Cyclical', 'large'], ['NKE', 'Nike', 'Consumer Cyclical', 'large'],
  ['MCD', "McDonald's", 'Consumer Cyclical', 'large'], ['SBUX', 'Starbucks', 'Consumer Cyclical', 'large'], ['ABNB', 'Airbnb', 'Consumer Cyclical', 'large'], ['F', 'Ford', 'Consumer Cyclical', 'mid'], ['GM', 'General Motors', 'Consumer Cyclical', 'mid'],
  ['WMT', 'Walmart', 'Consumer Defensive', 'mega'], ['COST', 'Costco', 'Consumer Defensive', 'mega'], ['PG', 'Procter & Gamble', 'Consumer Defensive', 'large'], ['KO', 'Coca-Cola', 'Consumer Defensive', 'large'], ['PEP', 'PepsiCo', 'Consumer Defensive', 'large'],
  ['BRK.B', 'Berkshire Hathaway', 'Financial Services', 'mega'], ['JPM', 'JPMorgan Chase', 'Financial Services', 'mega'], ['V', 'Visa', 'Financial Services', 'mega'], ['MA', 'Mastercard', 'Financial Services', 'mega'],
  ['BAC', 'Bank of America', 'Financial Services', 'large'], ['WFC', 'Wells Fargo', 'Financial Services', 'large'], ['GS', 'Goldman Sachs', 'Financial Services', 'large'], ['MS', 'Morgan Stanley', 'Financial Services', 'large'], ['AXP', 'American Express', 'Financial Services', 'large'],
  ['LLY', 'Eli Lilly', 'Healthcare', 'mega'], ['UNH', 'UnitedHealth', 'Healthcare', 'large'], ['JNJ', 'Johnson & Johnson', 'Healthcare', 'large'], ['MRK', 'Merck', 'Healthcare', 'large'], ['PFE', 'Pfizer', 'Healthcare', 'large'], ['ABT', 'Abbott', 'Healthcare', 'large'], ['TMO', 'Thermo Fisher', 'Healthcare', 'large'],
  ['XOM', 'Exxon Mobil', 'Energy', 'mega'], ['CVX', 'Chevron', 'Energy', 'large'], ['COP', 'ConocoPhillips', 'Energy', 'large'],
  ['CAT', 'Caterpillar', 'Industrials', 'large'], ['BA', 'Boeing', 'Industrials', 'large'], ['GE', 'GE Aerospace', 'Industrials', 'large'], ['HON', 'Honeywell', 'Industrials', 'large'], ['UPS', 'United Parcel Service', 'Industrials', 'large'], ['RTX', 'RTX', 'Industrials', 'large'], ['LMT', 'Lockheed Martin', 'Industrials', 'large'],
];
const CAP_RANK = { mega: 4, large: 3, mid: 2, small: 1 };
async function handleScreen(req, res, qs) {
  const q = new URLSearchParams(qs || '');
  const sector = q.get('sector'), cap = q.get('cap');
  const pmin = Number(q.get('priceMin')), pmax = Number(q.get('priceMax'));
  let uni = SCREEN_UNIVERSE.filter(u => (!sector || u[2] === sector) && (!cap || u[3] === cap));
  if (!uni.length) return json(res, 200, { available: true, universe: true, results: [] });
  const quotes = await fetchQuotes(uni.map(u => u[0]));
  const qmap = {}; quotes.forEach(x => { qmap[x.symbol] = x; });
  let results = uni.map(u => { const x = qmap[u[0]] || {}; return { symbol: u[0], name: u[1], sector: u[2], cap: u[3], price: x.price, changePct: x.changePct }; }).filter(r => r.price != null);
  if (pmin > 0) results = results.filter(r => r.price >= pmin);
  if (pmax > 0) results = results.filter(r => r.price <= pmax);
  results.sort((a, b) => (CAP_RANK[b.cap] - CAP_RANK[a.cap]) || (b.price - a.price));
  return json(res, 200, { available: true, universe: true, results });
}

const GA_SNIPPET = GA_ID ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>`
  + `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}');</script>` : '';
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC, urlPath);
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('403'); }
  // Inject the Google Analytics tag into index.html (Measurement ID from env).
  if (urlPath === '/index.html') {
    return fs.readFile(filePath, 'utf8', (err, html) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html.replace('<!--GA-->', GA_SNIPPET));
    });
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (url.startsWith('/api/')) { usage.total++; usage[url] = (usage[url] || 0) + 1; }
    if (url === '/api/admin' && req.method === 'GET') return await handleAdmin(req, res);
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
    if (url === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
    if (url === '/api/fundamentals' && req.method === 'GET') return await handleFundamentals(req, res, new URLSearchParams(req.url.split('?')[1] || '').get('symbol'));
    if (url === '/api/compare' && req.method === 'GET') return await handleCompare(req, res, new URLSearchParams(req.url.split('?')[1] || '').get('symbols'));
    if (url === '/api/alerts') return await handleAlerts(req, res);
    if (url === '/api/screen' && req.method === 'GET') return await handleScreen(req, res, req.url.split('?')[1] || '');
    serveStatic(req, res);
  } catch (e) { logError(e); console.error('server error:', e); json(res, 500, { error: 'Internal error' }); }
});

db.init().then((storeMode) => {
  server.listen(PORT, () => console.log(`MarketLens running at http://localhost:${PORT}  (data: ${STOCK_API_KEY ? 'live' : 'demo'}, AI: ${ANTHROPIC_API_KEY ? 'on' : 'rule-based'}, fundamentals: ${FMP_API_KEY ? 'on' : 'off'}, news: ${FINNHUB_API_KEY ? 'on' : 'off'}, accounts: ${storeMode})`));
});
