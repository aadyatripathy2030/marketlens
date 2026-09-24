// Terms, privacy, refunds and contact. Server-rendered into the document so a
// reviewer or a crawler sees the text without running JavaScript.
//
// These describe what ChartGauge actually does — what it stores, who it sends
// data to, and what a Pro subscription does and does not include. They are an
// accurate account of the software, not legal advice.

const CONTACT_EMAIL = (process.env.CONTACT_EMAIL || 'chartgauge@gmail.com').trim();
const SITE = 'ChartGauge';
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const UPDATED = 'September 2026';

const h = (title, blocks) => `<article class="legal">
  <h1>${esc(title)}</h1>
  <p class="legal-updated">Last updated ${esc(UPDATED)}</p>
  ${blocks}
  <p class="legal-foot">Questions about this page: <a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a></p>
</article>`;

const s = (heading, ...paras) => `<h2>${esc(heading)}</h2>` + paras.map(p => `<p>${p}</p>`).join('');
const ul = (items) => `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`;

// ---------------------------------------------------------------- terms
const TERMS = h('Terms of Service', [
  s('What ChartGauge is',
    `${SITE} is a charting tool. It pulls price history for a stock or crypto pair, computes standard technical indicators, marks stop-loss and take-profit levels derived from volatility and recent swing levels, and writes a plain-English description of what those indicators read. It is built to help you learn to read a chart.`,
    `By using ${SITE} you agree to these terms. If you do not agree, do not use the service.`),

  s('It is not financial advice',
    `Nothing on ${SITE} is financial, investment, legal, or tax advice, and nothing on it is a recommendation to buy, sell, or hold any security or asset. No adviser, broker, or fiduciary relationship is created by your use of it.`,
    `The scores, ratings, projections, levels, and written summaries are mechanical outputs of formulas applied to past prices. They are frequently wrong. ${SITE} publishes a measured base rate beside its own score precisely so you can see how often that reading has actually preceded the move it implies — which is often no more often than chance.`,
    `All trading and investing involves risk, including the loss of everything you put in. Every decision you make, and every consequence of it, is yours alone.`),

  s('Accuracy and availability',
    `Market data comes from third-party providers and may be delayed, incomplete, or wrong. When live data is unavailable the service falls back to clearly-labelled demo data, which is generated and does not represent any real market.`,
    `${SITE} is provided as-is, with no guarantee of uptime, accuracy, or fitness for any purpose. It may be slow, unavailable, or discontinued at any time.`),

  s('Your account',
    `You are responsible for anything done through your account and for keeping your password secure. Do not reuse a password from a bank, broker, or any account that matters — this is not a financial institution and should not be treated as one.`,
    `You must be 18 or older to hold an account.`),

  s('Acceptable use', `You agree not to:`,
    ul([
      'resell, rebrand, or redistribute the service or its output as your own',
      'scrape it in bulk, or use it in a way that degrades it for others',
      'attempt to gain access to accounts, data, or systems that are not yours',
      'present its output to other people as financial advice or as a trading signal',
    ])),

  s('Pro subscriptions',
    `Pro is a paid subscription that covers the market-data and model costs of running ${SITE}, and unlocks the features that cost money each time they run.`,
    `<strong>Free with any account:</strong> the full chart and every indicator on it, for stocks and crypto; the stop-loss level and one take-profit level; the mechanical score and the measured base rate beside it; a limited number of AI-written reports each day, with the rule-based written read always available after that; a watchlist and a small number of price alerts; and every lesson. A free account — an email address and a password — is required to load charts and market data; the lessons and these policy pages are readable without one.`,
    `<strong>Pro adds:</strong> AI-written reports without the daily limit; Ask Claude; reading an uploaded chart image; the screener and side-by-side compare; additional take-profit levels; and a watchlist and alerts without limits.`,
    `The daily limits and allowances above may be adjusted as running costs change. Any reduction applies from your next renewal.`,
    `Subscriptions are billed in advance on the period you choose and renew automatically until cancelled. Payments are processed by Stripe; ${SITE} never receives or stores your card details. Prices may change, and any change applies from your next renewal, not retroactively.`,
    `Cancellation and refunds are covered on the <a href="/refunds">Refunds and Cancellation</a> page.`),

  s('Limitation of liability',
    `To the fullest extent permitted by law, ${SITE} and the people who make it are not liable for any loss, damage, or cost arising from your use of the service or your reliance on anything it produces. That includes trading losses, missed gains, and any decision taken on the basis of its output.`),

  s('Changes and termination',
    `These terms may change; material changes will be reflected in the date at the top of this page. Continuing to use the service after a change means you accept it.`,
    `You may stop using ${SITE} and delete your account at any time. Access may be suspended or removed for breach of these terms.`),
].join(''));

// -------------------------------------------------------------- privacy
const PRIVACY = h('Privacy Policy', [
  s('The short version',
    `${SITE} stores the minimum needed to run an account: your email address, a hashed password, and the watchlist and price alerts you create. It never sees your card details. It has no access to any brokerage or bank account, and could not place a trade on your behalf even if you asked it to.`),

  s('What is stored', `If you create an account:`,
    ul([
      '<strong>Email address</strong> — to identify your account and to contact you about it',
      '<strong>Password</strong> — stored only as a scrypt hash with a per-user salt, never in plain text and never recoverable',
      '<strong>Session token</strong> — a random value in an HttpOnly cookie so you stay signed in',
      '<strong>Watchlist and price alerts</strong> — the ticker symbols and targets you choose to save',
      '<strong>Plan status</strong> — whether the account is free or Pro',
    ]),
    `Charts and market data require an account, so using those features means the above exists. The lessons and these policy pages can be read without an account, and reading them creates none of it. Your display preferences — simple or advanced mode, candle colours, the number of take-profit levels — are kept in your own browser and are never sent to the server.`),

  s('What is never stored',
    ul([
      '<strong>Card or bank details.</strong> Payments go directly to Stripe, which handles them entirely. ' + SITE + ' receives only your subscription status.',
      '<strong>Brokerage or trading account credentials.</strong> There is no integration with any broker.',
      '<strong>Your name, address, date of birth, or any government identifier.</strong> None of it is asked for.',
    ])),

  s('Who your data is sent to', `Using the service sends some information to these third parties:`,
    ul([
      '<strong>Twelve Data</strong> — the ticker or pair you look up, to fetch prices.',
      '<strong>Financial Modeling Prep</strong> and <strong>Finnhub</strong> — the ticker you look up, to fetch fundamentals and news.',
      '<strong>Anthropic</strong> — when a written summary or chat reply is generated: the ticker, the computed indicator values, and anything you type into the chat. If you upload a chart screenshot for reading, the image is sent too. Do not upload images containing personal or account information.',
      '<strong>Stripe</strong> — your email address and subscription details, if you subscribe.',
      '<strong>Google Analytics</strong> — page views and general usage, to see which parts of the site get used. Only after you accept the cookie banner; if you decline, nothing is sent to Google.',
      '<strong>Render</strong> — the hosting provider, which processes requests and stores the database.',
    ]),
    `Your data is not sold, and is not shared with advertisers or data brokers.`),

  s('Cookies and local storage',
    ul([
      '<strong>Session cookie</strong> — set only when you sign in. HttpOnly and SameSite=Lax, so it is not readable by scripts and is not sent with cross-site requests. It is strictly necessary for staying signed in.',
      '<strong>Local storage</strong> — your display preferences, whether you have accepted the terms notice, and your analytics choice below. This never leaves your browser.',
      '<strong>Google Analytics cookies</strong> — set <strong>only if you press Accept</strong> on the cookie banner. Until then Google Analytics is not loaded at all: no request is made to Google and no analytics cookie exists. If you decline, you are not asked again on that device, and the site works exactly the same.',
    ])),

  s('Your choices',
    `You can change your analytics choice at any time by clearing this site's data in your browser, which makes the banner appear again on your next visit.`,
    `You can delete your account and everything attached to it by emailing <a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a> from the address on the account. Deletion removes the account record, sessions, watchlist, and alerts.`,
    `You can ask what is held about you, ask for it to be corrected, or ask for it to be exported, at the same address. Depending on where you live you may have these rights under the GDPR, the UK GDPR, or the CCPA; they are offered to everyone regardless.`,
    `Data is kept for as long as the account exists. Subscription records are kept by Stripe for as long as their own retention and tax obligations require.`),

  s('Children',
    `${SITE} is not directed at children and accounts are for people 18 and over.`),

  s('Security and its limits',
    `Passwords are hashed with scrypt, sessions use HttpOnly cookies, and traffic is served over HTTPS. That said, no service is perfectly secure, and this one is a small independent project rather than a financial institution — which is exactly why you should not reuse an important password here.`),
].join(''));

// -------------------------------------------------------------- refunds
const REFUNDS = h('Refunds and Cancellation', [
  s('What you are paying for',
    `A Pro subscription covers the market-data and model costs of running ${SITE} and unlocks the features that cost money each time they run: AI-written reports without the daily limit, Ask Claude, chart-image reading, the screener and side-by-side compare, extra take-profit levels, and an unlimited watchlist and alerts.`,
    `The chart itself, every indicator, the stop-loss and take-profit levels, the score and the measured base rate beside it remain free for everyone, subscribed or not. Pro is worth paying for only if you want the parts listed above — the tool is fully usable without it. See the <a href="/terms">Terms of Service</a> for the full split.`),

  s('Cancelling',
    `You can cancel at any time, with no notice period and no cancellation fee, from the <strong>Manage subscription</strong> button on the Plans page. That opens Stripe's billing portal, where cancellation takes effect immediately for future renewals.`,
    `When you cancel, your subscription runs to the end of the period you have already paid for and then stops. After that the account returns to the free tier: nothing you saved is deleted, but the Pro-only features stop and the free daily limits apply again.`),

  s('Refunds',
    `If you are unhappy for any reason, email <a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a> within <strong>14 days</strong> of a charge and it will be refunded in full, no questions asked.`,
    `After 14 days, a charge for the current period is generally not refunded — cancel instead, and you will not be billed again. If something went genuinely wrong, such as being charged twice or charged after cancelling, that is refunded whenever you report it.`,
    `Refunds go back to the original payment method through Stripe and usually appear within five to ten business days, depending on your bank.`),

  s('Before you dispute a charge',
    `If a charge looks wrong, please email first. Almost everything is resolved the same day, and a direct refund reaches you faster than a bank dispute does.`),

  s('Failed payments',
    `If a renewal payment fails, Stripe retries it over several days. If it ultimately fails, the subscription ends. Nothing is lost, and you can subscribe again whenever you want.`),
].join(''));

// -------------------------------------------------------------- contact
const CONTACT = h('Contact', [
  s('Get in touch',
    `Email <a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a> for anything: billing questions, refunds, account deletion, bug reports, or if something on the site is simply wrong.`,
    `${SITE} is a small independent project, not a company with a support desk. Expect a reply within a couple of business days.`),

  s('For billing and refunds',
    `Include the email address on the account and the date of the charge. See <a href="/refunds">Refunds and Cancellation</a> for what to expect.`),

  s('For account deletion',
    `Email from the address on the account and say you want it deleted. Everything attached to it is removed — see the <a href="/privacy">Privacy Policy</a>.`),

  s('What cannot be answered',
    `No question about what to buy, sell, or hold can be answered, and no view on any specific security will be given. ${SITE} is a charting tool, not an adviser — see the <a href="/terms">Terms of Service</a>.`),
].join(''));

const PAGES = {
  terms:   { title: `Terms of Service — ${SITE}`, desc: `The terms covering use of ${SITE}, including that nothing it produces is financial advice and that a Pro subscription unlocks no additional features.`, html: TERMS, heading: 'Terms of Service' },
  privacy: { title: `Privacy Policy — ${SITE}`, desc: `What ${SITE} stores about you, who it sends data to, what it never collects, and how to have your account deleted.`, html: PRIVACY, heading: 'Privacy Policy' },
  refunds: { title: `Refunds and Cancellation — ${SITE}`, desc: `Cancel any time from Stripe's billing portal, and a full refund within 14 days of a charge, no questions asked.`, html: REFUNDS, heading: 'Refunds and Cancellation' },
  contact: { title: `Contact — ${SITE}`, desc: `How to reach ${SITE} about billing, refunds, account deletion, or a bug.`, html: CONTACT, heading: 'Contact' },
};

module.exports = { PAGES, CONTACT_EMAIL };
