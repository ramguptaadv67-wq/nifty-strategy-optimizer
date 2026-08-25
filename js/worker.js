/**
 * worker.js — Web Worker for running the parameter optimization sweep.
 * Imports engine.js, optimizer.js, csv.js via importScripts.
 * Posts progress and final results back to the main thread.
 */
importScripts("engine.js", "optimizer.js", "csv.js");

self.onmessage = function (e) {
  const msg = e.data;

  if (msg.type === "optimize") {
    try {
      const { csvText, ranges, fixedParams, steps, sortMetric } = msg;
      const candles = self.parseCSV(csvText);

      if (candles.length < 3) {
        self.postMessage({ type: "error", message: "Not enough valid candles parsed from CSV. Need at least 3 rows." });
        return;
      }

      self.postMessage({ type: "parsed", candleCount: candles.length });

      const result = self.optimizeParams(candles, ranges, fixedParams, steps, (done, total) => {
        self.postMessage({ type: "progress", done, total });
      }, sortMetric);

      self.postMessage({ type: "done", result });
    } catch (err) {
      self.postMessage({ type: "error", message: err.message || String(err) });
    }
  } else if (msg.type === "single") {
    try {
      const { csvText, params } = msg;
      const candles = self.parseCSV(csvText);
      const result = self.runBacktest(candles, params);
      self.postMessage({ type: "singleDone", result, candleCount: candles.length });
    } catch (err) {
      self.postMessage({ type: "error", message: err.message || String(err) });
    }
  }
};
