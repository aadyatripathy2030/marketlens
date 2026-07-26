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

module.exports = { sma, rsi, linearForecast, computeSignal, demoCloses };
