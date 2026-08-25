/**
 * yahoo.js — Fetch OHLCV candle data from Yahoo Finance
 * Uses Cloudflare Pages Function (/api/yahoo) when available,
 * falls back to public CORS proxies for local/other hosting.
 */
(function (global) {
  "use strict";

  const SYMBOLS = {
    "NIFTY 50": "^NSEI",
    "BANK NIFTY": "^NSEI",
    "NIFTY BANK": "^NSEI",
    "SENSEX": "^BSESN",
  };

  const INTERVALS = {
    "1 min": "1m",
    "5 min": "5m",
    "15 min": "15m",
    "30 min": "30m",
    "1 hour": "60m",
    "1 day": "1d",
    "1 week": "1wk",
    "1 month": "1mo",
  };

  // Yahoo range limits:
  // Intraday (1m-60m): max 60 days (use 1mo, 3mo for intraday)
  // Daily+: 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, max
  const RANGES = ["1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "max"];

  // CORS proxy fallbacks (tried in order)
  // Each returns a fetch-compatible URL that wraps the original Yahoo URL
  const CORS_PROXIES = [
    (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    (url) => `https://thingproxy.freeboard.io/fetch/${url}`,
    (url) => `https://cors-anywhere.herokuapp.com/${url}`,
  ];

  /**
   * Fetch candle data from Yahoo Finance.
   * @param {string} symbol - Yahoo ticker (e.g. "^NSEI")
   * @param {string} interval - "1m","5m","15m","30m","60m","1d","1wk","1mo"
   * @param {string} range - "1mo","3mo","6mo","1y","2y","5y","10y","max"
   * @param {function} onProgress - optional callback(statusMsg)
   * @returns {Promise<{candles: Array, csvText: string, meta: object}>}
   */
  async function fetchCandles(symbol, interval, range, onProgress) {
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;

    let data = null;
    let lastError = null;

    // Try 1: Cloudflare Pages Function (works when deployed on Cloudflare)
    if (onProgress) onProgress("Trying Cloudflare proxy...");
    try {
      const fnUrl = `/api/yahoo?symbol=${encodeURIComponent(symbol)}&interval=${interval}&range=${range}`;
      const resp = await fetch(fnUrl);
      if (resp.ok) {
        data = await resp.json();
      }
    } catch (e) {
      // Not deployed on Cloudflare or function not available
    }

    // Try 2: Public CORS proxies
    if (!data) {
      for (let i = 0; i < CORS_PROXIES.length; i++) {
        if (onProgress) onProgress(`Trying CORS proxy ${i + 1}/${CORS_PROXIES.length}...`);
        try {
          const proxyUrl = CORS_PROXIES[i](yahooUrl);
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 8000);
          const resp = await fetch(proxyUrl, { signal: controller.signal });
          clearTimeout(timeout);
          if (resp.ok) {
            const text = await resp.text();
            data = JSON.parse(text);
            if (data && data.chart && data.chart.result) break;
            data = null;
          }
        } catch (e) {
          lastError = e;
        }
      }
    }

    if (!data || !data.chart || !data.chart.result) {
      throw new Error(
        "Failed to fetch from Yahoo Finance. " +
        "All CORS proxies are unavailable or rate-limited. " +
        "Please try again in a moment. " +
        (lastError ? "(" + lastError.message + ")" : "")
      );
    }

    const result = data.chart.result[0];
    const timestamps = result.timestamp || [];
    const quote = result.indicators.quote[0];
    const meta = result.meta || {};

    // Build candle array
    const candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = quote.open[i];
      const h = quote.high[i];
      const l = quote.low[i];
      const c = quote.close[i];
      const v = quote.volume ? quote.volume[i] : 0;
      // Skip null candles (Yahoo sometimes returns null for non-trading periods)
      if (o == null || h == null || l == null || c == null) continue;
      candles.push({
        time: timestamps[i] * 1000, // convert to ms
        open: o,
        high: h,
        low: l,
        close: c,
        volume: v || 0,
      });
    }

    // Also build CSV text so it flows through the existing pipeline
    let csvText = "Date,Open,High,Low,Close,Volume\n";
    for (const candle of candles) {
      const d = new Date(candle.time);
      const dateStr =
        interval === "1d" || interval === "1wk" || interval === "1mo"
          ? d.toISOString().slice(0, 10)
          : d.toISOString().slice(0, 16).replace("T", " ");
      csvText += `${dateStr},${candle.open},${candle.high},${candle.low},${candle.close},${candle.volume}\n`;
    }

    if (onProgress) onProgress(`Fetched ${candles.length} candles from Yahoo Finance`);

    return { candles, csvText, meta };
  }

  global.YahooFinance = {
    fetchCandles,
    SYMBOLS,
    INTERVALS,
    RANGES,
  };
})(window);
