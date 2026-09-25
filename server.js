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
const crypto = require('crypto');
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
// The free allowance runs on a cheaper model. Reading a table of computed
// indicators back in plain English is not a task that needs the big one.
const AI_MODEL_FREE = (process.env.ANTHROPIC_MODEL_FREE || 'claude-haiku-4-5').trim();
const FMP_API_KEY = (process.env.FMP_API_KEY || '').replace(/\s/g, ''); // Financial Modeling Prep — fundamentals
const FINNHUB_API_KEY = (process.env.FINNHUB_API_KEY || '').replace(/\s/g, ''); // Finnhub — company news
const GA_ID = (process.env.GA_MEASUREMENT_ID || 'G-4GG1NXEE2E').trim();         // Google Analytics 4 (public Measurement ID; env can override)
const STRIPE_SECRET_KEY = (process.env.STRIPE_SECRET_KEY || '').replace(/\s/g, '');       // sk_...
const STRIPE_WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET || '').replace(/\s/g, ''); // whsec_...
// Pro price IDs per billing period (weekly / monthly / yearly). STRIPE_PRICE_ID stays as a monthly fallback.
const STRIPE_PRICES = {
  weekly: (process.env.STRIPE_PRICE_WEEKLY || '').replace(/\s/g, ''),
  monthly: (process.env.STRIPE_PRICE_MONTHLY || process.env.STRIPE_PRICE_ID || '').replace(/\s/g, ''),
  yearly: (process.env.STRIPE_PRICE_YEARLY || '').replace(/\s/g, ''),
};
const PLAN_LABELS = { weekly: 'week', monthly: 'month', yearly: 'year' };
const BILLING_ON = !!(STRIPE_SECRET_KEY && (STRIPE_PRICES.weekly || STRIPE_PRICES.monthly || STRIPE_PRICES.yearly));
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'atriuminstitutereal@gmail.com,aadyatripathy3@gmail.com').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const isAdmin = (u) => !!(u && ADMIN_EMAILS.includes(String(u.email || '').toLowerCase()));
// Accounts that get Pro without paying — the operator's own, and anyone else
// listed. Held here rather than written into the users table so it survives a
// database reset and cannot be lost by a Stripe webhook flipping the row back.
const COMP_PRO_EMAILS = (process.env.PRO_EMAILS || 'aadyatripathy3@gmail.com,cjcthegolfer2@icloud.com').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
// One answer to "is this account Pro", used everywhere a plan is checked, so a
// complimentary account cannot be Pro in one place and free in another.
const isPro = (u) => !!(u && (u.plan === 'pro' || isAdmin(u) || COMP_PRO_EMAILS.includes(String(u.email || '').toLowerCase())));

// Launch period: every Pro feature is open to every account until this moment,
// after which the normal split applies with no deploy needed. Set FREE_UNTIL
// to an ISO timestamp to move it, or to a past date to end it early.
// End of 17 October UTC, so 17 October is itself a free day everywhere rather
// than ending at UTC midnight — which is the afternoon of the 16th in the US
// and would cut people off a day before the date they were told.
const FREE_UNTIL = Date.parse(process.env.FREE_UNTIL || '2026-10-18T00:00:00Z');
const inLaunchPeriod = () => Number.isFinite(FREE_UNTIL) && Date.now() < FREE_UNTIL;

// Entitlement and access are deliberately different questions. isPro is what
// the account is actually entitled to and guards checkout — during the launch
// period everyone has access, and if that also counted as being Pro, nobody
// could subscribe. hasPro is what the feature gates ask.
const hasPro = (u) => inLaunchPeriod() || isPro(u);
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
    // req.destroy() on an over-cap body does not reliably emit 'end' or
    // 'error', so settle explicitly and treat 'close' as a terminal event —
    // otherwise an oversized POST leaves this promise pending forever.
    let d = '', done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', c => {
      if (done) return;
      d += c;
      if (d.length > cap) { finish({}); req.destroy(); }
    });
    req.on('end', () => { try { finish(d ? JSON.parse(d) : {}); } catch { finish({}); } });
    req.on('error', () => finish({}));
    req.on('close', () => finish({}));
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

// ---- Upstream response cache ----
// Twelve Data's free tier allows 8 credits per minute and every page view
// spends several, so identical lookups inside a short window are collapsed.
// In-flight requests are shared too: a burst of identical requests becomes
// one upstream call, not one per caller. Failures are never cached.
const dataCache = new Map();   // key -> { at, value }
const inFlight = new Map();    // key -> Promise
function cached(key, ttlMs, producer) {
  const hit = dataCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = Promise.resolve().then(producer)
    .then(v => { dataCache.set(key, { at: Date.now(), value: v }); return v; })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of dataCache) if (now - v.at > 600000) dataCache.delete(k);
}, 120000);
if (sweep.unref) sweep.unref();
// Intraday bars move constantly; daily and above do not.
const barsTtl = (interval) => /min|^1h$|^4h$/.test(String(interval)) ? 30000 : 120000;

// ---- Market data ----
async function fetchLive(symbol, interval, sizeOverride) {
  const size0 = sizeOverride || OUTPUTSIZE[interval] || 1300;
  return cached(`bars:${symbol}:${interval}:${size0}`, barsTtl(interval),
    () => fetchLiveUncached(symbol, interval, sizeOverride));
}
async function fetchLiveUncached(symbol, interval, sizeOverride) {
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
  symbol = String(symbol || '').toUpperCase().replace(/[^A-Z0-9.\-\/]/g, '').slice(0, 16);
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
  const levels = I.tradeLevels(candles, a.direction);
  // What actually happened, historically, at scores like today's. Roughly 50ms
  // on a full series; null when there is not enough history to say anything.
  let edge = null;
  try { edge = I.historicalEdge(candles, rating.score, 20); } catch (e) { logError(e); }
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
    tech, rating, bands, levels, edge,
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
  const lead = `${sym} scores ${r.score}/100 on the technical composite — a "${r.label}" read, with ${r.agreeing} of its ${r.groupCount} indicator groups pointing that way. `;
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
  const edgeLine = p.edge
    ? ` Measured on this symbol\u2019s own history, setups scoring near this were higher ${p.edge.horizon} bars later ${p.edge.winRate}% of the time, against ${p.edge.baseWinRate}% on any given bar.`
    : "";
  const conclusion = `The technical model scores ${p.symbol} ${r.score}/100 — a "${r.label}" read, ${r.agreeing} of ${r.groupCount} indicator groups agreeing, ${String(r.risk).toLowerCase()} risk.`
    + edgeLine
    + " This is a mechanical read of price action, not advice; confirm with your own research.";
  return { summary: ruleBasedSummary(p), bull: bull.slice(0, 4), bear: bear.slice(0, 4), conclusion };
}

function reportPrompt(p) {
  const t = p.tech || {}, r = p.rating || {}, sma = t.sma || {};
  const fmt = (x) => x == null ? 'n/a' : (typeof x === 'number' ? x.toFixed(2) : x);
  const system = 'You are a sharp, balanced equity analyst writing for curious beginners. You will be given a stock and a set of already-computed technical indicators plus a mechanical rating. Respond with ONLY a JSON object (no markdown, no prose outside it) of the form: {"summary": string (3-4 lively plain-English sentences on where the stock stands and what is driving the rating), "bull": [3 short bullet strings — the strongest reasons it could go up], "bear": [3 short bullet strings — the strongest risks], "conclusion": string (2 sentences tying it together)}. Ground every point in the numbers provided; do not invent fundamentals, news, or price targets. Be explicit in the conclusion that this is a mechanical technical read, often wrong, and NOT financial advice.';
  const user = `SYMBOL: ${p.symbol} @ ${fmt(p.latest)} ${p.currency} (${fmt(p.changePct)}% today)\n`
    + `RATING: ${r.label} — score ${r.score}/100, ${r.agreeing}/${r.groupCount} indicator groups agreeing, risk ${r.risk}\n`
    + `RSI14: ${fmt(t.rsi14)} | SMA20 ${fmt(sma[20])} / SMA50 ${fmt(sma[50])} / SMA200 ${fmt(sma[200])}\n`
    + `MACD hist: ${fmt(t.macd && t.macd.hist)} | VWAP: ${fmt(t.vwap)} | Bollinger %B: ${fmt(t.bollinger && t.bollinger.pctB)}\n`
    + `ATR: ${fmt(t.atr)} | Volatility(annual %): ${fmt(t.volatility && t.volatility.annual)} | Trend: ${t.trend ? t.trend.strength + '/100 ' + t.trend.direction : 'n/a'}\n`
    + `Support ${fmt(t.supportResistance && t.supportResistance.support)} / Resistance ${fmt(t.supportResistance && t.supportResistance.resistance)}\n`
    + (p.edge ? `MEASURED BASE RATE: at scores near ${r.score}, this symbol was higher ${p.edge.horizon} bars later ${p.edge.winRate}% of the time across ${p.edge.n} past occurrences; the rate on any bar was ${p.edge.baseWinRate}%. Treat this as the ground truth about whether the setup has predicted anything for this symbol, and say plainly when it has not.\n` : '')
    + `Return the JSON now.`;
  return { system, user };
}

async function callClaudeReport(p, model) {
  const { system, user } = reportPrompt(p);
  const body = JSON.stringify({ model: model || AI_MODEL, max_tokens: 1000, system, messages: [{ role: 'user', content: user }] });
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
// Streams the response body to a callback instead of buffering it.
function httpsStream(options, body, onChunk) {
  return new Promise((resolve, reject) => {
    const r = https.request(options, resp => {
      resp.setEncoding('utf8');
      if (resp.statusCode !== 200) {
        let err = ''; resp.on('data', c => err += c);
        resp.on('end', () => reject(new Error('upstream ' + resp.statusCode)));
        return;
      }
      resp.on('data', onChunk);
      resp.on('end', resolve);
      resp.on('error', reject);
    });
    r.on('error', reject);
    r.setTimeout(60000, () => r.destroy(new Error('upstream timeout')));
    if (body) r.write(body);
    r.end();
  });
}

// Pull the summary field out of a partially-received JSON object. Anything the
// streaming extractor gets slightly wrong (a \uXXXX escape, say) is corrected
// when the final parsed report replaces it, so this only has to be close.
function summaryPrefix(buf) {
  const i = buf.indexOf('"summary"');
  if (i < 0) return null;
  const colon = buf.indexOf(':', i);
  if (colon < 0) return null;
  const q = buf.indexOf('"', colon + 1);
  if (q < 0) return null;
  const MAP = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
  let out = '', esc = false;
  for (let k = q + 1; k < buf.length; k++) {
    const ch = buf[k];
    if (esc) { out += (MAP[ch] || ch); esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') break;
    out += ch;
  }
  return out;
}

// NDJSON: one {"t":"d","v":"…"} per delta, then a final {"t":"done", …report}.
// The client never has to parse half-formed JSON, and a client that cannot
// stream can still use the plain /api/analyze route.
async function handleAnalyzeStream(req, res) {
  const p = await readBody(req);
  if (!p || !p.symbol) return json(res, 400, { error: 'Missing data.' });
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  const send = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch (e) {} };

  if (!ANTHROPIC_API_KEY) {
    send({ t: 'done', ...ruleBasedReport(p), source: 'rule', note: 'Set ANTHROPIC_API_KEY for an AI-written report.' });
    return res.end();
  }
  const { pro, key } = await plan(req);
  let streamModel = AI_MODEL;
  if (!pro) {
    if (await db.peekUsage(key, 'ai') >= AI_FREE_DAILY) {
      send({ t: 'done', ...ruleBasedReport(p), source: 'rule', limited: true, note: aiLimitNote() });
      return res.end();
    }
    streamModel = AI_MODEL_FREE;
  }
  // Counted once the report actually parses; a stream that dies is not charged.
  const chargeStream = async () => { if (!pro) { try { await db.bumpUsage(key, 'ai', AI_FREE_DAILY); } catch (e) {} } };
  const { system, user } = reportPrompt(p);
  const body = JSON.stringify({ model: streamModel, max_tokens: 1000, stream: true, system, messages: [{ role: 'user', content: user }] });
  let full = '', sent = 0, sse = '';
  try {
    await httpsStream({ method: 'POST', hostname: 'api.anthropic.com', path: '/v1/messages',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) } },
      body, (chunk) => {
        sse += chunk;
        let nl;
        while ((nl = sse.indexOf('\n')) >= 0) {
          const line = sse.slice(0, nl).trim(); sse = sse.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type !== 'content_block_delta' || !ev.delta || typeof ev.delta.text !== 'string') continue;
          full += ev.delta.text;
          const sofar = summaryPrefix(full);
          if (sofar != null && sofar.length > sent) { send({ t: 'd', v: sofar.slice(sent) }); sent = sofar.length; }
        }
      });
    const m = full.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : full);
    if (!parsed.summary) throw new Error('empty AI report');
    send({ t: 'done', summary: String(parsed.summary),
      bull: Array.isArray(parsed.bull) ? parsed.bull.map(String).slice(0, 4) : [],
      bear: Array.isArray(parsed.bear) ? parsed.bear.map(String).slice(0, 4) : [],
      conclusion: String(parsed.conclusion || ''), source: 'ai' });
    await chargeStream();
  } catch (e) {
    logError(e);
    const rb = ruleBasedReport(p);
    const partial = summaryPrefix(full);
    // The reader has already watched this text arrive. Replacing it with a
    // different summary is more jarring than keeping it and filling in the
    // structured parts mechanically, so only fall back wholesale if there is
    // nothing substantial to keep.
    if (partial && partial.length > 80) {
      send({ t: 'done', summary: partial, bull: rb.bull, bear: rb.bear, conclusion: rb.conclusion,
        source: 'ai-partial',
        note: 'Claude’s reply was cut short, so the bull and bear points below are the rule-based ones.' });
    } else {
      send({ t: 'done', ...rb, source: 'rule',
        note: 'Claude was unreachable (' + e.message + '); this is the rule-based report.' });
    }
  }
  res.end();
}

// "Claude was unreachable" used to be printed for every failure, including
// TypeErrors thrown while building the prompt — which made a bug in this file
// look like an outage at Anthropic. Log the real error, and only blame the
// network when it actually was the network.
function aiFallbackNote(e, where) {
  console.error(`[ai:${where}]`, e && e.stack ? e.stack : e);
  const bug = e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError;
  return bug
    ? 'The AI report could not be built; this is the rule-based report.'
    : 'Claude was unreachable (' + (e && e.message ? e.message : 'unknown') + '); this is the rule-based report.';
}

async function handleAnalyze(req, res) {
  const p = await readBody(req);
  if (!p || !p.symbol) return json(res, 400, { error: 'Missing data.' });
  if (ANTHROPIC_API_KEY) {
    const { pro, key } = await plan(req);
    let model = AI_MODEL;
    if (!pro) {
      // Checked before the call and counted only after it succeeds, so a
      // failed request does not spend one of the day's reports.
      if (await db.peekUsage(key, 'ai') >= AI_FREE_DAILY) {
        return json(res, 200, { ...ruleBasedReport(p), source: 'rule', limited: true, note: aiLimitNote() });
      }
      model = AI_MODEL_FREE;
    }
    try {
      const rep = await callClaudeReport(p, model);
      if (!rep.summary) throw new Error('empty AI report');
      if (!pro) await db.bumpUsage(key, 'ai', AI_FREE_DAILY);
      return json(res, 200, { ...rep, source: 'ai' });
    } catch (e) { return json(res, 200, { ...ruleBasedReport(p), source: 'rule', note: aiFallbackNote(e, 'analyze') }); }
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
  const { pro } = await plan(req);
  if (!pro) return json(res, 402, PRO_ONLY('Reading a chart image'));
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

// ---- plan gating ----
// Pro covers the features that cost money every time they run: the written
// reports, the chat, reading an uploaded chart, and the screener and compare
// pages (which fan out into dozens of price-API calls). Everything that is
// pure computation on data already fetched — the chart, every indicator, the
// levels, the measured base rate, the lessons — stays free for everyone,
// with or without an account.
const AI_FREE_DAILY = Number(process.env.AI_FREE_DAILY || 3);
const aiLimitNote = () => `That is today's ${AI_FREE_DAILY} written reports. This one is the rule-based read, which is always free and always available — Pro lifts the daily limit.`;
const FREE_WATCH_MAX = Number(process.env.FREE_WATCH_MAX || 10);
const FREE_ALERT_MAX = Number(process.env.FREE_ALERT_MAX || 3);

function clientKey(req, user) {
  if (user) return 'u:' + user.id;
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return 'ip:' + (fwd || (req.socket && req.socket.remoteAddress) || 'unknown');
}

// Resolves the caller once: who they are, whether they are Pro, and the key
// their free allowance is counted against.
async function plan(req) {
  let user = null;
  try { user = await currentUser(req); } catch (e) { user = null; }
  return { user, pro: hasPro(user), key: clientKey(req, user) };
}

// Market data needs an account. Enforced here rather than only in the browser,
// because a gate that lives in the client is a suggestion — the endpoints were
// answering anyone who asked. Returns true when the request should stop.
async function requireAccount(req, res) {
  const user = await currentUser(req).catch(() => null);
  if (user) return false;
  json(res, 401, { error: 'auth_required',
    message: 'Sign in to load market data. An account is free.' });
  return true;
}

const PRO_ONLY = (what) => ({ error: 'pro_required', feature: what,
  message: `${what} is part of Pro. Everything else on ChartGauge — the chart, the indicators, the levels and the measured base rate — stays free.` });

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
  return json(res, 200, { user: { id: user.id, email: user.email, plan: isPro(user) ? 'pro' : user.plan } });
}
async function handleLogout(req, res) {
  await db.deleteSession(parseCookies(req).session);
  setSessionCookie(req, res, '', true);
  return json(res, 200, { ok: true });
}
async function handleMe(req, res) {
  const u = await currentUser(req);
  // Limits follow access (so the launch period shows as unlimited); the plan
  // badge follows entitlement, so nobody is told they are on Pro when the
  // promotion is the only reason everything is open.
  const access = hasPro(u);
  let aiUsed = 0;
  if (!access && ANTHROPIC_API_KEY) { try { aiUsed = await db.peekUsage(clientKey(req, u), 'ai'); } catch (e) {} }
  return json(res, 200, {
    user: u ? { ...u, plan: isPro(u) ? 'pro' : u.plan, admin: isAdmin(u) } : null,
    store: db.storeMode(),
    billing: await billingInfo(),
    // lastFree is the final free day itself, which is the date to show; `until`
    // is the instant access changes.
    launch: { free: inLaunchPeriod(),
      until: Number.isFinite(FREE_UNTIL) ? FREE_UNTIL : null,
      lastFree: Number.isFinite(FREE_UNTIL) ? FREE_UNTIL - 1 : null },
    // So the interface can show what is available without probing endpoints.
    limits: { pro: access, aiPerDay: access ? null : AI_FREE_DAILY, aiUsed,
      watchMax: access ? null : FREE_WATCH_MAX, alertMax: access ? null : FREE_ALERT_MAX,
      takeProfits: access ? 3 : 1 },
  });
}
async function handleAdmin(req, res) {
  const u = await currentUser(req);
  if (!isAdmin(u)) return json(res, 403, { error: 'Admin access only.' });
  // plan stays the database truth — what this account is actually paying for —
  // with complimentary Pro flagged separately, so comped accounts are never
  // counted as customers when reading this table.
  const users = (await db.listUsers(200)).map(x => ({
    ...x, comp: isPro(x) && x.plan !== 'pro', admin: isAdmin(x),
  }));
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
  const symbol = String(b.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-\/]/g, '').slice(0, 16);
  if (!symbol) return json(res, 400, { error: 'No symbol.' });
  if (b.action === 'remove') { await db.removeWatch(user.id, symbol); }
  else {
    // Checked only when adding: someone who subscribed, built a long list and
    // then cancelled keeps what they saved, they just cannot add more.
    const cur = await db.listWatch(user.id);
    if (!hasPro(user) && !cur.includes(symbol) && cur.length >= FREE_WATCH_MAX) {
      return json(res, 402, { error: 'pro_required', feature: 'watchlist',
        message: `A free watchlist holds ${FREE_WATCH_MAX} symbols. Pro removes the limit.`, symbols: cur });
    }
    await db.addWatch(user.id, symbol);
  }
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
  const { pro } = await plan(req);
  if (!pro) return json(res, 402, PRO_ONLY('Ask Claude'));
  const b = await readBody(req, 2e6);
  const msgs = (Array.isArray(b.messages) ? b.messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-12).map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!msgs.length) return json(res, 400, { error: 'No message.' });
  if (!ANTHROPIC_API_KEY) return json(res, 200, { reply: 'Chat needs a Claude key (ANTHROPIC_API_KEY) set on the server. Everything else works without one.', source: 'none' });

  const lastUser = [...msgs].reverse().find(m => m.role === 'user');
  const tickers = extractTickers(lastUser && lastUser.content);
  let liveCtx = b.context ? String(b.context).slice(0, 600) : '';
  if (tickers.length) {
    try {
      const qs = await fetchQuotes(tickers);
      liveCtx += ' Live quotes — ' + qs.map(q => `${q.symbol} $${(+q.price).toFixed(2)} (${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}%)`).join(', ') + '.';
    } catch {}
  }
  const system = 'You are the analyst chat inside ChartGauge, a stock-charting tool — a friendly finance assistant for beginners and enthusiasts. Discuss stocks, markets, and investing concepts in clear plain English; explain what indicators or ratings suggest, compare companies, and lay out balanced bull/bear cases. Use any LIVE DATA provided. ALWAYS stay balanced, note uncertainty, and be explicit that this is educational information, NOT personalized financial advice — never tell the user what they personally should do with their money, and never promise returns. Keep replies concise: a short paragraph or a few tight bullets.'
    + (liveCtx ? ('\n\nLIVE DATA (as of now): ' + liveCtx) : '');
  const body = JSON.stringify({ model: AI_MODEL, max_tokens: 800, system, messages: msgs });
  try {
    const { json: j } = await httpsJson({ method: 'POST', hostname: 'api.anthropic.com', path: '/v1/messages',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) } }, body);
    const text = j && j.content && j.content[0] && j.content[0].text;
    if (!text) throw new Error(j && j.error ? (j.error.message || 'AI error') : 'No AI response');
    return json(res, 200, { reply: text.trim(), source: 'ai', grounded: tickers });
  } catch (e) { return json(res, 200, { reply: 'I hit an error reaching Claude (' + e.message + '). Try again.', source: 'error' }); }
}

// ---- Fundamentals + news (Financial Modeling Prep) ----
function fetchFMP(pathNoKey) {
  // Fundamentals change daily at most; news a little faster.
  return cached('fmp:' + pathNoKey, 300000, async () => {
    const path = pathNoKey + (pathNoKey.includes('?') ? '&' : '?') + 'apikey=' + FMP_API_KEY;
    const { json: j } = await httpsJson({ method: 'GET', hostname: 'financialmodelingprep.com', path });
    return j;
  });
}
const fmpSafe = (p) => fetchFMP(p).catch(() => null);
const arr0 = (x) => Array.isArray(x) ? x[0] : null;

// Finnhub company news (free tier), last ~14 days.
function fetchFinnhubNews(symbol) {
  if (!FINNHUB_API_KEY) return Promise.resolve(null);
  return cached('news:' + symbol, 300000, () => fetchFinnhubNewsUncached(symbol));
}
async function fetchFinnhubNewsUncached(symbol) {
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
  symbol = String(symbol || '').toUpperCase().replace(/[^A-Z0-9.\-\/]/g, '').slice(0, 16);
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
  const { pro } = await plan(req);
  if (!pro) return json(res, 402, PRO_ONLY('Side-by-side compare'));
  const symbols = String(raw || '').toUpperCase().split(',').map(s => s.replace(/[^A-Z0-9.\-\/]/g, '').slice(0, 16)).filter(Boolean).filter((s, i, a) => a.indexOf(s) === i).slice(0, 4);
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
  const c = I.demoCandles(sym, OUTPUTSIZE['1day']);
  const price = c[c.length - 1].c, prev = c[c.length - 2].c;
  // Marked, so a generated price can never be reported as a real one.
  return { symbol: sym, price, change: price - prev, changePct: prev ? ((price - prev) / prev) * 100 : 0, demo: true };
}
function fetchQuotes(symbols) {
  if (!STOCK_API_KEY) return Promise.resolve(symbols.map(demoQuote));
  // Matches the client's live-quote poll, so polling costs one upstream call
  // per symbol set per interval no matter how many tabs are open.
  return cached(`quotes:${symbols.join(',')}`, 10000, () => fetchQuotesUncached(symbols));
}
async function fetchQuotesUncached(symbols) {
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
// ---- Movers scan ----
// Describes what is happening right now; it does not predict what happens next.
// Every field below is an observation — the size of the move, how unusual the
// volume is, where price sits in the day's range. The ranking is by how
// unusual the activity is, which is a statement about the present tense only.
//
// One batched /quote call covers the whole universe, cached for 20s, so the
// scan costs the same whether one person opens it or a thousand do.
// Twelve Data bills a batch by symbol count and caps how many a single request
// may carry on smaller plans; 24 came back empty in production, 12 matches what
// the Markets page already asks for successfully.
const MOVERS_UNIVERSE = ['AAPL','MSFT','NVDA','AMZN','META','TSLA','AMD','NFLX','COIN','PLTR','SMCI','MU'];

async function fetchScanUncached(symbols) {
  const path = `/quote?symbol=${encodeURIComponent(symbols.join(','))}&apikey=${STOCK_API_KEY}`;
  const { json: j } = await httpsJson({ method: 'GET', hostname: 'api.twelvedata.com', path });
  // The endpoint answers a single symbol with a bare object, several with one
  // keyed by symbol, and a rejected request with {code, message} — which keyed
  // lookup turns into undefined for every symbol and so into a silent empty
  // result. Fail loudly instead.
  if (j && j.code && j.status !== 'ok' && !j.close) {
    throw new Error(`quote batch rejected: ${j.code} ${j.message || ''}`.trim());
  }
  const pick = (s) => {
    if (symbols.length === 1) return j;
    if (j && j[s]) return j[s];
    if (Array.isArray(j)) return j.find(x => x && x.symbol === s);
    return null;
  };
  return symbols.map(s => {
    const q = pick(s);
    if (!q || q.status === 'error' || q.close == null) return null;
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    return {
      symbol: s,
      price: num(q.close), open: num(q.open), high: num(q.high), low: num(q.low),
      prevClose: num(q.previous_close),
      changePct: num(q.percent_change),
      volume: num(q.volume), avgVolume: num(q.average_volume),
      marketOpen: q.is_market_open === true || q.is_market_open === 'true',
    };
  }).filter(Boolean);
}

function scanRows(raw) {
  return raw.map(q => {
    // Relative volume: today's volume against this symbol's own normal. The
    // single most informative "is anything actually happening" number, and it
    // is a fact rather than a forecast.
    const relVol = (q.avgVolume && q.volume != null) ? q.volume / q.avgVolume : null;
    const span = (q.high != null && q.low != null) ? q.high - q.low : null;
    // Where in today's range price sits: 1 = at the high, 0 = at the low.
    const rangePos = (span && span > 0) ? (q.price - q.low) / span : null;
    // Today's range as a share of price — how much it is actually moving.
    const rangePct = (span != null && q.price) ? (span / q.price) * 100 : null;
    const absMove = q.changePct == null ? 0 : Math.abs(q.changePct);
    // Activity, not opportunity. Unusual volume counts most, then the size of
    // the move, then how wide the day has been.
    const activity = (relVol ? Math.min(relVol, 5) * 20 : 0)
      + Math.min(absMove, 10) * 4
      + (rangePct ? Math.min(rangePct, 8) * 2.5 : 0);
    return { ...q, relVol, rangePos, rangePct, activity: Math.round(activity) };
  }).sort((a, b) => b.activity - a.activity);
}

async function handleMovers(req, res) {
  if (!STOCK_API_KEY) {
    return json(res, 200, { available: false, rows: [], source: 'demo',
      message: 'Live scanning needs a market-data key. Set STOCK_API_KEY to enable it.' });
  }
  try {
    const raw = await cached('movers:' + MOVERS_UNIVERSE.join(','), 20000,
      () => fetchScanUncached(MOVERS_UNIVERSE));
    const rows = scanRows(raw).slice(0, 12);
    // An empty parse is a failure, not an empty market. Saying "available" with
    // no rows renders as "nothing to show", which reads like a quiet session
    // rather than a broken scan.
    if (!rows.length) {
      return json(res, 200, { available: false, rows: [], source: 'live',
        message: 'The market-data provider returned nothing for the scan just now. Try again shortly.' });
    }
    return json(res, 200, {
      available: true, rows, source: 'live',
      marketOpen: rows.some(r => r.marketOpen),
      asOf: Date.now(),
    });
  } catch (e) {
    logError(e);
    return json(res, 200, { available: false, rows: [], source: 'live',
      message: 'Could not reach the market-data provider just now.' });
  }
}

async function handleQuotes(req, res, raw) {
  const symbols = String(raw || '').toUpperCase().split(',').map(s => s.replace(/[^A-Z0-9.\-\/]/g, '').slice(0, 16)).filter(Boolean).slice(0, 24);
  if (!symbols.length) return json(res, 400, { error: 'No symbols.' });
  // Source described whether a key was configured, not whether the prices came
  // back — so when the provider failed and every quote fell back to generated
  // data, the Markets page labelled invented numbers "live".
  const quotes = await fetchQuotes(symbols);
  const anyDemo = quotes.some(q => q && q.demo);
  return json(res, 200, { quotes, source: anyDemo ? 'demo' : 'live' });
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
  const symbol = String(b.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-\/]/g, '').slice(0, 16);
  const direction = b.direction === 'below' ? 'below' : 'above';
  const target = Number(b.target);
  if (!symbol || !Number.isFinite(target) || target <= 0) return json(res, 400, { error: 'Enter a ticker and a target price above 0.' });
  if (!hasPro(user)) {
    const cur = await db.listAlerts(user.id);
    if (cur.filter(x => !x.triggered).length >= FREE_ALERT_MAX) {
      return json(res, 402, { error: 'pro_required', feature: 'alerts',
        message: `A free account runs ${FREE_ALERT_MAX} price alerts at a time. Delete one, or go Pro for unlimited.` });
    }
  }
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
  const { pro } = await plan(req);
  if (!pro) return json(res, 402, PRO_ONLY('The screener'));
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

// ---- Stripe billing (raw API + manual webhook verification, no SDK) ----
// Read side of the Stripe API, so the Plans page can show real amounts
// instead of "billed via Stripe". Cached: prices change rarely and this runs
// on every session check.
function stripeGet(apiPath) {
  return new Promise((resolve, reject) => {
    const r = https.request({ method: 'GET', hostname: 'api.stripe.com', path: '/v1/' + apiPath,
      headers: { 'Authorization': 'Bearer ' + STRIPE_SECRET_KEY } }, resp => {
      let d = ''; resp.on('data', c => d += c);
      resp.on('end', () => { try { const j = JSON.parse(d); if (resp.statusCode >= 400) reject(new Error(j.error ? j.error.message : 'Stripe error')); else resolve(j); } catch (e) { reject(new Error('bad Stripe response')); } });
    });
    r.on('error', reject);
    r.setTimeout(8000, () => r.destroy(new Error('stripe timeout')));
    r.end();
  });
}

// {weekly,monthly,yearly} -> amount, currency and interval, or just a boolean
// when the price cannot be read (no key, or Stripe unreachable).
async function billingInfo() {
  const out = {};
  for (const [period, id] of Object.entries(STRIPE_PRICES)) {
    if (!id) { out[period] = false; continue; }
    if (!STRIPE_SECRET_KEY) { out[period] = true; continue; }
    try {
      const p = await cached('price:' + id, 600000, () => stripeGet('prices/' + encodeURIComponent(id)));
      out[period] = (p && p.unit_amount != null)
        ? { amount: p.unit_amount, currency: p.currency,
            interval: p.recurring ? p.recurring.interval : period,
            intervalCount: p.recurring ? (p.recurring.interval_count || 1) : 1 }
        : true;
    } catch (e) { out[period] = true; }   // still purchasable, just unpriced here
  }
  return out;
}

function stripePost(apiPath, form) {
  const body = Object.entries(form).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  return new Promise((resolve, reject) => {
    const r = https.request({ method: 'POST', hostname: 'api.stripe.com', path: '/v1/' + apiPath,
      headers: { 'Authorization': 'Bearer ' + STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, resp => {
      let d = ''; resp.on('data', c => d += c);
      resp.on('end', () => { try { const j = JSON.parse(d); if (resp.statusCode >= 400) reject(new Error(j.error ? j.error.message : 'Stripe error')); else resolve(j); } catch (e) { reject(new Error('bad Stripe response')); } });
    });
    r.on('error', reject); r.write(body); r.end();
  });
}
function readRawBody(req, cap) { cap = cap || 1e6; return new Promise(resolve => { let d = ''; req.on('data', c => { d += c; if (d.length > cap) req.destroy(); }); req.on('end', () => resolve(d)); req.on('error', () => resolve('')); }); }
function verifyStripeSig(raw, header, secret) {
  if (!header) return false;
  const parts = {}; header.split(',').forEach(p => { const i = p.indexOf('='); parts[p.slice(0, i)] = p.slice(i + 1); });
  if (!parts.t || !parts.v1) return false;
  const expected = crypto.createHmac('sha256', secret).update(parts.t + '.' + raw).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1)); } catch { return false; }
}
const baseUrl = (req) => (req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host;

async function handleCheckout(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Please sign in first.' });
  if (!BILLING_ON) return json(res, 200, { error: 'Billing isn’t configured yet.' });
  if (isPro(user)) return json(res, 200, { error: 'You’re already on Pro.' });
  const b = await readBody(req);
  const plan = ['weekly', 'monthly', 'yearly'].includes(b.plan) ? b.plan : 'monthly';
  const price = STRIPE_PRICES[plan] || STRIPE_PRICES.monthly || STRIPE_PRICES.weekly || STRIPE_PRICES.yearly;
  if (!price) return json(res, 200, { error: 'That plan isn’t available.' });
  try {
    const s = await stripePost('checkout/sessions', {
      mode: 'subscription',
      'line_items[0][price]': price,
      'line_items[0][quantity]': '1',
      success_url: baseUrl(req) + '/?billing=success',
      cancel_url: baseUrl(req) + '/?billing=cancel',
      client_reference_id: user.id,
      customer_email: user.email,
      allow_promotion_codes: 'true',
    });
    return json(res, 200, { url: s.url });
  } catch (e) { return json(res, 200, { error: 'Could not start checkout (' + e.message + ').' }); }
}
async function handlePortal(req, res) {
  const user = await currentUser(req);
  if (!user) return json(res, 401, { error: 'Please sign in first.' });
  const full = await db.getUserById(user.id);
  const customer = full && full.stripe_customer;
  if (!STRIPE_SECRET_KEY || !customer) return json(res, 200, { error: 'No subscription to manage yet.' });
  try {
    const s = await stripePost('billing_portal/sessions', { customer, return_url: baseUrl(req) + '/' });
    return json(res, 200, { url: s.url });
  } catch (e) { return json(res, 200, { error: 'Could not open the billing portal (' + e.message + ').' }); }
}
async function handleWebhook(req, res) {
  const raw = await readRawBody(req);
  if (STRIPE_WEBHOOK_SECRET && !verifyStripeSig(raw, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)) { res.writeHead(400); return res.end('bad signature'); }
  let event; try { event = JSON.parse(raw); } catch { res.writeHead(400); return res.end('bad json'); }
  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      if (s.client_reference_id) await db.setPro(s.client_reference_id, s.customer, s.subscription);
    } else if (event.type === 'customer.subscription.deleted' ||
      (event.type === 'customer.subscription.updated' && ['canceled', 'unpaid', 'incomplete_expired'].includes(event.data.object.status))) {
      const u = await db.findByStripeSub(event.data.object.id);
      if (u) await db.setFree(u.id);
    }
  } catch (e) { logError(e); }
  res.writeHead(200); res.end('ok');
}

// ---- SEO ----
// Every view used to live at "/", which left exactly one indexable URL and hid
// the lesson prose behind client-side rendering. Each route below is a real URL
// with its own title, description, canonical and structured data, and the
// lessons are rendered into the HTML so they index without JavaScript.
const SITE_NAME = 'ChartGauge';
const LEGAL = require('./legal');
const siteOrigin = (req) => (req.headers['x-forwarded-proto'] || 'http') + '://' + (req.headers.host || 'chartgauge.com');

const VIEW_SEO = {
  '': { view: 'home', title: 'ChartGauge — stock charts, indicators and a plain-English read',
    desc: 'Free stock and crypto charts with SMA, RSI, MACD, Bollinger bands, ATR and VWAP, plus ATR-based stop-loss and take-profit levels and a written read of what the indicators say. Educational, not financial advice.' },
  'analyze': { view: 'analyze', title: 'Analyze a stock or crypto pair — ChartGauge',
    desc: 'Enter a ticker or crypto pair for a candlestick chart, 13 technical indicators, an indicator score, and stop-loss and take-profit levels derived from ATR and recent swing highs and lows.' },
  'markets': { view: 'markets', title: 'Market snapshot — indices and trending stocks — ChartGauge',
    desc: 'Live quotes for the major US indices and the most active stocks, with the percentage move on the day.' },
  'compare': { view: 'compare', title: 'Compare stocks side by side — ChartGauge',
    desc: 'Put two or more tickers next to each other on market cap, revenue, P/E, PEG, margins, ROE, debt to equity, dividend yield and beta.' },
  'screener': { view: 'screener', title: 'Stock screener — filter by sector, market cap and price — ChartGauge',
    desc: 'Filter a curated universe of stocks by sector, market capitalisation and price range to find candidates worth a closer look.' },
  'alerts': { view: 'alerts', title: 'Price alerts — ChartGauge',
    desc: 'Set a target above or below the current price and get flagged when a stock crosses it.' },
  'watchlist': { view: 'watchlist', title: 'Your watchlist — ChartGauge',
    desc: 'Keep the tickers you follow in one place, with live prices and one-click analysis.' },
  'learn': { view: 'learn', title: 'Learn investing — free plain-English lessons — ChartGauge',
    desc: 'Eleven short lessons covering market basics, technical and fundamental analysis, valuation, financial statements, risk management, dividends, growth, value and options — each with a quiz.' },
  'settings': { view: 'settings', title: 'Settings — simple or advanced view — ChartGauge',
    desc: 'Choose how much of the analysis to show: the chart and exit levels only, or every indicator and written summary.' },
  'movers': { view: 'movers', title: 'What is moving right now — ChartGauge',
    desc: 'A live scan of the most active US stocks ranked by unusual volume, the size of the move and where price sits in the day range. A description of what is happening, not a prediction of what happens next.' },
  'pricing': { view: 'pricing', title: 'Plans and billing — ChartGauge',
    desc: 'What a free ChartGauge account includes, what Pro adds, and what each billing period costs per month. Charts, indicators, stop-loss and take-profit levels and the measured base rate are free on any account.' },
  'chat': { view: 'chat', title: 'Ask Claude about a stock or the market — ChartGauge',
    desc: 'Ask questions about a ticker or a market concept and get a plain-English answer grounded in live prices.' },
};

function lessonSeo(id) {
  const l = LESSON_INDEX[id];
  if (!l) return null;
  return {
    view: 'learn', lesson: l,
    title: `${l.title} — ${l.level} investing lesson — ${SITE_NAME}`,
    desc: `${l.intro} A free ${l.minutes}-minute ${String(l.level).toLowerCase()} lesson with a ${l.quiz.length}-question quiz.`,
  };
}

// The lessons file is the client's, loaded here so one copy feeds both.
let LESSONS = [], LESSON_INDEX = {};
try {
  const raw = fs.readFileSync(path.join(PUBLIC, 'lessons.js'), 'utf8');
  const sandbox = { window: {} };
  new Function('window', raw)(sandbox.window);
  LESSONS = Array.isArray(sandbox.window.LESSONS) ? sandbox.window.LESSONS : [];
  LESSONS.forEach(l => { LESSON_INDEX[l.id] = l; });
} catch (e) { logError(e); }

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Route -> page metadata. Unknown paths fall through to the home page rather
// than 404-ing, since the app itself is a single document.
function seoFor(urlPath, req) {
  const origin = siteOrigin(req);
  const clean = urlPath.replace(/^\/+|\/+$/g, '');
  const parts = clean ? clean.split('/') : [];
  if (parts[0] === 'learn' && parts[1]) {
    const s = lessonSeo(decodeURIComponent(parts[1]).toLowerCase());
    if (s) return { ...s, canonical: `${origin}/learn/${parts[1]}` };
  }
  if (parts[0] === 'stock' && parts[1]) {
    // BTC/USD arrives as two segments once the path is decoded; rejoin it.
    const sym = parts.slice(1).join('/').toUpperCase().replace(/[^A-Z0-9.\-\/]/g, '').slice(0, 16);
    if (sym) return {
      view: 'analyze', symbol: sym,
      title: `${sym} chart, indicators and stop-loss levels — ${SITE_NAME}`,
      desc: `${sym} candlestick chart with SMA, RSI, MACD, Bollinger bands, ATR and VWAP, an indicator score, and ATR-based stop-loss and take-profit levels. Educational, not financial advice.`,
      canonical: `${origin}/stock/${sym}`,
    };
  }
  if (LEGAL.PAGES[parts[0]]) {
    const pg = LEGAL.PAGES[parts[0]];
    return { view: 'legal', legal: pg, title: pg.title, desc: pg.desc, canonical: `${origin}/${parts[0]}` };
  }
  const v = VIEW_SEO[parts[0] || ''];
  if (v) return { ...v, canonical: origin + (parts[0] ? '/' + parts[0] : '/') };
  return { ...VIEW_SEO[''], canonical: origin + '/' };
}

function jsonLd(seo, origin) {
  const blocks = [{
    '@context': 'https://schema.org', '@type': 'WebApplication', name: SITE_NAME, url: origin + '/',
    applicationCategory: 'FinanceApplication', operatingSystem: 'Any',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    description: VIEW_SEO[''].desc,
  }];
  if (seo.symbol) {
    blocks.push({
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: origin + '/' },
        { '@type': 'ListItem', position: 2, name: 'Analyze', item: origin + '/analyze' },
        { '@type': 'ListItem', position: 3, name: seo.symbol, item: seo.canonical },
      ],
    });
  }
  if (seo.lesson) {
    const l = seo.lesson;
    blocks.push({
      '@context': 'https://schema.org', '@type': 'LearningResource',
      name: l.title, description: l.intro, url: seo.canonical,
      educationalLevel: l.level, timeRequired: `PT${l.minutes}M`,
      learningResourceType: 'Lesson', isAccessibleForFree: true, inLanguage: 'en',
      teaches: (l.sections || []).map(x => x.h).join(', '),
      provider: { '@type': 'Organization', name: SITE_NAME, url: origin + '/' },
    });
    blocks.push({
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: origin + '/' },
        { '@type': 'ListItem', position: 2, name: 'Learn', item: origin + '/learn' },
        { '@type': 'ListItem', position: 3, name: l.title, item: seo.canonical },
      ],
    });
  }
  return blocks.map(b => `<script type="application/ld+json">${JSON.stringify(b).replace(/</g, '\\u003c')}</script>`).join('');
}

function seoHead(seo, origin) {
  // A raster square: most platforms will not render an SVG social image, and
  // twitter:card=summary crops to a square anyway.
  const img = origin + '/avatar.png';
  return [
    `<link rel="canonical" href="${esc(seo.canonical)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:title" content="${esc(seo.title)}" />`,
    `<meta property="og:description" content="${esc(seo.desc)}" />`,
    `<meta property="og:url" content="${esc(seo.canonical)}" />`,
    `<meta property="og:image" content="${esc(img)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${esc(seo.title)}" />`,
    `<meta name="twitter:description" content="${esc(seo.desc)}" />`,
    `<meta name="twitter:image" content="${esc(img)}" />`,
    `<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1" />`,
    jsonLd(seo, origin),
  ].join('\n');
}

// Lesson prose, rendered into the document so it indexes without JavaScript and
// is present regardless of what the client-side app does with it afterwards.
function lessonHtml(l) {
  if (!l) return '';
  const secs = (l.sections || []).map(x => `<section><h2>${esc(x.h)}</h2><p>${esc(x.p)}</p></section>`).join('');
  const quiz = (l.quiz || []).map(q => `<li><p>${esc(q.q)}</p><p>${esc(q.why)}</p></li>`).join('');
  return `<article class="ssr-lesson" id="ssrLesson">`
    + `<h1>${esc(l.title)}</h1>`
    + `<p>${esc(l.intro)}</p>`
    + `<p>${esc(l.level)} · ${esc(l.minutes)} minute read · ${(l.quiz || []).length} question quiz</p>`
    + secs
    + (quiz ? `<h2>Check yourself</h2><ol>${quiz}</ol>` : '')
    + `<p><a href="/learn">All lessons</a> · <a href="/">Analyze a stock</a></p>`
    + `</article>`;
}

// Analytics is no longer injected as an inline script. The measurement id is
// published as a meta tag and app.js loads gtag.js only once the visitor has
// accepted — so nothing is set before consent, and the CSP below needs no
// 'unsafe-inline' for scripts.
const GA_SNIPPET = GA_ID ? `<meta name="ga-id" content="${esc(GA_ID)}">` : '';
// Paths the single-page app owns. Anything matching is served the document
// with that route's metadata rather than a 404.
// 'admin' is routable so the operator can open /admin directly, but it is
// absent from VIEW_SEO, so it never reaches the sitemap, and robots.txt
// disallows it. The page itself is guarded server-side regardless.
const APP_PATH = /^\/(analyze|markets|movers|compare|screener|alerts|watchlist|learn|settings|pricing|chat|terms|privacy|refunds|contact|admin)(\/|$)|^\/stock\//;

function serveDocument(req, res, urlPath) {
  const origin = siteOrigin(req);
  const seo = seoFor(urlPath, req);
  fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8', (err, html) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    let out = html
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(seo.title)}</title>`)
      .replace(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${esc(seo.desc)}" />`)
      .replace('<!--SEO-->', seoHead(seo, origin))
      .replace('<!--GA-->', GA_SNIPPET);
    // One <h1> per rendered page: the active view keeps it, the rest step down.
    out = out.replace(/<h1 class="(hero-h|view-h)"/g, '<h2 class="$1"');
    if (seo.lesson || seo.legal) { /* the rendered page supplies its own h1 */ }
    else if (seo.view === 'home') out = out.replace('<h2 class="hero-h"', '<h1 class="hero-h"');
    else {
      const marker = `id="view-${seo.view}">`;
      const at = out.indexOf(marker);
      if (at >= 0) {
        const hAt = out.indexOf('<h2 class="view-h"', at);
        if (hAt >= 0) out = out.slice(0, hAt) + '<h1 class="view-h"' + out.slice(hAt + '<h2 class="view-h"'.length);
      }
    }
    // Lesson prose goes into the document itself so it indexes without JS.
    if (seo.lesson) out = out.replace('<div id="learnHost"></div>', `<div id="learnHost"></div>${lessonHtml(seo.lesson)}`);
    if (seo.legal) out = out.replace('<div id="legalHost"></div>', `<div id="legalHost">${seo.legal.html}</div>`);
    // Pages with no market data ship with the gate already down, so they do
    // not flash a sign-in wall before app.js reaches the same conclusion.
    // Must stay in step with ON_OPEN_PAGE in app.js.
    if (seo.legal || seo.lesson || seo.view === 'learn') {
      out = out.replace('<div class="gate" id="gate">', '<div class="gate hidden" id="gate">');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(out);
  });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  // A path with a file extension is an asset request, never an app route —
  // otherwise /learn/app.js would be answered with the HTML document.
  const looksLikeFile = /\.[a-z0-9]{2,5}$/i.test(urlPath);
  if (urlPath === '/' || (!looksLikeFile && APP_PATH.test(urlPath))) return serveDocument(req, res, urlPath);
  const filePath = path.join(PUBLIC, urlPath);
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('403'); }
  if (urlPath === '/index.html') return serveDocument(req, res, '/');
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    // Filenames are not content-hashed, so a long max-age would pin stale code
    // after a deploy. Revalidate instead: an unchanged asset costs a 304 with
    // an empty body rather than a re-download.
    const tag = `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`;
    if (req.headers['if-none-match'] === tag) { res.writeHead(304, { ETag: tag }); return res.end(); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'ETag': tag,
      'Cache-Control': 'public, max-age=60, must-revalidate',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// Set on every response, before routing. Values are deliberately strict: the
// site loads no third-party code except analytics, so nothing here needs a
// wildcard. frame-ancestors is what stops the billing page being framed.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: https://www.google-analytics.com https://www.googletagmanager.com",
  // Styles stay 'unsafe-inline': the markup carries style attributes, and an
  // injected stylesheet is a far smaller problem than an injected script.
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' https://www.googletagmanager.com https://www.google-analytics.com",
  "connect-src 'self' https://www.google-analytics.com https://analytics.google.com https://www.googletagmanager.com",
  "font-src 'self' data:",
].join('; ');

function securityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Content-Security-Policy', CSP);
  // Only assert HSTS on a request that actually arrived over TLS, so a local
  // http run does not pin the browser to https://localhost.
  if ((req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    securityHeaders(req, res);
    const url = req.url.split('?')[0];
    if (url.startsWith('/api/')) { usage.total++; usage[url] = (usage[url] || 0) + 1; }
    if (url === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\n\nSitemap: ${siteOrigin(req)}/sitemap.xml\n`);
    }
    if (url === '/sitemap.xml') {
      const origin = siteOrigin(req);
      const today = new Date().toISOString().slice(0, 10);
      // A curated list only: publishing a URL per ticker would be thousands of
      // near-identical pages, which is thin content rather than coverage.
      const FEATURED = ['AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AMD','NFLX','JPM','V','WMT','XOM','KO','DIS','BAC','INTC','CRM','ORCL','AVGO','BTC/USD','ETH/USD','SOL/USD','XRP/USD','DOGE/USD'];
      const urls = [
        { loc: origin + '/', pri: '1.0', freq: 'daily' },
        ...Object.keys(VIEW_SEO).filter(Boolean).map(k => ({ loc: `${origin}/${k}`, pri: '0.8', freq: 'weekly' })),
        ...LESSONS.map(l => ({ loc: `${origin}/learn/${l.id}`, pri: '0.7', freq: 'monthly' })),
        ...Object.keys(LEGAL.PAGES).map(k => ({ loc: `${origin}/${k}`, pri: '0.4', freq: 'yearly' })),
        ...FEATURED.map(sym => ({ loc: `${origin}/stock/${sym}`, pri: '0.6', freq: 'daily' })),
      ];
      const body = urls.map(u => `  <url><loc>${esc(u.loc)}</loc><lastmod>${today}</lastmod><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n');
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      return res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`);
    }
    // Everything that returns market data, in one list. Auth, billing, robots
    // and the sitemap are deliberately absent: sign-in has to work before you
    // are signed in, and crawlers must still reach the documents.
    if (/^\/api\/(stock|quotes|fundamentals|analyze|analyze-stream|analyze-image|chat|compare|screen|watchlist|alerts|movers)\b/.test(url)) {
      if (await requireAccount(req, res)) return;
    }
    if (url === '/api/admin' && req.method === 'GET') return await handleAdmin(req, res);
    if (url === '/api/stock' && req.method === 'GET') {
      const q = new URLSearchParams(req.url.split('?')[1] || '');
      return await handleStock(req, res, q.get('symbol'), q.get('strategy'), q.get('direction'), q.get('interval'));
    }
    if (url === '/api/analyze' && req.method === 'POST') return await handleAnalyze(req, res);
    if (url === '/api/analyze-stream' && req.method === 'POST') return await handleAnalyzeStream(req, res);
    if (url === '/api/analyze-image' && req.method === 'POST') return await handleAnalyzeImage(req, res);
    if (url === '/api/auth/signup' && req.method === 'POST') return await handleSignup(req, res);
    if (url === '/api/auth/login' && req.method === 'POST') return await handleLogin(req, res);
    if (url === '/api/auth/logout' && req.method === 'POST') return await handleLogout(req, res);
    if (url === '/api/auth/me' && req.method === 'GET') return await handleMe(req, res);
    if (url === '/api/watchlist') return await handleWatchlist(req, res);
    if (url === '/api/quotes' && req.method === 'GET') return await handleQuotes(req, res, new URLSearchParams(req.url.split('?')[1] || '').get('symbols'));
    if (url === '/api/movers' && req.method === 'GET') return await handleMovers(req, res);
    if (url === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
    if (url === '/api/fundamentals' && req.method === 'GET') return await handleFundamentals(req, res, new URLSearchParams(req.url.split('?')[1] || '').get('symbol'));
    if (url === '/api/compare' && req.method === 'GET') return await handleCompare(req, res, new URLSearchParams(req.url.split('?')[1] || '').get('symbols'));
    if (url === '/api/alerts') return await handleAlerts(req, res);
    if (url === '/api/screen' && req.method === 'GET') return await handleScreen(req, res, req.url.split('?')[1] || '');
    if (url === '/api/billing/webhook' && req.method === 'POST') return await handleWebhook(req, res);
    if (url === '/api/billing/checkout' && req.method === 'POST') return await handleCheckout(req, res);
    if (url === '/api/billing/portal' && req.method === 'POST') return await handlePortal(req, res);
    serveStatic(req, res);
  } catch (e) { logError(e); console.error('server error:', e); json(res, 500, { error: 'Internal error' }); }
});

db.init().then((storeMode) => {
  server.listen(PORT, () => console.log(`ChartGauge running at http://localhost:${PORT}  (data: ${STOCK_API_KEY ? 'live' : 'demo'}, AI: ${ANTHROPIC_API_KEY ? 'on' : 'rule-based'}, fundamentals: ${FMP_API_KEY ? 'on' : 'off'}, news: ${FINNHUB_API_KEY ? 'on' : 'off'}, accounts: ${storeMode})`));
});
