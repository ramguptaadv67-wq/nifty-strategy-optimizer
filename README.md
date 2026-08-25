# NIFTY Strategy Optimizer

Upload your OHLCV candle data (CSV), sweep **all parameter combinations** across configurable ranges (default 0â€“99), and instantly get the **top 20 best-performing parameter sets** for the NIFTY engulfing-doji-TSL strategy.

A faithful JavaScript port of the Pine Script v5 `strategy("NIFTY â€” webhook()")` strategy, running entirely in your browser via Web Workers. No server, no data leaves your machine.

## What it does

1. **Parses** your CSV OHLCV data (TradingView export, Yahoo Finance, Zerodha, etc.)
2. **Translates** the Pine Script strategy to JavaScript â€” engulfing detection, doji setup-line touches, Tradetron-style trailing stop-loss (TSL), day-of-week/monthly-expiry filters, candle-based time exits
3. **Sweeps** every parameter combination you configure (engulf_min, doji_body_max, activation_pts, lock_profit, profit_step, trail_step â€” each 0â€“99 by default)
4. **Ranks** all results by net profit (or Sharpe, win rate, profit factor) and shows the **top 20**
5. **Visualizes** the equity curve for any of the top 20 with a single click

## Strategy logic (ported from Pine Script)

The strategy combines three concepts:

- **Engulfing pattern detection** â€” a bullish/bearish engulfing candle sets up a "setup line" at its midpoint
- **Doji confirmation** â€” a doji touching the setup line triggers a long (CE signal, green doji) or short (PE signal, red doji) entry
- **Tradetron-style trailing stop-loss** â€” once price moves `activation_pts` in your favor, a TSL locks in `lock_profit` and ratchets up in `profit_step`/`trail_step` increments
- **Filters** â€” optional no-trade on Monday, no-trade on monthly expiry day, exit on monthly expiry, exit after N candles

## Quick start (local)

```bash
# No build step needed. Just serve the folder:
cd nifty-optimizer
python3 -m http.server 8000
# Open http://localhost:8000
```

Or open `index.html` directly in a browser (Web Workers require a server though, so the local server is recommended).

## Deploy to Cloudflare Pages

This is a fully static site â€” no backend needed.

### Option A: Git-connected (recommended)

1. Push this repo to GitHub
2. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) â†’ **Workers & Pages** â†’ **Create** â†’ **Pages** â†’ **Connect to Git**
3. Select your repository
4. Build settings:
   - **Framework preset:** None
   - **Build command:** (leave empty)
   - **Build output directory:** `/` (root)
5. Click **Save and Deploy** â€” your site goes live in ~30 seconds on a `*.pages.dev` URL

### Option B: Direct upload (Wrangler CLI)

```bash
npm install -g wrangler
cd nifty-optimizer
wrangler pages deploy . --project-name nifty-optimizer
```

### Option C: Drag & drop

1. Zip the folder contents
2. Go to Cloudflare Pages â†’ **Create** â†’ **Direct Upload**
3. Drag the zip file

## CSV format

Any CSV with OHLCV columns. The parser auto-detects headers and is flexible with column order:

```
time,open,high,low,close,volume
2024-01-01,20000,20100,19950,20050,1000000
2024-01-02,20050,20200,20000,20150,950000
```

Supported time formats: Unix timestamp (seconds or milliseconds), ISO date (`2024-01-01`), or `YYYY-MM-DD HH:MM`.

## Parameter sweep

Each of the 6 numeric parameters can be configured with a **min**, **max**, and **step**:

| Parameter | Description | Default Range | Default Step |
|---|---|---|---|
| `engulf_min` | Minimum engulfing candle body size (points) | 0â€“99 | 4 |
| `doji_body_max` | Maximum doji body size (points) | 0â€“99 | 4 |
| `activation_pts` | Profit at which TSL activates | 0â€“99 | 5 |
| `lock_profit` | Profit locked when TSL activates | 0â€“99 | 4 |
| `profit_step` | Increment for extra profit calculation | 1â€“99 | 5 |
| `trail_step` | TSL movement per profit step | 1â€“99 | 5 |

With defaults this tests ~131,000 combinations. Reduce step sizes or ranges for faster sweeps.

## Metrics shown

For each of the top 20 results:

- **Net Profit** â€” total points gained/lost
- **Trades** â€”[X™\ˆÙˆÛÛ\]Y˜Y\Â‹H
Š•Ú[ˆ˜]H	JŠˆ8 %\˜Ù[YÙHÙˆ›Ùš]X›H˜Y\Â‹H
Š”›Ùš]˜XİÜŠŠˆ8 %Ü›ÜÜÈ›Ùš]ÈÜ›ÜÜÈÜÜÂ‹H
Š”Ú\œH˜][ÊŠˆ8 %š\ÚËXY\İY™]\›‚‹H
Š“X^˜]ÙİÛŠŠˆ8 %\™Ù\İXZË]Ë]›İYÚXÛ[™B‹H
Š]™ËÕ˜YJŠˆ8 %YX[ˆ›Ùš]\ˆ˜YB‚ˆÈÈXÚİXÚÂ‚‹H
Š”\™H˜[š[H”ÊŠˆ8 $›Èœ˜[Y]ÛÜšÜË›È\[™[˜ÚY\Ë›ÈZ[İ\‹H
Š•ÙXˆÛÜšÙ\œÊŠˆ8 %Ü[Z^˜][Ûˆ[œÈÙ™ˆHXZ[ˆ™XYRHİ^\È™\ÜÛœÚ]™B‹H
ŠØ[˜\ÊŠˆ8 $YÚÙZYÚ\]Z]KXİ\™HÚ\[™Â‹H
ŠŒL	HÛY[\ÚYJŠˆ8 %[İ\ˆ]H™]™\ˆX]™\È[İ\ˆœ›İÜÙ\‚‚ˆÈÈš[HİXİ\™B‚˜šYK[Ü[Z^™\‹Â¸¥'8¥ 8¥ [™^š[ÈXZ[ˆRH
S
ÈÔÔÈ
È\ÙÚXÊB¸¥'8¥ 8¥ œËÂ¸¥ ˆ8¥'8¥ 8¥ [™Ú[™KšœÈÈ˜XÚİ\İ[™È[™Ú[™H
[™HØÜš\8¡¤ˆ”ÈÜ
B¸¥ ˆ8¥'8¥ 8¥ Ü[Z^™\‹šœÈÈ\˜[Y]\ˆİÙY\ÙÚXÂ¸¥ ˆ8¥'8¥ 8¥ Üİ‹šœÈÈÔÕˆ\œÙ\‚¸¥ ˆ8¥%8¥ 8¥ ÛÜšÙ\‹šœÈÈÙXˆÛÜšÙ\ˆ
[œÈİÙY\Ù™ˆXZ[ˆ™XY
B¸¥'8¥ 8¥ İ˜]YŞKœ[™HÈÜšYÚ[˜[[™HØÜš\H™Y™\™[˜ÙB¸¥'8¥ 8¥ Ü™Y\™XİÈÈÛİY›\™HYÙ\ÈÔH™Y\™Xİ¸¥%8¥ 8¥ ‘PQQK›Y˜‚ˆÈÈXÙ[œÙB‚“RU