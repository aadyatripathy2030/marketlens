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
  const base = price;                        // anchor for gentle mean-reversion
  const drift = (rnd() - 0.45) * 0.15;
  const vol = 0.8 + rnd() * 1.6;
  const out = [];
  for (let i = 0; i < n; i++) {
    const open = price;
    // Pull weakly toward the anchor so multi-year series stay realistic.
    const revert = ((base - price) / price) * 1.2;
    const change = drift + revert + (rnd() - 0.5) * vol * 2;
    price = Math.max(1, price * (1 + change / 100));
    const close = price;
    const hi = Math.max(open, close) * (1 + rnd() * vol / 200);
    const lo = Math.min(open, close) * (1 - rnd() * vol / 200);
    const volume = Math.round((0.6 + rnd() * 0.8) * 5e6 * (1 + Math.abs(change) / 5));
    out.push({ o: r2(open), h: r2(hi), l: r2(lo), c: r2(close), v: volume });
  }
  return out;
}

// ---- Extended indicator suite (all pure, for the Deep AI Analysis page) ----
const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

// Exponential moving average — full series (nulls until seeded).
function ema(vals, period) {
  if (!vals || vals.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(vals.length).fill(null);
  let prev = avg(vals.slice(0, period));
  out[period - 1] = prev;
  for (let i = period; i < vals.length; i++) { prev = vals[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
const emaLast = (vals, p) => { const e = ema(vals, p); return e.length ? e[e.length - 1] : null; };

// MACD (12, 26, 9): line, signal, histogram.
function macd(closes, fast = 12, slow = 26, sig = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  if (!ef.length || !es.length) return null;
  const macdLine = closes.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null).filter(v => v != null);
  if (macdLine.length < sig) return null;
  const signalArr = ema(macdLine, sig);
  const line = macdLine[macdLine.length - 1];
  const signal = signalArr[signalArr.length - 1];
  return { line, signal, hist: line - signal };
}

// Bollinger Bands (20, 2σ) with %B position (0 = lower band, 1 = upper).
function bollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = avg(slice);
  const sd = Math.sqrt(avg(slice.map(v => (v - mid) ** 2)));
  const upper = mid + mult * sd, lower = mid - mult * sd;
  const last = closes[closes.length - 1];
  return { upper, mid, lower, pctB: upper === lower ? 0.5 : (last - lower) / (upper - lower) };
}

// Average True Range (14) — absolute volatility.
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return avg(trs.slice(-period));
}

// Rolling VWAP over the last `period` bars (volume-weighted average price).
function vwap(candles, period = 20) {
  const slice = candles.slice(-period).filter(c => c.volume > 0);
  if (!slice.length) return null;
  let pv = 0, vv = 0;
  slice.forEach(c => { const tp = (c.high + c.low + c.close) / 3; pv += tp * c.volume; vv += c.volume; });
  return vv ? pv / vv : null;
}

// Recent swing support (low) and resistance (high).
function supportResistance(candles, lookback = 60) {
  const slice = candles.slice(-lookback);
  if (!slice.length) return null;
  return { support: Math.min(...slice.map(c => c.low)), resistance: Math.max(...slice.map(c => c.high)) };
}

// Fibonacci retracement levels across the recent range.
function fibonacci(candles, lookback = 60) {
  const sr = supportResistance(candles, lookback);
  if (!sr) return null;
  const hi = sr.resistance, lo = sr.support, d = hi - lo;
  return { high: hi, low: lo, levels: { '0.0%': hi, '23.6%': hi - d * 0.236, '38.2%': hi - d * 0.382, '50.0%': hi - d * 0.5, '61.8%': hi - d * 0.618, '100.0%': lo } };
}

// Volatility: stdev of daily returns, daily and annualized (%).
function volatility(closes, period = 20) {
  if (closes.length < period + 1) return null;
  const rets = [];
  for (let i = closes.length - period; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const m = avg(rets);
  const daily = Math.sqrt(avg(rets.map(r => (r - m) ** 2)));
  return { daily: daily * 100, annual: daily * Math.sqrt(252) * 100 };
}

// Trend strength 0–100 via R² of a linear fit (how cleanly price trends).
function trendStrength(closes, lookback = 30) {
  const s = closes.slice(-lookback), n = s.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += s[i]; sxx += i * i; syy += s[i] * s[i]; sxy += i * s[i]; }
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  const r = den ? num / den : 0;
  return { strength: Math.round(r * r * 100), direction: num >= 0 ? 'up' : 'down' };
}

// Everything the Deep Analysis page needs, computed from OHLCV candles.
function techReport(candles) {
  const closes = candles.map(c => c.close);
  const last = closes[closes.length - 1];
  const vol20 = candles.slice(-20).map(c => c.volume).filter(v => v);
  return {
    price: last,
    rsi14: rsi(closes, 14),
    sma: { 20: sma(closes, 20), 50: sma(closes, 50), 200: sma(closes, 200) },
    ema: { 20: emaLast(closes, 20), 50: emaLast(closes, 50) },
    macd: macd(closes),
    bollinger: bollinger(closes),
    vwap: vwap(candles),
    atr: atr(candles),
    supportResistance: supportResistance(candles),
    fibonacci: fibonacci(candles),
    volatility: volatility(closes),
    trend: trendStrength(closes),
    volume: candles[candles.length - 1].volume,
    avgVolume: vol20.length ? avg(vol20) : null,
  };
}

// Composite AI rating (0–100) from the technicals — explainable, not black-box.
function overallRating(rep) {
  const w = [];              // {v: signal in [-1,1], weight}
  const push = (v, weight) => { if (v != null && !Number.isNaN(v)) w.push({ v: clamp(v, -1, 1), weight }); };
  const { sma, ema, macd, bollinger, vwap, rsi14, trend, price } = rep;
  if (sma[20] != null && sma[50] != null) push(sma[20] > sma[50] ? 1 : -1, 0.18);
  if (sma[50] != null && sma[200] != null) push(sma[50] > sma[200] ? 1 : -1, 0.15);
  if (macd && macd.hist != null) push(Math.tanh(macd.hist / (price * 0.01)), 0.18);
  if (vwap != null) push(price > vwap ? 1 : -1, 0.1);
  if (rsi14 != null) push(Math.tanh((rsi14 - 50) / 15), 0.15);
  if (bollinger) push((bollinger.pctB - 0.5) * 2, 0.09);
  if (ema[20] != null && ema[50] != null) push(ema[20] > ema[50] ? 1 : -1, 0.1);
  if (trend) push((trend.strength / 100) * (trend.direction === 'up' ? 1 : -1), 0.05);
  const wsum = w.reduce((a, b) => a + b.weight, 0) || 1;
  const bull = w.reduce((a, b) => a + b.v * b.weight, 0) / wsum;   // -1..1
  const score = Math.round(clamp(50 + 50 * bull, 0, 100));
  const label = score >= 78 ? 'Strong Buy' : score >= 60 ? 'Buy' : score >= 45 ? 'Hold' : score >= 30 ? 'Sell' : 'Strong Sell';
  const tone = score >= 60 ? 'bullish' : score <= 44 ? 'bearish' : 'neutral';
  const agree = w.length ? w.filter(x => Math.sign(x.v) === Math.sign(bull) && x.v !== 0).length / w.length : 0;
  const confidence = Math.round(clamp(52 + agree * 43, 40, 96));
  const annual = rep.volatility ? rep.volatility.annual : null;
  const risk = annual == null ? 'Unknown' : annual < 25 ? 'Low' : annual < 45 ? 'Moderate' : annual < 70 ? 'High' : 'Very High';
  return { score, label, tone, confidence, risk };
}

// Probabilistic forecast bands (±1σ ≈ 68% range) per horizon, in trading days.
function forecastBands(closes) {
  const last = closes[closes.length - 1];
  const v = volatility(closes, Math.min(60, closes.length - 1));
  if (!v || !last) return [];
  const sd = v.daily / 100;                       // daily stdev (fraction)
  // mild drift from recent slope, clamped so it can't run away
  const { slope } = linearForecast(closes.slice(-30), 1);
  const driftPerDay = clamp((slope || 0) / last, -0.004, 0.004);
  const H = [['Tomorrow', 1], ['1 week', 5], ['1 month', 21], ['3 months', 63], ['6 months', 126], ['1 year', 252]];
  return H.map(([label, d]) => {
    const mid = last * (1 + driftPerDay * d);
    const band = last * sd * Math.sqrt(d);
    return { label, days: d, low: Math.max(0, mid - band), mid, high: mid + band };
  });
}

module.exports = {
  sma, rsi, linearForecast, computeSignal, demoCloses, demoCandles, analyze, verdict, STRAT, RISK,
  ema, macd, bollinger, atr, vwap, supportResistance, fibonacci, volatility, trendStrength,
  techReport, overallRating, forecastBands,
};

