# ChartGauge

Stock and crypto charts with thirteen indicators, stop-loss and take-profit
levels, a written read of the chart, lessons, and a public record of how
often the read was right. Live at https://chartgauge.com.

> A trading tool, **not financial advice**. Trading can lose money, including
> everything put in. Every reading is a formula applied to past prices, and
> the site publishes how often it was right.

## Run locally

    node server.js          # http://localhost:3000

Runs in **demo mode** with no keys (deterministic sample prices, a rule-based
summary, accounts kept in memory). The only npm dependency is `pg`, used when a
database is configured. `tools/` holds the video and voice-over helpers used
for the site's recordings, not part of the server.

## Where the facts live

Every number, price and name the site shows comes from one of these places.
Change it there and every page follows.

| Fact | Source |
|---|---|
| Prices and billing periods | Stripe prices, read at boot through `STRIPE_PRICE_*` (never typed into a page) |
| Free trial length, launch period | `TRIAL_DAYS`, `FREE_UNTIL` env vars |
| Contact email | `CONTACT_EMAIL` env var (default in `legal.js`), used on every policy page, security.txt and emails |
| Affiliate rate, window, minimum, pay day | `AFFILIATE_SHARE`, `AFFILIATE_MONTHS`, `AFFILIATE_MIN_PAYOUT`, `AFFILIATE_PAY_DAY` env vars, read by both the ledger and the terms page |
| Policy pages (terms, privacy, refunds, contact, affiliate terms, accessibility, security) | `legal.js`; the `UPDATED` constant is the "last updated" date |
| Lessons | `public/lessons.js` |
| Page titles, descriptions, structured data, sitemap | `VIEW_SEO` and `jsonLd` in `server.js` |
| Site name | `SITE_NAME` in `server.js`, `SITE` in `legal.js` |

## Structure

- `server.js`: HTTP server, API, server-rendered documents, robots, sitemap, security.txt, billing webhooks, affiliate ledger and monthly payout run
- `db.js`: data layer; Postgres when `DATABASE_URL` is set, memory otherwise
- `legal.js`: the policy pages
- `indicators.js`: technical-analysis math
- `public/`: the front end (`index.html`, `app.js`, `styles.css`, `lessons.js`, `payout.js`, icons, fonts, service worker)
- `render.yaml`: the Render blueprint and the list of every environment variable

## Environment

All keys go in Render's environment (or the shell locally), never in code or
chat. `render.yaml` lists each one with a comment; the main ones:

| Variable | Enables |
|---|---|
| `DATABASE_URL` | Persistent accounts (Render Postgres) |
| `STOCK_API_KEY` | Real prices (Twelve Data) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | AI-written analysis and chart-image reading |
| `RESEND_API_KEY`, `MAIL_FROM` | Confirmation links and sign-in codes by email |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_WEEKLY/MONTHLY/YEARLY` | Pro subscriptions |
| `PAYOUT_KEY` | Encrypts affiliate payout details. Never change once set |
| `GA_MEASUREMENT_ID` | Google Analytics, loaded only after the visitor accepts |
| `ADMIN_EMAILS` | Accounts that see `/admin` |

## Deploy

Render deploys `main` of the `atrium-math/marketlens` repository automatically
(the repository kept its old name when the product was renamed). To ship:

    git push origin main && git push atrium main

Then watch https://chartgauge.com until the change shows. The Stripe webhook
must point at `https://chartgauge.com/api/billing/webhook` with these events:
`checkout.session.completed`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.paid`, `charge.refunded`.

## Updating content

- Policy wording: edit the matching `build*` function in `legal.js` and bump `UPDATED`.
- A lesson: edit or add an entry in `public/lessons.js`; the sitemap and the Learn page pick it up.
- Marketing copy on the home page: `public/index.html` (the `view-home` section).
- Meta titles and descriptions: `VIEW_SEO` in `server.js`.
