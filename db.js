// Data + auth layer for ChartGauge accounts.
// Uses Postgres when DATABASE_URL is set (persistent), else an in-memory store
// (works for a demo but resets on restart — fine until a real DB is attached).
const crypto = require('crypto');

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const DAY = 86400000;
const SESSION_TTL = 30 * DAY;

let pool = null;
let mode = 'memory';
let lastErr = null;
const mem = { users: new Map(), byEmail: new Map(), sessions: new Map(), watch: new Map(), alerts: new Map(), usage: new Map(), preds: new Map() };

// Render's INTERNAL Postgres host has no dot (e.g. dpg-xxxx-a) and speaks plain
// TCP; hosted/external hosts (Neon, Render external) are dotted and need SSL.
function sslFor(url) {
  const host = (url.match(/@([^/:?]+)/) || [])[1] || '';
  if (!host || /^localhost$/i.test(host) || /^127\./.test(host) || !host.includes('.')) return false;
  return { rejectUnauthorized: false };
}

async function init() {
  if (DATABASE_URL) {
    try {
      const { Pool } = require('pg');
      pool = new Pool({ connectionString: DATABASE_URL, ssl: sslFor(DATABASE_URL) });
      await pool.query(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, pw TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free', created BIGINT NOT NULL)`);
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer TEXT');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_sub TEXT');
      // Google's subject id. Stable for the life of the account and never
      // reused, unlike an email address, so it is what a Google login is
      // matched on once the two are linked.
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT');
      // Streak, counted in trading days. streak_day is the market day the run
      // was last extended to, so a second visit the same day is a no-op and a
      // weekend cannot advance or break it.
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS streak_count INTEGER NOT NULL DEFAULT 0');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS streak_best INTEGER NOT NULL DEFAULT 0');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS streak_day TEXT');
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_google_id_idx ON users (google_id) WHERE google_id IS NOT NULL');
      await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires BIGINT NOT NULL)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS watchlist (
        uid TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, symbol TEXT NOT NULL, created BIGINT NOT NULL,
        PRIMARY KEY (uid, symbol))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL, direction TEXT NOT NULL, target DOUBLE PRECISION NOT NULL,
        created BIGINT NOT NULL, triggered BIGINT NOT NULL DEFAULT 0)`);
      // Every reading the site has shown, and what happened next. One row per
      // symbol per day: a score computed from daily bars cannot change until
      // the next daily close, so recording each view would only duplicate.
      await pool.query(`CREATE TABLE IF NOT EXISTS predictions (
        id TEXT PRIMARY KEY, symbol TEXT NOT NULL, day TEXT NOT NULL,
        score INTEGER NOT NULL, label TEXT NOT NULL, price DOUBLE PRECISION NOT NULL,
        created BIGINT NOT NULL,
        out_price DOUBLE PRECISION, out_day TEXT, ret DOUBLE PRECISION, graded BIGINT)`);
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS predictions_sym_day ON predictions (symbol, day)');
      await pool.query('CREATE INDEX IF NOT EXISTS predictions_ungraded ON predictions (symbol) WHERE graded IS NULL');
      await pool.query(`CREATE TABLE IF NOT EXISTS usage_daily (
        k TEXT NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (k, kind, day))`);
      mode = 'postgres';
    } catch (e) {
      lastErr = e.message;
      console.error('DB init failed — falling back to in-memory:', e.message);
      mode = 'memory';
    }
  }
  return mode;
}
const storeMode = () => mode;
const hasUrl = () => !!DATABASE_URL;
const lastError = () => lastErr;

// ---- password hashing (built-in scrypt, no deps) ----
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPw(pw, stored) {
  // A Google-only account has no password hash. Nothing can match it, so a
  // password attempt on such an account must fail rather than throw.
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  const a = Buffer.from(h), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const pub = (u) => u && { id: u.id, email: u.email, plan: u.plan };

// ---- streak ----
async function getStreak(uid) {
  const u = await getUserById(uid);
  if (!u) return null;
  return { count: u.streak_count || 0, best: u.streak_best || 0, day: u.streak_day || null };
}
async function saveStreak(uid, count, best, day) {
  if (mode === 'postgres') {
    await pool.query('UPDATE users SET streak_count=$2, streak_best=$3, streak_day=$4 WHERE id=$1',
      [uid, count, best, day]);
  } else {
    const u = mem.users.get(uid);
    if (u) { u.streak_count = count; u.streak_best = best; u.streak_day = day; }
  }
}

// ---- Google-linked accounts ----
// Three cases, in order: a returning Google user (match on google_id), someone
// whose email already has a password account (link the two), and a new user.
async function getUserByGoogleId(gid) {
  if (!gid) return null;
  if (mode === 'postgres') {
    const r = await pool.query('SELECT * FROM users WHERE google_id=$1', [String(gid)]);
    return r.rows[0] || null;
  }
  for (const u of mem.users.values()) if (u.google_id === String(gid)) return u;
  return null;
}

async function linkGoogleId(uid, gid) {
  if (mode === 'postgres') { await pool.query('UPDATE users SET google_id=$1 WHERE id=$2', [String(gid), uid]); return; }
  const u = mem.users.get(uid); if (u) u.google_id = String(gid);
}

// Created with no password: the only way in is Google until one is set.
async function createGoogleUser(email, gid) {
  email = String(email).toLowerCase().trim();
  const id = crypto.randomUUID();
  const rec = { id, email, pw: '', google_id: String(gid), plan: 'free', created: Date.now() };
  if (mode === 'postgres') {
    try {
      await pool.query('INSERT INTO users (id, email, pw, plan, created, google_id) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, email, '', 'free', rec.created, String(gid)]);
    } catch (e) { if (/duplicate|unique/i.test(e.message)) throw new Error('EMAIL_TAKEN'); throw e; }
  } else {
    if (mem.byEmail.has(email)) throw new Error('EMAIL_TAKEN');
    mem.users.set(id, rec); mem.byEmail.set(email, rec);
  }
  return rec;
}

// ---- users ----
async function createUser(email, pw) {
  email = String(email).toLowerCase().trim();
  const id = crypto.randomUUID();
  const rec = { id, email, pw: hashPw(pw), plan: 'free', created: Date.now() };
  if (mode === 'postgres') {
    try {
      await pool.query('INSERT INTO users (id, email, pw, plan, created) VALUES ($1,$2,$3,$4,$5)', [id, email, rec.pw, 'free', rec.created]);
    } catch (e) { if (/duplicate|unique/i.test(e.message)) throw new Error('EMAIL_TAKEN'); throw e; }
  } else {
    if (mem.byEmail.has(email)) throw new Error('EMAIL_TAKEN');
    mem.users.set(id, rec); mem.byEmail.set(email, rec);
  }
  return pub(rec);
}
async function getUserByEmail(email) {
  email = String(email).toLowerCase().trim();
  if (mode === 'postgres') { const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]); return r.rows[0] || null; }
  return mem.byEmail.get(email) || null;
}
async function getUserById(id) {
  if (mode === 'postgres') { const r = await pool.query('SELECT * FROM users WHERE id=$1', [id]); return r.rows[0] || null; }
  return mem.users.get(id) || null;
}

// ---- sessions ----
async function createSession(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_TTL;
  if (mode === 'postgres') await pool.query('INSERT INTO sessions (token, uid, expires) VALUES ($1,$2,$3)', [token, uid, expires]);
  else mem.sessions.set(token, { uid, expires });
  return token;
}
async function getSessionUser(token) {
  if (!token) return null;
  let s;
  if (mode === 'postgres') { const r = await pool.query('SELECT * FROM sessions WHERE token=$1', [token]); s = r.rows[0]; }
  else s = mem.sessions.get(token);
  if (!s || s.expires < Date.now()) { if (s) await deleteSession(token); return null; }
  return pub(await getUserById(s.uid));
}
async function deleteSession(token) {
  if (!token) return;
  if (mode === 'postgres') await pool.query('DELETE FROM sessions WHERE token=$1', [token]);
  else mem.sessions.delete(token);
}

// Expired sessions were only ever removed when someone presented the dead
// token, so a row for a visitor who never came back stayed forever. On a free
// Postgres plan that table is the one thing that grows without a ceiling.
async function purgeExpiredSessions() {
  const now = Date.now();
  if (mode === 'postgres') {
    const r = await pool.query('DELETE FROM sessions WHERE expires < $1', [now]);
    return r.rowCount || 0;
  }
  let n = 0;
  for (const [t, s] of mem.sessions) if (!s || s.expires < now) { mem.sessions.delete(t); n++; }
  return n;
}

// ---- watchlist ----
async function listWatch(uid) {
  if (mode === 'postgres') { const r = await pool.query('SELECT symbol FROM watchlist WHERE uid=$1 ORDER BY created DESC', [uid]); return r.rows.map(x => x.symbol); }
  return [...(mem.watch.get(uid) || new Map()).entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
}
async function addWatch(uid, symbol) {
  symbol = String(symbol).toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12);
  if (!symbol) return;
  if (mode === 'postgres') await pool.query('INSERT INTO watchlist (uid, symbol, created) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [uid, symbol, Date.now()]);
  else { if (!mem.watch.has(uid)) mem.watch.set(uid, new Map()); mem.watch.get(uid).set(symbol, Date.now()); }
}
async function removeWatch(uid, symbol) {
  symbol = String(symbol).toUpperCase();
  if (mode === 'postgres') await pool.query('DELETE FROM watchlist WHERE uid=$1 AND symbol=$2', [uid, symbol]);
  else if (mem.watch.has(uid)) mem.watch.get(uid).delete(symbol);
}

// ---- price alerts ----
async function listAlerts(uid) {
  if (mode === 'postgres') { const r = await pool.query('SELECT id, symbol, direction, target, created, triggered FROM alerts WHERE uid=$1 ORDER BY created DESC', [uid]); return r.rows.map(a => ({ ...a, target: Number(a.target), created: Number(a.created), triggered: Number(a.triggered) })); }
  return [...(mem.alerts.get(uid) || new Map()).values()].sort((a, b) => b.created - a.created);
}
async function addAlert(uid, symbol, direction, target) {
  const a = { id: crypto.randomUUID(), symbol, direction, target: Number(target), created: Date.now(), triggered: 0 };
  if (mode === 'postgres') await pool.query('INSERT INTO alerts (id, uid, symbol, direction, target, created, triggered) VALUES ($1,$2,$3,$4,$5,$6,0)', [a.id, uid, symbol, direction, a.target, a.created]);
  else { if (!mem.alerts.has(uid)) mem.alerts.set(uid, new Map()); mem.alerts.get(uid).set(a.id, a); }
  return a;
}
async function removeAlert(uid, id) {
  if (mode === 'postgres') await pool.query('DELETE FROM alerts WHERE uid=$1 AND id=$2', [uid, id]);
  else if (mem.alerts.has(uid)) mem.alerts.get(uid).delete(id);
}
async function markTriggered(uid, id, ts) {
  if (mode === 'postgres') await pool.query('UPDATE alerts SET triggered=$1 WHERE uid=$2 AND id=$3', [ts, uid, id]);
  else { const m = mem.alerts.get(uid); if (m && m.has(id)) m.get(id).triggered = ts; }
}

// ---- admin ----
async function listUsers(limit) {
  limit = limit || 200;
  if (mode === 'postgres') { const r = await pool.query('SELECT id, email, plan, created FROM users ORDER BY created DESC LIMIT $1', [limit]); return r.rows.map(u => ({ ...u, created: Number(u.created) })); }
  return [...mem.users.values()].map(u => ({ id: u.id, email: u.email, plan: u.plan, created: u.created })).sort((a, b) => b.created - a.created).slice(0, limit);
}
async function counts() {
  if (mode === 'postgres') {
    const [u, w, a] = await Promise.all([pool.query('SELECT count(*) FROM users'), pool.query('SELECT count(*) FROM watchlist'), pool.query('SELECT count(*) FROM alerts')]);
    return { users: +u.rows[0].count, watch: +w.rows[0].count, alerts: +a.rows[0].count };
  }
  const watch = [...mem.watch.values()].reduce((n, m) => n + m.size, 0);
  const alerts = [...mem.alerts.values()].reduce((n, m) => n + m.size, 0);
  return { users: mem.users.size, watch, alerts };
}

// ---- billing / plan ----
async function setPro(uid, customer, sub) {
  if (mode === 'postgres') await pool.query("UPDATE users SET plan='pro', stripe_customer=$2, stripe_sub=$3 WHERE id=$1", [uid, customer || null, sub || null]);
  else { const u = mem.users.get(uid); if (u) { u.plan = 'pro'; u.stripe_customer = customer; u.stripe_sub = sub; } }
}
async function setFree(uid) {
  if (mode === 'postgres') await pool.query("UPDATE users SET plan='free' WHERE id=$1", [uid]);
  else { const u = mem.users.get(uid); if (u) u.plan = 'free'; }
}
// Removes the account and everything hanging off it. Sessions, watchlist and
// alerts cascade in Postgres; the daily usage rows are keyed by account id and
// have no foreign key, so they are cleared explicitly.
async function deleteUser(uid) {
  if (mode === 'postgres') {
    await pool.query('DELETE FROM usage_daily WHERE k=$1', ['u:' + uid]);
    await pool.query('DELETE FROM users WHERE id=$1', [uid]);
    return;
  }
  const u = mem.users.get(uid);
  if (u) mem.byEmail.delete(u.email);
  mem.users.delete(uid);
  mem.watch.delete(uid);
  mem.alerts.delete(uid);
  for (const [t, s] of mem.sessions) if (s && (s.uid === uid || s === uid)) mem.sessions.delete(t);
  for (const k of [...mem.usage.keys()]) if (k.startsWith('u:' + uid + '|')) mem.usage.delete(k);
}

async function findByStripeSub(sub) {
  if (!sub) return null;
  if (mode === 'postgres') { const r = await pool.query('SELECT * FROM users WHERE stripe_sub=$1', [sub]); return r.rows[0] || null; }
  return [...mem.users.values()].find(u => u.stripe_sub === sub) || null;
}

// ---- daily usage counters ----
// Keyed by account id when signed in, by IP when not, so the free allowance
// cannot be reset by signing out. The day is a UTC date string, which means
// the allowance rolls over at midnight UTC rather than on a per-user timer.
const usageDay = (at) => new Date(at || Date.now()).toISOString().slice(0, 10);

async function bumpUsage(k, kind, limit) {
  const day = usageDay();
  if (mode === 'postgres') {
    const r = await pool.query(
      `INSERT INTO usage_daily (k, kind, day, n) VALUES ($1, $2, $3, 1)
       ON CONFLICT (k, kind, day) DO UPDATE SET n = usage_daily.n + 1 RETURNING n`,
      [k, kind, day]);
    const n = r.rows[0].n;
    return { n, remaining: Math.max(0, limit - n), over: n > limit };
  }
  const key = k + '|' + kind + '|' + day;
  const n = (mem.usage.get(key) || 0) + 1;
  mem.usage.set(key, n);
  // Memory mode has no eviction elsewhere; drop yesterday's keys as we go.
  if (mem.usage.size > 5000) for (const kk of mem.usage.keys()) if (!kk.endsWith('|' + day)) mem.usage.delete(kk);
  return { n, remaining: Math.max(0, limit - n), over: n > limit };
}

async function peekUsage(k, kind) {
  const day = usageDay();
  if (mode === 'postgres') {
    const r = await pool.query('SELECT n FROM usage_daily WHERE k=$1 AND kind=$2 AND day=$3', [k, kind, day]);
    return r.rows[0] ? r.rows[0].n : 0;
  }
  return mem.usage.get(k + '|' + kind + '|' + day) || 0;
}

// ---- Prediction record ----
// The point of this table is that it is written BEFORE the outcome is known
// and never rewritten afterwards. A backtest can be tuned until the history
// flatters you; a timestamped forward record cannot.
async function recordPrediction(p) {
  const key = p.symbol + '|' + p.day;
  if (mode === 'postgres') {
    // Do nothing on conflict: the first reading of the day is the one that
    // counts, so a later view cannot quietly revise it.
    await pool.query(
      `INSERT INTO predictions (id, symbol, day, score, label, price, created)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (symbol, day) DO NOTHING`,
      [crypto.randomUUID(), p.symbol, p.day, p.score, p.label, p.price, Date.now()]);
    return;
  }
  if (!mem.preds.has(key)) mem.preds.set(key, { id: key, ...p, created: Date.now(), graded: null });
}

async function ungradedFor(symbol) {
  if (mode === 'postgres') {
    const r = await pool.query('SELECT id, day, price FROM predictions WHERE symbol=$1 AND graded IS NULL', [symbol]);
    return r.rows;
  }
  return [...mem.preds.values()].filter(p => p.symbol === symbol && !p.graded).map(p => ({ id: p.id, day: p.day, price: p.price }));
}

async function gradePrediction(id, outPrice, outDay, ret) {
  if (mode === 'postgres') {
    await pool.query('UPDATE predictions SET out_price=$1, out_day=$2, ret=$3, graded=$4 WHERE id=$5 AND graded IS NULL',
      [outPrice, outDay, ret, Date.now(), id]);
    return;
  }
  const p = mem.preds.get(id);
  if (p && !p.graded) { p.out_price = outPrice; p.out_day = outDay; p.ret = ret; p.graded = Date.now(); }
}

// Aggregate for the public scoreboard. The comparison is every graded reading
// taken together — the return you would have had without consulting the score
// at all — so the score is measured against doing nothing, not against a
// benchmark chosen to flatter it.
async function accuracyStats() {
  let rows;
  if (mode === 'postgres') {
    const r = await pool.query('SELECT label, ret FROM predictions WHERE graded IS NOT NULL');
    rows = r.rows;
    const t = await pool.query('SELECT COUNT(*)::int AS n FROM predictions');
    var total = t.rows[0].n;
  } else {
    rows = [...mem.preds.values()].filter(p => p.graded).map(p => ({ label: p.label, ret: p.ret }));
    var total = mem.preds.size;
  }
  const byLabel = {};
  for (const r of rows) (byLabel[r.label] ||= []).push(Number(r.ret));
  const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const all = rows.map(r => Number(r.ret));
  return {
    recorded: total, graded: rows.length,
    baseline: mean(all),
    labels: Object.entries(byLabel).map(([label, a]) => ({
      label, n: a.length, mean: mean(a),
      winRate: a.length ? (a.filter(x => x > 0).length / a.length) * 100 : null,
    })),
  };
}

module.exports = {
  deleteUser,
  recordPrediction, ungradedFor, gradePrediction, accuracyStats,
  bumpUsage, peekUsage,
  getUserByGoogleId, linkGoogleId, createGoogleUser,
  init, storeMode, hasUrl, lastError, verifyPw,
  createUser, getUserByEmail, getUserById,
  createSession, getSessionUser, deleteSession, purgeExpiredSessions,
  getStreak, saveStreak,
  listWatch, addWatch, removeWatch,
  listAlerts, addAlert, removeAlert, markTriggered,
  listUsers, counts,
  setPro, setFree, findByStripeSub,
};
