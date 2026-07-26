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
const STRAT = {
  daytrade: { fast: 5,  slow: 10,  rsiP: 7,  horizon: 3,  fwWindow: 15,  fastLabel: 'SMA 5',  slowLabel: 'SMA 10' },
  longterm: { fast: 50, slow: 200, rsiP: 14, horizon: 30, fwWindow: 120, fastLabel: 'SMA 50', slowLabel: 'SMA 200' },
  short:    { fast: 20, slow: 50,  rsiP: 14, horizon: 10, fwWindow: 30,  fastLabel: 'SMA 20', slowLabel: 'SMA 50' },
};

const RISK = {
  daytrade: 'High risk. Most day traders lose money over time. This model reads DAILY bars — real day trading needs intraday (minute/hour) data, which you can enable with a market-data key.',
  longterm: 'Even long-term trends reverse, and past performance does not guarantee future returns. Diversify; do your own research.',
  short: '⚠️ Shorting has UNLIMITED loss potential — a stock can keep rising with no ceiling — plus borrow fees, margin calls, and short-squeeze risk. Among the riskiest strategies there is.',
};

function signalFor(strategy, fast, slow, r) {
  if (strategy === 'longterm') {
    if (fast == null || slow == null) return { label: 'Not enough history', tone: 'neutral', reason: 'Need ~200 days of data for a long-term read.' };
    const golden = fast > slow;
    return golden
      ? { label: 'Long-term uptrend', tone: 'bullish', reason: 'The 50-day average is above the 200-day (a "golden cross" regime) — the long-term trend is up.' }
      : { label: 'Long-term downtrend', tone: 'bearish', reason: 'The 50-day average is below the 200-day (a "death cross" regime) — the long-term trend is down.' };
  }
  if (strategy === 'short') {
    if (fast == null || slow == null || r == null) return { label: 'Short setup: n/a', tone: 'neutral', reason: 'Not enough data.' };
    const down = fast < slow;
    if (down && r >= 70) return { label: 'Short setup: Elevated', tone: 'bearish', reason: 'Downtrend with an overbought bounce (RSI > 70) — the kind of spot short-sellers look to fade. But watch for a squeeze if momentum flips.' };
    if (down && r > 45) return { label: 'Short setup: Elevated', tone: 'bearish', reason: 'Price is in a downtrend (20-day below 50-day) and momentum is not oversold yet — room to keep falling.' };
    if (down) return { label: 'Short setup: Moderate', tone: 'neutral', reason: 'Downtrend, but RSI is nearing oversold — shorting here fights a possible bounce.' };
    return { label: 'Short setup: Weak', tone: 'neutral', reason: 'Price is in an uptrend — shorting fights the trend, which is dangerous.' };
  }
  // daytrade
  if (fast == null || slow == null || r == null) return { label: 'Not enough data', tone: 'neutral', reason: 'Need more history.' };
  const up = fast > slow;
  if (r >= 75) return { label: 'Overbought', tone: 'neutral', reason: 'RSI(7) is very high (> 75) — short-term price is stretched, pullback risk.' };
  if (r <= 25) return { label: 'Oversold', tone: 'neutral', reason: 'RSI(7) is very low (< 25) — short-term price is stretched, possible bounce.' };
  return up
    ? { label: 'Momentum: Up', tone: 'bullish', reason: 'The 5-day average is above the 10-day — short-term momentum is up.' }
    : { label: 'Momentum: Down', tone: 'bearish', reason: 'The 5-day average is below the 10-day — short-term momentum is down.' };
}

function analyze(closes, strategy) {
  const cfg = STRAT[strategy] ? strategy : 'daytrade';
  const c = STRAT[cfg];
  const fastVal = sma(closes, c.fast);
  const slowVal = sma(closes, c.slow);
  const r = rsi(closes, c.rsiP);
  const { forecast, slope } = linearForecast(closes.slice(-c.fwWindow), c.horizon);
  return {
    strategy: cfg,
    maFast: { period: c.fast, label: c.fastLabel, value: fastVal },
    maSlow: { period: c.slow, label: c.slowLabel, value: slowVal },
    rsi: r, rsiPeriod: c.rsiP,
    forecast, slope, horizon: c.horizon,
    signal: signalFor(cfg, fastVal, slowVal, r),
    risk: RISK[cfg],
  };
}

module.exports = { sma, rsi, linearForecast, computeSignal, demoCloses, analyze, STRAT, RISK };

