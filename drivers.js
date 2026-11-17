'use strict';
// Everything that moves a stock, scored. Pure functions only: server.js
// fetches the data (Finnhub, FRED, cached bars) and hands it here.
//
// Each driver returns { key, v, w, say } where v is -1 (down) .. +1 (up), w is
// its weight, and `say` is the short public phrase used if it is one of the
// few reasons the written summary names. Drivers with no data are left out
// and the weights renormalise over what is present.
//
// NOT BACKTESTED as a combination. The chart score alone was tested and did
// not beat chance on large caps (see indicators.js), so this is a weighing of
// the evidence, never a measured probability.

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const num = (x) => (typeof x === 'number' && Number.isFinite(x)) ? x : (x != null && Number.isFinite(Number(x)) ? Number(x) : null);
const DAY = 86400000;

// ---- Part A: what the company does (from headlines and filings) ----
// [pattern, vote, public phrase]. Order matters only for the phrase shown.
const EVENTS = [
  // 1. Share count
  [/\b(buyback|share repurchase|repurchase (program|plan)|buy back)\b/i, 0.6, 'a buyback'],
  [/\breverse (stock )?split\b/i, -0.6, 'a reverse split'],
  [/\b(stock split|share split)\b/i, 0.3, 'a stock split'],
  [/\b(secondary offering|public offering|follow-on offering|at-the-market|atm (program|offering)|share sale|prices offering|dilut)/i, -0.6, 'a share offering'],
  [/\bconvertible (senior )?notes?\b/i, -0.4, 'a convertible note sale'],
  // 2. Debt
  [/\b(going concern|default(ed|s)? on|covenant (breach|waiver)|chapter 11|bankruptcy)\b/i, -1, 'debt distress'],
  [/\brefinanc/i, 0.2, 'a refinancing'],
  [/\b(moody'?s|s&p|fitch)\b.*\bupgrad/i, 0.3, 'a credit upgrade'],
  [/\b(moody'?s|s&p|fitch)\b.*\bdowngrad/i, -0.4, 'a credit downgrade'],
  // 3. Dividends
  [/\b(cuts?|slashes|suspends?|eliminates?) (its |the |quarterly )?dividend/i, -0.7, 'a dividend cut'],
  [/\b(raises?|hikes?|increases?|boosts?) (its |the |quarterly )?dividend|special dividend|initiates? (a )?dividend/i, 0.4, 'a dividend increase'],
  // 4. Product and business
  [/\bfda (approv|clears|grants)|receives? fda approval/i, 0.8, 'an FDA approval'],
  [/\b(complete response letter|fda (reject|declin)|fails? (phase|trial)|trial fail)/i, -0.8, 'an FDA setback'],
  [/\b(wins?|awarded|secures?|lands?) .{0,40}\b(contract|deal|order)\b/i, 0.4, 'a contract win'],
  [/\b(recall|outage|cyberattack|data breach|hack(ed)?)\b/i, -0.4, 'an outage or recall'],
  [/\b(lawsuit|sued|class action)\b/i, -0.2, 'a lawsuit'],
  // 5. Earnings and guidance
  [/\b(raises?|raised|lifts?|boosts?|ups) (its |full-year |annual |fy )?(guidance|outlook|forecast)/i, 0.7, 'raised guidance'],
  [/\b(cuts?|lowers?|lowered|slashes|withdraws?|pulls?) (its |full-year |annual |fy )?(guidance|outlook|forecast)|weak (guidance|outlook|forecast)/i, -0.8, 'lowered guidance'],
  [/\b(beats?|tops?|surpass(es)?|exceeds?) .{0,30}(estimates|expectations|forecasts)/i, 0.4, 'an earnings beat'],
  [/\b(miss(es|ed)?|falls? short of|below) .{0,30}(estimates|expectations|forecasts)/i, -0.4, 'an earnings miss'],
  // 7. M&A and restructuring
  [/\b(to be acquired|agrees? to be (bought|acquired)|buyout offer|takeover (bid|offer)|tender offer|go(es|ing)? private)\b/i, 0.8, 'a takeover offer'],
  [/\bspin[- ]?off\b/i, 0.2, 'a spin-off'],
  [/\b(layoffs?|job cuts|restructuring|cost cuts)\b/i, 0.2, 'cost cuts'],
  // 8. Ownership
  [/\b(activist|takes? .{0,20}stake|13d)\b/i, 0.4, 'an activist stake'],
  [/\block-?up (expir|end)/i, -0.3, 'a lock-up expiry'],
  [/\b(added to|join(s|ing)?|inclusion in) (the )?s&p 500\b/i, 0.6, 'S&P 500 inclusion'],
  [/\b(removed from|drop(ped|s)? from|exits?) (the )?s&p 500\b/i, -0.5, 'S&P 500 removal'],
  // 9-10. Listing, leadership, governance
  [/\b(delist|delisting notice|non-?compliance notice)\b/i, -0.7, 'a delisting notice'],
  [/\b(cfo|chief financial officer) (resigns?|departs?|steps down|exits?|to leave)/i, -0.5, 'a CFO exit'],
  [/\b(ceo|chief executive) (resigns?|departs?|steps down|ousted|fired)/i, -0.4, 'a CEO exit'],
  [/\b(restatement|restate[sd]?|auditor (resigns?|quits))\b/i, -0.9, 'an accounting problem'],
  [/\b(sec (investigation|probe|charges)|subpoena|doj (probe|investigation))\b/i, -0.6, 'a regulator probe'],
  // 11. Analysts
  [/\bupgrade[sd]?\b(?!.*\b(moody|fitch)\b)/i, 0.4, 'an analyst upgrade'],
  [/\bdowngrade[sd]?\b(?!.*\b(moody|fitch)\b)/i, -0.4, 'an analyst downgrade'],
  [/\b(raises?|lifts?) (its )?price target/i, 0.2, 'higher price targets'],
  [/\b(cuts?|lowers?) (its )?price target/i, -0.2, 'lower price targets'],
  // 20. Shocks
  [/\b(short[- ]seller|short report|fraud)\b/i, -0.6, 'a short-seller report'],
  [/\btrading halt(ed)?\b/i, -0.3, 'a trading halt'],
];
// Filing types from SEC EDGAR (via Finnhub /stock/filings).
const FILINGS = [
  [/^(S-3|S-1|424B[1-8]?)/, -0.4, 'a shelf or offering filing'],
  [/^SC 13D/, 0.3, 'an activist filing'],
  [/^NT 10-[KQ]/, -0.6, 'a late annual or quarterly report'],
];

function newsDriver(news, filings, now) {
  const hits = [];
  for (const n of news || []) {
    const t = String(n.title || '') + ' ' + String(n.summary || '').slice(0, 200);
    const age = now - (n.time || now);
    const fade = clamp(1 - age / (14 * DAY), 0.3, 1);       // fresher news counts more
    for (const [re, v, say] of EVENTS) if (re.test(t)) { hits.push({ v: v * fade, say }); break; }
  }
  for (const f of filings || []) {
    const form = String(f.form || '');
    for (const [re, v, say] of FILINGS) if (re.test(form)) { hits.push({ v, say }); break; }
  }
  if (!hits.length) return null;
  // One headline repeated by ten outlets is one event: dedupe by phrase,
  // keep the strongest of each.
  const best = new Map();
  for (const h of hits) { const b = best.get(h.say); if (!b || Math.abs(h.v) > Math.abs(b.v)) best.set(h.say, h); }
  const list = [...best.values()].sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const v = clamp(list.reduce((s, h) => s + h.v, 0), -1, 1);
  const lead = list.filter(h => Math.sign(h.v) === Math.sign(v)).slice(0, 2).map(h => h.say);
  return { key: 'news', v, w: 0.16, say: lead.length ? lead.join(' and ') : null, events: list.map(h => h.say) };
}

// 5. Earnings surprise, with post-earnings drift fading over ~60 days.
function earningsDriver(hist, now) {
  const last = (hist || []).filter(e => num(e.actual) != null && num(e.estimate) != null)
    .sort((a, b) => String(b.period).localeCompare(String(a.period)))[0];
  if (!last) return null;
  const est = num(last.estimate), act = num(last.actual);
  const pct = est !== 0 ? (act - est) / Math.abs(est) * 100 : (act > 0 ? 10 : -10);
  const age = (now - Date.parse(last.period)) / DAY - 30;     // period is quarter end; report ~30d later
  if (age > 90) return null;
  const fade = clamp(1 - Math.max(0, age) / 90, 0.2, 1);
  const v = clamp(pct / 10, -1, 1) * fade;
  return { key: 'earnings', v, w: 0.10, say: pct >= 0 ? 'an earnings beat' : 'an earnings miss' };
}

// 11. Analyst consensus drift, month over month.
function analystDriver(recs) {
  const r = (recs || []).slice().sort((a, b) => String(b.period).localeCompare(String(a.period)));
  if (r.length < 2) return null;
  const net = (x) => {
    const sb = num(x.strongBuy) || 0, b = num(x.buy) || 0, h = num(x.hold) || 0, s = num(x.sell) || 0, ss = num(x.strongSell) || 0;
    const t = sb + b + h + s + ss; return t ? (2 * sb + b - s - 2 * ss) / (2 * t) : null;
  };
  const now = net(r[0]), then = net(r[Math.min(2, r.length - 1)]);
  if (now == null || then == null) return null;
  const v = clamp((now - then) * 8, -1, 1);
  if (Math.abs(v) < 0.1) return { key: 'analysts', v: 0, w: 0.07, say: null };
  return { key: 'analysts', v, w: 0.07, say: v > 0 ? 'analysts turning more positive' : 'analysts turning more cautious' };
}

// 8. Insider buying clusters (open-market purchases, code P) vs sales (S).
function insiderDriver(tx, now) {
  const recent = (tx || []).filter(t => now - Date.parse(t.transactionDate || t.filingDate || 0) < 90 * DAY);
  if (!recent.length) return null;
  const buyers = new Set(recent.filter(t => t.transactionCode === 'P' && num(t.change) > 0).map(t => t.name));
  const sellers = new Set(recent.filter(t => t.transactionCode === 'S').map(t => t.name));
  // Insiders sell for many reasons and buy for one, so buys weigh far more.
  let v = 0, say = null;
  if (buyers.size >= 2) { v = 0.8; say = 'insider buying'; }
  else if (buyers.size === 1) { v = 0.35; say = 'insider buying'; }
  else if (sellers.size >= 4) { v = -0.25; say = 'heavy insider selling'; }
  return { key: 'insiders', v, w: 0.08, say };
}

// 6. Fundamentals and valuation (long run).
function fundamentalsDriver(m) {
  if (!m) return null;
  const parts = [];
  const g = num(m.revenueGrowthTTMYoy), eg = num(m.epsGrowthTTMYoy), nm = num(m.netProfitMarginTTM);
  const pe = num(m.peTTM ?? m.peBasicExclExtraTTM), de = num(m['totalDebt/totalEquityQuarterly']);
  if (g != null) parts.push(clamp(g / 25, -1, 1));
  if (eg != null) parts.push(clamp(eg / 40, -1, 1));
  if (nm != null) parts.push(nm < 0 ? -0.5 : clamp(nm / 30, 0, 0.5));
  if (pe != null) parts.push(pe <= 0 ? -0.3 : pe > 80 ? -0.5 : pe > 45 ? -0.2 : pe < 12 ? 0.2 : 0);
  if (de != null && de > 2.5) parts.push(-0.4);
  if (!parts.length) return null;
  const v = clamp(parts.reduce((a, b) => a + b, 0) / parts.length * 1.5, -1, 1);
  const say = v > 0.25 ? (g != null && g > 10 ? 'strong sales growth' : 'solid fundamentals')
    : v < -0.25 ? (nm != null && nm < 0 ? 'losses' : g != null && g < 0 ? 'shrinking sales' : 'a stretched valuation') : null;
  return { key: 'fundamentals', v, w: 0.08, say };
}

// ---- Part B: outside the company ----
const ret = (c, n) => (c && c.length > n && c[c.length - 1 - n] > 0) ? c[c.length - 1] / c[c.length - 1 - n] - 1 : null;
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const smaLast = (c, n) => c && c.length >= n ? avg(c.slice(-n)) : null;

// 12 / 21. The broad market, scaled by the stock's beta.
function marketDriver(spy, beta) {
  if (!spy || spy.length < 210) return null;
  const last = spy[spy.length - 1], s50 = smaLast(spy, 50), s200 = smaLast(spy, 200), r20 = ret(spy, 20);
  const v0 = 0.5 * clamp((s50 - s200) / (s200 * 0.04), -1, 1) + 0.3 * clamp(r20 / 0.05, -1, 1) + 0.2 * (last > s50 ? 1 : -1);
  const b = beta != null ? clamp(beta, 0.3, 2) : 1;
  const v = clamp(v0 * b, -1, 1);
  return { key: 'market', v, w: 0.12, say: v > 0.2 ? 'a rising market' : v < -0.2 ? 'a falling market' : null };
}
// 14. Relative strength vs the market over three months.
function relativeDriver(closes, spy) {
  const a = ret(closes, 63), b = ret(spy, 63);
  if (a == null || b == null) return null;
  const v = clamp((a - b) / 0.15, -1, 1);
  return { key: 'relative', v, w: 0.07, say: v > 0.3 ? 'outperforming the market' : v < -0.3 ? 'lagging the market' : null };
}
// 12. Rates: a rising 10-year hurts most where earnings sit far in the future.
function ratesDriver(t10, pe, beta) {
  const c = t10 && t10.length > 25 ? t10[t10.length - 1] - t10[t10.length - 21] : null;   // points over ~a month
  if (c == null) return null;
  const sens = (pe != null && pe > 35) || (beta != null && beta > 1.3) ? 1.5 : 1;
  const v = clamp(-c / 0.4 * sens, -1, 1);
  return { key: 'rates', v, w: 0.06, say: v > 0.3 ? 'falling bond yields' : v < -0.3 ? 'rising bond yields' : null };
}
function dollarDriver(usd) {
  const c = usd && usd.length > 25 ? usd[usd.length - 1] / usd[usd.length - 21] - 1 : null;
  if (c == null) return null;
  const v = clamp(-c / 0.03, -1, 1);
  return { key: 'dollar', v, w: 0.03, say: v < -0.4 ? 'a strong dollar' : v > 0.4 ? 'a weaker dollar' : null };
}
function creditDriver(hy) {
  const c = hy && hy.length > 25 ? hy[hy.length - 1] - hy[hy.length - 21] : null;
  if (c == null) return null;
  const v = clamp(-c / 0.6, -1, 1);
  return { key: 'credit', v, w: 0.05, say: v < -0.3 ? 'widening credit spreads' : v > 0.3 ? 'calmer credit markets' : null };
}
// 16 / 18. Fear: a spike above normal is a headwind; panic extremes are
// where bottoms tend to form, so the vote turns back up there.
function vixDriver(ratio) {
  if (ratio == null) return null;
  let v = 0, say = null;
  if (ratio > 1.6) { v = 0.3; say = 'extreme fear (often near lows)'; }
  else if (ratio > 1.15) { v = -clamp((ratio - 1) / 0.4, 0, 1) * 0.6; say = 'rising market fear'; }
  else if (ratio < 0.8) { v = -0.1; }
  else v = 0.1;
  return { key: 'fear', v, w: 0.05, say };
}
// 21. Crypto-linked names follow Bitcoin.
const CRYPTO_LINKED = new Set(['COIN', 'MSTR', 'MARA', 'RIOT', 'CLSK', 'HUT', 'BITF', 'CIFR', 'WULF', 'IREN', 'HOOD', 'BTBT', 'CORZ', 'GLXY']);
function cryptoDriver(symbol, btc) {
  if (!CRYPTO_LINKED.has(symbol) || !btc || btc.length < 60) return null;
  const v = clamp(0.6 * clamp(ret(btc, 20) / 0.15, -1, 1) + 0.4 * (btc[btc.length - 1] > smaLast(btc, 50) ? 1 : -1), -1, 1);
  return { key: 'bitcoin', v, w: 0.14, say: v > 0 ? 'Bitcoin strength' : 'Bitcoin weakness' };
}
// 17. Technicals: the chart score already on the page.
function chartDriver(rating) {
  if (!rating || rating.score == null) return null;
  const v = clamp((rating.score - 50) / 40, -1, 1);
  return { key: 'chart', v, w: 0.14, say: v > 0.3 ? 'an uptrend on the chart' : v < -0.3 ? 'a downtrend on the chart' : null };
}

// 19. Timing and seasonality. Third Friday = monthly options expiry; March,
// June, September and December's are quad witching.
function thirdFriday(y, m) { const d = new Date(Date.UTC(y, m, 1)); const off = (5 - d.getUTCDay() + 7) % 7; return new Date(Date.UTC(y, m, 1 + off + 14)); }
function timingDriver(now, ytd) {
  const d = new Date(now), m = d.getUTCMonth(), day = d.getUTCDate();
  let v = 0, say = null;
  if (m === 8) { v = -0.4; say = 'a weak season'; }                         // September
  else if (m === 10 || m === 3 || m === 6) v = 0.3;                         // Nov, Apr, Jul
  else if (m === 11 && day >= 20) { v = 0.4; say = 'the year-end rally window'; }
  else if (m === 0) v = ytd != null && ytd < -0.2 ? 0.4 : 0.2;              // January effect
  else if (m >= 4 && m <= 9) v = -0.1;                                      // "sell in May"
  // December tax-loss selling hits the year's losers before the 20th.
  if (m === 11 && day < 20 && ytd != null && ytd < -0.2) { v = -0.4; say = 'year-end tax-loss selling'; }
  const tf = thirdFriday(d.getUTCFullYear(), m);
  const toOpex = (tf - Date.UTC(d.getUTCFullYear(), m, day)) / DAY;
  const opex = toOpex >= 0 && toOpex <= 4 ? ([2, 5, 8, 11].includes(m) ? 'quad witching' : 'options expiry') : null;
  return { key: 'timing', v, w: 0.04, say, opex };
}

// Upcoming events that make any lean less reliable (5, 19).
function eventRisk(nextEarnings, now) {
  if (!nextEarnings) return null;
  const days = Math.round((Date.parse(nextEarnings) - now) / DAY);
  if (!(days >= 0 && days <= 10)) return null;
  return { days, date: nextEarnings };
}

// ---- Combine ----
function weigh(input) {
  const now = input.now || Date.now();
  const m = input.metric || {};
  const beta = num(m.beta), pe = num(m.peTTM ?? m.peBasicExclExtraTTM);
  const closes = input.closes || null;
  let ytd = null;
  if (input.bars && input.bars.length) {
    const y = String(new Date(now).getUTCFullYear());
    const first = input.bars.find(b => String(b.date || '').startsWith(y));
    if (first && first.close > 0) ytd = input.bars[input.bars.length - 1].close / first.close - 1;
  }
  const timing = timingDriver(now, ytd);
  const ds = [
    chartDriver(input.rating),
    newsDriver(input.news, input.filings, now),
    earningsDriver(input.earnings, now),
    analystDriver(input.recs),
    insiderDriver(input.insiders, now),
    fundamentalsDriver(input.metric),
    marketDriver(input.spy, beta),
    relativeDriver(closes, input.spy),
    ratesDriver(input.t10, pe, beta),
    dollarDriver(input.usd),
    creditDriver(input.hy),
    vixDriver(input.vixRatio),
    cryptoDriver(input.symbol, input.btc),
    timing,
  ].filter(Boolean);
  if (!ds.length) return null;
  const wsum = ds.reduce((s, d) => s + d.w, 0);
  let score = ds.reduce((s, d) => s + d.v * d.w, 0) / wsum;
  const risk = eventRisk(input.nextEarnings, now);
  // Earnings within days: the report itself will swamp everything else.
  if (risk) score *= 0.6;
  const lean = score >= 0.1 ? 'up' : score <= -0.1 ? 'down' : 'mixed';
  const dir = lean === 'up' ? 1 : lean === 'down' ? -1 : 0;
  // The few reasons named in public: strongest pushes in the lean's
  // direction, plus the strongest push against it.
  const named = ds.filter(d => d.say);
  // On a mixed read, "for" is the strongest push up and "against" the
  // strongest push down.
  const side = (sg) => named.filter(d => Math.sign(d.v) === sg).sort((a, b) => Math.abs(b.v * b.w) - Math.abs(a.v * a.w));
  const forIt = dir ? side(dir).slice(0, 2) : side(1).slice(0, 1);
  const against = dir ? side(-dir).slice(0, 1) : side(-1).slice(0, 1);
  return {
    lean, label: lean === 'up' ? 'Leans up' : lean === 'down' ? 'Leans down' : 'Mixed',
    score: Math.round(score * 100), count: ds.length,
    reasons: forIt.map(d => d.say), against: against.map(d => d.say),
    earningsIn: risk ? risk.days : null, opex: timing.opex,
    // Kept server-side for logs and tuning; not sent to the page.
    detail: ds.map(d => ({ key: d.key, v: Math.round(d.v * 100) / 100, w: d.w })),
  };
}

module.exports = { weigh, EVENTS, CRYPTO_LINKED, newsDriver, timingDriver, thirdFriday };
