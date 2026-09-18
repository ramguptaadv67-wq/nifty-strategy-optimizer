# NIFTY Strategy Optimizer

Fetch live NIFTY data (index charts from Yahoo Finance, NIFTY futures from NSE), sweep **all parameter combinations** across configurable ranges (default 0-99), and instantly get the **top 20 best-performing parameter sets** for the NIFTY engulfing-doji-TSL strategy.

A faithful JavaScript port of the Pine Script v5 `strategy("NIFTY — webhook()")` strategy, running entirely in your browser via Web Workers. The only backend is a Cloudflare Worker that proxies data (no CORS issues).

## What it does

1. **Fetches** live candle data - pick a chart (NIFTY 50, NIFTY 50 FUTURES, SENSEX, BANK NIFTY, FINNIFTY, MIDCAP 100, SMLCAP 250, NIFTY IT), a timeframe (1m to 1 month, including 3-min built from 1-min data), and a range
2. **Translates** the Pine Script strategy to JavaScript - engulfing detection, doji setup-line touches, Tradetron-style trailing stop-loss (TSL), day-of-week/monthly-expiry filters, candle-based time exits
3. **Sweeps** every parameter combination you configure (engulf_min, doji_body_max, activation_pts, lock_profit, profit_step, trail_step - step is always 1, every value in range is tested)
4. **Ranks** all results by net profit (or Sharpe, win rate, profit factor) and shows the **top 20**
5. **Visualizes** the equity curve for any of the top 20 with a single click
6. **Reproducible** - same ranges + same data always gives the same top 20 (seeded random sampling)

## Strategy logic (ported from Pine Script)

- **Engulfing pattern detection** - a bullish/bearish engulfing candle sets up a "setup line" at its midpoint
- **Doji confirmation** - a doji touching the setup line triggers a long (CE signal) or short (PE signal) entry
- **Tradetron-style trailing stop-loss** - once price moves `activation_pts` in your favor, a TSL locks in `lock_profit` and ratchets up in `profit_step`/`trail_step` increments
- **Filters** - optional no-trade on Monday, no-trade on monthly expiry day, exit on monthly expiry, exit after N candles

## Data sources

| Chart | Source | Timeframes |
|---|---|---|
| NIFTY 50, SENSEX, BANK, FINNIFTY, MIDCAP, SMLCAP, IT | Yahoo Finance | 1m, 2m, 3m*, 5m, 15m, 30m, 1h, 1d, 1wk, 1mo |
| NIFTY 50 FUTURES (EOD) | NSE UDiFF bhavcopy archives | Daily candles only |

*3-min candles are built in the browser from 1-min data (Yahoo has no native 3m interval; ~1 month of history available).

Note: intraday NIFTY futures candles (3-min etc.) are only available through a broker API (e.g. Angel One SmartAPI, free with an account). NSE publishes only end-of-day futures data for free.

## Deploy to Cloudflare Workers

```bash
npm install -g wrangler
wrangler login
npx wrangler deploy
```

Then hard-refresh the site (Ctrl+Shift+R) and check the **Build** date in the header matches today - if it does not, the deploy did not go through.

## Parameter sweep

Each of the 6 numeric parameters is configured with a **min** and **max** (step is fixed at 1 - every value in the range is tested):

| Parameter | Description | Default Range |
|---|---|---|
| `engulf_min` | Minimum engulfing candle body size (points) | 0-99 |
| `doji_body_max` | Maximum doji body size (points) | 0-9 |
| `activation_pts` | Profit at which TSL activates | 0-99 |
| `lock_profit` | Profit locked when TSL activates | 0-99 |
| `profit_step` | Increment for extra profit calculation | 1-99 |
| `trail_step` | TSL movement per profit step | 1-99 |

Sweeps larger than 1,00,000 combinations are randomly sampled (1,00,000 combos, seeded - so results are still reproducible).

## Metrics shown

For each of the top 20 results: **Net Profit**, **Trades**, **Win Rate %**, **Profit Factor**, **Sharpe**, **Max Drawdown**, **Avg/Trade**, and the full parameter set.

## Checkpoints (nothing can be deleted silently)

Every push to `main` runs the **Checkpoint** GitHub Action (see `.github/workflows/checkpoint.yml`):

1. **Feature guard** - it checks that every existing chart, timeframe, parameter, and endpoint is still present in the code. If a change deletes any feature, or a file gets truncated/replaced with junk, the check FAILS with a red X (repo -> Actions tab).
2. **Restore points** - if the check passes, the version is tagged `checkpoint-<date>-<sha>` as a restore point.

### How to check

Go to the repo on GitHub -> **Actions** tab. A red X next to a commit means that change deleted a feature - **do not deploy it**. A green tick means all features are intact and a checkpoint tag was created.

### How to restore if something was deleted

From a local clone:

```bash
git fetch --tags
git tag -l "checkpoint-*"        # list restore points (newest last)
git checkout <newest-tag> -- .   # restore ALL files from that checkpoint
git commit -m "Restore from checkpoint"
git push
```

Or on GitHub.com: open the last green commit -> "Revert changes" button.

## Files

- `index.html` - the whole app (UI + Yahoo/NSE fetching + optimization client)
- `js/worker.js` - self-contained Web Worker (engine + optimizer + CSV parser inlined, no imports)
- `src/index.js` - Cloudflare Worker: `/api/yahoo` proxy + `/api/nsefut` NSE futures endpoint
