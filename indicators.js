// Pure technical-analysis math — no I/O, no deps, so it can be unit-tested.
// A "forecast" here is a naive least-squares trend projection. It is NOT a
// reliable price prediction; markets are not predictable from past prices alone.

// Simple moving average of the last n values.
function sma(a, n) {
  if (!Array.isArray(a) || a.length < n || n <= 0) return null;
  let s = 0;
  for (let i = a.length - n; i < a.length; i++) s += a[i];
  return s / n;
}

// Relative Strength Index over `period` (classic simple-average form).
function rsi(closes, period) {
  period = period || 14;
  if (!Array.isArray(closes) || closes.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return avgG === 0 ? 50 : 100;
  const rs = avgG / avgL;
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

// Least-squares line over the series; project `days` points forward.
function linearForecast(closes, days) {
  const n = closes ? closes.length : 0;
  if (n < 2) return { forecast: [], slope: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += closes[i]; sxx += i * i; sxy += i * closes[i]; }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const forecast = [];
  for (let d = 1; d <= days; d++) forecast.push(Math.round((intercept + slope * (n - 1 + d)) * 100) / 100);
  return { forecast, slope };
}

// Combine the indicators into a plain-English signal.
function computeSignal(closes) {
  const s20 = sma(closes, 20), s50 = sma(closes, 50), r = rsi(closes, 14);
  let label = 'Neutral', reason = 'Not enough clear signal.';
  if (s20 != null && s50 != null && r != null) {
    const up = s20 > s50;
    if (up && r < 70) { label = 'Bullish'; reason = 'Short-term average is above the long-term average (uptrend), and momentum is not overbought.'; }
    else if (!up && r > 30) { label = 'Bearish'; reason = 'Short-term average is below the long-term average (downtrend), and momentum is not oversold.'; }
    else if (r >= 70) { label = 'Neutral'; reason = 'Uptrend, but RSI is overbought (>70) — pullback risk.'; }
    else if (r <= 30) { label = 'Neutral'; reason = 'Downtrend, but RSI is oversold (<30) — possible bounce.'; }
  }
  return { label, reason, sma20: s20, sma50: s50, rsi: r };
}

// Deterministic demo price series for a symbol (seeded random walk) — used when
// no market-data API key is configured, so the tool runs without a key.
function demoCloses(symbol, n) {
  n = n || 140;
  let seed = 0;
  const str = String(symbol || 'DEMO').toUpperCase();
  for (let i = 0; i < str.length; i++) seed = (seed * 31 + str.charCodeAt(i)) >>> 0;
  function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
  let price = 40 + (seed % 360);            // start $40–$400, stable per symbol
  const drift = (rnd() - 0.45) * 0.35;      // slight upward bias
  const vol = 0.8 + rnd() * 1.6;            // daily volatility %
  const out = [];
  for (let i = 0; i < n; i++) {
    const change = drift + (rnd() - 0.5) * vol * 2;
    price = Math.max(1, price * (1 + change / 100));
    out.push(Math.round(price * 100) / 100);
  }
  return out;
}

// ---- Strategy-aware analysis --------------------------------------------
// Each strategy reads the same price history through a different lens:
// which moving averages matter, which RSI period, how far to project, and how
// to interpret the setup. Every strategy carries its own risk note.
// Two timeframes. Day trading can be traded long OR short (a direction);
// long-term investing is long-only.
const STRAT = {
  daytrade: { fast: 5,  slow: 10,  rsiP: 7,  horizon: 3,  fwWindow: 15,  fastLabel: 'SMA 5',  slowLabel: 'SMA 10' },
  longterm: { fast: 50, slow: 200, rsiP: 14, horizon: 30, fwWindow: 120, fastLabel: 'SMA 50', slowLabel: 'SMA 200' },
};

const RISK = {
  daytrade: 'High risk. Most day traders lose money over time. This model reads DAILY bars — real day trading needs intraday (minute/hour) data, which you can enable with a market-data key.',
  longterm: 'Even long-term trends reverse, and past performance does not guarantee future returns. Diversify; do your own research.',
};
const SHORT_RISK = ' ⚠️ Selling short adds UNLIMITED loss potential — a stock can keep rising with no ceiling — plus borrow fees, margin calls, and short-squeeze risk.';

// Normalize a direction; long-term is always long.
function dirOf(strategy, direction) { return strategy === 'longterm' ? 'long' : (direction === 'short' ? 'short' : 'long'); }
function riskFor(strategy, direction) { return RISK[strategy] + (dirOf(strategy, direction) === 'short' ? SHORT_RISK : ''); }

function signalFor(strategy, direction, fast, slow, r) {
  if (strategy === 'longterm') {
    if (fast == null || slow == null) return { label: 'Not enough history', tone: 'neutral', reason: 'Need ~200 days of data for a long-term read.' };
    return fast > slow
      ? { label: 'Long-term uptrend', tone: 'bullish', reason: 'The 50-day average is above the 200-day (a "golden cross" regime) — the long-term trend is up.' }
      : { label: 'Long-term downtrend', tone: 'bearish', reason: 'The 50-day average is below the 200-day (a "death cross" regime) — the long-term trend is down.' };
  }
  // day trading
  if (fast == null || slow == null || r == null) return { label: 'Not enough data', tone: 'neutral', reason: 'Need more history.' };
  const down = fast < slow;
  if (dirOf(strategy, direction) === 'short') {
    if (down && r >= 70) return { label: 'Sell setup: Elevated', tone: 'bearish', reason: 'Short-term downtrend with an overbought bounce (RSI > 70) — the kind of spot sellers look to fade. Watch for a squeeze if momentum flips.' };
    if (down && r > 45) return { label: 'Sell setup: Elevated', tone: 'bearish', reason: 'The 5-day average is below the 10-day and momentum is not oversold yet — room to keep falling.' };
    if (down) return { label: 'Sell setup: Moderate', tone: 'neutral', reason: 'Short-term downtrend, but RSI is nearing oversold — selling here fights a possible bounce.' };
    return { label: 'Sell setup: Weak', tone: 'neutral', reason: 'Short-term momentum is up — selling fights the trend, which is dangerous.' };
  }
  if (r >= 75) return { label: 'Overbought', tone: 'neutral', reason: 'RSI(7) is very high (> 75) — short-term price is stretched, pullback risk.' };
  if (r <= 25) return { label: 'Oversold', tone: 'neutral', reason: 'RSI(7) is very low (< 25) — short-term price is stretched, possible bounce.' };
  return down
    ? { label: 'Momentum: Down', tone: 'bearish', reason: 'The 5-day average is below the 10-day — short-term momentum is down.' }
    : { label: 'Momentum: Up', tone: 'bullish', reason: 'The 5-day average is above the 10-day — short-term momentum is up.' };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Aggregate the indicators into a single mechanical Buy/Sell/Hold rating.
// This is a weighted score of trend (MA gap), momentum (RSI), and the naive
// projection slope — the same kind of "technical rating" trading sites show.
// It is NOT advice and is frequently wrong; the score is just transparency.
function verdict(strategy, direction, fast, slow, r, slope, last) {
  // Three sub-signals, each squashed to [-1, 1], then weighted into a
  // −100…+100 score: trend (MA gap), momentum (RSI), projection (slope).
  let trendSig = 0, momSig = 0, projSig = 0;
  if (fast != null && slow != null && slow !== 0) trendSig = Math.tanh(((fast - slow) / slow) * 100 / 1.5);
  if (r != null) { momSig = clamp((r - 50) / 20, -1, 1); if (r > 72) momSig *= 0.6; } // haircut when overbought
  if (slope != null && last) projSig = Math.tanh((slope / last) * 100 * 5);
  const score = Math.round(clamp((0.5 * trendSig + 0.3 * momSig + 0.2 * projSig) * 100, -100, 100));

  const parts = [];
  if (fast != null && slow != null) parts.push(fast > slow ? 'trend up' : 'trend down');
  if (r != null) parts.push(r >= 70 ? 'overbought' : r <= 30 ? 'oversold' : r > 50 ? 'firm momentum' : 'soft momentum');
  if (slope != null) parts.push(slope > 0 ? 'projection higher' : 'projection lower');
  const rationale = parts.join(', ');
  const mag = Math.abs(score);
  const strength = mag >= 60 ? 'Strong' : mag >= 38 ? 'Moderate' : 'Weak';
  const TH = 22;

  if (dirOf(strategy, direction) === 'short') {
    // A negative score (downside expected) is the favourable case for a sell/short.
    if (score <= -TH) return { action: 'Sell', strength, tone: 'bearish', score, rationale };
    if (score >= TH) return { action: 'Avoid', strength: '', tone: 'neutral', score, rationale };
    return { action: 'Wait', strength: '', tone: 'neutral', score, rationale };
  }
  if (score >= TH) return { action: 'Buy', strength, tone: 'bullish', score, rationale };
  if (score <= -TH) return { action: 'Sell', strength, tone: 'bearish', score, rationale };
  return { action: 'Hold', strength: '', tone: 'neutral', score, rationale };
}

function analyze(closes, strategy, direction) {
  const cfg = STRAT[strategy] ? strategy : 'daytrade';
  const dir = dirOf(cfg, direction);
  const c = STRAT[cfg];
  const fastVal = sma(closes, c.fast);
  const slowVal = sma(closes, c.slow);
  const r = rsi(closes, c.rsiP);
  const { forecast, slope } = linearForecast(closes.slice(-c.fwWindow), c.horizon);
  const last = closes[closes.length - 1];
  return {
    strategy: cfg, direction: dir,
    maFast: { period: c.fast, label: c.fastLabel, value: fastVal },
    maSlow: { period: c.slow, label: c.slowLabel, value: slowVal },
    rsi: r, rsiPeriod: c.rsiP,
    forecast, slope, horizon: c.horizon,
    signal: signalFor(cfg, dir, fastVal, slowVal, r),
    verdict: verdict(cfg, dir, fastVal, slowVal, r, slope, last),
    risk: riskFor(cfg, dir),
  };
}

// Deterministic demo OHLC candles (seeded walk) — used when no market-data key
// is set. Same seeding idea as demoCloses but emits open/high/low/close.
function demoCandles(symbol, n) {
  n = n || 260;
  let seed = 0;
  const str = String(symbol || 'DEMO').toUpperCase();
  for (let i = 0; i < str.length; i++) seed = (seed * 31 + str.charCodeAt(i)) >>> 0;
  function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
  const r2 = (x) => Math.round(x * 100) / 100;
  let price = 40 + (seed % 360);
  const drift = (rnd() - 0.45) * 0.35;
  const vol = 0.8 + rnd() * 1.6;
  const out = [];
  for (let i = 0; i < n; i++) {
    const open = price;
    const change = drift + (rnd() - 0.5) * vol * 2;
    price = Math.max(1, price * (1 + change / 100));
    const close = price;
    const hi = Math.max(open, close) * (1 + rnd() * vol / 200);
    const lo = Math.min(open, close) * (1 - rnd() * vol / 200);
    out.push({ o: r2(open), h: r2(hi), l: r2(lo), c: r2(close) });
  }
  return out;
}

module.exports = { sma, rsi, linearForecast, computeSignal, demoCloses, demoCandles, analyze, verdict, STRAT, RISK };

