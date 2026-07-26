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
    prices: rows.map(v => ({
      date: v.datetime,
      open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close),
    })).filter(p => Number.isFinite(p.close)),
  };
}
function buildDemo(symbol) {
  const candles = I.demoCandles(symbol, HISTORY);
  // Attach recent business-ish dates (calendar days back is fine for demo).
  const prices = [];
  const today = new Date();
  for (let i = 0; i < candles.length; i++) {
    const dt = new Date(today.getTime() - (candles.length - 1 - i) * 86400000);
    const k = candles[i];
    prices.push({ date: dt.toISOString().slice(0, 10), open: k.o, high: k.h, low: k.l, close: k.c });
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
    signal: a.signal, verdict: a.verdict, risk: a.risk,
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
  const v = p.verdict;
  const vTxt = v ? `The mechanical rating lands on ${v.action}${v.strength ? ' (' + v.strength + ')' : ''} — score ${v.score} on a −100…+100 scale (${v.rationale}). ` : '';
  return `Through a ${strat} lens, ${p.symbol} shows a "${p.signal.label}" setup. ${p.signal.reason} `
    + `Momentum (RSI) is ${rsiTxt}, and the ${fast}/${slow} pair frames the trend. `
    + `A naive projection points slightly ${dir} over the next ${p.forecast.length} sessions. `
    + vTxt
    + `${p.risk ? p.risk + ' ' : ''}`
    + `This rating is a formula on past prices, not advice — such signals are wrong often, so never trade on it alone.`;
}
async function callClaude(p) {
  const strat = p.strategyLabel || 'day trading (short-term)';
  const v = p.verdict || {};
  const system = `You are a cautious market-analysis assistant. The user is looking at this stock through a ${strat} lens, and a mechanical indicator model has produced a "${v.action}" rating. Write a brief (3-4 sentence) plain-English read of the trend and momentum AS THEY MATTER FOR ${strat.toUpperCase()}. Explain what is driving that "${v.action}" rating and note the single most important risk of acting on it. Be balanced and explicit that the rating is a mechanical technical signal, frequently wrong, and NOT financial advice — the user must make their own decision. Do not phrase it as a personal recommendation to the user.`;
  const user = `SYMBOL: ${p.symbol}\nSTRATEGY LENS: ${strat}\nLatest: ${p.latest} ${p.currency} (${p.changePct.toFixed(2)}% vs prior day)\n`
    + `${p.maFast ? p.maFast.label : 'fast'}: ${p.indicators.maFast}\n${p.maSlow ? p.maSlow.label : 'slow'}: ${p.indicators.maSlow}\nRSI(${p.indicators.rsiPeriod}): ${p.indicators.rsi}\n`
    + `Signal: ${p.signal.label} — ${p.signal.reason}\nMechanical rating: ${v.action}${v.strength ? ' (' + v.strength + ')' : ''}, score ${v.score}/100 (${v.rationale})\n`
    + `Known risk of this strategy: ${p.risk}\nTrend projection (next ${p.forecast.length} days): ${p.forecast.join(', ')}\nWrite the summary.`;
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
    if (url === '/api/analyze-image' && req.method === 'POST') return await handleAnalyzeImage(req, res);
    serveStatic(req, res);
  } catch (e) { console.error('server error:', e); json(res, 500, { error: 'Internal error' }); }
}).listen(PORT, () => console.log(`Stock tool running at http://localhost:${PORT}  (data: ${STOCK_API_KEY ? 'live' : 'demo'}, AI: ${ANTHROPIC_API_KEY ? 'on' : 'rule-based'})`));
