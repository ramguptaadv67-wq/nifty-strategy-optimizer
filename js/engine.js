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
      // For a long sell-stop: triggers when bar.low <= stop.
      //   If stop >= bar.open (bar opened below stop), fill at bar.open (gap).
      //   If bar.low <= stop < bar.open, fill at stop price.
      //   If stop < bar.low, no trigger (price never reached stop).
      if (position === 1 && !isNaN(pendingLongTsl)) {
        if (pendingLongTsl >= bar.low) {
          var longFill = Math.min(pendingLongTsl, bar.open);
          closeLong(longFill, bar.time, "TSL Exit", i);
          resetTsl(); pendingLongTsl = NaN;
        }
      }
      // For a short buy-stop: triggers when bar.high >= stop.
      //   If stop <= bar.open (bar opened above stop), fill at bar.open (gap).
      //   If bar.high >= stop > bar.open, fill at stop price.
      //   If stop > bar.high, no trigger.
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
          // Clamp: TSL must never be above current close (would be above market)
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
          // Clamp: TSL must never be below current close (would be below market)
          if (shortTsl < bar.close) shortTsl = bar.close;
        } else { shortTsl = NaN; }
      }
      if (!isShort) { shortLl = NaN; shortTsl = NaN; }

      // Set pending stops for the NEXT bar
      pendingLongTsl = (isLong && !isNaN(longTsl)) ? longTsl : NaN;
      pendingShortTsl = (isShort && !isNaN(shortTsl)) ? shortTsl : NaN;
    }

    // Close any remaining open trade at last close
    if (openTrade && position !== 0) {
      const last = candles[candles.length - 1];
      if (position === 1) closeLong(last.close, last.time, "End of Data", candles.length - 1);
      else closeShort(last.close, last.time, "End of Data", candles.length - 1);
    }

    // ---- Compute equity curve & metrics ----
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

    // Max drawdown from equity curve
    let peak = -Infinity, maxDd = 0;
    for (const pt of equity) {
      if (pt.equity > peak) peak = pt.equity;
      const dd = peak - pt.equity;
      if (dd > maxDd) maxDd = dd;
    }

    // Sharpe ratio (per-trade, annualized approx using sqrt of trades)
    const mean = avgTrade;
    const variance = profits.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance) || 1;
    const sharpe = (mean / std) * Math.sqrt(n);

    return { netProfit, totalTrades: n, winRate, profitFactor, maxDrawdown: maxDd, sharpe, avgTrade, maxWin, maxLoss };
  }

  global.runBacktest = runBacktest;
})(typeof self !== "undefined" ? self : globalThis);
