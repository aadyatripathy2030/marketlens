// Terms, privacy, refunds and contact. Server-rendered into the document so a
// reviewer or a crawler sees the text without running JavaScript.
//
// These describe what ChartGauge actually does — what it stores, who it sends
// data to, and what a Pro subscription does and does not include. They are an
// accurate account of the software, not legal advice.

const CONTACT_EMAIL = (process.env.CONTACT_EMAIL || 'chartgauge@gmail.com').trim();
// Whether a confirmation link is sent on sign-up, so these pages describe
// the email provider only when one is actually in use.
const MAIL_ON = !!(process.env.RESEND_API_KEY || '').replace(/\s/g, '');
const SITE = 'ChartGauge';
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const UPDATED = 'October 2026';

// Kept in step with FREE_UNTIL in server.js — the terms have to describe the
// access people actually have, not the split that starts later.
const FREE_UNTIL_MS = Date.parse(process.env.FREE_UNTIL || '2026-10-18T00:00:00Z');
// The last free day, and the day charging begins — both in UTC, both shown, so
// the terms cannot be read as ending a day earlier than the site advertises.
const fmtUTC = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const FREE_UNTIL_TEXT = Number.isFinite(FREE_UNTIL_MS) ? fmtUTC(FREE_UNTIL_MS - 1) : '';
const CHARGE_FROM_TEXT = Number.isFinite(FREE_UNTIL_MS) ? fmtUTC(FREE_UNTIL_MS) : '';
const inLaunch = () => Number.isFinite(FREE_UNTIL_MS) && Date.now() < FREE_UNTIL_MS;
// Kept in step with TRIAL_DAYS in server.js, read from the same variable, so
// the terms describe the trial checkout actually gives rather than a number
// typed here once and left behind.
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 14);
const launchPara = () => inLaunch()
  ? `<strong>Launch period:</strong> through the end of ${FREE_UNTIL_TEXT} (UTC) every feature below, including those listed as Pro, is available to every account at no charge. No subscription is needed to use anything during this period, and the daily limits described below are not applied. From ${CHARGE_FROM_TEXT} the split described here takes effect. If you subscribe before that date you are supporting the project early and will not receive anything a free account does not already have until the split begins.`
  : '';

const h = (title, blocks) => `<article class="legal">
  <h1>${esc(title)}</h1>
  <p class="legal-updated">Last updated ${esc(UPDATED)}</p>
  ${blocks}
  <p class="legal-foot">Questions about this page: <a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a></p>
</article>`;

// Falsy paragraphs are dropped rather than rendered: several of these are
// conditional, and an empty <p> leaves a gap in the page for a sentence that
// was deliberately not said.
const s = (heading, ...paras) => `<h2>${esc(heading)}</h2>`
  + paras.filter(Boolean).map(p => `<p>${p}</p>`).join('');
const ul = (items) => `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`;

// ---------------------------------------------------------------- terms
const buildTerms = () => h('Terms of Service', [
  s('What ChartGauge is',
    `${SITE} is a charting tool. It pulls price history for a stock or crypto pair, computes standard technical indicators, marks stop-loss and take-profit levels derived from volatility and recent swing levels, and writes a description of what those indicators read. It is built to help you find, size and time trades. Trading and investing carry a real risk of loss, including everything you put in, and that risk is yours to take.`,
    `By using ${SITE} you agree to these terms. If you do not agree, do not use the service.`),

  s('It is not financial advice',
    `Nothing on ${SITE} is financial, investment, legal, or tax advice, and no adviser, broker, or fiduciary relationship is created by your use of it. ${SITE} does show a Buy / Sell / Hold verdict. It is a mechanical output, not advice: it is taken from the indicator score, and held back to Hold whenever bars resembling the current one went on to perform clearly worse, or better, than that same symbol's own base rate over the same period. It is not a prediction, it is not personalized to you or your circumstances, and it is not a recommendation that you do anything.`,
    `The scores, ratings, projections, levels, and written summaries are mechanical outputs of formulas applied to past prices. They are frequently wrong. ${SITE} publishes a measured base rate beside its own score precisely so you can see how often that reading has actually preceded the move it implies, which is often no more often than chance.`,
    `All trading and investing involves risk, including the loss of everything you put in. Every decision you make, and every consequence of it, is yours alone.`),

  s('Accuracy and availability',
    `Market data comes from third-party providers and may be delayed, incomplete, or wrong. When live data is unavailable the service falls back to clearly-labeled demo data, which is generated and does not represent any real market.`,
    `${SITE} is provided as-is, with no guarantee of uptime, accuracy, or fitness for any purpose. It may be slow, unavailable, or discontinued at any time.`),

  s('Your account',
    `You can create an account with an email address and a password, or with "Continue with Google". Signing in with Google shares your email address and Google account identifier with ${SITE} and nothing else; ${SITE} never receives your Google password. If you later sign in with Google using the same email address as an existing password account, the two are treated as one account.`,
    `You are responsible for anything done through your account and for keeping your password secure. Do not reuse a password from a bank, broker, or any account that matters. This is not a financial institution and should not be treated as one.`,
    `You must be 18 or older to hold an account.`),

  s('Acceptable use', `You agree not to:`,
    ul([
      'resell, rebrand, or redistribute the service or its output as your own',
      'scrape it in bulk, or use it in a way that degrades it for others',
      'attempt to gain access to accounts, data, or systems that are not yours',
      'present its output to other people as financial advice or as a trading signal',
    ])),

  s('Pro subscriptions',
    launchPara(),
    `Pro is a paid subscription that covers the market-data and model costs of running ${SITE}, and pays for the features that cost money each time they run.`,
    `<strong>Free with any account:</strong> the full chart and every indicator on it, for stocks and crypto; the stop-loss level and one take-profit level; the mechanical score and the measured base rate beside it; a limited number of AI-written reports each day, with the rule-based written read always available after that; a watchlist and a small number of price alerts; and every lesson. The chart itself can be viewed without an account. A free account (an email address and a password) is required for everything read from it and for the other market-data pages; the lessons and these policy pages are readable without one.${MAIL_ON ? ' A new account must confirm its address by opening a link sent to it before it can be used, and every sign-in, including with Google, is completed with a code sent to that address when email can be delivered.' : ''}`,
    `<strong>Pro adds:</strong> AI-written reports without the daily limit; reading an uploaded chart image; the screener and side-by-side compare; additional take-profit levels; and a watchlist and alerts without limits.`,
    `The daily limits and allowances above may be adjusted as running costs change. Any reduction applies from your next renewal.`,
    `Subscriptions are billed in advance on the period you choose and renew automatically until canceled. Payments are processed by Stripe; ${SITE} never receives or stores your card details. Prices may change, and any change applies from your next renewal, not retroactively.`,
    TRIAL_DAYS > 0
      ? `A first subscription starts with a free trial of ${TRIAL_DAYS} days. A card is taken at sign-up but nothing is charged during the trial, and canceling before it ends costs nothing. If you do not cancel, the first payment is taken automatically on the day the trial ends and the subscription continues normally. The trial is offered once per account: if you have subscribed before, checkout charges immediately and the Plans page says so rather than offering a trial it will not give you.`
      : '',
    `Cancellation and refunds are covered on the <a href="/refunds">Refunds and Cancellation</a> page.`),

  s('Limitation of liability',
    `To the fullest extent permitted by law, ${SITE} and the people who make it are not liable for any loss, damage, or cost arising from your use of the service or your reliance on anything it produces. That includes trading losses, missed gains, and any decision taken on the basis of its output.`),

  s('Changes and termination',
    `These terms may change; material changes will be reflected in the date at the top of this page. Continuing to use the service after a change means you accept it.`,
    `You may stop using ${SITE} and delete your account at any time. Access may be suspended or removed for breach of these terms.`),
].join(''));

// -------------------------------------------------------------- privacy
const buildPrivacy = () => h('Privacy Policy', [
  s('The short version',
    `${SITE} stores the minimum needed to run an account: your email address, a hashed password, and the watchlist and price alerts you create. It never sees your card details. It has no access to any brokerage or bank account, and could not place a trade on your behalf even if you asked it to.`),

  s('What is stored', `If you create an account:`,
    ul([
      '<strong>Email address</strong>: to identify your account and to contact you about it',
      '<strong>Password</strong>: stored only as a scrypt hash with a per-user salt, never in plain text and never recoverable',
      '<strong>Session token</strong>: a random value in an HttpOnly cookie so you stay signed in',
      '<strong>Watchlist and price alerts</strong>: the stocks and targets you choose to save',
      '<strong>Plan status</strong>: whether the account is free or Pro',
      '<strong>Email confirmation and sign-in codes</strong>: whether the address has been confirmed, a short-lived token while a confirmation link is outstanding, and a short-lived code while a sign-in is in progress',
      '<strong>Google account identifier</strong>: only if you sign in with Google: the opaque user id Google issues for you, stored so the same Google account signs into the same ChartGauge account next time. It is not your Google password, and it gives no access to anything else in your Google account.',
      '<strong>Affiliate details</strong>: only if you are invited into the affiliate programme and accept: a referral code, a count of the accounts created through your link, and the payout details you choose to enter (the name on the account and either a US bank account or a PayPal address). The account and routing numbers are stored encrypted with a key that is not kept in the database, are read only to send you a payment, and are deleted with your account. Money is only ever paid into the account you name; nothing is ever taken from it.',
    ]),
    `Everything beyond the bare chart requires an account, so using those features means the above exists. The lessons and these policy pages can be read without an account, and reading them creates none of it. Your display preferences (simple or advanced mode, candle colors, the number of take-profit levels) are kept in your own browser and are never sent to the server.`),

  s('What is never stored',
    ul([
      '<strong>Card details.</strong> Payments go directly to Stripe, which handles them entirely. ' + SITE + ' receives only your subscription status. The one exception to "no bank details" is the affiliate payout form above, which exists so that affiliates can be paid, and which only an invited affiliate ever sees.',
      '<strong>Brokerage or trading account credentials.</strong> There is no integration with any broker.',
      '<strong>Your name, address, date of birth, or any government identifier.</strong> None of it is asked for.',
    ])),

  s('Who your data is sent to', `Using the service sends some information to these third parties:`,
    ul([
      '<strong>Twelve Data</strong>: the stock or crypto pair you look up, to fetch prices.',
      '<strong>Financial Modeling Prep</strong> and <strong>Finnhub</strong>: the stock you look up, to fetch fundamentals and news.',
      '<strong>Anthropic</strong>: when a written summary is generated: the stock and the computed indicator values. If you upload a chart screenshot for reading, the image is sent too. Do not upload images containing personal or account information.',
      '<strong>Stripe</strong>: your email address and subscription details, if you subscribe. If you are an affiliate and choose to be paid through Stripe, your email address is used to open a payout account with Stripe, and the bank details you then enter go to Stripe directly and are never seen by ' + SITE + '.',
      '<strong>Google Analytics</strong>: page views and general usage, to see which parts of the site get used. Only after you accept the cookie banner; if you decline, nothing is sent to Google.',
      '<strong>Google (sign-in)</strong>: only if you choose "Continue with Google". You sign in on Google\u2019s own page; ' + SITE + ' never sees your Google password. ' + SITE + ' asks Google for two things: your email address and your account identifier. Nothing else is requested, and nothing is written back to your Google account.',
      '<strong>Render</strong>: the hosting provider, which processes requests and stores the database.',
      ...(MAIL_ON ? ['<strong>Resend</strong>: your email address, to deliver the confirmation link when you create an account and the code at each sign-in.'] : []),
    ]),
    `Your data is not sold, and is not shared with advertisers or data brokers.`),

  s('Cookies and local storage',
    ul([
      '<strong>Session cookie</strong>: set only when you sign in. HttpOnly and SameSite=Lax, so it is not readable by scripts and is not sent with cross-site requests. It is strictly necessary for staying signed in.',
      '<strong>Local storage</strong>: your display preferences, whether you have accepted the terms notice, and your analytics choice below. This never leaves your browser.',
      '<strong>Nothing is sold or shared.</strong> No personal data is sold, and none is shared for advertising. There is no advertising on the site and no advertising pixel in it.',
      '<strong>Google Analytics cookies</strong>: set <strong>only if you press Accept</strong> on the cookie banner. Until then Google Analytics is not loaded at all: no request is made to Google and no analytics cookie exists. If you decline, you are not asked again on that device, and the site works exactly the same.',
    ])),

  s('Your choices',
    `You can change your analytics choice at any time with the <strong>Cookie settings</strong> link in the footer of every page, which brings the banner back. If your browser sends a Global Privacy Control signal, ${SITE} treats it as a refusal: analytics stays off and the banner says so instead of asking.`,
    `You can delete your account and everything attached to it by emailing <a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a> from the address on the account. Deletion removes the account record, sessions, watchlist, and alerts.`,
    `You can ask what is held about you, ask for it to be corrected, or ask for it to be exported, at the same address. Depending on where you live you may have these rights under the GDPR, the UK GDPR, or the CCPA; they are offered to everyone regardless.`,
    `Data is kept for as long as the account exists. Subscription records are kept by Stripe for as long as their own retention and tax obligations require.`),

  s('Children',
    `${SITE} is not directed at children and accounts are for people 18 and over.`),

  s('Security and its limits',
    `Passwords are hashed with scrypt, sessions use HttpOnly cookies, and traffic is served over HTTPS. That said, no service is perfectly secure, and this one is a small independent project rather than a financial institution, which is exactly why you should not reuse an important password here.`),
].join(''));

// -------------------------------------------------------------- refunds
const buildRefunds = () => h('Refunds and Cancellation', [
  s('What you are paying for',
    launchPara(),
    `A Pro subscription covers the market-data and model costs of running ${SITE} and pays for the features that cost money each time they run: AI-written reports without the daily limit, chart-image reading, the screener and side-by-side compare, extra take-profit levels, and an unlimited watchlist and alerts.`,
    `The chart itself, every indicator, the stop-loss and take-profit levels, the score and the measured base rate beside it remain free for everyone, subscribed or not. Pro is worth paying for only if you want the parts listed above. The tool is fully usable without it. See the <a href="/terms">Terms of Service</a> for the full split.`),

  s('Canceling',
    TRIAL_DAYS > 0
      ? `If you are in the free trial, canceling before it ends means you are never charged at all. The Plans page shows the trial you would get, and Stripe emails you before the first payment.`
      : '',
    `You can cancel at any time, with no notice period and no cancellation fee, from the <strong>Manage subscription</strong> button on the Plans page. That opens Stripe's billing portal, where cancellation takes effect immediately for future renewals.`,
    `When you cancel, your subscription runs to the end of the period you have already paid for and then stops. After that the account returns to the free tier: nothing you saved is deleted, but the Pro-only features stop and the free daily limits apply again.`),

  s('Refunds',
    `If you are unhappy for any reason, email <a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a> within <strong>14 days</strong> of a charge and it will be refunded in full, no questions asked.`,
    `After 14 days, a charge for the current period is generally not refunded. Cancel instead, and you will not be billed again. If something went genuinely wrong, such as being charged twice or charged after canceling, that is refunded whenever you report it.`,
    `Refunds go back to the original payment method through Stripe and usually appear within five to ten business days, depending on your bank.`),

  s('Before you dispute a charge',
    `If a charge looks wrong, please email first. Almost everything is resolved the same day, and a direct refund reaches you faster than a bank dispute does.`),

  s('Failed payments',
    `If a renewal payment fails, Stripe retries it over several days. If it ultimately fails, the subscription ends. Nothing is lost, and you can subscribe again whenever you want.`),
].join(''));

// -------------------------------------------------------------- contact
const buildContact = () => h('Contact', [
  s('Get in touch',
    `Email <a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a> for anything: billing questions, refunds, account deletion, bug reports, or if something on the site is simply wrong.`,
    `${SITE} is a small independent project, not a company with a support desk. Expect a reply within a couple of business days.`),

  s('For billing and refunds',
    `Include the email address on the account and the date of the charge. See <a href="/refunds">Refunds and Cancellation</a> for what to expect.`),

  s('For account deletion',
    `Email from the address on the account and say you want it deleted. Everything attached to it is removed. See the <a href="/privacy">Privacy Policy</a>.`),

  s('What cannot be answered',
    `No question about what to buy, sell, or hold can be answered, and no view on any specific security will be given. ${SITE} is a trading tool, not an adviser. See the <a href="/terms">Terms of Service</a>.`),
].join(''));

// ------------------------------------------------------ affiliate terms
// Read from the same variables the ledger uses, so the page states the rate
// that is actually being credited.
const AFF_SHARE = String(process.env.AFFILIATE_SHARE || '25').replace(/[^\d.]/g, '') || '25';
const AFF_MONTHS = Number(process.env.AFFILIATE_MONTHS || 12);
const AFF_MIN = Number(process.env.AFFILIATE_MIN_PAYOUT || 25);
const buildAffiliateTerms = () => h('Affiliate Terms', [
  s('Who this is for',
    `The ${SITE} affiliate programme is by invitation. An account becomes an affiliate when ${SITE} marks it as one, at which point it receives a referral link of its own and the terms below apply. Accepting the link, sharing it, or entering payout details counts as agreeing to them.`),

  s('What you get',
    ul([
      `<strong>Pro, free</strong>, for as long as the account remains an affiliate.`,
      `<strong>${esc(AFF_SHARE)}% of every payment</strong> that Stripe collects from an account created through your link, for <strong>${AFF_MONTHS} months</strong> from that account's first payment. After that the account is still counted as yours, but no further commission accrues on it.`,
    ]),
    `Commission is calculated on the amount actually paid, after any discount or promotion code, and before Stripe's processing fee. A free trial earns nothing until the first real charge. If a payment is refunded or charged back, the same share of the refund is deducted.`),

  s('How you are paid',
    `Balances are paid on the first of each month once the balance reaches <strong>$${AFF_MIN}</strong>. A smaller balance rolls over to the next month. If you set up payouts through Stripe, the money is sent to your Stripe account automatically on the first and Stripe pays it on to your bank, usually within a few business days. If you entered bank or PayPal details instead, ${SITE} sends the money by hand, so allow a few business days after the first of the month.`,
    `Earnings may be taxable where you live. In the United States, anyone paid $600 or more in a year will be asked for a W-9 and will receive a 1099. You are responsible for your own taxes.`,
    `You can see your referral count, earnings, what has been paid and what is owed on the Settings page while signed in.`),

  s('What counts as a referral',
    `An account counts as yours when it is created in a browser that visited ${SITE} through your link within the previous 30 days. Accounts you create yourself, accounts for people in your household, and accounts created to earn commission on your own subscription do not count, and commission on them is reversed if found.`),

  s('How you may promote the link',
    ul([
      `Say what ${SITE} is: a trading tool with a published record. Do not promise profits, quote or imply returns, or call it a signal service or financial advice, and say that trading can lose money.`,
      `Do not send unsolicited email or messages, post the link where it is not welcome, or run paid search advertising on the name ${SITE} or chartgauge.com.`,
      `Do not present yourself as ${SITE} or as speaking for it. Say you are an affiliate when asked, and wherever the law where you live requires it.`,
    ]),
    `Breaking these rules ends the arrangement and forfeits any unpaid balance.`),

  s('Ending it',
    `Either side can end the arrangement at any time, for any reason, by email. Your Pro access ends with it. A balance of $${AFF_MIN} or more that was earned properly is still paid at the next monthly run; a smaller balance is forfeited. Commission stops accruing on your referred accounts when the arrangement ends.`),

  s('Changes',
    `The rate, the window, and the minimum may change for future payments. A change is announced by email to affiliates at least 30 days before it applies, and never reduces what has already been earned.`),
].join(''));

// ---------------------------------------------------------- accessibility
const buildAccessibility = () => h('Accessibility Statement', [
  s('The standard',
    `${SITE} aims to meet the Web Content Accessibility Guidelines (WCAG) 2.2 at level AA. This page says what has been done toward that, what is known to fall short, and how to report a problem.`),

  s('What is in place',
    ul([
      'Every page can be used with a keyboard alone. The first link on each page skips to the content, and the focused control is always visibly outlined.',
      'Pages use landmarks (header, navigation, main, footer), one top-level heading each, headings in order, and a declared language.',
      'Text and controls meet the 4.5:1 and 3:1 contrast ratios in the default dark theme, and the site honours the system light and dark setting.',
      'Form fields have labels, and errors are written out next to the field rather than shown by color alone.',
      'Animation stops when the operating system asks for reduced motion. Nothing moves, flashes or plays sound on its own.',
      'The site works at a 320 pixel width, zooms to 400% without horizontal scrolling, and its buttons and links are at least 24 by 24 pixels.',
      'There is no accessibility overlay widget. The fixes are in the pages themselves.',
    ])),

  s('Known gaps',
    ul([
      'The candlestick chart is drawn on a canvas, which a screen reader cannot read. The numbers it shows are also presented as text: the last price, the change, every indicator value, the score and the stop-loss and take-profit levels. A per-bar text table of the chart is not yet offered.',
      'Up and down candles are told apart by color. The colors can be changed in Settings, and every figure the colors summarize is also given as a signed number, but the chart itself still relies on color.',
      'The chart-image reading accepts a screenshot and describes it in text, which is the accessible direction; there is no equivalent in the other direction yet.',
    ])),

  s('Tell us',
    `If something on ${SITE} is hard or impossible to use, email <a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a> with the page address and what happened. Reports are read by the person who builds the site, and problems that block a task are fixed first.`,
    `This statement was last reviewed in ${esc(UPDATED)}.`),
].join(''));

// --------------------------------------------------------------- security
// Facts only: what is done, where things are, and what is not held. No
// certification is claimed because none is held.
const buildSecurity = () => h('Security', [
  s('The short version',
    `${SITE} holds very little that is worth stealing: an email address, a password hash, a watchlist and some price alerts. Card details go to Stripe and never pass through ${SITE}. This page says how what is held is protected and how to report a weakness.`),

  s('Where things run',
    ul([
      '<strong>Hosting</strong>: the application and its database run on Render, in the United States.',
      '<strong>Transport</strong>: every page and request is served over HTTPS. Plain HTTP is redirected, and browsers are told to keep using HTTPS for a year (HSTS).',
      '<strong>Browser protections</strong>: a Content Security Policy limits where scripts, styles, images and connections can come from; the site cannot be framed by other sites; and the referrer sent to third parties is trimmed.',
    ])),

  s('Accounts',
    ul([
      '<strong>Passwords</strong> are stored only as scrypt hashes with a per-user salt. They cannot be recovered, only reset.',
      '<strong>Every sign-in</strong>, with a password or with Google, finishes with a 6-digit code sent to the account\'s email, so a leaked password alone does not open an account.',
      '<strong>Sessions</strong> live in an HttpOnly, SameSite cookie that scripts cannot read. Signing out ends the session on the server.',
      '<strong>Rate limits</strong> apply to sign-up, sign-in, code entry and the contact points, so passwords and codes cannot be guessed at speed.',
    ])),

  s('Payments and payout details',
    ul([
      '<strong>Subscriptions</strong> are taken on Stripe\'s hosted checkout page and managed on Stripe\'s billing portal. ' + SITE + ' never sees a card number and stores only the subscription status and Stripe\'s customer id.',
      '<strong>Affiliate payout details</strong> (for the few people in the affiliate programme) are either held by Stripe, or, if entered on ' + SITE + '\'s own form, encrypted with AES-256-GCM under a key that exists only in the server\'s environment, never in the database or the code.',
    ])),

  s('Third parties',
    `Price data, email delivery, payments and the written analysis each come from a named provider. The <a href="/privacy">Privacy Policy</a> lists every one and what it receives.`),

  s('What is not claimed',
    `${SITE} is a small independent service. It holds no SOC 2 report and no ISO 27001 certificate, has not had an external penetration test, and does not run a bug bounty. The measures above are what is actually in place.`),

  s('Reporting a weakness',
    `If you find a security problem, email <a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a> with enough detail to reproduce it. The same address is published at <a href="/.well-known/security.txt">/.well-known/security.txt</a>. Please give a reasonable time for a fix before describing it publicly, and do not access other people\'s accounts or data while testing. Reports are answered, and a real finding is credited here if you wish.`),
].join(''));

// Rebuilt whenever the launch period flips, so a process that was running
// before the cutoff stops advertising it the moment it passes rather than at
// the next deploy. Same content otherwise, so this is one rebuild, not one
// per request.
let cache = null, cacheLaunch = null;
function buildPages() {
  return {
    terms:   { title: `Terms of Service | ${SITE}`, desc: `The terms covering use of ${SITE}, including that nothing it produces is financial advice and what a Pro subscription does and does not include.`, html: buildTerms(), heading: 'Terms of Service' },
    privacy: { title: `Privacy Policy | ${SITE}`, desc: `What ${SITE} stores about you, who it sends data to, what it never collects, and how to have your account deleted.`, html: buildPrivacy(), heading: 'Privacy Policy' },
    refunds: { title: `Refunds and Cancellation | ${SITE}`, desc: `Cancel any time from Stripe's billing portal, and a full refund within 14 days of a charge, no questions asked.`, html: buildRefunds(), heading: 'Refunds and Cancellation' },
    contact: { title: `Contact | ${SITE}`, desc: `How to reach ${SITE} about billing, refunds, account deletion, or a bug.`, html: buildContact(), heading: 'Contact' },
    'affiliate-terms': { title: `Affiliate Terms | ${SITE}`, desc: `What a ${SITE} affiliate earns (${AFF_SHARE}% of referred payments for ${AFF_MONTHS} months), how and when it is paid, what counts as a referral, and the rules for promoting the link.`, html: buildAffiliateTerms(), heading: 'Affiliate Terms' },
    accessibility: { title: `Accessibility Statement | ${SITE}`, desc: `The standard ${SITE} is built to (WCAG 2.2 AA), what is in place, the known gaps, and how to report a problem.`, html: buildAccessibility(), heading: 'Accessibility Statement' },
    security: { title: `Security | ${SITE}`, desc: `How ${SITE} protects accounts and payments, where it runs, what it does not claim, and how to report a weakness.`, html: buildSecurity(), heading: 'Security' },
  };
}
function getPages() {
  const now = inLaunch();
  if (!cache || cacheLaunch !== now) { cache = buildPages(); cacheLaunch = now; }
  return cache;
}

module.exports = { CONTACT_EMAIL };
Object.defineProperty(module.exports, 'PAGES', { get: getPages, enumerable: true });
