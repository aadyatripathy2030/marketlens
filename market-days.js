'use strict';
// US market calendar, used by the streak so that a day the market never opened
// cannot break one. Everything here works in dates, never timestamps: a
// "day" is the YYYY-MM-DD it was in New York, because that is what decides
// whether the market was open.

// The date in New York right now, as YYYY-MM-DD. Intl does the timezone and
// the daylight-saving shift, so there is no offset table to go stale.
function etDay(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d || new Date());
  const get = (t) => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Calendar helpers on YYYY-MM-DD. Date.UTC keeps these free of local-time
// drift — the string already carries the timezone decision.
const toUTC = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUTC = (ms) => new Date(ms).toISOString().slice(0, 10);
const DAY_MS = 86400000;
const dow = (ymd) => new Date(toUTC(ymd)).getUTCDay();   // 0 Sun … 6 Sat
const isWeekend = (ymd) => { const w = dow(ymd); return w === 0 || w === 6; };
const addDays = (ymd, n) => fromUTC(toUTC(ymd) + n * DAY_MS);
const pad = (n) => String(n).padStart(2, '0');

// nth weekday of a month, e.g. the 3rd Monday of January.
function nthWeekday(year, month, weekday, n) {
  const first = Date.UTC(year, month - 1, 1);
  const shift = (weekday - new Date(first).getUTCDay() + 7) % 7;
  return fromUTC(first + (shift + (n - 1) * 7) * DAY_MS);
}
function lastWeekday(year, month, weekday) {
  const last = Date.UTC(year, month, 0);                  // day 0 of next month
  const back = (new Date(last).getUTCDay() - weekday + 7) % 7;
  return fromUTC(last - back * DAY_MS);
}

// Anonymous Gregorian algorithm. Good Friday moves every year, so computing
// Easter beats a hardcoded table that silently expires.
function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad(month)}-${pad(day)}`;
}

// A fixed-date holiday moves off a weekend: Saturday is kept on the Friday
// before, Sunday on the Monday after.
function observed(ymd) {
  const w = dow(ymd);
  if (w === 6) return addDays(ymd, -1);
  if (w === 0) return addDays(ymd, 1);
  return ymd;
}

const holidayCache = new Map();
function holidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const set = new Set([
    observed(`${year}-01-01`),                 // New Year's Day
    nthWeekday(year, 1, 1, 3),                 // MLK Jr — 3rd Monday, January
    nthWeekday(year, 2, 1, 3),                 // Washington's Birthday — 3rd Monday, February
    addDays(easter(year), -2),                 // Good Friday
    lastWeekday(year, 5, 1),                   // Memorial Day — last Monday, May
    observed(`${year}-06-19`),                 // Juneteenth
    observed(`${year}-07-04`),                 // Independence Day
    nthWeekday(year, 9, 1, 1),                 // Labor Day — 1st Monday, September
    nthWeekday(year, 11, 4, 4),                // Thanksgiving — 4th Thursday, November
    observed(`${year}-12-25`),                 // Christmas
  ]);
  holidayCache.set(year, set);
  return set;
}

function isHoliday(ymd) { return holidays(Number(ymd.slice(0, 4))).has(ymd); }

// The market was open on this date.
function isTradingDay(ymd) { return !isWeekend(ymd) && !isHoliday(ymd); }

// The trading day before this date. Walks back a day at a time; the longest
// US market closure in an ordinary year is four days, and the bound below is
// there so a bad input cannot spin forever.
function prevTradingDay(ymd) {
  let d = addDays(ymd, -1);
  for (let i = 0; i < 400; i++) {
    if (isTradingDay(d)) return d;
    d = addDays(d, -1);
  }
  return d;
}

// How many trading days separate two dates. 0 when they are the same day,
// 1 when `to` is the next trading day after `from`. Weekends and holidays
// count for nothing, which is the whole point.
function tradingDaysBetween(from, to) {
  if (from === to) return 0;
  if (from > to) return -tradingDaysBetween(to, from);
  let n = 0, d = from;
  for (let i = 0; i < 4000 && d < to; i++) {
    d = addDays(d, 1);
    if (isTradingDay(d)) n++;
  }
  return n;
}

module.exports = {
  etDay, isTradingDay, isHoliday, isWeekend, prevTradingDay,
  tradingDaysBetween, addDays, easter, holidays,
};
