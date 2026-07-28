// Data + auth layer for MarketLens accounts.
// Uses Postgres when DATABASE_URL is set (persistent), else an in-memory store
// (works for a demo but resets on restart — fine until a real DB is attached).
const crypto = require('crypto');

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const DAY = 86400000;
const SESSION_TTL = 30 * DAY;

let pool = null;
let mode = 'memory';
let lastErr = null;
const mem = { users: new Map(), byEmail: new Map(), sessions: new Map(), watch: new Map(), alerts: new Map() };

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
      await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires BIGINT NOT NULL)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS watchlist (
        uid TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, symbol TEXT NOT NULL, created BIGINT NOT NULL,
        PRIMARY KEY (uid, symbol))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL, direction TEXT NOT NULL, target DOUBLE PRECISION NOT NULL,
        created BIGINT NOT NULL, triggered BIGINT NOT NULL DEFAULT 0)`);
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
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  const a = Buffer.from(h), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const pub = (u) => u && { id: u.id, email: u.email, plan: u.plan };

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

module.exports = {
  init, storeMode, hasUrl, lastError, verifyPw,
  createUser, getUserByEmail, getUserById,
  createSession, getSessionUser, deleteSession,
  listWatch, addWatch, removeWatch,
  listAlerts, addAlert, removeAlert, markTriggered,
  listUsers, counts,
};
