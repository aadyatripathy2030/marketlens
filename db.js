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
const mem = { users: new Map(), byEmail: new Map(), sessions: new Map(), watch: new Map(),
  alerts: new Map(), usage: new Map(), preds: new Map(), etokens: new Map(), codes: new Map(),
  paper: new Map(), pos: new Map(), fills: new Map(), payouts: new Map(), ledger: [], settings: new Map() };

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
      // Whether the address has been confirmed by a link sent to it. Accounts
      // that predate confirmation default to TRUE; a new password account is
      // inserted FALSE and flips when its link is opened.
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE');
      await pool.query(`CREATE TABLE IF NOT EXISTS email_tokens (
        hash TEXT PRIMARY KEY, uid TEXT NOT NULL, expires BIGINT NOT NULL)`);
      // What the token is for: 'verify' (confirm the address) or 'payout' (the
      // link in the affiliate email). Checked on use, so one kind is never
      // accepted as the other.
      await pool.query("ALTER TABLE email_tokens ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'verify'");
      // Affiliate programme. affiliate_code is what goes in the member's
      // referral link (?ref=CODE); referred_by on another account is the code
      // it signed up through. Neither is a secret.
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS affiliate_code TEXT');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS affiliate_since BIGINT');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT');
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_affiliate_code_idx ON users (affiliate_code) WHERE affiliate_code IS NOT NULL');
      // How each affiliate asked to be paid. The form fields are stored only as
      // `enc`, which the server encrypts with a key held outside this database;
      // method, holder and last4 are the summary the admin table shows.
      await pool.query(`CREATE TABLE IF NOT EXISTS payouts (
        uid TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        method TEXT NOT NULL, holder TEXT NOT NULL, last4 TEXT NOT NULL,
        enc TEXT NOT NULL, updated BIGINT NOT NULL)`);
      // What each affiliate has earned and been paid, one row per event, in
      // cents. kind is commission (a referred account paid), refund (some of
      // that went back) or payout (the operator sent money; negative). The
      // balance is the plain sum. stripe_ref is the Stripe object the row came
      // from and is unique, so a webhook and the daily sync can both report
      // the same invoice without counting it twice. group_ref ties a refund to
      // the invoice whose commission it reverses.
      await pool.query(`CREATE TABLE IF NOT EXISTS affiliate_ledger (
        id TEXT PRIMARY KEY, aff_uid TEXT NOT NULL, ref_uid TEXT, kind TEXT NOT NULL,
        amount INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'usd',
        stripe_ref TEXT UNIQUE, group_ref TEXT, note TEXT, ts BIGINT NOT NULL)`);
      await pool.query('CREATE INDEX IF NOT EXISTS affiliate_ledger_aff_idx ON affiliate_ledger (aff_uid, ts DESC)');
      // Small named values the server must remember across restarts, such as
      // which month the automatic payout run last covered.
      await pool.query('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated BIGINT NOT NULL)');
      // When a referred account first paid: the commission window runs from it.
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS first_paid BIGINT');
      // Stripe Connect, for affiliates who set up payouts on Stripe's page:
      // their connected account id, whether Stripe will accept transfers to
      // it yet (pending | review | ready), the last four of the bank Stripe
      // holds for it, and when that was last checked.
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_account TEXT');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS connect_status TEXT');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS connect_last4 TEXT');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS connect_checked BIGINT');
      // A sign-in that is waiting for its emailed code. One row per attempt;
      // gone once the code is entered, used up, or expired.
      await pool.query(`CREATE TABLE IF NOT EXISTS login_codes (
        id TEXT PRIMARY KEY, uid TEXT NOT NULL, hash TEXT NOT NULL, expires BIGINT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0)`);
      // Streak, counted in trading days. streak_day is the market day the run
      // was last extended to, so a second visit the same day is a no-op and a
      // weekend cannot advance or break it.
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS streak_count INTEGER NOT NULL DEFAULT 0');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS streak_best INTEGER NOT NULL DEFAULT 0');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS streak_day TEXT');

      // Risk limits the user sets, applied to paper trades and shown against
      // real positions. Percentages of account value.
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_max_position INTEGER NOT NULL DEFAULT 20');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_per_trade INTEGER NOT NULL DEFAULT 2');

      // Paper trading. Cash and positions are separate rows so a position can
      // be closed without rewriting the account, and every fill is kept in
      // paper_trades so the history survives a position being flattened.
      await pool.query(`CREATE TABLE IF NOT EXISTS paper_accounts (
        uid TEXT PRIMARY KEY, cash DOUBLE PRECISION NOT NULL,
        start_balance DOUBLE PRECISION NOT NULL, created BIGINT NOT NULL)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS paper_positions (
        uid TEXT NOT NULL, symbol TEXT NOT NULL,
        qty DOUBLE PRECISION NOT NULL, avg_price DOUBLE PRECISION NOT NULL,
        opened BIGINT NOT NULL, PRIMARY KEY (uid, symbol))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS paper_trades (
        id TEXT PRIMARY KEY, uid TEXT NOT NULL, symbol TEXT NOT NULL,
        side TEXT NOT NULL, qty DOUBLE PRECISION NOT NULL,
        price DOUBLE PRECISION NOT NULL, realized DOUBLE PRECISION,
        ts BIGINT NOT NULL)`);
      await pool.query('CREATE INDEX IF NOT EXISTS paper_trades_uid_idx ON paper_trades (uid, ts DESC)');
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_google_id_idx ON users (google_id) WHERE google_id IS NOT NULL');
      await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires BIGINT NOT NULL)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS watchlist (
        uid TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, symbol TEXT NOT NULL, created BIGINT NOT NULL,
        PRIMARY KEY (uid, symbol))`);
      // A watched symbol can carry the price it was added at and the levels
      // the user set on it. Nullable: an entry only exists if a price was
      // available, and levels only once they are drawn.
      await pool.query('ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS entry DOUBLE PRECISION');
      await pool.query('ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS stop DOUBLE PRECISION');
      await pool.query('ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS target DOUBLE PRECISION');
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
      // The record stores the reading's display name, and those names changed
      // from bullish/bearish to buy/sell. The bands and thresholds did not move
      // -- "Very bullish" and "Strong buy" are the same 72-and-above band -- so
      // the stored names are brought along rather than left to show up as extra
      // rows on the accuracy page beside their own renamed selves. Idempotent,
      // so it is harmless on every boot after the first.
      // Then from buy/sell to lean words, in October 2026, for the same
      // reason in the other direction: the buy/sell words belong to the
      // measured signal alone now.
      for (const [was, now] of [['Very bullish', 'Strong buy'], ['Bullish', 'Buy'],
                                ['Bearish', 'Sell'], ['Very bearish', 'Strong sell'],
                                ['Strong buy', 'Strongly up'], ['Buy', 'Leans up'],
                                ['Sell', 'Leans down'], ['Strong sell', 'Strongly down']]) {
        await pool.query('UPDATE predictions SET label=$2 WHERE label=$1', [was, now]);
      }
      await pool.query(`CREATE TABLE IF NOT EXISTS usage_daily (
        k TEXT NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (k, kind, day))`);
      mode = 'postgres';
    } catch (e) {
      lastErr = e.message;
      console.error('DB init failed — falling back to in-memory:', e.message);
      // Closed, so a retry can open a fresh one without leaking the old.
      if (pool) { pool.end().catch(() => {}); pool = null; }
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

const pub = (u) => u && { id: u.id, email: u.email, plan: u.plan, verified: u.email_verified !== false };

// ---- risk limits ----
const RISK_DEFAULTS = { maxPosition: 20, perTrade: 2 };
async function getRisk(uid) {
  const u = await getUserById(uid);
  if (!u) return { ...RISK_DEFAULTS };
  return {
    maxPosition: Number.isFinite(u.risk_max_position) ? u.risk_max_position : RISK_DEFAULTS.maxPosition,
    perTrade: Number.isFinite(u.risk_per_trade) ? u.risk_per_trade : RISK_DEFAULTS.perTrade,
  };
}
async function saveRisk(uid, maxPosition, perTrade) {
  if (mode === 'postgres') {
    await pool.query('UPDATE users SET risk_max_position=$2, risk_per_trade=$3 WHERE id=$1', [uid, maxPosition, perTrade]);
  } else {
    const u = mem.users.get(uid);
    if (u) { u.risk_max_position = maxPosition; u.risk_per_trade = perTrade; }
  }
}

// ---- paper trading ----
async function getPaper(uid) {
  if (mode === 'postgres') {
    const r = await pool.query('SELECT cash, start_balance, created FROM paper_accounts WHERE uid=$1', [uid]);
    if (!r.rows[0]) return null;
    return { cash: Number(r.rows[0].cash), startBalance: Number(r.rows[0].start_balance), created: Number(r.rows[0].created) };
  }
  return mem.paper.get(uid) || null;
}
async function openPaper(uid, startBalance) {
  const rec = { cash: startBalance, startBalance, created: Date.now() };
  if (mode === 'postgres') {
    await pool.query(`INSERT INTO paper_accounts (uid, cash, start_balance, created) VALUES ($1,$2,$3,$4)
      ON CONFLICT (uid) DO UPDATE SET cash=$2, start_balance=$3, created=$4`,
      [uid, rec.cash, rec.startBalance, rec.created]);
    await pool.query('DELETE FROM paper_positions WHERE uid=$1', [uid]);
    await pool.query('DELETE FROM paper_trades WHERE uid=$1', [uid]);
  } else {
    mem.paper.set(uid, rec); mem.pos.set(uid, new Map()); mem.fills.set(uid, []);
  }
  return rec;
}
async function clearPaper(uid) {
  if (mode === 'postgres') {
    await pool.query('DELETE FROM paper_positions WHERE uid=$1', [uid]);
    await pool.query('DELETE FROM paper_trades WHERE uid=$1', [uid]);
    await pool.query('DELETE FROM paper_accounts WHERE uid=$1', [uid]);
  } else {
    mem.paper.delete(uid); mem.pos.delete(uid); mem.fills.delete(uid);
  }
}
async function setCash(uid, cash) {
  if (mode === 'postgres') await pool.query('UPDATE paper_accounts SET cash=$2 WHERE uid=$1', [uid, cash]);
  else { const a = mem.paper.get(uid); if (a) a.cash = cash; }
}
async function listPositions(uid) {
  if (mode === 'postgres') {
    const r = await pool.query('SELECT symbol, qty, avg_price, opened FROM paper_positions WHERE uid=$1 ORDER BY opened', [uid]);
    return r.rows.map(x => ({ symbol: x.symbol, qty: Number(x.qty), avgPrice: Number(x.avg_price), opened: Number(x.opened) }));
  }
  return [...(mem.pos.get(uid) || new Map()).values()];
}
async function savePosition(uid, p) {
  if (mode === 'postgres') {
    await pool.query(`INSERT INTO paper_positions (uid, symbol, qty, avg_price, opened) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (uid, symbol) DO UPDATE SET qty=$3, avg_price=$4`, [uid, p.symbol, p.qty, p.avgPrice, p.opened]);
  } else {
    if (!mem.pos.has(uid)) mem.pos.set(uid, new Map());
    mem.pos.get(uid).set(p.symbol, p);
  }
}
async function dropPosition(uid, symbol) {
  if (mode === 'postgres') await pool.query('DELETE FROM paper_positions WHERE uid=$1 AND symbol=$2', [uid, symbol]);
  else if (mem.pos.has(uid)) mem.pos.get(uid).delete(symbol);
}
async function addFill(uid, f) {
  const row = { id: crypto.randomUUID(), uid, ...f, ts: Date.now() };
  if (mode === 'postgres') {
    await pool.query('INSERT INTO paper_trades (id, uid, symbol, side, qty, price, realized, ts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [row.id, uid, row.symbol, row.side, row.qty, row.price, row.realized == null ? null : row.realized, row.ts]);
  } else {
    if (!mem.fills.has(uid)) mem.fills.set(uid, []);
    mem.fills.get(uid).unshift(row);
  }
  return row;
}
async function listFills(uid, limit) {
  limit = Math.min(200, Math.max(1, limit || 50));
  if (mode === 'postgres') {
    const r = await pool.query('SELECT symbol, side, qty, price, realized, ts FROM paper_trades WHERE uid=$1 ORDER BY ts DESC LIMIT $2', [uid, limit]);
    return r.rows.map(x => ({ symbol: x.symbol, side: x.side, qty: Number(x.qty), price: Number(x.price),
      realized: x.realized == null ? null : Number(x.realized), ts: Number(x.ts) }));
  }
  return (mem.fills.get(uid) || []).slice(0, limit);
}

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

// Google has confirmed the address by the time this runs, so a password
// account that was never confirmed becomes confirmed here.
async function linkGoogleId(uid, gid) {
  if (mode === 'postgres') { await pool.query('UPDATE users SET google_id=$1, email_verified=TRUE WHERE id=$2', [String(gid), uid]); return; }
  const u = mem.users.get(uid); if (u) { u.google_id = String(gid); u.email_verified = true; }
}

// Created with no password: the only way in is Google until one is set.
async function createGoogleUser(email, gid) {
  email = String(email).toLowerCase().trim();
  const id = crypto.randomUUID();
  const rec = { id, email, pw: '', google_id: String(gid), plan: 'free', created: Date.now(), email_verified: true };
  if (mode === 'postgres') {
    try {
      await pool.query('INSERT INTO users (id, email, pw, plan, created, google_id, email_verified) VALUES ($1,$2,$3,$4,$5,$6,TRUE)',
        [id, email, '', 'free', rec.created, String(gid)]);
    } catch (e) { if (/duplicate|unique/i.test(e.message)) throw new Error('EMAIL_TAKEN'); throw e; }
  } else {
    if (mem.byEmail.has(email)) throw new Error('EMAIL_TAKEN');
    mem.users.set(id, rec); mem.byEmail.set(email, rec);
  }
  return rec;
}

// ---- users ----
// `verified` is true only when there is no way to send a confirmation link,
// in which case the account is usable at once.
async function createUser(email, pw, verified) {
  email = String(email).toLowerCase().trim();
  const id = crypto.randomUUID();
  const rec = { id, email, pw: hashPw(pw), plan: 'free', created: Date.now(), email_verified: !!verified };
  if (mode === 'postgres') {
    try {
      await pool.query('INSERT INTO users (id, email, pw, plan, created, email_verified) VALUES ($1,$2,$3,$4,$5,$6)', [id, email, rec.pw, 'free', rec.created, !!verified]);
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

// ---- email confirmation ----
const VERIFY_TTL = 24 * 60 * 60 * 1000;
const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
// The raw token goes in the link; only its hash is stored, so a copy of the
// database does not contain working links.
// kind defaults to the confirmation link; 'payout' is the link in the
// affiliate email, which lives longer and is checked rather than spent when
// the page is opened.
async function createVerifyToken(uid, kind, ttl) {
  kind = kind || 'verify';
  const raw = crypto.randomBytes(32).toString('hex');
  const rec = { hash: tokenHash(raw), uid, kind, expires: Date.now() + (ttl || VERIFY_TTL) };
  if (mode === 'postgres') await pool.query('INSERT INTO email_tokens (hash, uid, expires, kind) VALUES ($1,$2,$3,$4)', [rec.hash, uid, rec.expires, kind]);
  else mem.etokens.set(rec.hash, rec);
  return raw;
}
// Single use: the row goes whether or not it was still valid.
async function consumeVerifyToken(raw, kind) {
  if (!raw) return null;
  kind = kind || 'verify';
  const h = tokenHash(raw);
  let rec;
  if (mode === 'postgres') {
    const r = await pool.query('DELETE FROM email_tokens WHERE hash=$1 AND kind=$2 RETURNING uid, expires', [h, kind]);
    rec = r.rows[0];
  } else { rec = mem.etokens.get(h); if (rec && (rec.kind || 'verify') !== kind) rec = null; else mem.etokens.delete(h); }
  if (!rec || Number(rec.expires) < Date.now()) return null;
  return rec.uid;
}
// Looks without spending, so the page a link opens can be refreshed.
async function peekToken(raw, kind) {
  if (!raw) return null;
  kind = kind || 'verify';
  const h = tokenHash(raw);
  let rec;
  if (mode === 'postgres') {
    const r = await pool.query('SELECT uid, expires FROM email_tokens WHERE hash=$1 AND kind=$2', [h, kind]);
    rec = r.rows[0];
  } else { rec = mem.etokens.get(h); if (rec && (rec.kind || 'verify') !== kind) rec = null; }
  if (!rec || Number(rec.expires) < Date.now()) return null;
  return rec.uid;
}
async function markVerified(uid) {
  if (mode === 'postgres') {
    await pool.query('UPDATE users SET email_verified=TRUE WHERE id=$1', [uid]);
    await pool.query("DELETE FROM email_tokens WHERE uid=$1 AND kind='verify'", [uid]);
    return;
  }
  const u = mem.users.get(uid); if (u) u.email_verified = true;
  for (const [h, t] of mem.etokens) if (t.uid === uid && (t.kind || 'verify') === 'verify') mem.etokens.delete(h);
}
// For a sign-up over an address that is registered but never confirmed: the
// new password replaces the old, so whoever can open the inbox ends up with
// the account rather than whoever typed the address first.
async function setPassword(uid, pw) {
  const hashed = hashPw(pw);
  if (mode === 'postgres') { await pool.query('UPDATE users SET pw=$1 WHERE id=$2', [hashed, uid]); return; }
  const u = mem.users.get(uid); if (u) u.pw = hashed;
}

// ---- sign-in codes ----
// Six digits is little entropy, so the protection is the attempt limit, not
// the hash: five wrong guesses end the attempt and ten minutes expire it.
const CODE_TTL = 10 * 60 * 1000, CODE_MAX_ATTEMPTS = 5;
async function createLoginCode(uid) {
  const id = crypto.randomBytes(16).toString('hex');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const rec = { id, uid, hash: tokenHash(id + ':' + code), expires: Date.now() + CODE_TTL, attempts: 0 };
  if (mode === 'postgres') await pool.query('INSERT INTO login_codes (id, uid, hash, expires, attempts) VALUES ($1,$2,$3,$4,0)', [id, uid, rec.hash, rec.expires]);
  else mem.codes.set(id, rec);
  return { id, code };
}
async function getLoginCode(id) {
  if (!id) return null;
  let rec;
  if (mode === 'postgres') { const r = await pool.query('SELECT * FROM login_codes WHERE id=$1', [id]); rec = r.rows[0]; }
  else rec = mem.codes.get(id);
  if (!rec) return null;
  if (Number(rec.expires) < Date.now()) { await deleteLoginCode(id); return null; }
  return rec;
}
async function deleteLoginCode(id) {
  if (!id) return;
  if (mode === 'postgres') await pool.query('DELETE FROM login_codes WHERE id=$1', [id]);
  else mem.codes.delete(id);
}
// { uid } when the code is right; { left } with the guesses remaining when it
// is wrong (0 means the attempt is over); null when there is no live attempt.
async function checkLoginCode(id, code) {
  const rec = await getLoginCode(id);
  if (!rec) return null;
  if (rec.hash === tokenHash(id + ':' + code)) { await deleteLoginCode(id); return { uid: rec.uid }; }
  const attempts = Number(rec.attempts) + 1;
  if (attempts >= CODE_MAX_ATTEMPTS) { await deleteLoginCode(id); return { left: 0 }; }
  if (mode === 'postgres') await pool.query('UPDATE login_codes SET attempts=$1 WHERE id=$2', [attempts, id]);
  else rec.attempts = attempts;
  return { left: CODE_MAX_ATTEMPTS - attempts };
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
  // Confirmation links that were never opened go the same way.
  if (mode === 'postgres') {
    await pool.query('DELETE FROM email_tokens WHERE expires < $1', [now]);
    await pool.query('DELETE FROM login_codes WHERE expires < $1', [now]);
  } else {
    for (const [h, t] of mem.etokens) if (t.expires < now) mem.etokens.delete(h);
    for (const [id, c] of mem.codes) if (c.expires < now) mem.codes.delete(id);
  }
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
  return (await listWatchFull(uid)).map(r => r.symbol);
}
// The same rows with the entry price and the user's levels attached.
async function listWatchFull(uid) {
  if (mode === 'postgres') {
    const r = await pool.query('SELECT symbol, created, entry, stop, target FROM watchlist WHERE uid=$1 ORDER BY created DESC', [uid]);
    return r.rows.map(x => ({
      symbol: x.symbol, created: Number(x.created),
      entry: x.entry == null ? null : Number(x.entry),
      stop: x.stop == null ? null : Number(x.stop),
      target: x.target == null ? null : Number(x.target),
    }));
  }
  return [...(mem.watch.get(uid) || new Map()).values()]
    .sort((a, b) => b.created - a.created)
    .map(r => ({ symbol: r.symbol, created: r.created,
      entry: r.entry == null ? null : Number(r.entry),
      stop: r.stop == null ? null : Number(r.stop),
      target: r.target == null ? null : Number(r.target) }));
}
async function addWatch(uid, symbol, entry) {
  symbol = String(symbol).toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12);
  if (!symbol) return;
  const e = Number.isFinite(Number(entry)) && Number(entry) > 0 ? Number(entry) : null;
  if (mode === 'postgres') {
    await pool.query('INSERT INTO watchlist (uid, symbol, created, entry) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [uid, symbol, Date.now(), e]);
  } else {
    if (!mem.watch.has(uid)) mem.watch.set(uid, new Map());
    const m = mem.watch.get(uid);
    if (!m.has(symbol)) m.set(symbol, { symbol, created: Date.now(), entry: e, stop: null, target: null });
  }
}
// null clears a level; undefined leaves it alone.
async function setWatchLevels(uid, symbol, patch) {
  symbol = String(symbol).toUpperCase();
  const clean = (v) => {
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const entry = clean(patch.entry), stop = clean(patch.stop), target = clean(patch.target);
  if (mode === 'postgres') {
    const sets = [], vals = [uid, symbol];
    if (entry !== undefined) { vals.push(entry); sets.push('entry=$' + vals.length); }
    if (stop !== undefined) { vals.push(stop); sets.push('stop=$' + vals.length); }
    if (target !== undefined) { vals.push(target); sets.push('target=$' + vals.length); }
    if (!sets.length) return;
    await pool.query('UPDATE watchlist SET ' + sets.join(', ') + ' WHERE uid=$1 AND symbol=$2', vals);
  } else {
    const m = mem.watch.get(uid);
    if (!m || !m.has(symbol)) return;
    const row = m.get(symbol);
    if (entry !== undefined) row.entry = entry;
    if (stop !== undefined) row.stop = stop;
    if (target !== undefined) row.target = target;
  }
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

// ---- affiliates ----
// Codes are short and upper-case so they survive being read out loud or typed
// from a screenshot; the alphabet leaves out 0/O and 1/I for the same reason.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newAffiliateCode() {
  const b = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}
async function getUserByAffiliateCode(code) {
  code = String(code || '').toUpperCase().trim();
  if (!code) return null;
  if (mode === 'postgres') { const r = await pool.query('SELECT * FROM users WHERE affiliate_code=$1', [code]); return r.rows[0] || null; }
  for (const u of mem.users.values()) if (u.affiliate_code === code) return u;
  return null;
}
// Idempotent: an account that already has a code keeps it, so pressing the
// button twice does not break a link that is already out in the world.
async function makeAffiliate(uid) {
  const u = await getUserById(uid);
  if (!u) return null;
  if (u.affiliate_code) return u.affiliate_code;
  for (let i = 0; i < 5; i++) {
    const code = newAffiliateCode();
    if (await getUserByAffiliateCode(code)) continue;
    if (mode === 'postgres') await pool.query('UPDATE users SET affiliate_code=$2, affiliate_since=$3 WHERE id=$1', [uid, code, Date.now()]);
    else { u.affiliate_code = code; u.affiliate_since = Date.now(); }
    return code;
  }
  throw new Error('could not allot an affiliate code');
}
async function dropAffiliate(uid) {
  if (mode === 'postgres') { await pool.query('UPDATE users SET affiliate_code=NULL, affiliate_since=NULL WHERE id=$1', [uid]); return; }
  const u = mem.users.get(uid); if (u) { u.affiliate_code = null; u.affiliate_since = null; }
}
// Written once, at sign-up, and only when the account has no referrer yet.
async function setReferrer(uid, code) {
  if (mode === 'postgres') { await pool.query('UPDATE users SET referred_by=$2 WHERE id=$1 AND referred_by IS NULL', [uid, code]); return; }
  const u = mem.users.get(uid); if (u && !u.referred_by) u.referred_by = code;
}
async function countReferrals(code) {
  if (!code) return 0;
  if (mode === 'postgres') { const r = await pool.query('SELECT count(*) FROM users WHERE referred_by=$1', [code]); return +r.rows[0].count; }
  let n = 0; for (const u of mem.users.values()) if (u.referred_by === code) n++;
  return n;
}
// The summary row the admin table shows and the settings card reads. Never
// includes enc.
async function payoutSummary(uid) {
  let p;
  if (mode === 'postgres') { const r = await pool.query('SELECT method, holder, last4, updated FROM payouts WHERE uid=$1', [uid]); p = r.rows[0]; }
  else p = mem.payouts.get(uid);
  return p ? { method: p.method, holder: p.holder, last4: p.last4, updated: Number(p.updated) } : null;
}
async function getPayout(uid) {
  if (mode === 'postgres') { const r = await pool.query('SELECT * FROM payouts WHERE uid=$1', [uid]); return r.rows[0] || null; }
  return mem.payouts.get(uid) || null;
}
async function savePayout(uid, p) {
  const rec = { uid, method: p.method, holder: p.holder, last4: p.last4, enc: p.enc, updated: Date.now() };
  if (mode === 'postgres') {
    await pool.query(`INSERT INTO payouts (uid, method, holder, last4, enc, updated) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (uid) DO UPDATE SET method=EXCLUDED.method, holder=EXCLUDED.holder, last4=EXCLUDED.last4, enc=EXCLUDED.enc, updated=EXCLUDED.updated`,
      [uid, rec.method, rec.holder, rec.last4, rec.enc, rec.updated]);
    return;
  }
  mem.payouts.set(uid, rec);
}
// ---- Stripe Connect ----
async function setConnectAccount(uid, acct) {
  if (mode === 'postgres') { await pool.query("UPDATE users SET stripe_account=$2, connect_status='pending', connect_checked=$3 WHERE id=$1", [uid, acct, Date.now()]); return; }
  const u = mem.users.get(uid); if (u) { u.stripe_account = acct; u.connect_status = 'pending'; u.connect_checked = Date.now(); }
}
async function setConnectStatus(uid, status, last4) {
  if (mode === 'postgres') { await pool.query('UPDATE users SET connect_status=$2, connect_last4=$3, connect_checked=$4 WHERE id=$1', [uid, status, last4 || null, Date.now()]); return; }
  const u = mem.users.get(uid); if (u) { u.connect_status = status; u.connect_last4 = last4 || null; u.connect_checked = Date.now(); }
}
const connectOf = (u) => u && u.stripe_account ? { status: u.connect_status || 'pending', last4: u.connect_last4 || null } : null;

// ---- affiliate ledger ----
async function findByStripeCustomer(cust) {
  if (!cust) return null;
  if (mode === 'postgres') { const r = await pool.query('SELECT * FROM users WHERE stripe_customer=$1', [cust]); return r.rows[0] || null; }
  return [...mem.users.values()].find(u => u.stripe_customer === cust) || null;
}
// Written once; a later, earlier-dated payment (the sync walking back through
// history) moves it back, so the window always starts at the true first one.
async function setFirstPaid(uid, ts) {
  if (mode === 'postgres') { await pool.query('UPDATE users SET first_paid=$2 WHERE id=$1 AND (first_paid IS NULL OR first_paid > $2)', [uid, ts]); return; }
  const u = mem.users.get(uid); if (u && (!u.first_paid || u.first_paid > ts)) u.first_paid = ts;
}
// True when the row was new; false when stripe_ref had already been recorded.
async function addLedger(r) {
  const row = { id: crypto.randomUUID(), aff_uid: r.aff_uid, ref_uid: r.ref_uid || null, kind: r.kind, amount: Math.round(r.amount),
    currency: r.currency || 'usd', stripe_ref: r.stripe_ref || null, group_ref: r.group_ref || null, note: r.note || null, ts: r.ts || Date.now() };
  if (mode === 'postgres') {
    const q = await pool.query(`INSERT INTO affiliate_ledger (id, aff_uid, ref_uid, kind, amount, currency, stripe_ref, group_ref, note, ts)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (stripe_ref) DO NOTHING RETURNING id`,
      [row.id, row.aff_uid, row.ref_uid, row.kind, row.amount, row.currency, row.stripe_ref, row.group_ref, row.note, row.ts]);
    return q.rowCount > 0;
  }
  if (row.stripe_ref && mem.ledger.some(x => x.stripe_ref === row.stripe_ref)) return false;
  mem.ledger.push(row);
  return true;
}
async function ledgerByRef(ref) {
  if (!ref) return null;
  if (mode === 'postgres') { const r = await pool.query('SELECT * FROM affiliate_ledger WHERE stripe_ref=$1', [ref]); return r.rows[0] || null; }
  return mem.ledger.find(x => x.stripe_ref === ref) || null;
}
// Sum of one kind of row under a group, e.g. how much of an invoice's
// commission has already been reversed.
async function ledgerGroupSum(group, kind) {
  if (mode === 'postgres') { const r = await pool.query('SELECT coalesce(sum(amount),0) AS s FROM affiliate_ledger WHERE group_ref=$1 AND kind=$2', [group, kind]); return Number(r.rows[0].s); }
  return mem.ledger.filter(x => x.group_ref === group && x.kind === kind).reduce((s, x) => s + x.amount, 0);
}
// earned = commissions less refunds; paid = what has been sent; owed = balance.
// rows is how many ledger rows the account has: it only ever grows, so
// (owed, rows) names a balance state exactly.
async function ledgerTotals(uid) {
  let rows, n = 0;
  if (mode === 'postgres') { const r = await pool.query('SELECT kind, sum(amount) AS s, count(*) AS n FROM affiliate_ledger WHERE aff_uid=$1 GROUP BY kind', [uid]); rows = r.rows.map(x => { n += Number(x.n); return [x.kind, Number(x.s)]; }); }
  else { const m = {}; for (const x of mem.ledger) if (x.aff_uid === uid) { n++; m[x.kind] = (m[x.kind] || 0) + x.amount; } rows = Object.entries(m); }
  const by = Object.fromEntries(rows);
  const earned = (by.commission || 0) + (by.refund || 0);
  const paid = -(by.payout || 0);
  return { earned, paid, owed: earned - paid, rows: n };
}
async function ledgerRows(uid, limit) {
  limit = limit || 50;
  if (mode === 'postgres') { const r = await pool.query('SELECT kind, amount, currency, note, ts FROM affiliate_ledger WHERE aff_uid=$1 ORDER BY ts DESC LIMIT $2', [uid, limit]); return r.rows.map(x => ({ ...x, ts: Number(x.ts) })); }
  return mem.ledger.filter(x => x.aff_uid === uid).sort((a, b) => b.ts - a.ts).slice(0, limit).map(({ kind, amount, currency, note, ts }) => ({ kind, amount, currency, note, ts }));
}

// Named values; JSON in, JSON out. Missing keys read as null.
async function getSetting(key) {
  if (mode === 'postgres') { const r = await pool.query('SELECT value FROM settings WHERE key=$1', [key]); return r.rows[0] ? JSON.parse(r.rows[0].value) : null; }
  return mem.settings.has(key) ? mem.settings.get(key) : null;
}
async function setSetting(key, value) {
  if (mode === 'postgres') {
    await pool.query('INSERT INTO settings (key, value, updated) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated=EXCLUDED.updated', [key, JSON.stringify(value), Date.now()]);
    return;
  }
  mem.settings.set(key, value);
}

async function affiliateInfo(uid) {
  const u = await getUserById(uid);
  if (!u || !u.affiliate_code) return null;
  return { code: u.affiliate_code, since: Number(u.affiliate_since) || null,
    referrals: await countReferrals(u.affiliate_code), payout: await payoutSummary(uid), connect: connectOf(u), totals: await ledgerTotals(uid) };
}
async function listAffiliates() {
  let rows;
  if (mode === 'postgres') {
    const r = await pool.query('SELECT id, email, affiliate_code, affiliate_since, stripe_account, connect_status, connect_last4, connect_checked FROM users WHERE affiliate_code IS NOT NULL ORDER BY affiliate_since DESC NULLS LAST');
    rows = r.rows;
  } else rows = [...mem.users.values()].filter(u => u.affiliate_code).sort((a, b) => (b.affiliate_since || 0) - (a.affiliate_since || 0));
  const out = [];
  for (const u of rows) {
    out.push({ id: u.id, email: u.email, code: u.affiliate_code, since: Number(u.affiliate_since) || null,
      referrals: await countReferrals(u.affiliate_code), payout: await payoutSummary(u.id), connect: connectOf(u),
      connectChecked: Number(u.connect_checked) || 0, totals: await ledgerTotals(u.id) });
  }
  return out;
}

// ---- admin ----
async function listUsers(limit) {
  limit = limit || 200;
  if (mode === 'postgres') { const r = await pool.query('SELECT id, email, plan, created, stripe_sub, affiliate_code, referred_by FROM users ORDER BY created DESC LIMIT $1', [limit]); return r.rows.map(u => ({ ...u, created: Number(u.created) })); }
  return [...mem.users.values()].map(u => ({ id: u.id, email: u.email, plan: u.plan, created: u.created, stripe_sub: u.stripe_sub, affiliate_code: u.affiliate_code || null, referred_by: u.referred_by || null })).sort((a, b) => b.created - a.created).slice(0, limit);
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
    await pool.query('DELETE FROM email_tokens WHERE uid=$1', [uid]);
    await pool.query('DELETE FROM login_codes WHERE uid=$1', [uid]);
    await pool.query('DELETE FROM payouts WHERE uid=$1', [uid]);
    await pool.query('DELETE FROM affiliate_ledger WHERE aff_uid=$1', [uid]);
    await pool.query('DELETE FROM users WHERE id=$1', [uid]);
    return;
  }
  const u = mem.users.get(uid);
  if (u) mem.byEmail.delete(u.email);
  mem.users.delete(uid);
  mem.payouts.delete(uid);
  mem.ledger = mem.ledger.filter(x => x.aff_uid !== uid);
  for (const [h, t] of mem.etokens) if (t.uid === uid) mem.etokens.delete(h);
  for (const [id, c] of mem.codes) if (c.uid === uid) mem.codes.delete(id);
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
  let rows, oldestPending = null;
  if (mode === 'postgres') {
    const r = await pool.query('SELECT label, ret FROM predictions WHERE graded IS NOT NULL');
    rows = r.rows;
    const t = await pool.query('SELECT COUNT(*)::int AS n FROM predictions');
    var total = t.rows[0].n;
    // The earliest reading still waiting on its outcome, so a record with
    // nothing in it yet can say when it will have something rather than
    // looking broken or abandoned.
    const o = await pool.query('SELECT MIN(day) AS d FROM predictions WHERE graded IS NULL');
    oldestPending = (o.rows[0] && o.rows[0].d) || null;
  } else {
    rows = [...mem.preds.values()].filter(p => p.graded).map(p => ({ label: p.label, ret: p.ret }));
    var total = mem.preds.size;
    for (const p of mem.preds.values()) {
      if (!p.graded && (!oldestPending || p.day < oldestPending)) oldestPending = p.day;
    }
  }
  const byLabel = {};
  // Readings recorded before the labels changed wording are folded into the
  // row they now belong to, so the record stays one record.
  const LEGACY_LABEL = { 'Strong buy': 'Strongly up', 'Buy': 'Leans up', 'Sell': 'Leans down', 'Strong sell': 'Strongly down' };
  for (const r of rows) (byLabel[LEGACY_LABEL[r.label] || r.label] ||= []).push(Number(r.ret));
  const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const all = rows.map(r => Number(r.ret));
  return {
    recorded: total, graded: rows.length, oldestPending,
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
  createVerifyToken, consumeVerifyToken, peekToken, markVerified, setPassword,
  makeAffiliate, dropAffiliate, getUserByAffiliateCode, setReferrer, countReferrals,
  affiliateInfo, listAffiliates, getPayout, savePayout, payoutSummary,
  findByStripeCustomer, setFirstPaid, addLedger, ledgerByRef, ledgerGroupSum, ledgerTotals, ledgerRows,
  setConnectAccount, setConnectStatus, getSetting, setSetting,
  createLoginCode, getLoginCode, checkLoginCode, deleteLoginCode,
  getStreak, saveStreak,
  getRisk, saveRisk, RISK_DEFAULTS,
  getPaper, openPaper, clearPaper, setCash, listPositions, savePosition, dropPosition, addFill, listFills,
  listWatch, listWatchFull, addWatch, removeWatch, setWatchLevels,
  listAlerts, addAlert, removeAlert, markTriggered,
  listUsers, counts,
  setPro, setFree, findByStripeSub,
};
