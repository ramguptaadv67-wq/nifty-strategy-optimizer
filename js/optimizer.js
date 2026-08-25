/**
 * optimizer.js — Parameter sweep optimizer
 * Tests all parameter combinations (0–99 range, or custom ranges) and
 * returns the top 20 results ranked by net profit.
 *
 * Exposes `optimizeParams(candles, ranges, options)` on globalThis.
 */
(function (global) {
  "use strict";

  /**
   * Build all parameter combinations from ranges.
   * ranges: { engulf_min: [0,99], activation_pts: [0,99], ... }
   * Each range is [min, max] (inclusive). Step defaults to 1.
   * options.step: { engulf_min: 2, ... } to reduce combination count.
   */
  function buildCombinations(ranges, steps) {
    const keys = Object.keys(ranges);
    const combos = [];
    function recurse(idx, current) {
      if (idx === keys.length) { combos.push({ ...current }); return;
}
      const key = keys[idx];
      const [min, max] = ranges[key];
      const step = (steps && steps[key]) || 1;
      for (let v = min; v <= max; v += step) {
        current[key] = v;
        recurse(idx + 1, current);
      }
    }
    recurse(0, {});
    return combos;
  }

  /**
   * Run optimization sweep.
   * @param {Array} candles - OHLCV candle data
   * @param {Object} ranges - { param: [min, max] }
   * @param {Object} fixedParams - params not swept (e.g. booleans, strings)
   * @param {Object} steps - { param: stepSize }
   * @param {Function} onProgress - (done, total) => void
   * @param {Object} sortMetric - metric to sort by: 'netProfit' | 'sharpe' | 'winRate' | 'profitFactor'
   * @returns {Array} top 20 results
   */
  function optimizeParams(candles, ranges, fixedParams, steps, onProgress, sortMetric) {
    const combos = buildCombinations(ranges, steps);
    const total = combos.length;
    const results = [];

    const baseParams = {
      no_trade_monday: true,
      no_trade_monthly_exp: false,
      expiry_dow_str: "Tuesday",
      exit_on_monthly: true,
      monthly_exit_time: "1510-1520",
      use_candle_exit: true,
      max_candles: 300,
      ...fixedParams,
    };

    for (let i = 0; i < combos.length; i++) {
      const params = { ...baseParams, ...combos[i] };

      // Skip invalid combos early
      if (params.profit_step <= 0 || params.trail_step <= 0) {
        if (onProgress) onProgress(i + 1, total);
        continue;
      }

      const { trades, equity, metrics } = global.runBacktest(candles, params);
      results.push({ params, metrics, trades: trades.length });
      if (onProgress) onProgress(i + 1, total);
    }

    // Sort by chosen metric, descending
    const metric = sortMetric || "netProfit";
    results.sort((a, b) => {
      const av = a.metrics[metric];
      const bv = b.metrics[metric];
      if (isFinite(av) && isFinite(bv)) return bv - av;
      if (isFinite(av)) return -1;
      if (isFinite(bv)) return 1;
      return 0;
    });

    return { top: results.slice(0, 20), totalTested: results.length, totalCombinations: total };
  }

  global.optimizeParams = optimizeParams;
  global.buildCombinations = buildCombinations;
})(typeof self !== "undefined" ? self : globalThis);
