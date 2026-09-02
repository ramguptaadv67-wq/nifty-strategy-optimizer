/**
 * optimizer.js - Parameter sweep optimizer with random sampling
 *
 * When total combinations exceed SAMPLE_LIMIT (100,000), picks random
 * combinations to test instead of iterating through all of them.
 * Uses seeded PRNG (mulberry32, seed=42) so results are reproducible.
 *
 * Exposes `optimizeParams(candles, ranges, fixedParams, steps, onProgress, sortMetric)` on globalThis.
 */
(function (global) {
  "use strict";

  var TOP_N = 20;
  var SAMPLE_LIMIT = 100000; // 1 lakh - max random samples when combos exceed this

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

  // Seeded PRNG (mulberry32) - same seed = same results every time
  function makeRng(seed) {
    var s = seed | 0;
    return function() {
      s = (s + 0x6D2B79F5) | 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function TopNBuffer(n, isDesc) {
    this.n = n;
    this.items = [];
    this.isDesc = isDesc;
  }

  TopNBuffer.prototype.tryInsert = function (item, metricValue) {
    if (!isFinite(metricValue)) return;
    var arr = this.items;
    if (arr.length < this.n) {
      var pos = 0;
      while (pos < arr.length && arr[pos].metricValue <= metricValue) pos++;
      arr.splice(pos, 0, { item: item, metricValue: metricValue });
    } else {
      if (this.isDesc) {
        if (metricValue > arr[0].metricValue) {
          var lo = 1, hi = arr.length;
          while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (arr[mid].metricValue < metricValue) lo = mid + 1;
            else hi = mid;
          }
          arr.splice(lo, 0, { item: item, metricValue: metricValue });
          arr.shift();
        }
      } else {
        if (metricValue < arr[arr.length - 1].metricValue) {
          var lo2 = 0, hi2 = arr.length - 1;
          while (lo2 < hi2) {
            var mid2 = (lo2 + hi2) >> 1;
            if (arr[mid2].metricValue <= metricValue) lo2 = mid2 + 1;
            else hi2 = mid2;
          }
          arr.splice(lo2, 0, { item: item, metricValue: metricValue });
          arr.pop();
        }
      }
    }
  };

  TopNBuffer.prototype.getSorted = function () {
    if (this.isDesc) {
      return this.items.slice().reverse().map(function (e) { return e.item; });
    } else {
      return this.items.slice().map(function (e) { return e.item; });
    }
  };

  function optimizeParams(candles, ranges, fixedParams, steps, onProgress, sortMetric) {
    var metric = sortMetric || "netProfit";
    var isDesc = (metric !== "maxDrawdown");

    var total = countCombinations(ranges, steps);

    if (total === 0) {
      return { top: [], totalTested: 0, totalCombinations: 0 };
    }

    var info = buildValueLists(ranges, steps);
    var keys = info.keys;
    var valueLists = info.valueLists;
    var numParams = keys.length;

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

    var useSampling = total > SAMPLE_LIMIT;
    var targetCount = useSampling ? SAMPLE_LIMIT : total;

    if (onProgress) onProgress(0, targetCount);

    if (useSampling) {
      // RANDOM SAMPLING with seeded PRNG (reproducible)
      var rng = makeRng(42);
      var seen = {};
      var attempts = 0;
      var maxAttempts = SAMPLE_LIMIT * 3;

      while (tested < SAMPLE_LIMIT && attempts < maxAttempts) {
        attempts++;

        var params = {};
        for (var p = 0; p < numParams; p++) {
          var idx = Math.floor(rng() * valueLists[p].length);
          params[keys[p]] = valueLists[p][idx];
        }

        var key = "";
        for (var p2 = 0; p2 < numParams; p2++) {
          key += params[keys[p2]] + ",";
        }
        if (seen[key]) continue;
        seen[key] = true;

        var fullParams = {};
        var bpKeys = Object.keys(baseParams);
        for (var b = 0; b < bpKeys.length; b++) {
          fullParams[bpKeys[b]] = baseParams[bpKeys[b]];
        }
        for (var p3 = 0; p3 < numParams; p3++) {
          fullParams[keys[p3]] = params[keys[p3]];
        }

        if (fullParams.profit_step <= 0 || fullParams.trail_step <= 0) continue;

        var result = global.runBacktest(candles, fullParams);
        tested++;

        var metricValue = result.metrics[metric];
        topBuffer.tryInsert(
          { params: fullParams, metrics: result.metrics, trades: result.trades.length },
          metricValue
        );

        if (onProgress && (tested % 500 === 0 || tested === targetCount)) {
          onProgress(tested, targetCount);
        }
      }
    } else {
      // FULL SWEEP: test every combination
      var progressInterval = Math.min(50000, Math.max(1, Math.floor(total / 200)));
      var indices = new Array(numParams).fill(0);

      while (true) {
        var params = {};
        for (var p = 0; p < numParams; p++) {
          params[keys[p]] = valueLists[p][indices[p]];
        }

        var fullParams = {};
        var bpKeys = Object.keys(baseParams);
        for (var b = 0; b < bpKeys.length; b++) {
          fullParams[bpKeys[b]] = baseParams[bpKeys[b]];
        }
        for (var p2 = 0; p2 < numParams; p2++) {
          fullParams[keys[p2]] = params[keys[p2]];
        }

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

        if (onProgress && (tested % progressInterval === 0 || tested === total)) {
          onProgress(tested, total);
        }

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
          break;
        }
      }
    }

    var top = topBuffer.getSorted();
    return { top: top, totalTested: tested, totalCombinations: total };
  }

  global.optimizeParams = optimizeParams;
  global.countCombinations = countCombinations;
})(typeof self !== "undefined" ? self : globalThis);
