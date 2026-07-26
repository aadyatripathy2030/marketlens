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

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const STOCK_API_KEY = process.env.STOCK_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
const HISTORY = 260; // enough bars for the 200-day average (long-term lens)
const STRAT_LABEL = { daytrade: 'day trading (short-term)', longterm: 'long-term investing', short: 'short-selling' };

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
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
async function fetchLive(symbol) {
  // Twelve Data: /time_series?symbol=AAPL&interval=1day&outputsize=150&apikey=KEY
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=${HISTORY}&apikey=${STOCK_API_KEY}`;
  const { json: j } = await httpsJson({ method: 'GET', hostname: 'api.twelvedata.com',
    path: url.replace('https://api.twelvedata.com', '') });
  if (!j || j.status === 'error' || !Array.isArray(j.values)) throw new Error(j && j.message ? j.message : 'No data for that symbol');
  // Twelve Data returns newest-first; reverse to oldest-first.
  const rows = j.values.slice().reverse();
  return {
    name: (j.meta && j.meta.symbol) || symbol,
    currency: (j.meta && j.meta.currency) || 'USD',
    prices: rows.map(v => ({ date: v.datetime, close: Number(v.close) })).filter(p => Number.isFinite(p.close)),
  };
}
function buildDemo(symbol) {
  const closes = I.demoCloses(symbol, HISTORY);
  // Attach recent business-ish dates (calendar days back is fine for demo).
  const prices = [];
  const today = new Date();
  for (let i = 0; i < closes.length; i++) {
    const dt = new Date(today.getTime() - (closes.length - 1 - i) * 86400000);
    prices.push({ date: dt.toISOString().slice(0, 10), close: closes[i] });
  }
  return { name: symbol, currency: 'USD', prices };
}

async function handleStock(req, res, symbol, strategy) {
  symbol = String(symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12);
  if (!symbol) return json(res, 400, { error: 'Enter a ticker symbol.' });
  strategy = I.STRAT[strategy] ? strategy : 'daytrade';
  let source = 'demo', note = '', data;
  if (STOCK_API_KEY) {
    try { data = await fetchLive(symbol); source = 'live'; }
    catch (e) { data = buildDemo(symbol); note = 'Live data unavailable (' + e.message + ') — showing demo data.'; }
  } else {
    data = buildDemo(symbol);
    note = 'Demo data — set STOCK_API_KEY (twelvedata.com, free) for real prices.';
  }
  const closes = data.prices.map(p => p.close);
  const a = I.analyze(closes, strategy);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2] || last;
  json(res, 200, {
    symbol, name: data.name, currency: data.currency, source, note,
    strategy, strategyLabel: STRAT_LABEL[strategy],
    prices: data.prices,
    latest: last, change: last - prev, changePct: prev ? ((last - prev) / prev) * 100 : 0,
    maFast: a.maFast, maSlow: a.maSlow,
    indicators: { maFast: a.maFast.value, maSlow: a.maSlow.value, rsi: a.rsi, rsiPeriod: a.rsiPeriod, trendSlope: a.slope },
    signal: a.signal, risk: a.risk,
    forecast: a.forecast, horizon: a.horizon,
  });
}

// ---- AI (or rule-based) summary ----
function ruleBasedSummary(p) {
  const strat = p.strategyLabel || 'day trading (short-term)';
  const dir = p.forecast && p.forecast.length ? (p.forecast[p.forecast.length - 1] > p.latest ? 'higher' : 'lower') : 'flat';
  const rsiTxt = p.indicators.rsi == null ? 'unavailable'
    : p.indicators.rsi >= 70 ? `overbought (${p.indicators.rsi})`
    : p.indicators.rsi <= 30 ? `oversold (${p.indicators.rsi})`
    : `neutral (${p.indicators.rsi})`;
  const fast = p.maFast ? p.maFast.label : 'fast average';
  const slow = p.maSlow ? p.maSlow.label : 'slow average';
  return `Through a ${strat} lens, ${p.symbol} shows a "${p.signal.label}" setup. ${p.signal.reason} `
    + `Momentum (RSI) is ${rsiTxt}, and the ${fast}/${slow} pair frames the trend. `
    + `A naive projection points slightly ${dir} over the next ${p.forecast.length} sessions. `
    + `${p.risk ? p.risk + ' ' : ''}`
    + `This is a mechanical read of past prices, not a forecast to trust for decisions — it can be wrong.`;
}
async function callClaude(p) {
  const strat = p.strategyLabel || 'day trading (short-term)';
  const system = `You are a cautious market-analysis assistant. The user is looking at this stock specifically through a ${strat} lens. Given the symbol and its technical indicators, write a brief (3-4 sentence) plain-English read of the trend and momentum AS THEY MATTER FOR ${strat.toUpperCase()}, plus the single most important risk of that approach. Be balanced and explicitly note uncertainty. This is educational analysis, NOT financial advice. Do not tell the user to buy, sell, or short.`;
  const user = `SYMBOL: ${p.symbol}\nSTRATEGY LENS: ${strat}\nLatest: ${p.latest} ${p.currency} (${p.changePct.toFixed(2)}% vs prior day)\n`
    + `${p.maFast ? p.maFast.label : 'fast'}: ${p.indicators.maFast}\n${p.maSlow ? p.maSlow.label : 'slow'}: ${p.indicators.maSlow}\nRSI(${p.indicators.rsiPeriod}): ${p.indicators.rsi}\n`
    + `Signal: ${p.signal.label} — ${p.signal.reason}\nKnown risk of this strategy: ${p.risk}\nTrend projection (next ${p.forecast.length} days): ${p.forecast.join(', ')}\nWrite the summary.`;
  const body = JSON.stringify({ model: AI_MODEL, max_tokens: 400,
    system, messages: [{ role: 'user', content: user }] });
  const { json: j } = await httpsJson({ method: 'POST', hostname: 'api.anthropic.com', path: '/v1/messages',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) } }, body);
  const text = j && j.content && j.content[0] && j.content[0].text;
  if (!text) throw new Error(j && j.error ? (j.error.message || 'AI error') : 'No AI response');
  return text.trim();
}
async function handleAnalyze(req, res) {
  const p = await readBody(req);
  if (!p || !p.symbol) return json(res, 400, { error: 'Missing data.' });
  if (ANTHROPIC_API_KEY) {
    try { return json(res, 200, { summary: await callClaude(p), source: 'ai' }); }
    catch (e) { return json(res, 200, { summary: ruleBasedSummary(p), source: 'rule', note: 'AI unavailable (' + e.message + ') — rule-based summary.' }); }
  }
  return json(res, 200, { summary: ruleBasedSummary(p), source: 'rule', note: 'Set ANTHROPIC_API_KEY for an AI-written analysis.' });
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

http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (url === '/api/stock' && req.method === 'GET') {
      const q = new URLSearchParams(req.url.split('?')[1] || '');
      return await handleStock(req, res, q.get('symbol'), q.get('strategy'));
    }
    if (url === '/api/analyze' && req.method === 'POST') return await handleAnalyze(req, res);
    serveStatic(req, res);
  } catch (e) { console.error('server error:', e); json(res, 500, { error: 'Internal error' }); }
}).listen(PORT, () => console.log(`Stock tool running at http://localhost:${PORT}  (data: ${STOCK_API_KEY ? 'live' : 'demo'}, AI: ${ANTHROPIC_API_KEY ? 'on' : 'rule-based'})`));
