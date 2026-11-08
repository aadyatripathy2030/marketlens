// Free-trial abuse checks (Nov 2026).
//
// One free trial per person. Checking only the account (as checkout did) is
// beaten by making another account, so a trial is checked against every
// signal that tends to stay the same across someone's accounts:
//
//   email     the address with aliases folded (Gmail dots, +tags), so
//             a.b+2@gmail.com and ab@gmail.com are one person
//   device    a random id in an HttpOnly cookie, and a second one the page
//             keeps in local storage (clearing one rarely clears both)
//   fp        a browser fingerprint: screen, time zone, languages, GPU,
//             canvas rendering and similar, hashed in the browser
//   ip / net  the address, and its network block (/24, or /48 for IPv6)
//   card      the card's Stripe fingerprint, checked after checkout, the
//             strongest signal there is, and the one hardest to change
//
// plus a few that say "made to be thrown away": a disposable email domain,
// an account minutes old, an automated browser, a Tor exit.
//
// Every signal is stored as an HMAC under a key kept in the database, never
// as the raw value, so the table cannot be read back into IPs or emails. The
// rows outlive the account on purpose (deleting the account and signing up
// again is the abuse being stopped) and are purged after about 13 months.
//
// The score only ever withholds the TRIAL. Anyone can still subscribe and
// pay; nobody is locked out of anything by a guess.
const crypto = require('crypto');

const DAY = 86400000;
const NO_TRIAL_AT = Number(process.env.TRIAL_RISK_NO_TRIAL || 40);   // this score or more: no trial
const FLAG_AT = Number(process.env.TRIAL_RISK_FLAG || 70);           // this or more: shown red on the admin page
const KEEP_DAYS = 400;

let key = null;
// The HMAC key: from TRIAL_GUARD_KEY if set, otherwise made once and kept in
// the settings table so it survives restarts and deploys.
async function init(db) {
  const env = (process.env.TRIAL_GUARD_KEY || '').trim();
  if (env) { key = env; return; }
  try {
    let k = await db.getSetting('trial_guard_key');
    if (!k) { k = crypto.randomBytes(32).toString('hex'); await db.setSetting('trial_guard_key', k); }
    key = k;
  } catch (e) { key = null; }
}
const ready = () => !!key;
const h = (kind, v) => (key && v) ? crypto.createHmac('sha256', key).update(kind + ':' + String(v)).digest('hex').slice(0, 40) : null;

// Gmail ignores dots and anything after +; most providers ignore +tags.
function normEmail(email) {
  email = String(email || '').toLowerCase().trim();
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  let local = email.slice(0, at), dom = email.slice(at + 1);
  if (dom === 'googlemail.com') dom = 'gmail.com';
  local = local.split('+')[0];
  if (dom === 'gmail.com') local = local.replace(/\./g, '');
  return local + '@' + dom;
}
// Common throwaway-inbox services. Not exhaustive, and it does not need to
// be: it is one signal among several.
const DISPOSABLE = new Set(('mailinator.com guerrillamail.com guerrillamail.net guerrillamailblock.com sharklasers.com grr.la ' +
  'pokemail.net spam4.me 10minutemail.com 10minutemail.net 10minutemail.co.uk temp-mail.org tempmail.com tempmail.net tempmailo.com ' +
  'temp-mail.io tempr.email tmpmail.org tmpmail.net throwawaymail.com yopmail.com yopmail.net yopmail.fr cool.fr.nf jetable.org ' +
  'trashmail.com trashmail.de trashmail.net mailnesia.com maildrop.cc dispostable.com getnada.com nada.email getairmail.com ' +
  'mohmal.com emailondeck.com fakeinbox.com mintemail.com mytemp.email moakt.com discard.email burnermail.io spambox.us ' +
  'mailcatch.com inboxkitten.com dropmail.me emailfake.com fakemail.net tempinbox.com mail.tm mail.gw linshiyouxiang.net ' +
  'byom.de 33mail.com anonaddy.me simplelogin.co duck.com mailpoof.com tempail.com spamgourmet.com harakirimail.com ' +
  'mvrht.net mailsac.com tempmailaddress.com 1secmail.com 1secmail.org 1secmail.net vjuum.com laafd.com txcct.com rteet.com').split(/\s+/));
const isDisposable = (email) => DISPOSABLE.has(String(email || '').toLowerCase().split('@')[1] || '');

function netOf(ip) {
  ip = String(ip || '').replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split('.').slice(0, 3).join('.') + '.0/24';
  if (ip.includes(':')) {
    // Expand :: just enough to take the first three groups (a /48).
    const [head] = ip.split('::');
    const g = head.split(':').filter(Boolean);
    while (g.length < 3) g.push('0');
    return g.slice(0, 3).join(':') + '::/48';
  }
  return null;
}
const clean = (v, n) => typeof v === 'string' ? v.replace(/[^\w.:/-]/g, '').slice(0, n || 80) : '';

// The hashed signals for this request. `body` carries what the page sent
// (dl: local-storage device id, fp: fingerprint hash, wd: automation flag);
// `cookieDevice` is the HttpOnly device cookie.
function signals(req, ip, user, body, cookieDevice) {
  body = body || {};
  const net = netOf(ip);
  return {
    email: user && user.email ? h('email', normEmail(user.email)) : null,
    ip: ip && ip !== 'unknown' ? h('ip', ip) : null,
    net: net ? h('net', net) : null,
    dev: cookieDevice ? h('dev', clean(cookieDevice)) : null,
    dl: body.dl ? h('dev', clean(body.dl)) : null,       // same kind as the cookie: either one matches
    fp: body.fp ? h('fp', clean(body.fp, 128)) : null,
    // Plain facts used for this score only, not stored as marks.
    sentFp: !!body.fp,
    automated: body.wd === true,
    tor: String(req.headers['cf-ipcountry'] || '').toUpperCase() === 'T1',
  };
}
// The marks that stand for "this account was here with these signals".
function marksFor(uid, sig, ev, extra) {
  const rows = [];
  const add = (kind, hv) => { if (hv) rows.push({ kind, h: hv, uid, ev }); };
  add('email', sig.email); add('ip', sig.ip); add('net', sig.net);
  add('dev', sig.dev); if (sig.dl !== sig.dev) add('dev', sig.dl); add('fp', sig.fp);
  if (extra && extra.card) add('card', extra.card);
  return rows;
}

// The score, 0 to 100, with the reasons that made it. Prior trials on other
// accounts weigh most; "made to be thrown away" signals add on top.
async function score(db, user, sig) {
  const why = [];
  let s = 0;
  const add = (pts, reason) => { s += pts; why.push(`+${pts} ${reason}`); };
  const prior = (kind, hv, days) => db.countMarks(kind, hv, ['trial', 'blocked'], user.id, days ? Date.now() - days * DAY : 0);

  if (await prior('email', sig.email)) add(70, 'this email, or an alias of it, already had a trial');
  const devHit = (await prior('dev', sig.dev)) || (await prior('dev', sig.dl));
  if (devHit) add(60, 'this device already had a trial on another account');
  if (!devHit && await prior('fp', sig.fp)) add(35, 'a browser with the same fingerprint already had a trial');
  const ipHit = await prior('ip', sig.ip, 90);
  if (ipHit) add(25, `this IP address had a trial on ${ipHit} other account${ipHit > 1 ? 's' : ''} in 90 days`);
  else if (await prior('net', sig.net, 90)) add(10, 'this network block had a trial in 90 days');

  const devAccounts = Math.max(
    sig.dev ? await db.countMarks('dev', sig.dev, ['signup'], user.id, Date.now() - 30 * DAY) : 0,
    sig.dl ? await db.countMarks('dev', sig.dl, ['signup'], user.id, Date.now() - 30 * DAY) : 0);
  if (devAccounts >= 2) add(20, `${devAccounts} other accounts made on this device in 30 days`);
  const ipAccounts = sig.ip ? await db.countMarks('ip', sig.ip, ['signup'], user.id, Date.now() - 7 * DAY) : 0;
  if (ipAccounts >= 3) add(15, `${ipAccounts} other accounts made from this IP in 7 days`);

  if (isDisposable(user.email)) add(30, 'disposable email domain');
  if (normEmail(user.email) !== String(user.email || '').toLowerCase().trim()) add(5, 'email uses an alias (dots or +tag)');
  if (user.email_verified === false) add(15, 'email not confirmed');
  const age = Date.now() - Number(user.created || 0);
  if (user.created && age < 10 * 60000) add(10, 'account under 10 minutes old');
  if (sig.automated) add(25, 'automated browser');
  if (!sig.sentFp) add(10, 'browser sent no device check');
  if (sig.tor) add(25, 'Tor exit node');

  s = Math.min(100, s);
  return { score: s, why, trial: s < NO_TRIAL_AT, flagged: s >= FLAG_AT };
}

module.exports = { init, ready, h, normEmail, isDisposable, netOf, signals, marksFor, score, NO_TRIAL_AT, FLAG_AT, KEEP_DAYS };
