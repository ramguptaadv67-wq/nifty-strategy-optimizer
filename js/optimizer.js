/**
 * optimizer.js — Parameter sweep optimizer (memory-efficient version)
 * 
 * KEY FIX: Does NOT build all combinations in memory. Instead:
 *   - Counts total combinations mathematically (just multiplication)
 *   - Iterates combinations one-at-a-time using a mixed-radix counter
 *   - Keeps only the top 20 results in a rolling buffer
 * 
 * Exposes `optimizeParams(candles, ranges, fixedParams, steps, onProgress, sortMetric)` on globalThis.
 */
(function (global) {
  "use strict";

  var TOP_N = 20;
  var MAX_COMBOS = 2000000; // 2M safety limit

  /**
   * Count total combinations without building the array.
   */
  function countCombinations(ranges, steps) {
    var keys = Object.keys(ranges);
    var total = 1;
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var min = ranges[key][0];
      var max = ranges[key][1];
      var step = (steps && steps[key]) || 1;
      if (step <= 0) step = 1;
      var count = Math.floor((max - min) / step) + 1;
      if (count < 0) count = 0;
      total *= count;
    }
    return total;
  }

  /**
   * Generate parameter values for each key as an array.
   * Returns { keys: [...], valueLists: [[...], [...], ...] }
   */
  function buildValueLists(ranges, steps) {
    var keys = Object.keys(ranges);
    var valueLists = [];
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var min = ranges[key][0];
      var max = ranges[key][1];
      var step = (steps && steps[key]) || 1;
      if (step <= 0) step = 1;
      var vals = [];
      for (var v = min; v <= max; v += step) {
        vals.push(v);
      }
      valueLists.push(vals);
    }
    return { keys: keys, valueLists: valueLists };
  }

  /**
   * Rolling top-N buffer. Keeps the best N results by `metricValue`.
   * Uses a simple sorted array (ascending by metricValue so worst is at index 0).
   */
  function TopNBuffer(n, isDesc) {
    this.n = n;
    this.items = []; // sorted ascending by metricValue (worst at [0])
    this.isDesc = isDesc; // true = higher is better
  }

  TopNBuffer.prototype.tryInsert = function (item, metricValue) {
    if (!isFinite(metricValue)) return;
    var arr = this.items;
    if (arr.length < this.n) {
      // Still filling — insert in sorted position
      var pos = 0;
      while (pos < arr.length && arr[pos].metricValue <= metricValue) pos++;
      arr.splice(pos, 0, { item: item, metricValue: metricValue });
    } else {
      // Full — only insert if better than the worst
      var worst = this.isDesc ? arr[0] : arr[arr.length - 1];
      if (this.isDesc) {
        // Higher is better — worst is at [0] (smallest value)
        if (metricValue > arr[0].metricValue) {
          // Binary search for insert position
          var lo = 1, hi = arr.length;
          while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (arr[mid].metricValue < metricValue) lo = mid + 1;
            else hi = mid;
          }
          arr.splice(lo, 0, { item: item, metricValue: metricValue });
          arr.shift(); // remove worst (smallest)
        }
      } else {
        // Lower is better — worst is at [length-1] (largest value)
        if (metricValue < arr[arr.length - 1].metricValue) {
          var lo2 = 0, hi2 = arr.length - 1;
          while (lo2 < hi2) {
            var mid2 = (lo2 + hi2) >> 1;
            if (arr[mid2].metricValue <= metricValue) lo2 = mid2 + 1;
            else hi2 = mid2;
          }
          arr.splice(lo2, 0, { item: item, metricValue: metricValue });
          arr.pop(); // remove worst (largest)
        }
      }
    }
  };

  TopNBuffer.prototype.getSorted = function () {
    // Return items sorted best-first
    if (this.isDesc) {
      return this.items.slice().reverse().map(function (e) { return e.item; });
    } else {
      return this.items.slice().map(function (e) { return e.item; });
    }
  };

  /**
   * Run optimization sweep.
   * @param {Array} candles - OHLCV candle data
   * @param {Object} ranges - { param: [min, max] }
   * @param {Object} fixedParams - params not swept
   * @param {Object} steps - { param: stepSize }
   * @param {Function} onProgress - (done, total) => void
   * @param {String} sortMetric - 'netProfit' | 'sharpe' | 'winRate' | 'profitFactor'
   * @returns {Object} { top: [...20], totalTested, totalCombinations }
   */
  function optimizeParams(candles, ranges, fixedParams, steps, onProgress, sortMetric) {
    var metric = sortMetric || "netProfit";
    // For most metrics, higher is better. For maxDrawdown, lower is better.
    var isDesc = (metric !== "maxDrawdown");

    // Count combinations without building the array
    var total = countCombinations(ranges, steps);

    if (total === 0) {
      return { top: [], totalTested: 0, totalCombinations: 0 };
    }

    if (total > MAX_COMBOS) {
      throw new Error(
        "Too many combinations (" + total.toLocaleString("en-IN") + "). " +
        "Maximum is " + MAX_COMBOS.toLocaleString("en-IN") + ". " +
        "Increase step sizes or narrow ranges."
      );
    }

    // Build value lists for each parameter
    var info = buildValueLists(ranges, steps);
    var keys = info.keys;
    var valueLists = info.valueLists;
    var numParams = keys.length;

    // Base params
    var baseParams = {
      no_trade_monday: true,
      no_trade_monthly_exp: false,
      expiry_dow_str: "Tuesday",
      exit_on_monthly: true,
      monthly_exit_time: "1510-1520",
      use_candle_exit: true,
      max_candles: 300
    };
    if (fixedParams) {
      var fpKeys = Object.keys(fixedParams);
      for (var f = 0; f < fpKeys.length; f++) {
        baseParams[fpKeys[f]] = fixedParams[fpKeys[f]];
      }
    }

    var topBuffer = new TopNBuffer(TOP_N, isDesc);
    var tested = 0;
    var progressInterval = Math.max(1, Math.floor(total / 200)); // report ~200 times

    // Mixed-radix counter to iterate combinations one at a time
    var indices = new Array(numParams).fill(0);

    while (true) {
      // Build current params from indices
      var params = {};
      var skipCombo = false;
      for (var p = 0; p < numParams; p++) {
        params[keys[p]] = valueLists[p][indices[p]];
      }

      // Merge with base params
      var fullParams = {};
      var bpKeys = Object.keys(baseParams);
      for (var b = 0; b < bpKeys.length; b++) {
        fullParams[bpKeys[b]] = baseParams[bpKeys[b]];
      }
      for (var p2 = 0; p2 < numParams; p2++) {
        fullParams[keys[p2]] = params[keys[p2]];
      }

      // Skip invalid combos
      if (fullParams.profit_step <= 0 || fullParams.trail_step <= 0) {
        // skip
      } else {
        var result = global.runBacktest(candles, fullParams);
        tested++;

        var metricValue = result.metrics[metric];
        topBuffer.tryInsert(
          { params: fullParams, metrics: result.metrics, trades: result.trades.length },
          metricValue
        );
      }

      // Report progress
      if (onProgress && (tested % progressInterval === 0 || tested === total)) {
        onProgress(tested, total);
      }

      // Increment the mixed-radix counter
      var carry = numParams - 1;
      while (carry >= 0) {
        indices[carry]++;
        if (indices[carry] < valueLists[carry].length) {
          break;
        }
        indices[carry] = 0;
        carry--;
      }
      if (carry < 0) {
        break; // all combinations exhausted
      }
    }

    var top = topBuffer.getSorted();
    return { top: top, totalTested: tested, totalCombinations: total };
  }

  global.optimizeParams = optimizeParams;
  global.countCombinations = countCombinations;
})(typeof self !== "undefined" ? self : globalThis);
