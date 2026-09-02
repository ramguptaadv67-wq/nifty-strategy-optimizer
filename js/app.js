let csvText = null;
let worker = null;
let topResults = [];
let currentSort = "netProfit";
let sortDesc = true;

// ---- Yahoo Finance fetch ----
const yahooSymbol = document.getElementById("yahooSymbol");
const yahooInterval = document.getElementById("yahooInterval");
const yahooRange = document.getElementById("yahooRange");
const yahooBtn = document.getElementById("yahooBtn");
const yahooStatus = document.getElementById("yahooStatus");
const candleCount = document.getElementById("candleCount");
const runBtn = document.getElementById("runBtn");

// Populate dropdowns
if (typeof YahooFinance !== "undefined") {
  Object.entries(YahooFinance.SYMBOLS).forEach(([name, ticker]) => {
    const opt = document.createElement("option");
    opt.value = ticker; opt.textContent = name;
    yahooSymbol.appendChild(opt);
  });
  Object.entries(YahooFinance.INTERVALS).forEach(([name, val]) => {
    const opt = document.createElement("option");
    opt.value = val; opt.textContent = name;
    yahooInterval.appendChild(opt);
  });
  YahooFinance.RANGES.forEach(r => {
    const opt = document.createElement("option");
    opt.value = r;
    const label = r === "max" ? "Max (10+ years)" : r;
    opt.textContent = label;
    if (r === "1y") opt.selected = true;
    yahooRange.appendChild(opt);
  });
}

yahooBtn.addEventListener("click", async () => {
  const symbol = yahooSymbol.value;
  const interval = yahooInterval.value;
  const range = yahooRange.value;

  yahooBtn.disabled = true;
  yahooBtn.textContent = "Fetching...";
  yahooStatus.style.display = "block";
  yahooStatus.className = "yahoo-status loading";
  yahooStatus.textContent = "Connecting to Yahoo Finance...";

  try {
    const { candles, csvText: csv, meta } = await YahooFinance.fetchCandles(
      symbol, interval, range,
      (msg) => { yahooStatus.textContent = msg; }
    );

    csvText = csv;
    runBtn.disabled = false;
    yahooStatus.className = "yahoo-status success";
    yahooStatus.textContent = `✓ Fetched ${candles.length} candles from ${meta.exchangeName || symbol} (${new Date(candles[0].time).toLocaleDateString()} → ${new Date(candles[candles.length-1].time).toLocaleDateString()})`;
    candleCount.textContent = candles.length + " candles ready for optimization.";
  } catch (err) {
    yahooStatus.className = "yahoo-status error";
    yahooStatus.textContent = "✗ " + err.message;
  } finally {
    yahooBtn.disabled = false;
    yahooBtn.textContent = "Fetch from Yahoo";
  }
});

// ---- Collect ranges ----
function getRanges() {
  function rng(name) {
    return [parseInt(document.getElementById(name + "_min").value), parseInt(document.getElementById(name + "_max").value)];
  }
  function stp(name) {
    return parseInt(document.getElementById(name + "_step").value) || 1;
  }
  return {
    ranges: {
      engulf_min: rng("engulf_min"),
      doji_body_max: rng("doji_body_max"),
      activation_pts: rng("activation_pts"),
      lock_profit: rng("lock_profit"),
      profit_step: rng("profit_step"),
      trail_step: rng("trail_step"),
    },
    steps: {
      engulf_min: stp("engulf_min"),
      doji_body_max: stp("doji_body_max"),
      activation_pts: stp("activation_pts"),
      lock_profit: stp("lock_profit"),
      profit_step: stp("profit_step"),
      trail_step: stp("trail_step"),
    }
  };
}

function getFixedParams() {
  return {
    no_trade_monday: document.getElementById("no_trade_monday").checked,
    no_trade_monthly_exp: document.getElementById("no_trade_monthly_exp").checked,
    exit_on_monthly: document.getElementById("exit_on_monthly").checked,
    use_candle_exit: document.getElementById("use_candle_exit").checked,
    expiry_dow_str: document.getElementById("expiry_dow_str").value,
    max_candles: parseInt(document.getElementById("max_candles").value) || 300,
    monthly_exit_time: document.getElementById("monthly_exit_time").value,
  };
}

// ---- Combination counter ----
function getComboCount() {
  const { ranges, steps } = getRanges();
  const keys = Object.keys(ranges);
  let total = 1;
  for (const key of keys) {
    const [min, max] = ranges[key];
    const step = steps[key] || 1;
    const count = Math.floor((max - min) / step) + 1;
    total *= Math.max(0, count);
  }
  return total;
}

function updateComboCount() {
  const total = getComboCount();
  const comboEl = document.getElementById("comboCount");
  if (!comboEl) return;
  if (total > 2000000) {
    comboEl.style.color = "#e74c3c";
    comboEl.textContent = total.toLocaleString("en-IN") + " combinations — TOO MANY! Max 20 lakh. Increase step sizes.";
  } else if (total > 100000) {
    comboEl.style.color = "#f39c12";
    comboEl.textContent = total.toLocaleString("en-IN") + " combinations — may take a while.";
  } else {
    comboEl.style.color = "#27ae60";
    comboEl.textContent = total.toLocaleString("en-IN") + " combinations — ready to run.";
  }
}

["engulf_min", "doji_body_max", "activation_pts", "lock_profit", "profit_step", "trail_step"].forEach(function(name) {
  ["_min", "_max", "_step"].forEach(function(suffix) {
    var el = document.getElementById(name + suffix);
    if (el) el.addEventListener("input", updateComboCount);
  });
});
updateComboCount();

// ---- Run optimization ----
runBtn.addEventListener("click", () => {
  if (!csvText) return;

  // Pre-check combination count
  const comboCount = getComboCount();
  if (comboCount > 2000000) {
    document.getElementById("progressWrap").style.display = "block";
    document.getElementById("progressFill").style.width = "0%";
    document.getElementById("progressText").textContent = "Error: " + comboCount.toLocaleString("en-IN") + " combinations is too many. Max 20 lakh. Increase step sizes or narrow ranges.";
    return;
  }

  runBtn.disabled = true;
  document.getElementById("progressWrap").style.display = "block";
  document.getElementById("progressFill").style.width = "0%";
  document.getElementById("progressText").textContent = "Initializing...";

  const { ranges, steps } = getRanges();
  const fixedParams = getFixedParams();
  const sortMetric = document.getElementById("sortMetric").value;

  if (worker) worker.terminate();
  worker = new Worker("js/worker.js?v=" + Date.now());
  worker.onmessage = handleWorkerMessage;
  worker.onerror = function(e) {
    document.getElementById("progressText").textContent = "Worker Error: " + (e.message || e.filename + ":" + e.lineno);
    runBtn.disabled = false;
  };
  worker.postMessage({ type: "optimize", csvText, ranges, fixedParams, steps, sortMetric });
});

function handleWorkerMessage(e) {
  const msg = e.data;
  if (msg.type === "parsed") {
    document.getElementById("progressText").textContent = msg.candleCount + " candles parsed. Sweeping parameters...";
  } else if (msg.type === "progress") {
    const pct = (msg.done / msg.total) * 100;
    document.getElementById("progressFill").style.width = pct + "%";
    document.getElementById("progressText").textContent = msg.done + " / " + msg.total + " combinations (" + pct.toFixed(1) + "%)";
  } else if (msg.type === "done") {
    topResults = msg.result.top;
    document.getElementById("progressWrap").style.display = "none";
    runBtn.disabled = false;
    renderResults(msg.result);
  } else if (msg.type === "error") {
    document.getElementById("progressText").textContent = "Error: " + msg.message;
    runBtn.disabled = false;
  }
}

// ---- Render results ----
function fmt(n, dec = 2) {
  if (!isFinite(n)) return "∞";
  return Number(n).toLocaleString("en-IN", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function renderResults(result) {
  document.getElementById("emptyCard").style.display = "none";
  document.getElementById("resultsCard").style.display = "block";

  const best = result.top[0] || { metrics: {} };
  const statsGrid = document.getElementById("statsGrid");
  const stats = [
    { val: result.totalTested.toLocaleString("en-IN"), label: "Combos Tested" },
    { val: result.top.length, label: "Top Results" },
    { val: fmt(best.metrics.netProfit, 0), label: "Best Net Profit" },
    { val: fmt(best.metrics.winRate, 1) + "%", label: "Best Win Rate" },
    { val: fmt(best.metrics.sharpe, 2), label: "Best Sharpe" },
  ];
  statsGrid.innerHTML = stats.map(s => `<div class="stat-item"><div class="stat-val">${s.val}</div><div class="stat-label">${s.label}</div></div>`).join("");

  renderTable();
  renderChart(0);
}

function renderTable() {
  const tbody = document.getElementById("resultsBody");
  tbody.innerHTML = topResults.map((r, i) => {
    const m = r.metrics;
    const profitClass = m.netProfit >= 0 ? "pos" : "neg";
    const params = Object.entries(r.params)
      .filter(([k]) => ["engulf_min", "doji_body_max", "activation_pts", "lock_profit", "profit_step", "trail_step"].includes(k))
      .map(([k, v]) => `${k.split("_")[0]}=${v}`).join(", ");
    return `<tr data-idx="${i}">
      <td>${i + 1}</td>
      <td class="${profitClass}">${fmt(m.netProfit, 0)}</td>
      <td>${m.totalTrades}</td>
      <td>${fmt(m.winRate, 1)}%</td>
      <td>${fmt(m.profitFactor, 2)}</td>
      <td>${fmt(m.sharpe, 2)}</td>
      <td>${fmt(m.maxDrawdown, 0)}</td>
      <td>${fmt(m.avgTrade, 1)}</td>
      <td class="params-cell">${params}</td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll("tr").forEach(tr => {
    tr.addEventListener("click", () => {
      tbody.querySelectorAll("tr").forEach(r => r.classList.remove("active"));
      tr.classList.add("active");
      const idx = parseInt(tr.dataset.idx);
      renderChart(idx);
      document.querySelector('.tab[data-tab="chart"]').click();
    });
  });
}

// ---- Chart (equity curve) ----
function renderChart(resultIdx) {
  const r = topResults[resultIdx];
  if (!r) return;
  // Re-run backtest for this param set to get equity curve
  if (worker) {
    worker.postMessage({ type: "single", csvText, params: r.params });
  }
}

// Handle single backtest response for chart
const origHandler = handleWorkerMessage;
handleWorkerMessage = function(e) {
  const msg = e.data;
  if (msg.type === "singleDone") {
    drawChart(msg.result.equity, msg.candleCount);
  } else {
    origHandler(e);
  }
};

function drawChart(equity, candleCount) {
  const canvas = document.getElementById("equityCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width = canvas.offsetWidth;
  const H = canvas.height = canvas.offsetHeight;
  ctx.clearRect(0, 0, W, H);

  if (!equity || equity.length === 0) {
    ctx.fillStyle = "#999";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No trades for this parameter set", W / 2, H / 2);
    return;
  }

  const vals = equity.map(e => e.equity);
  const minV = Math.min(...vals, 0);
  const maxV = Math.max(...vals, 1);
  const range = maxV - minV || 1;
  const pad = 40;

  // Zero line
  const zeroY = H - pad - ((0 - minV) / range) * (H - 2 * pad);
  ctx.strokeStyle = "#666";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, zeroY);
  ctx.lineTo(W - pad, zeroY);
  ctx.stroke();

  // Equity line
  ctx.strokeStyle = "#4fc3f7";
  ctx.lineWidth = 2;
  ctx.beginPath();
  equity.forEach((pt, i) => {
    const x = pad + (i / Math.max(1, equity.length - 1)) * (W - 2 * pad);
    const y = H - pad - ((pt.equity - minV) / range) * (H - 2 * pad);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Fill below
  ctx.lineTo(pad + (W - 2 * pad), H - pad);
  ctx.lineTo(pad, H - pad);
  ctx.closePath();
  ctx.fillStyle = "rgba(79, 195, 247, 0.15)";
  ctx.fill();

  // Labels
  ctx.fillStyle = "#999";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("₹" + fmt(maxV, 0), pad, pad - 5);
  ctx.fillText("₹" + fmt(minV, 0), pad, H - pad + 15);
  ctx.textAlign = "right";
  ctx.fillText(equity.length + " trades", W - pad, H - pad + 15);
}

// ---- Tabs ----
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-table").style.display = tab.dataset.tab === "table" ? "block" : "none";
    document.getElementById("tab-chart").style.display = tab.dataset.tab === "chart" ? "block" : "none";
    if (tab.dataset.tab === "chart") {
      const activeRow = document.querySelector("#resultsBody tr.active") || document.querySelector("#resultsBody tr");
      if (activeRow) renderChart(parseInt(activeRow.dataset.idx));
    }
  });
});

// ---- Table sort ----
document.querySelectorAll("th[data-sort]").forEach(th => {
  th.addEventListener("click", () => {
    const metric = th.dataset.sort;
    if (currentSort === metric) sortDesc = !sortDesc;
    else { currentSort = metric; sortDesc = true; }
    topResults.sort((a, b) => {
      const av = a.metrics[metric], bv = b.metrics[metric];
      if (isFinite(av) && isFinite(bv)) return sortDesc ? bv - av : av - bv;
      return 0;
    });
    renderTable();
  });
});
