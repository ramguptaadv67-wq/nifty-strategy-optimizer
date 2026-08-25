/**
 * csv.js â€” CSV parser for OHLCV candle data
 * Supports both headered and headerless CSV files.
 * Columns detected in order: time, open, high, low, close, volume
 * Time can be a unix timestamp (seconds or ms) or an ISO date string.
 */
(function (global) {
  "use strict";

  function parseCSV(text) {
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.trim().length > 0);
    if (lines.length === 0) return [];

    // Detect delimiter
    const firstLine = lines[0];
    const delim = firstLine.includes("\t") ? "\t" : firstLine.includes(";") ? ";" : ",";

    // Detect header
    let startIdx = 0;
    const lower = firstLine.toLowerCase();
    const hasHeader = /open|high|low|close|date|time|volume/.test(lower);
    let colMap = null;

    if (hasHeader) {
      const headers = firstLine.split(delim).map(h => h.trim().toLowerCase());
      colMap = {};
      headers.forEach((h, i) => {
        if (h.includes("date") || h.includes("time") || h === "t") colMap.time = i;
        else if (h === "open" || h === "o") colMap.open = i;
        else if (h === "high" || h === "h") colMap.high = i;
        else if (h === "low" || h === "l") colMap.low = i;
        else if (h === "close" || h === "c") colMap.close = i;
        else if (h === "volume" || h === "v") colMap.volume = i;
      });
      startIdx = 1;
    }

    const candles = [];
    for (let i = startIdx; i < lines.length; i++) {
      const parts = lines[i].split(delim);
      if (parts.length < 5) continue;

      let time, open, high, low, close, volume;

      if (colMap) {
        time = parseTime(parts[colMap.time ?? 0]);
        open = parseFloat(parts[colMap.open ?? 1]);
        high = parseFloat(parts[colMap.high ?? 2]);
        low = parseFloat(parts[colMap.low ?? 3]);
        close = parseFloat(parts[colMap.close ?? 4]);
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
      candles.push({ time, open, high, low, close, volume });
    }
    return candles;
  }

  function parseTime(val) {
    if (!val) return Date.now();
    const trimmed = String(val).trim();
    // Try ISO date
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      const t = new Date(trimmed).getTime();
      return isNaN(t) ? Date.now() : t;
    }
    // Numeric timestamp
    const num = Number(trimmed);
    if (!isNaN(num)) {
      // If seconds (10 digits), convert to ms
      return num < 1e12 ? num * 1000 : num;
    }
    // Try DD/MM/YYYY or MM/DD/YYYY
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? Date.now() : d.getTime();
  }

  global.parseCSV = parseCSÂŸJJ\[ÙˆÙ[ˆOOH[™Yš[™YˆÈÙ[ˆˆÛØ˜[\ÊNÂ