/**
 * worker.js - Web Worker for parameter optimization (ALL INLINED)
 * Everything inlined to avoid importScripts file-loading issues on Cloudflare.
 * Contains: backtesting engine, optimizer, CSV parser, and message handler.
 */
"use strict";

// ===== INLINED ENGINE (engine.js) =====
/**
 * engine.js - Backtesting engine
 * Faithful translation of the NIFTY "webhook()" Pine Script v5 strategy.
 *
 * Exposes a single function `runBacktest(candles, params)` on `globalThis`.
 *
 * candles: [{ time(ms), open, high, low, close, volume }, ...]
 * params:  { engulf_min, doji_body_max, activation_pts, lock_profit,
 *            profit_step, trail_step, max_candles, no_trade_monday,
 *            no_trade_monthly_exp, expiry_dow_str, exit_on_monthly,
 *            monthly_exit_time, use_candle_exit }
 *
 * Returns: { trades, equity, stats, metrics }
 */
(function (global) {
  "use strict";

  // JS getDay(): 0=Sun,1=Mon,...,6=Sat  (Pine: monday=2.. friday=6)
  const DOW_MAP = {
    Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
    Thursday: 4, Friday: 5, Saturday: 6,
  };

  /** Parse a TradingView session string "HHMM-HHMM" -> [startMin, endMin] */
  function parseSession(s) {
    const m = String(s).match(/(\d{3,4})\s*-\s*(\d{3,4})/);
    if (!m) return [15 * 60 + 10, 15 * 60 + 20];
    const toMin = (t) => {
      const n = parseInt(t, 10);
      return Math.floor(n / 100) * 60 + (n % 100);
    };
    return [toMin(m[1]), toMin(m[2])];
  }

  function body(c, o) { return Math.abs(c - o); }
  function isBull(c, o) { return c > o; }
  function isBear(c, o) { return c < o; }

  function runBacktest(candles, p) {
    if (!candles || candles.length < 3) {
      return { trades: [], equity: [], stats: { netProfit: 0 }, metrics: emptyMetrics() };
    }

    const expiryDowCode = DOW_MAP[p.expiry_dow_str] ?? DOW_MAP.Tuesday;
    const [wStart, wEnd] = parseSession(p.monthly_exit_time);

    // ---- State ----
    let position = 0;          // 0 flat, 1 long, -1 short
    let entryPrice = 0;
    let entryBarIndex = -1;
    let entryTime = 0;

    let setupLine = NaN;
    let setupType = null;
    let engulfBar = -1;

    let longHh = NaN, shortLl = NaN;
    let longTsl = NaN, shortTsl = NaN;
    let pendingLongTsl = NaN;   // TSL computed at prev bar close, checked this bar
    let pendingShortTsl = NaN;

    const trades = [];
    let openTrade = null;

    // ---- Helpers to close trades ----
    function closeLong(price, time, reason, barIdx) {
      if (!openTrade || openTrade.type !== "long") return;
      const profit = price - openTrade.entryPrice;
      trades.push({
        type: "long", entryPrice: openTrade.entryPrice, exitPrice: price,
        entryTime: openTrade.entryTime, exitTime: time, entryBar: openTrade.entryBar,
        exitBar: barIdx, profit, reason,
      });
      position = 0; openTrade = null; entryBarIndex = -1;
    }
    function closeShort(price, time, reason, barIdx) {
      if (!openTrade || openTrade.type !== "short") return;
      const profit = openTrade.entryPrice - price;
      trades.push({
        type: "short", entryPrice: openTrade.entryPrice, exitPrice: price,
        entryTime: openTrade.entryTime, exitTime: time, entryBar: openTrade.entryBar,
        exitBar: barIdx, profit, reason,
      });
      position = 0; openTrade = null; entryBarIndex = -1;
    }
    function resetTsl() {
      longHh = NaN; shortLl = NaN; longTsl = NaN; shortTsl = NaN;
    }

    // ---- Main loop ----
    for (let i = 1; i < candles.length; i++) {
      const bar = candles[i];
      const prev = candles[i - 1];
      const posAtStart = position;

      const dt = new Date(bar.time);
      const dow = dt.getDay();
      const month = dt.getMonth();
      const hhmm = dt.getHours() * 60 + dt.getMinutes();

      const nextWeek = new Date(bar.time + 7 * 86400000);
      const isLastDowMonth = dow === expiryDowCode && nextWeek.getMonth() !== month;

      const blockMonday = p.no_trade_monday && dow === 1;
      const blockMonthlyExp = p.no_trade_monthly_exp && isLastDowMonth;
      const canEnter = !blockMonday && !blockMonthlyExp;

      const inMonthlyWindow = hhmm >= wStart && hhmm <= wEnd;
      const monthlyCloseNow = p.exit_on_monthly && isLastDowMonth && inMonthlyWindow;

      // === 1. Check pending TSL exits (from previous bar close) ===
      if (position === 1 && !isNaN(pendingLongTsl)) {
        if (pendingLongTsl >= bar.low) {
          var longFill = Math.min(pendingLongTsl, bar.open);
          closeLong(longFill, bar.time, "TSL Exit", i);
          resetTsl(); pendingLongTsl = NaN;
        }
      }
      if (position === -1 && !isNaN(pendingShortTsl)) {
        if (pendingShortTsl <= bar.high) {
          var shortFill = Math.max(pendingShortTsl, bar.open);
          closeShort(shortFill, bar.time, "TSL Exit", i);
          resetTsl(); pendingShortTsl = NaN;
        }
      }

      // === 2. Engulfing detection (bar close) ===
      const bullEngulf = isBull(bar.close, bar.open) && isBear(prev.close, prev.open)
        && bar.close > prev.open && bar.open < prev.close
        && body(bar.close, bar.open) >= p.engulf_min;
      const bearEngulf = isBear(bar.close, bar.open) && isBull(prev.close, prev.open)
        && bar.close < prev.open && bar.open > prev.close
        && body(bar.close, bar.open) >= p.engulf_min;

      if (bullEngulf) { setupLine = (bar.open + bar.close) / 2; setupType = "bull"; engulfBar = i; }
      if (bearEngulf) { setupLine = (bar.open + bar.close) / 2; setupType = "bear"; engulfBar = i; }

      const valid = !isNaN(setupLine);
      const isDoji = body(bar.close, bar.open) <= p.doji_body_max && (bar.high - bar.low) >= body(bar.close, bar.open) * 2;
      const touchesLine = valid && bar.high >= setupLine && bar.low <= setupLine;
      const greenDoji = isDoji && bar.close > bar.open;
      const redDoji = isDoji && bar.close < bar.open;
      const ceSignal = touchesLine && greenDoji;
      const peSignal = touchesLine && redDoji;

      // === 3. Monthly expiry & candle time exits (bar close) ===
      const barsInTrade = entryBarIndex >= 0 ? i - entryBarIndex : 0;
      const candleExitNow = p.use_candle_exit && barsInTrade >= p.max_candles && position !== 0;

      if (monthlyCloseNow && position !== 0) {
        if (position === 1) closeLong(bar.close, bar.time, "Monthly Expiry Exit", i);
        else closeShort(bar.close, bar.time, "Monthly Expiry Exit", i);
        resetTsl(); pendingLongTsl = NaN; pendingShortTsl = NaN;
      } else if (candleExitNow) {
        if (position === 1) closeLong(bar.close, bar.time, "Candle Limit Exit", i);
        else closeShort(bar.close, bar.time, "Candle Limit Exit", i);
        resetTsl(); pendingLongTsl = NaN; pendingShortTsl = NaN;
      }

      const flatNow = position === 0;

      // === 4. Entries ===
      if (ceSignal && flatNow && canEnter) {
        position = 1;
        entryPrice = bar.close;
        entryBarIndex = i;
        entryTime = bar.time;
        openTrade = { type: "long", entryPrice, entryTime, entryBar: i };
        longHh = bar.high; longTsl = NaN;
      } else if (peSignal && flatNow && canEnter) {
        position = -1;
        entryPrice = bar.close;
        entryBarIndex = i;
        entryTime = bar.time;
        openTrade = { type: "short", entryPrice, entryTime, entryBar: i };
        shortLl = bar.low; shortTsl = NaN;
      }

      // === 5. TSL update (at bar close) ===
      const isLong = position === 1;
      const isShort = position === -1;
      const newLong = isLong && posAtStart <= 0;
      const newShort = isShort && posAtStart >= 0;
      const ep = entryPrice;

      if (newLong) { longHh = bar.high; longTsl = NaN; }
      if (isLong && !newLong) {
        if (bar.high - ep >= p.activation_pts) {
          longHh = isNaN(longHh) ? bar.high : Math.max(longHh, bar.high);
          const extraProfit = Math.max(0.0, longHh - ep - p.activation_pts);
          const tslMove = Math.floor(extraProfit / p.profit_step) * p.trail_step;
          longTsl = ep + p.lock_profit + tslMove;
          if (longTsl > bar.close) longTsl = bar.close;
        } else { longTsl = NaN; }
      }
      if (!isLong) { longHh = NaN; longTsl = NaN; }

      if (newShort) { shortLl = bar.low; shortTsl = NaN; }
      if (isShort && !newShort) {
        if (ep - bar.low >= p.activation_pts) {
          shortLl = isNaN(shortLl) ? bar.low : Math.min(shortLl, bar.low);
          const extraProfit = Math.max(0.0, ep - shortLl - p.activation_pts);
          const tslMove = Math.floor(extraProfit / p.profit_step) * p.trail_step;
          shortTsl = ep - p.lock_profit - tslMove;
          if (shortTsl < bar.close) shortTsl = bar.close;
        } else { shortTsl = NaN; }
      }
      if (!isShort) { shortLl = NaN; shortTsl = NaN; }

      pendingLongTsl = (isLong && !isNaN(longTsl)) ? longTsl : NaN;
      pendingShortTsl = (isShort && !isNaN(shortTsl)) ? shortTsl : NaN;
    }

    if (openTrade && position !== 0) {
      const last = candles[candles.length - 1];
      if (position === 1) closeLong(last.close, last.time, "End of Data", candles.length - 1);
      else closeShort(last.close, last.time, "End of Data", candles.length - 1);
    }

    let cum = 0;
    const equity = trades.map((t, idx) => { cum += t.profit; return { idx, time: t.exitTime, equity: cum }; });

    return { trades, equity, metrics: computeMetrics(trades, equity) };
  }

  function emptyMetrics() {
    return { netProfit: 0, totalTrades: 0, winRate: 0, profitFactor: 0, maxDrawdown: 0, sharpe: 0, avgTrade: 0, maxWin: 0, maxLoss: 0 };
  }

  function computeMetrics(trades, equity) {
    const n = trades.length;
    if (n === 0) return emptyMetrics();
    const profits = trades.map(t => t.profit);
    const netProfit = profits.reduce((a, b) => a + b, 0);
    const wins = profits.filter(x => x > 0);
    const losses = profits.filter(x => x < 0);
    const grossWin = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    const winRate = (wins.length / n) * 100;
    const profitFactor = grossLoss === 0 ? (grossWin > 0 ? Infinity : 0) : grossWin / grossLoss;
    const avgTrade = netProfit / n;
    const maxWin = Math.max(...profits);
    const maxLoss = Math.min(...profits);

    let peak = -Infinity, maxDd = 0;
    for (const pt of equity) {
      if (pt.equity > peak) peak = pt.equity;
      const dd = peak - pt.equity;
      if (dd > maxDd) maxDd = dd;
    }

    const mean = avgTrade;
    const variance = profits.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance) || 1;
    const sharpe = (mean / std) * Math.sqrt(n);

    return { netProfit, totalTrades: n, winRate, profitFactor, maxDrawdown: maxDd, sharpe, avgTrade, maxWin, maxLoss };
  }

  global.runBacktest = runBacktest;
})(typeof self !== "undefined" ? self : globalThis);

// ===== END ENGINE =====

// ===== INLINED OPTIMIZER (optimizer.js) =====
/**
 * optimizer.js - Parameter sweep optimizer with random sampling
 *
 * When total combinations exceed SAMPLE_LIMIT (100,000), picks random
 * combinations to test instead of iterating through all of them.
 * Uses seeded PRNG (mulberry32, seed=42) so results are reproducible.
 */
(function (global) {
  "use strict";

  var TOP_N = 20;
  var SAMPLE_LIMIT = 100000;

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

// ===== END OPTIMIZER =====

// ===== INLINED CSV PARSER =====
self.parseCSV = function (text) {
  var lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(function(l) { return l.trim().length > 0; });
  if (lines.length === 0) return [];

  var firstLine = lines[0];
  var delim = firstLine.includes("\t") ? "\t" : firstLine.includes(";") ? ";" : ",";

  var startIdx = 0;
  var lower = firstLine.toLowerCase();
  var hasHeader = /open|high|low|close|date|time|volume/.test(lower);
  var colMap = null;

  if (hasHeader) {
    var headers = firstLine.split(delim).map(function(h) { return h.trim().toLowerCase(); });
    colMap = {};
    headers.forEach(function(h, i) {
      if (h.includes("date") || h.includes("time") || h === "t") colMap.time = i;
      else if (h === "open" || h === "o") colMap.open = i;
      else if (h === "high" || h === "h") colMap.high = i;
      else if (h === "low" || h === "l") colMap.low = i;
      else if (h === "close" || h === "c") colMap.close = i;
      else if (h === "volume" || h === "v") colMap.volume = i;
    });
    startIdx = 1;
  }

  function parseTime(val) {
    if (!val) return Date.now();
    var trimmed = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      var t = new Date(trimmed).getTime();
      return isNaN(t) ? Date.now() : t;
    }
    var num = Number(trimmed);
    if (!isNaN(num)) {
      return num < 1e12 ? num * 1000 : num;
    }
    var d = new Date(trimmed);
    return isNaN(d.getTime()) ? Date.now() : d.getTime();
  }

  var candles = [];
  for (var i = startIdx; i < lines.length; i++) {
    var parts = lines[i].split(delim);
    if (parts.length < 5) continue;

    var time, open, high, low, close, volume;
    if (colMap) {
      time = parseTime(parts[colMap.time || 0]);
      open = parseFloat(parts[colMap.open || 1]);
      high = parseFloat(parts[colMap.high || 2]);
      low = parseFloat(parts[colMap.low || 3]);
      close = parseFloat(parts[colMap.close || 4]);
      volume = colMap.volume !== undefined ? parseFloat(parts[colMap.volume]) || 0 : 0;
    } else {
      time = parseTime(parts[0]);
      open = parseFloat(parts[1]);
      high = parseFloat(parts[2]);
      low = parseFloat(parts[3]);
      close = parseFloat(parts[4]);
      volume = parts[5] !== undefined ? parseFloat(parts[5]) || 0 : 0;
    }

    if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) continue;
    candles.push({ time: time, open: open, high: high, low: low, close: close, volume: volume });
  }
  return candles;
};
// ===== END CSV PARSER =====

self.onmessage = function (e) {
  var msg = e.data;

  if (msg.type === "optimize") {
    try {
      var candles = self.parseCSV(msg.csvText);

      if (candles.length < 3) {
        self.postMessage({ type: "error", message: "Not enough valid candles. Need at least 3 rows. Got: " + candles.length });
        return;
      }

      self.postMessage({ type: "parsed", candleCount: candles.length });

      var lastProgressTime = 0;
      var result = self.optimizeParams(candles, msg.ranges, msg.fixedParams, msg.steps, function(done, total) {
        var now = Date.now();
        if (now - lastProgressTime > 500 || done === total) {
          lastProgressTime = now;
          self.postMessage({ type: "progress", done: done, total: total });
        }
      }, msg.sortMetric);

      self.postMessage({ type: "done", result: result });
    } catch (err) {
      self.postMessage({ type: "error", message: err.message || String(err) });
    }
  } else if (msg.type === "single") {
    try {
      var candles = self.parseCSV(msg.csvText);
      var result = self.runBacktest(candles, msg.params);
      self.postMessage({ type: "singleDone", result: result, candleCount: candles.length });
    } catch (err) {
      self.postMessage({ type: "error", message: err.message || String(err) });
    }
  }
};
