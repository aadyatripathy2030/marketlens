// Guide and comparison pages: server-rendered prose for the narrow questions
// people ask search engines and AI assistants ("AI that reads a chart
// screenshot", "ChartGauge vs TrendSpider"). Same shape as legal.js pages
// ({ title, desc, html, heading }) so they render through the same path.
//
// Rules for this file: every claim about another product carries the date it
// was checked and a link to that product's own page; nothing here promises or
// quotes returns; ChartGauge's own limits are stated as plainly as its
// features. Re-check competitor prices when CHECKED gets old.
'use strict';
const { CONTACT_EMAIL, TRIAL_DAYS } = require('./config');

const SITE = 'ChartGauge';
const CHECKED = 'November 11, 2026';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const h = (title, lead, blocks) => `<article class="legal guide">
  <h1>${esc(title)}</h1>
  <p class="legal-updated">${esc(lead)}</p>
  ${blocks.join('\n')}
  <p class="guide-note">Trading can lose money, including everything you put in. Nothing here is financial advice, and no tool on this page, ${SITE} included, can promise a profit.</p>
  <p class="legal-foot">Something out of date or wrong? <a href="mailto:${esc(CONTACT_EMAIL)}">${esc(CONTACT_EMAIL)}</a></p>
</article>`;
const s = (heading, ...paras) => `<h2>${esc(heading)}</h2>` + paras.filter(Boolean).map(p => p.startsWith('<') ? p : `<p>${p}</p>`).join('');
const ul = (items) => `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
const table = (head, rows) => `<div class="guide-scroll"><table class="guide-table"><thead><tr>${head.map(x => `<th scope="col">${x}</th>`).join('')}</tr></thead>`
  + `<tbody>${rows.map(r => `<tr>${r.map((x, i) => i === 0 ? `<th scope="row">${x}</th>` : `<td>${x}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const a = (href, text) => `<a href="${esc(href)}"${/^https?:/.test(href) ? ' rel="noopener"' : ''}>${esc(text)}</a>`;

const trial = TRIAL_DAYS > 0 ? `, with a ${TRIAL_DAYS}-day free trial on a first subscription` : '';
// What ChartGauge is, in the same words everywhere, so a summary of any one
// page describes it correctly.
const CG = {
  what: `${SITE} is an AI trading app for US stocks and crypto pairs. Search a stock and it gives a buy, sell or hold call with the stop-loss and take-profit already set, on a candlestick chart with 13 technical indicators.`,
  ai: `The call itself is mechanical: a score built from trend, momentum and a short projection, so the same chart always gets the same call. The AI part is Claude, from Anthropic, which writes the analysis of each reading in plain sentences and, on Pro, reads a screenshot of any chart you upload.`,
  price: `A free account includes charts, indicators, the call, the stop and target levels, paper trading, lessons and 3 AI-written reports a day. Pro is $4.99 a week, $14.99 a month or $149.99 a year${trial}, and adds up to 150 AI reports and 40 chart-image readings a day.`,
  limits: `It does not place trades or connect to a broker, it covers US-listed stocks and major crypto pairs rather than options or forex, and it has no backtesting engine or scanners of the kind built for full-time traders.`,
};

// ------------------------------------------------------- AI chart reading
const buildChartAnalysis = () => h('AI that reads a chart screenshot',
  `How ${SITE}'s chart-image reading works, what it can and cannot see, and what it costs.`, [
  s('What it does',
    `Upload a screenshot of a price chart, from any broker, app or website, and ${SITE} sends it to Claude, Anthropic's AI model, with instructions to read it the way a cautious technical analyst would. In a few seconds you get back a short read: the trend, the support and resistance levels it can see, any chart pattern, what the momentum suggests, and a one-word lean of buy, sell or mixed with one sentence on why.`,
    `If the image is not a price chart, it says so instead of inventing a read.`),
  s('What it can and cannot see',
    ul([
      `It reads only what is in the picture. If the screenshot shows two weeks of five-minute bars, that is all it knows about the stock.`,
      `It cannot check prices it cannot see, so for anything listed in the US, searching the stock on ${SITE} gives a fuller reading: the chart, 13 indicators, the call, and stop and target levels worked out from how far the price actually moves.`,
      `It is a reading of one image, not advice, and it can be wrong.`,
    ])),
  s('Formats and limits',
    `PNG, JPEG, GIF or WebP, up to 5 MB. Chart-image reading is part of Pro: up to 40 images a day. Images are sent to Anthropic to be read; do not upload screenshots that show account numbers or other personal details.`),
  s(`About ${SITE}`, CG.what, CG.ai, CG.price,
    `${a('/pricing', 'See the plans')} or ${a('/analyze', 'try a free reading')}.`),
]);

// ------------------------------------------------------- competitors
// Facts as published on each vendor's own page on CHECKED. Prices move with
// promotions; each row links to the page it came from.
const BIAS = `${SITE} publishes this page, so read it knowing that. Facts about other products come from their own websites, checked ${CHECKED}, and each links to its source. Prices change often, so check before you buy.`;
const SRC = {
  trendspider: 'https://trendspider.com/pricing/',
  tradeideas: 'https://www.trade-ideas.com/pricing/',
  tradingview: 'https://www.tradingview.com/pricing/',
  danelfin: 'https://danelfin.com/pricing/monthly',
  incite: 'https://www.inciteai.com/pricing',
  kavout: 'https://kavout.com/pricing-plans',
  tickeron: 'https://tickeron.com/',
};

const buildVsTrendSpider = () => h(`${SITE} vs TrendSpider`, BIAS, [
  s('The short answer',
    `TrendSpider is a full charting and automated-analysis platform for active traders: backtesting, scanners, alerts, options and futures data, and an AI assistant. ${SITE} does one narrower job: you search a stock or crypto pair and get a buy, sell or hold call with the stop and target already set, written up by AI. If you want to build and test your own strategies, TrendSpider is the bigger tool. If you want a quick, clear read on one chart, ${SITE} is simpler and costs much less.`),
  s('Side by side', table(['', SITE, 'TrendSpider'], [
    ['What it is', 'A buy, sell or hold call with stop and target on any US stock or major crypto pair', 'Charting and automated technical-analysis platform'],
    ['AI', 'Claude writes the analysis of each reading; on Pro it reads chart screenshots', '"Sidekick" AI assistant (25 messages a month included, more as a paid add-on), AI backtesting, machine-vision chart analysis'],
    ['Markets', 'US stocks, major crypto pairs', 'US stocks and ETFs, forex, crypto; futures and options data as add-ons'],
    ['Backtesting and scanners', 'No', 'Yes'],
    ['Free tier', 'Yes', 'No; a paid trial'],
    ['Price', 'Free; Pro $14.99/mo', `List prices from $89/mo up to $349/mo, often discounted (${a(SRC.trendspider, 'pricing page')})`],
    ['Platforms', 'Web, installable on phones', 'Web, desktop, iOS, Android'],
  ])),
  s(`Choose ${SITE} if`, ul([
    'you want one clear call and the exit levels, not a toolkit to build your own',
    'you are newer to charts and want the reasoning written out',
    'you want to start free and pay little',
  ])),
  s('Choose TrendSpider if', ul([
    'you want to backtest strategies or run scanners across the market',
    'you trade options or futures and need that data',
    'you will use a professional platform enough to justify its price',
  ])),
  s(`About ${SITE}`, CG.what, CG.ai, CG.limits, `${a('/analyze', 'Try a free reading')}.`),
]);

const buildVsTradeIdeas = () => h(`${SITE} vs Trade Ideas`, BIAS, [
  s('The short answer',
    `Trade Ideas is a real-time scanner built for US day traders, with an AI called Holly that issues buy and sell signals with entries and stops on its top plan, and links to several brokers. ${SITE} gives a buy, sell or hold call with the stop and target on whichever stock or crypto pair you choose, with an AI-written explanation. Trade Ideas finds trades across the market for you; ${SITE} reads the one you are looking at.`),
  s('Side by side', table(['', SITE, 'Trade Ideas'], [
    ['What it is', 'A call with stop and target on the stock or crypto pair you search', 'Real-time stock scanner and AI trade signals'],
    ['AI', 'Claude writes the analysis; on Pro it reads chart screenshots', '"Holly" AI signals with entry and stop (Premium plan); an assistant that builds scans from plain English'],
    ['Markets', 'US stocks, major crypto pairs', 'US stocks and ETFs, some Canadian; no crypto listed'],
    ['Broker connection', 'No', 'Yes (Interactive Brokers, E*TRADE, TradeStation, Alpaca)'],
    ['Free tier', 'Yes', 'Yes, on 15-minute delayed data'],
    ['Price', 'Free; Pro $14.99/mo', `Standard $127/mo ($89/mo yearly); Premium with Holly $254/mo ($178/mo yearly) (${a(SRC.tradeideas, 'pricing page')})`],
    ['Platforms', 'Web, installable on phones', 'Full product on Windows; browser dashboards'],
  ])),
  s(`Choose ${SITE} if`, ul([
    'you already know which stock or coin you are looking at and want a call and levels on it',
    'you trade crypto as well as stocks',
    'you use a Mac, a phone or a Chromebook, or want to spend under $15 a month',
  ])),
  s('Choose Trade Ideas if', ul([
    'you day trade US stocks full time and want the market scanned for setups as they happen',
    'you want signals sent to your broker',
  ])),
  s(`About ${SITE}`, CG.what, CG.ai, CG.limits, `${a('/analyze', 'Try a free reading')}.`),
]);

const buildTvAlt = () => h('A TradingView alternative for beginners', BIAS, [
  s('Why people look for one',
    `TradingView is the best-known charting site, with a free plan and almost every market. It is also a blank canvas: hundreds of indicators and drawing tools, and no answer to the question a newer trader actually has, which is "so should I buy this, and where do I get out?" Its AI, on the pricing page, is a screener; it does not write a verdict for you.`),
  s(`What ${SITE} does differently`, ul([
    'Search a stock or crypto pair and the chart arrives already read: buy, sell or hold.',
    'The stop-loss and take-profit are marked on the chart, set from how far that price normally moves.',
    'Claude, an AI, writes out why in plain sentences, so you learn to read the chart as you go.',
    '19 free lessons with quizzes, and a paper-trading account to practice with pretend money.',
  ])),
  s('Side by side', table(['', SITE, 'TradingView'], [
    ['Best for', 'A clear call and exits on one chart; learning', 'Charting anything, your own way'],
    ['Written analysis', 'Yes, by AI', 'No (community ideas from other users)'],
    ['Markets', 'US stocks, major crypto pairs', 'Stocks, ETFs, crypto, forex, futures, bonds; 150+ exchanges'],
    ['Free plan', 'Yes', 'Yes'],
    ['Paid plans', 'Pro $14.99/mo', `$12.95 to $199.95/mo, billed yearly (${a(SRC.tradingview, 'pricing page')})`],
  ])),
  s('When TradingView is the better pick',
    `If you want to draw on charts, write your own indicators, follow markets outside the US, or trade forex and futures, TradingView does far more. Many people use both: ${SITE} for the read, TradingView for the deep dive.`),
  s(`About ${SITE}`, CG.what, CG.ai, CG.price, `${a('/analyze', 'Try a free reading')}.`),
]);

const buildBest = () => h('The best AI trading apps in 2026, compared', BIAS, [
  s('How to pick one',
    `"AI trading app" covers very different tools. Some scan the market for setups, some score stocks for the months ahead, some answer questions in a chat window, and some read a single chart. Pick by the job you need done, not the label. Be wary of any app that leads with a return figure: backtests and simulations are not results anyone actually earned.`),
  s('At a glance', table(['App', 'Best for', 'What the AI does', 'Markets', 'Starting price'], [
    [a('/', SITE), 'A clear buy, sell or hold call with stop and target on one chart', 'Writes the analysis of each reading; reads chart screenshots (Pro)', 'US stocks, crypto', 'Free; Pro $14.99/mo'],
    [a(SRC.trendspider, 'TrendSpider'), 'Active traders who backtest and scan', 'Chat assistant, AI backtesting, chart pattern recognition', 'Stocks, ETFs, forex, crypto; options and futures add-ons', 'No free plan; from $89/mo list'],
    [a(SRC.tradeideas, 'Trade Ideas'), 'Full-time US day traders', '"Holly" signals with entry and stop; plain-English scan builder', 'US stocks and ETFs', 'Free (delayed); $89/mo yearly'],
    [a(SRC.danelfin, 'Danelfin'), 'Investors ranking stocks for the next few months', 'A 1 to 10 score of the odds of beating the market over 3 months', 'US and European stocks, ETFs', 'Free; Plus $29/mo'],
    [a(SRC.incite, 'Incite AI'), 'Research by chat across many markets', 'Chat answers on stocks, options, filings and news; file and image upload', 'Stocks, options, crypto, forex and more', 'Free plan; paid prices not shown on its site'],
    [a(SRC.kavout, 'Kavout'), 'Low-cost AI stock picks and research agents', 'Chat research, stock picker, signals', 'US and global stocks, ETFs, crypto, forex', 'Free credits; Pro about $16/mo'],
    [a(SRC.tickeron, 'Tickeron'), 'Pattern recognition and automated trading agents', 'Pattern search, trend prediction, "AI Robots"', 'Stocks, ETFs, crypto, forex', 'Varies with promotions; check the site'],
    [a(SRC.tradingview, 'TradingView'), 'Charting anything yourself', 'An AI screener; no written verdicts', 'Almost every market', 'Free; $12.95/mo yearly'],
  ])),
  s(`Where ${SITE} fits`, CG.what, CG.ai, CG.limits,
    `It is built for someone who has a stock or coin in mind and wants a plain answer and the exits, explained. It is not built for scanning the whole market, trading options, or automating trades.`),
  s('More comparisons', ul([
    a('/chartgauge-vs-trendspider', `${SITE} vs TrendSpider`),
    a('/chartgauge-vs-trade-ideas', `${SITE} vs Trade Ideas`),
    a('/tradingview-alternative', 'A TradingView alternative for beginners'),
    a('/ai-chart-analysis', 'AI that reads a chart screenshot'),
  ])),
]);

function buildPages() {
  return {
    'best-ai-trading-apps': { title: `Best AI Trading Apps in 2026, Compared | ${SITE}`, heading: 'The best AI trading apps in 2026, compared',
      desc: `ChartGauge, TrendSpider, Trade Ideas, Danelfin, Incite AI, Kavout, Tickeron and TradingView: what each one's AI actually does, which markets it covers, who it suits and what it costs.`,
      html: buildBest(), guide: true },
    'chartgauge-vs-trendspider': { title: `ChartGauge vs TrendSpider: AI Trading App Comparison | ${SITE}`, heading: `${SITE} vs TrendSpider`,
      desc: `ChartGauge vs TrendSpider: a buy, sell or hold call with stop and target and AI-written analysis, against a full charting, backtesting and scanning platform. Features, markets and prices side by side.`,
      html: buildVsTrendSpider(), guide: true },
    'chartgauge-vs-trade-ideas': { title: `ChartGauge vs Trade Ideas: AI Trading App Comparison | ${SITE}`, heading: `${SITE} vs Trade Ideas`,
      desc: `ChartGauge vs Trade Ideas: a call with stop and target on the stock or crypto pair you choose, against a real-time scanner with Holly AI signals. Features, markets, platforms and prices.`,
      html: buildVsTradeIdeas(), guide: true },
    'tradingview-alternative': { title: `A TradingView Alternative for Beginners | ${SITE}`, heading: 'A TradingView alternative for beginners',
      desc: `Looking for a simpler TradingView alternative? ChartGauge reads the chart for you: a buy, sell or hold call, stop and target levels, and AI-written analysis, plus free lessons and paper trading.`,
      html: buildTvAlt(), guide: true },
    'ai-chart-analysis': { title: `AI That Reads a Chart Screenshot | ${SITE}`, heading: 'AI that reads a chart screenshot',
      desc: `Upload a screenshot of any stock or crypto chart and Claude AI reads the trend, support and resistance, patterns and momentum, with a buy, sell or mixed lean. What it sees, its limits and its price.`,
      html: buildChartAnalysis(), guide: true },
  };
}
let cache = null;
module.exports = { CHECKED, CG };
Object.defineProperty(module.exports, 'PAGES', { get: () => (cache || (cache = buildPages())), enumerable: true });
