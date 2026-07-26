# Market IQ

A web tool that pulls stock price data, computes technical indicators
(SMA 20/50, RSI), draws a chart with a naive trend projection, and writes a
short plain-English analysis.

> ⚠️ Educational / analysis only — **not financial advice**. No tool reliably
> predicts stock prices. The projection is a simple statistical line and can be wrong.

## Run locally
    node server.js          # → http://localhost:3000

Runs in **demo mode** out of the box (deterministic sample data per ticker), so
it works with no keys. Add keys for the real thing:

| Env var             | What it enables                                             |
|---------------------|-------------------------------------------------------------|
| `STOCK_API_KEY`     | Real prices via Twelve Data (twelvedata.com — free tier).   |
| `ANTHROPIC_API_KEY` | AI-written analysis via Claude (else a rule-based summary).  |
| `ANTHROPIC_MODEL`   | Defaults to `claude-opus-4-8`; set a cheaper model to save.  |

Set them without pasting into any chat, e.g.:
    STOCK_API_KEY=xxxx ANTHROPIC_API_KEY=sk-ant-xxxx node server.js

## Structure
- `indicators.js` — pure technical-analysis math (unit-tested)
- `server.js` — HTTP server + `/api/stock` and `/api/analyze`
- `public/` — frontend (chart drawn on a canvas, no libraries)

## Deploy
Push to GitHub → Render Web Service (Start: `node server.js`), add the env vars.
