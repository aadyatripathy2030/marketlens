// Learn-center content: plain-English investing lessons + quizzes.
// Educational only — not financial advice.
window.LESSONS = [
  {
    id: 'basics', icon: '📈', title: 'Stock Market Basics', level: 'Beginner', minutes: 5,
    intro: 'What a stock is, why prices move, and how the market actually works.',
    sections: [
      { h: 'What is a stock?', p: 'A stock (or share) is a small piece of ownership in a company. If a company has 1 billion shares and you own 100, you own a tiny slice of its future profits and assets.' },
      { h: 'Why do prices move?', p: 'A stock’s price is just what buyers and sellers agree on right now. It rises when more people want to buy than sell, and falls when the reverse is true — driven by earnings, news, interest rates, and overall sentiment.' },
      { h: 'Exchanges & tickers', p: 'Stocks trade on exchanges like the NYSE and Nasdaq during market hours. Each company has a ticker symbol (Apple = AAPL) used to look it up.' },
      { h: 'Bull vs bear', p: 'A "bull market" is a sustained rise in prices and optimism; a "bear market" is a sustained fall (often defined as a 20%+ drop) and pessimism. Both are normal parts of long cycles.' },
    ],
    quiz: [
      { q: 'What does owning a share represent?', options: ['A loan to the company', 'Part-ownership of the company', 'A guaranteed dividend'], correct: 1, why: 'A share is partial ownership — you own a fraction of the company, not a loan or a guarantee.' },
      { q: 'A stock’s price at any moment is mainly determined by…', options: ['The government', 'What buyers and sellers agree to trade at', 'The company’s CEO'], correct: 1, why: 'Price is set by supply and demand in the market — the latest price two parties agreed on.' },
      { q: 'A "bear market" generally means…', options: ['Prices rising strongly', 'A sustained decline in prices', 'A holiday for the exchange'], correct: 1, why: 'Bear = falling/pessimistic (often a 20%+ drop). Bull = rising/optimistic.' },
    ],
  },
  {
    id: 'technical', icon: '📊', title: 'Technical Analysis', level: 'Intermediate', minutes: 6,
    intro: 'Reading price charts — trends, moving averages, RSI, and MACD.',
    sections: [
      { h: 'The idea', p: 'Technical analysis studies price and volume patterns to gauge momentum and trend, on the theory that price already reflects what’s known. It’s about probabilities, not certainty.' },
      { h: 'Moving averages', p: 'A moving average smooths price over N days. When a short average (e.g. 50-day) is above a long one (200-day) it signals an uptrend (a "golden cross"); below signals a downtrend (a "death cross").' },
      { h: 'RSI', p: 'The Relative Strength Index (0–100) measures momentum. Above ~70 is "overbought" (stretched up, pullback risk); below ~30 is "oversold" (stretched down, possible bounce). It’s a caution flag, not a trigger.' },
      { h: 'MACD', p: 'MACD compares two moving averages to show momentum shifts. When its line crosses above its signal line, momentum is turning up; below, turning down.' },
    ],
    quiz: [
      { q: 'An RSI of 78 usually suggests a stock is…', options: ['Oversold', 'Overbought', 'Fairly valued'], correct: 1, why: 'Above ~70 = overbought (stretched to the upside, higher pullback risk). Below ~30 = oversold.' },
      { q: 'A "golden cross" is when…', options: ['The 50-day average crosses above the 200-day', 'Earnings beat estimates', 'RSI hits 50'], correct: 0, why: 'A golden cross (short average above long) is a classic uptrend signal; a death cross is the opposite.' },
      { q: 'Technical analysis is best described as…', options: ['A guaranteed prediction of price', 'A study of probabilities from price/volume', 'A measure of company profit'], correct: 1, why: 'It’s about odds and momentum from price action — never a guarantee.' },
    ],
  },
  {
    id: 'fundamental', icon: '🏢', title: 'Fundamental Analysis', level: 'Intermediate', minutes: 6,
    intro: 'Judging a business by its actual results — revenue, earnings, margins, and growth.',
    sections: [
      { h: 'The idea', p: 'Fundamental analysis values a company by its business: how much it earns, how fast it grows, how profitable and financially healthy it is — rather than its chart.' },
      { h: 'Revenue & earnings', p: 'Revenue is total sales. Earnings (net income) is what’s left after all costs. Earnings per share (EPS) divides that by shares outstanding. Growing revenue and EPS is a good sign; the market cares a lot about the growth rate.' },
      { h: 'Margins', p: 'Margins show efficiency. Gross margin is profit after direct costs; operating and net margins account for more expenses. Higher, stable margins usually mean pricing power and a stronger business.' },
      { h: 'Balance-sheet health', p: 'Look at cash vs debt. A company with lots of cash and manageable debt can survive downturns and invest; heavy debt adds risk, especially when rates are high.' },
    ],
    quiz: [
      { q: 'EPS stands for…', options: ['Equity per stock', 'Earnings per share', 'Expected price signal'], correct: 1, why: 'Earnings per share = net income divided by shares outstanding.' },
      { q: 'A rising gross margin generally indicates…', options: ['Weaker pricing power', 'Improving efficiency/pricing power', 'More debt'], correct: 1, why: 'Higher margins usually mean the company keeps more of each sale — a sign of efficiency or pricing power.' },
      { q: 'Fundamental analysis focuses on…', options: ['Chart patterns', 'The underlying business results', 'Social media buzz'], correct: 1, why: 'It’s about the business itself — revenue, earnings, margins, balance sheet.' },
    ],
  },
  {
    id: 'valuation', icon: '⚖️', title: 'Valuation', level: 'Intermediate', minutes: 6,
    intro: 'Is a stock cheap or expensive? P/E, PEG, and discounted cash flow.',
    sections: [
      { h: 'Price vs value', p: 'A great company can be a poor investment if you overpay. Valuation asks whether today’s price is reasonable relative to what the business earns and how fast it grows.' },
      { h: 'P/E ratio', p: 'Price-to-Earnings = price ÷ EPS. A P/E of 25 means you pay $25 per $1 of annual earnings. High P/E implies high growth expectations; low P/E can mean a bargain — or trouble.' },
      { h: 'PEG ratio', p: 'PEG = P/E ÷ earnings growth rate. It puts P/E in context: a P/E of 30 is reasonable if the company grows 30%/yr (PEG ≈ 1). Below 1 can signal good value for the growth.' },
      { h: 'Discounted cash flow (DCF)', p: 'A DCF estimates a company’s "intrinsic value" by projecting future cash flows and discounting them back to today. It’s powerful but very sensitive to assumptions — small changes swing the answer a lot.' },
    ],
    quiz: [
      { q: 'A P/E of 40 usually implies the market expects…', options: ['Low growth', 'High future growth', 'Bankruptcy'], correct: 1, why: 'A high P/E means investors are paying up for expected growth. If growth disappoints, the price often falls.' },
      { q: 'A PEG ratio near 1.0 suggests…', options: ['Price roughly matches growth', 'The stock is worthless', 'Guaranteed gains'], correct: 0, why: 'PEG ≈ 1 means the P/E is roughly justified by the growth rate — a rough "fair" zone.' },
      { q: 'A DCF valuation is…', options: ['Exact and certain', 'Very sensitive to its assumptions', 'Unaffected by growth rates'], correct: 1, why: 'DCF depends heavily on inputs like growth and discount rate — treat its output as a range, not a fact.' },
    ],
  },
  {
    id: 'statements', icon: '📄', title: 'Reading Financial Statements', level: 'Intermediate', minutes: 6,
    intro: 'The three statements every investor should recognize.',
    sections: [
      { h: 'Income statement', p: 'Shows performance over a period: revenue at the top, then costs, ending in net income (the "bottom line"). It answers: did the company make money?' },
      { h: 'Balance sheet', p: 'A snapshot in time of what a company owns (assets) and owes (liabilities); the difference is shareholders’ equity. It answers: how financially strong is it?' },
      { h: 'Cash flow statement', p: 'Tracks actual cash in and out — operating, investing, and financing. "Free cash flow" (operating cash minus capital spending) is prized because it’s hard to fake and funds dividends and buybacks.' },
      { h: 'Why cash matters', p: 'Profits can be shaped by accounting choices; cash is harder to massage. Consistently positive free cash flow is a strong sign of a healthy business.' },
    ],
    quiz: [
      { q: 'The "bottom line" (net income) appears on the…', options: ['Balance sheet', 'Income statement', 'Cash flow statement'], correct: 1, why: 'Net income is the final line of the income statement — revenue minus all costs.' },
      { q: 'A balance sheet shows…', options: ['Performance over a year', 'A snapshot of assets vs liabilities', 'Only cash movements'], correct: 1, why: 'It’s a point-in-time snapshot: assets, liabilities, and the equity in between.' },
      { q: 'Free cash flow is valued because…', options: ['It’s easy to manipulate', 'It’s hard to fake and funds dividends/buybacks', 'It ignores capital spending'], correct: 1, why: 'FCF = operating cash minus capex — real cash the business generates, hard to massage.' },
    ],
  },
  {
    id: 'risk', icon: '🛡️', title: 'Risk Management', level: 'Beginner', minutes: 5,
    intro: 'Protecting your capital — diversification, position sizing, and volatility.',
    sections: [
      { h: 'Diversification', p: 'Don’t put everything in one stock or sector. Spreading across many holdings means one blow-up won’t sink you. It’s the closest thing to a free lunch in investing.' },
      { h: 'Position sizing', p: 'Decide in advance how much of your portfolio any single stock can be. Keeping each position modest limits the damage from any one mistake.' },
      { h: 'Volatility', p: 'Volatility measures how much a price swings. Higher volatility = bigger ups and downs = more risk. It’s not "bad" by itself, but it should match your time horizon and stomach.' },
      { h: 'Only risk what you can lose', p: 'Money you may need soon shouldn’t be in volatile stocks. A long time horizon is your biggest ally — it lets you ride out downturns.' },
    ],
    quiz: [
      { q: 'Diversification mainly reduces…', options: ['The risk from any single holding', 'Trading fees', 'Taxes'], correct: 0, why: 'Spreading across holdings means one failure has limited impact on the whole portfolio.' },
      { q: 'Higher volatility means…', options: ['Smaller price swings', 'Larger price swings / more risk', 'Guaranteed losses'], correct: 1, why: 'Volatility = the size of price swings. More volatility means more risk, up and down.' },
      { q: 'Money you’ll need next month is best…', options: ['In volatile growth stocks', 'Kept out of volatile assets', 'Put in options'], correct: 1, why: 'Short-term money shouldn’t face big swings — you might have to sell at a bad time.' },
    ],
  },
  {
    id: 'longterm', icon: '🌱', title: 'Long-Term Investing', level: 'Beginner', minutes: 5,
    intro: 'Why time in the market usually beats timing the market.',
    sections: [
      { h: 'Compounding', p: 'Returns earn returns. A sum growing ~8%/year roughly doubles every 9 years. The longer you stay invested, the more this snowball works for you.' },
      { h: 'Time beats timing', p: 'Reliably predicting short-term moves is nearly impossible, and missing just a handful of the best days badly hurts long-run returns. Staying invested tends to win.' },
      { h: 'Index funds', p: 'For many people, low-cost index funds (owning the whole market, like an S&P 500 fund) are a simple, diversified, historically effective way to invest over decades.' },
      { h: 'Dollar-cost averaging', p: 'Investing a fixed amount on a schedule buys more shares when prices are low and fewer when high, smoothing out timing risk and removing emotion.' },
    ],
    quiz: [
      { q: 'Compounding means…', options: ['Returns earning further returns', 'Paying more fees', 'Selling at the top'], correct: 0, why: 'Gains generate their own gains over time — the core engine of long-term wealth.' },
      { q: 'Dollar-cost averaging is…', options: ['Investing a fixed amount on a schedule', 'Buying only at all-time highs', 'A type of option'], correct: 0, why: 'Investing steadily over time buys more when cheap, fewer when expensive, reducing timing risk.' },
      { q: 'Trying to time short-term moves is…', options: ['Easy and reliable', 'Very hard; missing top days hurts', 'Guaranteed to beat the market'], correct: 1, why: 'Timing is notoriously hard, and missing the best days disproportionately lowers returns.' },
    ],
  },
  {
    id: 'dividend', icon: '💵', title: 'Dividend Investing', level: 'Beginner', minutes: 5,
    intro: 'Earning cash income from stocks that pay you to hold them.',
    sections: [
      { h: 'What’s a dividend?', p: 'A dividend is a cash payment a company makes to shareholders, usually quarterly, from its profits. Not all companies pay them — many growth companies reinvest instead.' },
      { h: 'Dividend yield', p: 'Yield = annual dividend ÷ price. A $2 dividend on a $50 stock is a 4% yield. A very high yield can be a warning sign that the market expects a cut.' },
      { h: 'Payout ratio', p: 'The share of earnings paid as dividends. A moderate payout (say under ~60%) is more sustainable; a payout above 100% means paying more than it earns — often unsustainable.' },
      { h: 'Reinvesting', p: 'Reinvesting dividends to buy more shares supercharges compounding over decades — a big part of the stock market’s historical total return.' },
    ],
    quiz: [
      { q: 'Dividend yield equals…', options: ['Annual dividend ÷ price', 'Price ÷ earnings', 'Dividend × shares'], correct: 0, why: 'Yield = annual dividend per share divided by the share price.' },
      { q: 'A dividend yield of 15% might be…', options: ['Always great', 'A warning sign of a possible cut', 'Impossible'], correct: 1, why: 'Unusually high yields often signal a falling price or an unsustainable payout the market expects to be cut.' },
      { q: 'A payout ratio over 100% means…', options: ['Paying more than it earns', 'Very safe dividend', 'No dividend at all'], correct: 0, why: 'Paying out more than earnings is usually unsustainable and risks a cut.' },
    ],
  },
  {
    id: 'growth', icon: '🚀', title: 'Growth Investing', level: 'Intermediate', minutes: 5,
    intro: 'Buying fast-growing companies for future potential.',
    sections: [
      { h: 'The style', p: 'Growth investing targets companies expanding revenue and earnings quickly — often in tech or innovation — betting that rapid growth justifies a high price today.' },
      { h: 'Higher risk, higher reward', p: 'Growth stocks can soar but also fall hard when growth slows or rates rise, because so much of their value is expected future profit. Expect volatility.' },
      { h: 'What to look for', p: 'Strong, accelerating revenue growth, expanding markets, a durable edge (moat), and a path to profitability. Watch that valuation isn’t detached from reality.' },
      { h: 'Rates matter', p: 'Because their value is far in the future, growth stocks are especially sensitive to interest rates — higher rates make future profits worth less today.' },
    ],
    quiz: [
      { q: 'Growth stocks are especially sensitive to…', options: ['Dividend dates', 'Interest rates', 'Stock splits'], correct: 1, why: 'Their value is mostly future profit, which is discounted more heavily when rates rise.' },
      { q: 'Growth investing generally involves…', options: ['Low volatility, steady income', 'Higher risk and higher potential reward', 'Guaranteed dividends'], correct: 1, why: 'You pay up for fast growth — big upside, but sharp drops if growth disappoints.' },
      { q: 'A key thing to check in a growth stock is…', options: ['Only the ticker', 'Durable, accelerating growth and a moat', 'The CEO’s Twitter'], correct: 1, why: 'Sustainable growth and a competitive edge matter more than hype.' },
    ],
  },
  {
    id: 'value', icon: '🔍', title: 'Value Investing', level: 'Intermediate', minutes: 5,
    intro: 'Buying solid companies for less than they’re worth.',
    sections: [
      { h: 'The style', p: 'Value investing, associated with Warren Buffett and Benjamin Graham, seeks stocks trading below their intrinsic worth — buying a dollar for 70 cents and waiting for the gap to close.' },
      { h: 'Margin of safety', p: 'The core idea: buy with a cushion below your estimate of fair value, so you’re protected if you’re wrong. It’s about not overpaying.' },
      { h: 'Value traps', p: 'Cheap isn’t always good. A "value trap" is a stock that looks cheap but keeps falling because the business is genuinely deteriorating. Check that the low price is temporary, not terminal.' },
      { h: 'Patience', p: 'Value investing often requires patience — the market can take a long time to recognize value. It suits investors with a long horizon and steady temperament.' },
    ],
    quiz: [
      { q: 'A "margin of safety" means…', options: ['Buying well below your estimate of fair value', 'Using leverage', 'Buying at all-time highs'], correct: 0, why: 'It’s the cushion you build in by paying less than intrinsic value, protecting against mistakes.' },
      { q: 'A "value trap" is…', options: ['A cheap stock that keeps falling on a failing business', 'A guaranteed winner', 'A type of dividend'], correct: 0, why: 'Some cheap stocks are cheap for good reason — the business is deteriorating.' },
      { q: 'Value investing usually requires…', options: ['Day-trading speed', 'Patience', 'Ignoring the business'], correct: 1, why: 'The market can take years to close the gap — patience is essential.' },
    ],
  },
  {
    id: 'options', icon: '🎯', title: 'Options (Advanced)', level: 'Advanced', minutes: 6,
    intro: 'Contracts that can hedge or speculate — powerful and risky.',
    sections: [
      { h: 'Calls & puts', p: 'A call option is the right to BUY a stock at a set "strike" price by a date; a put is the right to SELL. Buyers pay a premium for that right. They’re often used to speculate or to hedge.' },
      { h: 'Leverage cuts both ways', p: 'Options control many shares for a small premium, magnifying gains — and losses. A bought option can expire worthless, losing 100% of the premium.' },
      { h: 'Time decay', p: 'Options lose value as expiration approaches (all else equal) — "theta decay." Time is working against option buyers, which is why timing matters so much.' },
      { h: 'Not for beginners', p: 'Options are complex and can lose money fast; some strategies (like selling naked options) carry very large or unlimited risk. Understand them thoroughly — on paper first — before risking real money.' },
    ],
    quiz: [
      { q: 'A call option gives the holder the right to…', options: ['Sell a stock at the strike', 'Buy a stock at the strike', 'Collect a dividend'], correct: 1, why: 'A call = right to buy at the strike price; a put = right to sell.' },
      { q: '"Theta decay" refers to…', options: ['Options gaining value over time', 'Options losing value as expiration nears', 'A dividend cut'], correct: 1, why: 'All else equal, options lose time value as expiration approaches — bad for buyers.' },
      { q: 'Compared with buying stock, options are…', options: ['Always safer', 'More leveraged and can expire worthless', 'Guaranteed income'], correct: 1, why: 'Leverage magnifies gains and losses, and a bought option can lose 100% of its premium.' },
    ],
  },
];
