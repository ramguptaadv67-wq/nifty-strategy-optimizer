(function() {
  "use strict";

  var csvText = null;
  var worker = null;
  var topResults = [];
  var currentSort = "netProfit";
  var sortDesc = true;

  function $(id) {
    return document.getElementById(id);
  }

  // ---- Yahoo Finance fetch ----
  var yahooSymbol = $("yahooSymbol");
  var yahooInterval = $("yahooInterval");
  var yahooRange = $("yahooRange");
  var yahooBtn = $("yahooBtn");
  var yahooStatus = $("yahooStatus");
  var candleCount = $("candleCount");
  var runBtn = $("runBtn");

  // Populate dropdowns
  if (typeof YahooFinance !== "undefined" && yahooSymbol && yahooInterval && yahooRange) {
    Object.entries(YahooFinance.SYMBOLS).forEach(function(entry) {
      var opt = document.createElement("option");
      opt.value = entry[1];
      opt.textContent = entry[0];
      yahooSymbol.appendChild(opt);
    });
    Object.entries(YahooFinance.INTERVALS).forEach(function(entry) {
      var opt = document.createElement("option");
      opt.value = entry[1];
      opt.textContent = entry[0];
      yahooInterval.appendChild(opt);
    });
    YahooFinance.RANGES.forEach(function(r) {
      var opt = document.createElement("option");
      opt.value = r;
      opt.textContent = r === "max" ? "Max (10+ years)" : r;
      if (r === "1y") opt.selected = true;
      yahooRange.appendChild(opt);
    });
  }

  if (yahooBtn) {
    yahooBtn.addEventListener("click", async function() {
      var symbol = yahooSymbol ? yahooSymbol.value : "^NSEI";
      var interval = yahooInterval ? yahooInterval.value : "1d";
      var range = yahooRange ? yahooRange.value : "1y";

      yahooBtn.disabled = true;
      yahooBtn.textContent = "Fetching...";
      if (yahooStatus) {
        yahooStatus.style.display = "block";
        yahooStatus.className = "yahoo-status loading";
        yahooStatus.textContent = "Connecting to Yahoo Finance...";
      }

      try {
        var result = await YahooFinance.fetchCandles(symbol, interval, range, function(msg) {
          if (yahooStatus) yahooStatus.textContent = msg;
        });

        csvText = result.csvText;
        if (runBtn) runBtn.disabled = false;
        if (yahooStatus) {
          yahooStatus.className = "yahoo-status success";
          yahooStatus.textContent = "\u2713 Fetched " + result.candles.length + " candles from " + (result.meta.exchangeName || symbol) + " (" + new Date(result.candles[0].time).toLocaleDateString() + " \u2192 " + new Date(result.candles[result.candles.length - 1].time).toLocaleDateString() + ")";
        }
        if (candleCount) candleCount.textContent = result.candles.length + " candles ready for optimization.";
      } catch (err) {
        if (yahooStatus) {
          yahooStatus.className = "yahoo-status error";
          yahooStatus.textContent = "\u2717 " + err.message;
        }
      } finally {
        yahooBtn.disabled = false;
        yahooBtn.textContent = "Fetch from Yahoo";
      }
    });
  }

  // ---- Collect ranges ----
  function getRanges() {
    function rng(name) {
      var minEl = $(name + "_min");
      var maxEl = $(name + "_max");
      return [parseInt(minEl ? minEl.value : "0"), parseInt(maxEl ? maxEl.value : "99")];
    }
    function stp(name) {
      var el = $(name + "_step");
      return parseInt(el ? el.value : "1") || 1;
    }
    return {
      ranges: {
        engulf_min: rng("engulf_min"),
        doji_body_max: rng("doji_body_max"),
        activation_pts: rng("activation_pts"),
        lock_profit: rng("lock_profit"),
        profit_step: rng("profit_step"),
        trail_step: rng("trail_step")
      },
      steps: {
        engulf_min: stp("engulf_min"),
        doji_body_max: stp("doji_body_max"),
        activation_pts: stp("activation_pts"),
        lock_profit: stp("lock_profit"),
        profit_step: stp("profit_step"),
        trail_step: stp("trail_step")
      }
    };
  }

  function getFixedParams() {
    return {
      no_trade_monday: $("no_trade_monday") ? $("no_trade_monday").checked : true,
      no_trade_monthly_exp: $("no_trade_monthly_exp") ? $("no_trade_monthly_exp").checked : false,
      exit_on_monthly: $("exit_on_monthly") ? $("exit_on_monthly").checked : true,
      use_candle_exit: $("use_candle_exit") ? $("use_candle_exit").checked : true,
      expiry_dow_str: $("expiry_dow_str") ? $("expiry_dow_str").value : "Tuesday",
      max_candles: parseInt($("max_candles") ? $("max_candles").value : "300") || 300,
      monthly_exit_time: $("monthly_exit_time") ? $("monthly_exit_time").value : "1510-1520"
    };
  }

  // ---- Combination counter ----
  function getComboCount() {
    var r = getRanges();
    var keys = Object.keys(r.ranges);
    var total = 1;
    for (var i = 0; i < keys.length; i++) {
      var min = r.ranges[keys[i]][0];
      var max = r.ranges[keys[i]][1];
      var step = r.steps[keys[i]] || 1;
      var count = Math.floor((max - min) / step) + 1;
      total *= Math.max(0, count);
    }
    return total;
  }

  function updateComboCount() {
    var total = getComboCount();
    var comboEl = $("comboCount");
    if (!comboEl) return;
    if (total > 5000000) {
      comboEl.style.color = "#e74c3c";
      comboEl.textContent = total.toLocaleString("en-IN") + " combinations \u2014 TOO MANY! Max 50 lakh. Increase step sizes.";
    } else if (total > 100000) {
      comboEl.style.color = "#f39c12";
      comboEl.textContent = total.toLocaleString("en-IN") + " combinations \u2014 may take a while.";
    } else {
      comboEl.style.color = "#27ae60";
      comboEl.textContent = total.toLocaleString("en-IN") + " combinations \u2014 ready to run.";
    }
  }

  // Attach listeners safely
  ["engulf_min", "doji_body_max", "activation_pts", "lock_profit", "profit_step", "trail_step"].forEach(function(name) {
    ["_min", "_max", "_step"].forEach(function(suffix) {
      var el = $(name + suffix);
      if (el) el.addEventListener("input", updateComboCount);
    });
  });
  updateComboCount();

  // ---- Run optimization ----
  if (runBtn) {
    runBtn.addEventListener("click", function() {
      if (!csvText) return;

      var comboCount = getComboCount();
      if (comboCount > 5000000) {
        var pw = $("progressWrap");
        if (pw) pw.style.display = "block";
        var pf = $("progressFill");
        if (pf) pf.style.width = "0%";
        var pt = $("progressText");
        if (pt) pt.textContent = "Error: " + comboCount.toLocaleString("en-IN") + " combinations is too many. Max 50 lakh. Increase step sizes or narrow ranges.";
        return;
      }

      runBtn.disabled = true;
      var pw = $("progressWrap");
      if (pw) pw.style.display = "block";
      var pf = $("progressFill");
      if (pf) pf.style.width = "0%";
      var pt = $("progressText");
      if (pt) pt.textContent = "Initializing...";

      var r = getRanges();
      var fixedParams = getFixedParams();
      var sortMetric = $("sortMetric") ? $("sortMetric").value : "netProfit";

      if (worker) worker.terminate();
      worker = new Worker("js/worker.js?v=" + Date.now());
      worker.onmessage = handleWorkerMessage;
      worker.onerror = function(e) {
        if (pt) pt.textContent = "Worker Error: " + (e.message || e.filename + ":" + e.lineno);
        runBtn.disabled = false;
      };
      worker.postMessage({ type: "optimize", csvText: csvText, ranges: r.ranges, fixedParams: fixedParams, steps: r.steps, sortMetric: sortMetric });
    });
  }

  function handleWorkerMessage(e) {
    var msg = e.data;
    var pt = $("progressText");
    var pf = $("progressFill");
    var pw = $("progressWrap");

    if (msg.type === "parsed") {
      if (pt) pt.textContent = msg.candleCount + " candles parsed. Sweeping parameters...";
    } else if (msg.type === "progress") {
      var pct = (msg.done / msg.total) * 100;
      if (pf) pf.style.width = pct + "%";
      if (pt) pt.textContent = msg.done + " / " + msg.total + " combinations (" + pct.toFixed(1) + "%)";
    } else if (msg.type === "done") {
      topResults = msg.result.top;
      if (pw) pw.style.display = "none";
      if (runBtn) runBtn.disabled = false;
      renderResults(msg.result);
    } else if (msg.type === "error") {
      if (pt) pt.textContent = "Error: " + msg.message;
      if (runBtn) runBtn.disabled = false;
    } else if (msg.type === "singleDone") {
      drawChart(msg.result.equity, msg.candleCount);
    }
  }

  // ---- Render results ----
  function fmt(n, dec) {
    dec = dec || 2;
    if (!isFinite(n)) return "\u221e";
    return Number(n).toLocaleString("en-IN", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  function renderResults(result) {
    var emptyCard = $("emptyCard");
    var resultsCard = $("resultsCard");
    if (emptyCard) emptyCard.style.display = "none";
    if (resultsCard) resultsCard.style.display = "block";

    var best = result.top[0] || { metrics: {} };
    var statsGrid = $("statsGrid");
    if (statsGrid) {
      var stats = [
        { val: result.totalTested.toLocaleString("en-IN"), label: "Combos Tested" },
        { val: result.top.length, label: "Top Results" },
        { val: fmt(best.metrics.netProfit, 0), label: "Best Net Profit" },
        { val: fmt(best.metrics.winRate, 1) + "%", label: "Best Win Rate" },
        { val: fmt(best.metrics.sharpe, 2), label: "Best Sharpe" }
      ];
      statsGrid.innerHTML = stats.map(function(s) {
        return '<div class="stat-item"><div class="stat-val">' + s.val + '</div><div class="stat-label">' + s.label + '</div></div>';
      }).join("");
    }

    renderTable();
    renderChart(0);
  }

  function renderTable() {
    var tbody = $("resultsBody");
    if (!tbody) return;

    tbody.innerHTML = topResults.map(function(r, i) {
      var m = r.metrics;
      var profitClass = m.netProfit >= 0 ? "pos" : "neg";
      var params = Object.entries(r.params)
        .filter(function(k) { return ["engulf_min", "doji_body_max", "activation_pts", "lock_profit", "profit_step", "trail_step"].indexOf(k[0]) >= 0; })
        .map(function(k) { return k[0].split("_")[0] + "=" + k[1]; })
        .join(", ");
      return '<tr data-idx="' + i + '">' +
        '<td>' + (i + 1) + '</td>' +
        '<td class="' + profitClass + '">' + fmt(m.netProfit, 0) + '</td>' +
        '<td>' + m.totalTrades + '</td>' +
        '<td>' + fmt(m.winRate, 1) + '%</td>' +
        '<td>' + fmt(m.profitFactor, 2) + '</td>' +
        '<td>' + fmt(m.sharpe, 2) + '</td>' +
        '<td>' + fmt(m.maxDrawdown, 0) + '</td>' +
        '<td>' + fmt(m.avgTrade, 1) + '</td>' +
        '<td class="params-cell">' + params + '</td>' +
        '</tr>';
    }).join("");

    var rows = tbody.querySelectorAll("tr");
    for (var i = 0; i < rows.length; i++) {
      (function(tr) {
        tr.addEventListener("click", function() {
          tbody.querySelectorAll("tr").forEach(function(r) { r.classList.remove("active"); });
          tr.classList.add("active");
          var idx = parseInt(tr.dataset.idx);
          renderChart(idx);
          var chartTab = document.querySelector('.tab[data-tab="chart"]');
          if (chartTab) chartTab.click();
        });
      })(rows[i]);
    }
  }

  // ---- Chart ----
  function renderChart(resultIdx) {
    var r = topResults[resultIdx];
    if (!r) return;
    if (worker) {
      worker.postMessage({ type: "single", csvText: csvText, params: r.params });
    }
  }

  function drawChart(equity, candleCount) {
    var canvas = $("equityCanvas");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var W = canvas.width = canvas.offsetWidth;
    var H = canvas.height = canvas.offsetHeight;
    ctx.clearRect(0, 0, W, H);

    if (!equity || equity.length === 0) {
      ctx.fillStyle = "#999";
      ctx.font = "14px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No trades for this parameter set", W / 2, H / 2);
      return;
    }

    var vals = equity.map(function(e) { return e.equity; });
    var minV = Math.min.apply(null, vals.concat([0]));
    var maxV = Math.max.apply(null, vals.concat([1]));
    var range = maxV - minV || 1;
    var pad = 40;

    var zeroY = H - pad - ((0 - minV) / range) * (H - 2 * pad);
    ctx.strokeStyle = "#666";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, zeroY);
    ctx.lineTo(W - pad, zeroY);
    ctx.stroke();

    ctx.strokeStyle = "#4fc3f7";
    ctx.lineWidth = 2;
    ctx.beginPath();
    equity.forEach(function(pt, i) {
      var x = pad + (i / Math.max(1, equity.length - 1)) * (W - 2 * pad);
      var y = H - pad - ((pt.equity - minV) / range) * (H - 2 * pad);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.lineTo(pad + (W - 2 * pad), H - pad);
    ctx.lineTo(pad, H - pad);
    ctx.closePath();
    ctx.fillStyle = "rgba(79, 195, 247, 0.15)";
    ctx.fill();

    ctx.fillStyle = "#999";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("\u20b9" + fmt(maxV, 0), pad, pad - 5);
    ctx.fillText("\u20b9" + fmt(minV, 0), pad, H - pad + 15);
    ctx.textAlign = "right";
    ctx.fillText(equity.length + " trades", W - pad, H - pad + 15);
  }

  // ---- Tabs ----
  document.querySelectorAll(".tab").forEach(function(tab) {
    tab.addEventListener("click", function() {
      document.querySelectorAll(".tab").forEach(function(t) { t.classList.remove("active"); });
      tab.classList.add("active");
      var tabTable = $("tab-table");
      var tabChart = $("tab-chart");
      if (tabTable) tabTable.style.display = tab.dataset.tab === "table" ? "block" : "none";
      if (tabChart) tabChart.style.display = tab.dataset.tab === "chart" ? "block" : "none";
      if (tab.dataset.tab === "chart") {
        var activeRow = document.querySelector("#resultsBody tr.active") || document.querySelector("#resultsBody tr");
        if (activeRow) renderChart(parseInt(activeRow.dataset.idx));
      }
    });
  });

  // ---- Table sort ----
  document.querySelectorAll("th[data-sort]").forEach(function(th) {
    th.addEventListener("click", function() {
      var metric = th.dataset.sort;
      if (currentSort === metric) sortDesc = !sortDesc;
      else { currentSort = metric; sortDesc = true; }
      topResults.sort(function(a, b) {
        var av = a.metrics[metric], bv = b.metrics[metric];
        if (isFinite(av) && isFinite(bv)) return sortDesc ? bv - av : av - bv;
        return 0;
      });
      renderTable();
    });
  });
})();
