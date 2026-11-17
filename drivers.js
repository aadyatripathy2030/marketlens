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
  [/\b(secondary offering|public offering|follow-on offering|at-the-market|atm (program|offering)|share sale|prices offering|(million|billion) (stock |share |common stock )?offering|dilut)/i, -0.6, 'a share offering'],
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
  [/\b(launch(es|ed|ing)?|release date|releas(es|ed|ing)|debuts?|arrives?|goes on sale|hits (stores|shelves)|pre-?orders?)\b/i, 0.35, 'a major product launch',
    /\b(results|earnings|quarter(ly)?|report|statement|guidance|outlook|data|filing|offering|notes)\b/i],
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
    for (const [re, v, say, not] of EVENTS) if (re.test(t) && !(not && not.test(t))) { hits.push({ v: v * fade, say, title: String(n.title || '') }); break; }
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
  return { key: 'news', v, w: 0.16, say: lead.length ? lead.join(' and ') : null, events: list.map(h => h.say),
    // The strongest event, with the headlines behind it: the precedent check
    // looks up how this company's stock did after past events of this kind.
    top: list[0] ? { kind: list[0].say, v: list[0].v, titles: hits.filter(h => h.say === list[0].say).map(h => h.title).slice(0, 3) } : null };
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
function fundamentalsDriver(m, fwdGrowth) {
  if (!m) return null;
  const parts = [];
  const g = num(m.revenueGrowthTTMYoy), eg = num(m.epsGrowthTTMYoy), nm = num(m.netProfitMarginTTM);
  const pe = num(m.peTTM ?? m.peBasicExclExtraTTM), de = num(m['totalDebt/totalEquityQuarterly']);
  if (g != null) parts.push(clamp(g / 25, -1, 1));
  if (eg != null) parts.push(clamp(eg / 40, -1, 1));
  // Losses and a sky-high trailing P/E say little when analysts expect
  // earnings to grow fast from here: that is what investing into a launch
  // looks like.
  const growing = fwdGrowth != null && fwdGrowth > 0.2;
  if (nm != null) parts.push(nm < 0 ? (growing ? -0.1 : -0.5) : clamp(nm / 30, 0, 0.5));
  if (pe != null && !growing) parts.push(pe <= 0 ? -0.3 : pe > 80 ? -0.5 : pe > 45 ? -0.2 : pe < 12 ? 0.2 : 0);
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

// ---- Free extras: options (Cboe), short volume (FINRA), dividends
// (Nasdaq), social chatter (StockTwits) ----

// 16. Options. Cboe's delayed chain: one row per contract, symbol like
// AAPL261218C00270000 (root, YYMMDD, C/P, strike x 1000).
function parseOcc(sym) {
  const m = /^(.+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(sym || ''));
  return m ? { exp: Date.UTC(2000 + +m[2], +m[3] - 1, +m[4]), put: m[5] === 'P', strike: +m[6] / 1000 } : null;
}
// Index funds are where everyone buys protection, so far more puts is normal there.
const HEDGE_FUNDS = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'VOO', 'IVV', 'VTI']);
function optionsDriver(o, now, symbol) {
  if (!o || !Array.isArray(o.options) || !(o.price > 0)) return null;
  const S = o.price;
  let cv = 0, pv = 0, cPrem = 0, pPrem = 0, gex = 0;
  const oiByStrike = new Map();
  let nextExp = Infinity;
  for (const r of o.options) {
    const k = parseOcc(r.option); if (!k) continue;
    const days = (k.exp - now) / DAY;
    if (days < -1 || days > 60) continue;
    const vol = num(r.volume) || 0, oi = num(r.open_interest) || 0;
    const mid = (num(r.bid) || 0) / 2 + (num(r.ask) || 0) / 2;
    if (k.put) pv += vol; else cv += vol;
    // Big trades: volume well above open interest means new positions today.
    if (vol >= 500 && vol > 2 * oi && mid > 0) { const prem = vol * mid * 100; if (k.put) pPrem += prem; else cPrem += prem; }
    // Naive dealer gamma: customers long calls and long puts, dealers short both
    // sides' gamma on puts and long on calls (the common GEX convention).
    const g = num(r.gamma) || 0;
    gex += (k.put ? -1 : 1) * g * oi * 100 * S * S * 0.01;
    if (days >= 0 && days < nextExp) nextExp = days;
    if (days >= 0 && days <= 7) oiByStrike.set(k.strike, (oiByStrike.get(k.strike) || 0) + oi);
  }
  if (cv + pv < 200) return null;
  const pcr = pv / Math.max(1, cv);
  const center = HEDGE_FUNDS.has(symbol) ? 1.3 : 0.8;
  const vPcr = clamp((center - pcr) / 0.6, -1, 1);
  const big = cPrem + pPrem;
  const vBig = big > 250000 ? clamp((cPrem - pPrem) / big, -1, 1) : 0;
  const ivUp = num(o.iv30ChangePct);
  const vIv = ivUp != null ? clamp(-ivUp / 25, -1, 0.3) : 0;
  const v = clamp(0.4 * vPcr + 0.45 * vBig + 0.15 * vIv, -1, 1);
  const say = vBig > 0.4 && big > 250000 ? 'large call buying in options'
    : vBig < -0.4 && big > 250000 ? 'large put buying in options'
    : vPcr > 0.5 ? 'heavy call volume' : vPcr < -0.5 ? 'heavy put volume' : null;
  // Pinning: the biggest open-interest strike in the coming week, if it is near.
  let pin = null, best = 0;
  for (const [k, oi] of oiByStrike) if (oi > best && Math.abs(k - S) / S < 0.05) { best = oi; pin = k; }
  return { key: 'options', v, w: 0.08, say, gamma: gex < 0 ? 'short' : 'long', pin: best > 5000 ? pin : null };
}

// 15. Short selling: FINRA's daily share of volume sold short, recent week
// against its own month. Market makers keep the level near half on most
// names, so only the change carries anything.
function shortDriver(ratios) {
  const r = (ratios || []).filter(x => x != null);
  if (r.length < 12) return null;
  const recent = avg(r.slice(-5)), base = avg(r.slice(0, -5));
  const v = clamp(-(recent - base) / 0.08, -1, 1);
  return { key: 'shorts', v, w: 0.04, say: v < -0.4 ? 'rising short selling' : v > 0.4 ? 'falling short selling' : null };
}

// 3. Dividends: a change in the payout, and the mechanical drop on the
// ex-dividend date.
function dividendDriver(d, now) {
  if (!d || !Array.isArray(d.rows) || !d.rows.length) return null;
  const cash = d.rows.filter(r => /cash/i.test(r.type || '') && r.amount > 0).sort((a, b) => b.ex - a.ex);
  let v = 0, say = null;
  if (cash.length >= 2 && now - cash[0].ex < 120 * DAY) {
    const ch = cash[0].amount / cash[1].amount - 1;
    if (ch > 0.02) { v = 0.4; say = 'a dividend increase'; }
    else if (ch < -0.05) { v = -0.7; say = 'a dividend cut'; }
  }
  const toEx = d.nextEx ? (d.nextEx - now) / DAY : null;
  const exSoon = toEx != null && toEx >= 0 && toEx <= 5 ? Math.round(toEx) : null;
  if (v === 0 && exSoon == null) return null;
  return { key: 'dividend', v, w: 0.05, say, exIn: exSoon };
}

// 18. Social chatter: StockTwits posts tagged bullish or bearish. The crowd
// there leans bullish by habit (about two in three), so that is the zero.
function socialDriver(msgs, now) {
  const tagged = (msgs || []).filter(m => now - m.time < 3 * DAY && (m.s === 'Bullish' || m.s === 'Bearish'));
  if (tagged.length < 10) return null;
  const bull = tagged.filter(m => m.s === 'Bullish').length / tagged.length;
  const v = clamp((bull - 0.65) / 0.3, -1, 1);
  return { key: 'social', v, w: 0.04, say: v > 0.5 ? 'bullish chatter online' : v < -0.5 ? 'bearish chatter online' : null };
}

// 6 / 11. What analysts expect next, from Nasdaq's consensus pages: earnings
// growth from this fiscal year to the next, the average price target against
// today's price, the buy/hold/sell mix and the last month's estimate
// revisions. This is the long-run view that trailing numbers miss: a company
// spending into a big launch shows losses now and growth ahead.
// Targets run optimistic on average (about 10% above the price), so that is
// the zero.
function forwardDriver(f, price) {
  if (!f) return null;
  const parts = [], says = [];
  const yr = (f.years || []).filter(r => num(r.eps) != null);
  let g = null;
  if (yr.length >= 2) {
    const a = yr[0].eps, b = yr[1].eps;
    g = a > 0 ? b / a - 1 : (b > 0 ? 1 : null);
    if (g != null) { parts.push([clamp(g / 0.3, -1, 1), 0.4]); if (g > 0.2) says.push('strong expected earnings growth'); else if (g < -0.05) says.push('falling earnings estimates'); }
  }
  if (num(f.target) && price > 0) {
    const u = f.target / price - 1;
    parts.push([clamp((u - 0.1) / 0.3, -1, 1), 0.35]);
    if (u > 0.25) says.push('analyst targets well above the price'); else if (u < 0) says.push('a price above analyst targets');
  }
  const t = (f.buy || 0) + (f.hold || 0) + (f.sell || 0);
  if (t >= 3) parts.push([clamp(((f.buy || 0) - (f.sell || 0)) / t - 0.5, -1, 1), 0.1]);
  const rv = (f.up || 0) + (f.down || 0);
  if (rv >= 2) { const x = ((f.up || 0) - (f.down || 0)) / rv; parts.push([x, 0.15]); if (x > 0.5 && !says.length) says.push('rising earnings estimates'); if (x < -0.5) says.unshift('falling earnings estimates'); }
  if (!parts.length) return null;
  const ws = parts.reduce((s2, x) => s2 + x[1], 0);
  const v = clamp(parts.reduce((s2, x) => s2 + x[0] * x[1], 0) / ws, -1, 1);
  const say = says.find(x => (v > 0) === !/falling|above analyst/.test(x)) || null;
  return { key: 'forward', v, w: 0.16, say, growth: g };
}

// Each horizon cares about different forces (the timeframe table): the long
// run is earnings growth and rates; days are events, macro, options and
// sentiment. Multipliers on each driver's base weight.
const HORIZON = {
  longterm: { precedent: 1.5, chart: 0.5, news: 0.8, earnings: 0.7, analysts: 1.2, insiders: 1, fundamentals: 1.5, forward: 1.8,
    market: 0.8, relative: 0.6, rates: 1.5, dollar: 1, credit: 1, fear: 0.6, bitcoin: 1, timing: 0.3,
    options: 0.3, shorts: 0.5, dividend: 1, social: 0.3 },
  daytrade: { precedent: 1, chart: 1.3, news: 1.2, earnings: 1, analysts: 0.6, insiders: 0.6, fundamentals: 0.3, forward: 0.3,
    market: 1.2, relative: 1, rates: 0.8, dollar: 0.8, credit: 0.8, fear: 1.2, bitcoin: 1.2, timing: 1.5,
    options: 1.6, shorts: 1.2, dividend: 1, social: 1.3 },
};

// ---- Precedent: what this stock did after its own past events of the same
// kind (GTA V for Take-Two, earlier iPhones for Apple, earlier approvals for
// a drug maker). The dates come from the server (named by Claude, which is
// all it supplies); the returns are measured here from real prices, against
// the S&P 500 over the same days. Starts at the last close before the event,
// so the reaction on the day counts.
function measureEvents(bars, spy, events, H) {
  if (!Array.isArray(bars) || bars.length < 30 || !Array.isArray(events)) return [];
  const idxOf = (arr, day) => { let lo = 0, hi = arr.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (String(arr[m].date).slice(0, 10) >= day) { ans = m; hi = m - 1; } else lo = m + 1; } return ans; };
  const out = [];
  for (let r = 0; r < events.length; r++) {
    const e = events[r];
    const day = String(e.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const i = idxOf(bars, day);
    if (i < 1 || i - 1 + H >= bars.length) continue;          // before the history, or too recent to have played out
    if (Math.abs(Date.parse(bars[i].date) - Date.parse(day)) > 7 * DAY) continue;   // a gap in the data
    const a = bars[i - 1].close, b = bars[i - 1 + H].close;
    if (!(a > 0 && b > 0)) continue;
    let mkt = 0;
    if (Array.isArray(spy) && spy.length) {
      const j = idxOf(spy, String(bars[i - 1].date).slice(0, 10)), k = idxOf(spy, String(bars[i - 1 + H].date).slice(0, 10));
      if (j >= 0 && k >= 0 && spy[j].close > 0 && spy[k].close > 0) mkt = spy[k].close / spy[j].close - 1;
    }
    out.push({ name: String(e.name || '').slice(0, 60), date: day, rank: r, ret: b / a - 1, excess: (b / a - 1) - mkt });
  }
  return out;
}
const KIND_NOUN = { 'a major product launch': 'launches', 'an FDA approval': 'approvals', 'an FDA setback': 'drug setbacks',
  'raised guidance': 'guidance raises', 'lowered guidance': 'guidance cuts', 'a buyback': 'buybacks', 'a share offering': 'share offerings',
  'a takeover offer': 'takeover offers', 'S&P 500 inclusion': 'index additions', 'an earnings beat': 'earnings beats', 'an earnings miss': 'earnings misses',
  'a stock split': 'splits', 'a CEO exit': 'CEO exits', 'a contract win': 'contract wins' };
function precedentDriver(p, strategy) {
  if (!p || !Array.isArray(p.measured) || p.measured.length < 2) return null;
  // Listed most comparable first (same franchise, same size of event), so
  // earlier entries count more: 1, 0.77, 0.63, 0.53 ...
  const m = p.measured;
  const wts = m.map((x, i) => 1 / (1 + 0.3 * (x.rank != null ? x.rank : i)));
  const avgEx = m.reduce((a, x, i) => a + x.excess * wts[i], 0) / wts.reduce((a, b) => a + b, 0);
  const scale = strategy === 'daytrade' ? 0.04 : 0.25;          // a 25-point beat over a year is a full vote
  const v = clamp(avgEx / scale, -1, 1);
  const noun = KIND_NOUN[p.kind] || 'similar events';
  const say = v > 0.25 ? `how it rose after past ${noun}` : v < -0.25 ? `how it fell after past ${noun}` : null;
  return { key: 'precedent', v, w: 0.14, say, avgExcess: avgEx, n: m.length };
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
  const last = closes && closes.length ? closes[closes.length - 1] : (input.options && input.options.price) || null;
  // Backup when Nasdaq's consensus pages do not answer (they can block cloud
  // servers): Finnhub's latest buy/hold/sell counts, which the server already
  // has with its key.
  let fwdIn = input.forward;
  if (!fwdIn && Array.isArray(input.recs) && input.recs.length) {
    const r = input.recs.slice().sort((a, b) => String(b.period).localeCompare(String(a.period)))[0];
    fwdIn = { buy: (num(r.strongBuy) || 0) + (num(r.buy) || 0), hold: num(r.hold) || 0, sell: (num(r.sell) || 0) + (num(r.strongSell) || 0), fallback: true };
  }
  const fwd = forwardDriver(fwdIn, last);
  if (fwd && fwdIn && fwdIn.fallback && !fwd.say && fwd.v > 0.3) fwd.say = 'strong analyst support';
  const ds = [
    fwd,
    precedentDriver(input.precedent, input.strategy),
    chartDriver(input.rating),
    newsDriver(input.news, input.filings, now),
    earningsDriver(input.earnings, now),
    analystDriver(input.recs),
    insiderDriver(input.insiders, now),
    fundamentalsDriver(input.metric, fwd ? fwd.growth : null),
    marketDriver(input.spy, beta),
    relativeDriver(closes, input.spy),
    ratesDriver(input.t10, pe, beta),
    dollarDriver(input.usd),
    creditDriver(input.hy),
    vixDriver(input.vixRatio),
    cryptoDriver(input.symbol, input.btc),
    timing,
    optionsDriver(input.options, now, input.symbol),
    shortDriver(input.shortRatios),
    dividendDriver(input.dividends, now),
    socialDriver(input.social, now),
  ].filter(Boolean);
  if (!ds.length) return null;
  const hz = HORIZON[input.strategy === 'daytrade' ? 'daytrade' : 'longterm'];
  for (const d of ds) d.w *= (hz[d.key] != null ? hz[d.key] : 1);
  const wsum = ds.reduce((s, d) => s + d.w, 0);
  let score = ds.reduce((s, d) => s + d.v * d.w, 0) / wsum;
  const risk = eventRisk(input.nextEarnings, now);
  // Earnings within days: the report itself will swamp everything else.
  // Earnings within days: the report itself can swamp everything else,
  // far more over the next few days than over the next year.
  if (risk) score *= input.strategy === 'daytrade' ? 0.5 : 0.85;
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
    exDivIn: (ds.find(d => d.key === 'dividend') || {}).exIn ?? null,
    gamma: (ds.find(d => d.key === 'options') || {}).gamma || null,
    pin: (ds.find(d => d.key === 'options') || {}).pin || null,
    // For the summary: the past events behind the precedent vote, if any.
    precedent: input.precedent && input.precedent.measured && input.precedent.measured.length >= 2
      ? { kind: input.precedent.kind, events: input.precedent.measured.map(x => ({ name: x.name, year: x.date.slice(0, 4), excess: Math.round(x.excess * 100) })) } : null,
    // Kept server-side for logs and tuning; not sent to the page.
    detail: ds.map(d => ({ key: d.key, v: Math.round(d.v * 100) / 100, w: d.w })),
  };
}

module.exports = { weigh, measureEvents, precedentDriver, KIND_NOUN, forwardDriver, HORIZON, EVENTS, CRYPTO_LINKED, optionsDriver, shortDriver, dividendDriver, socialDriver, parseOcc, newsDriver, timingDriver, thirdFriday };
