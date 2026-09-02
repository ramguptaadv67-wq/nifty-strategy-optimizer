/**
 * worker.js — Web Worker for running the parameter optimization sweep.
 * Imports engine.js and optimizer.js via importScripts.
 * CSV parser is inlined to avoid file loading issues.
 * Posts progress and final results back to the main thread.
 */
const v = "?v=" + Date.now();
importScripts("engine.js" + v, "optimizer.js" + v);

// === INLINED CSV PARSER (was csv.js) ===
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
// === END INLINED CSV PARSER ===

self.onmessage = function (e) {
  var msg = e.data;

  if (msg.type === "optimize") {
    try {
      var csvText = msg.csvText;
      var ranges = msg.ranges;
      var fixedParams = msg.fixedParams;
      var steps = msg.steps;
      var sortMetric = msg.sortMetric;

      var candles = self.parseCSV(csvText);

      if (candles.length < 3) {
        self.postMessage({ type: "error", message: "Not enough valid candles. Need at least 3 rows. Got: " + candles.length });
        return;
      }

      self.postMessage({ type: "parsed", candleCount: candles.length });

      var lastProgressTime = 0;
      var result = self.optimizeParams(candles, ranges, fixedParams, steps, function(done, total) {
        var now = Date.now();
        if (now - lastProgressTime > 500 || done === total) {
          lastProgressTime = now;
          self.postMessage({ type: "progress", done: done, total: total });
        }
      }, sortMetric);

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
