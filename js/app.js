let csvText = null;
    let worker = null;
    let topResults = [];
    let currentSort = "netProfit";
    let sortDesc = true;

    // ---- File upload ----
    const dropzone = document.getElementById("dropzone");
    const fileInput = document.getElementById("fileInput");
    const fileInfo = document.getElementById("fileInfo");
    const candleCount = document.getElementById("candleCount");
    const runBtn = document.getElementById("runBtn");

    // ---- Yahoo Finance fetch ----
    const yahooSymbol = document.getElementById("yahooSymbol");
    const yahooInterval = document.getElementById("yahooInterval");
    const yahooRange = document.getElementById("yahooRange");
    const yahooBtn = document.getElementById("yahooBtn");
    const yahooStatus = document.getElementById("yahooStatus");

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
        fileInfo.style.display = "block";
        const symbolName = Object.entries(YahooFinance.SYMBOLS).find(([k,v]) => v === symbol)?.[0] || symbol;
        const intervalName = Object.entries(YahooFinance.INTERVALS).find(([k,v]) => v === interval)?.[0] || interval;
        fileInfo.textContent = `✓ Yahoo Finance: ${symbolName} · ${intervalName} · ${range} (${candles.length} candles)`;
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

    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("dragover", e => { e.preventDefault(); dropzone.classList.add("dragover"); });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
    dropzone.addEventListener("drop", e => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener("change", e => { if (e.target.files[0]) handleFile(e.target.files[0]); });

    function handleFile(file) {
      const reader = new FileReader();
      reader.onload = e => {
        csvText = e.target.result;
        fileInfo.style.display = "block";
        fileInfo.textContent = "✓ " + file.name + " (" + (file.size / 1024).toFixed(1) + " KB)";
        runBtn.disabled = false;
        candleCount.textContent = "Click 'Run Optimization' to parse and begin.";

        // Quick parse to count candles
        try {
          const lines = csvText.replace(/\r\n/g, "\n").split("\n").filter(l => l.trim().length > 0);
          const hasHeader = /open|high|low|close|date|time/i.test(lines[0]);
          candleCount.textContent = (hasHeader ? lines.length - 1 : lines.length) + " rows detected.";
        } catch (err) { /* ignore */ }
      };
      reader.readAsText(file);
    }

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

    // ---- Run optimization ----
    runBtn.addEventListener("click", () => {
      if (!csvText) return;
      runBtn.disabled = true;
      document.getElementById("progressWrap").style.display = "block";
      document.getElementById("progressFill").style.width = "0%";
      document.getElementById("progressText").textContent = "Initializing...";

      const { ranges, steps } = getRanges();
      const fixedParams = getFixedParams();
      const sortMetric = document.getElementById("sortMetric").value;

      if (worker) worker.terminate();
      worker = new Worker("js/worker.js");
      worker.onmessage = handleWorkerMessage;
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

      // Summary stats
      const best = result.top[0] || { metrics: {} };
      const statsGrid = document.getElementById("statsGrid");
      const stats = [
        { val: result.totalTested.toLocaleString("en-IN"), label: "Combos Tested" },
        { val: result.top.length, label: "Top Results" },
        { val: fmt(best.metrics.netProfit, 0), label: "Best Net Profit" },
        { val: fmt(best.metrics.winRate, 1) + "%", label: "Best Win Rate" },
        { val: fmt(best.metrics.sharpe, 2), label: "Best Sharpe" },
      ];
      statsGrid.innerHTML = stats.map(s => `<div class="stat-box"><div class="val">${s.val}</div><div class="label">${s.label}</div></div>`).join("");

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
          <td class="rank">${i + 1}</td>
          <td class="${profitClass}">${fmt(m.netProfit, 0)}</td>
          <td>${m.totalTrades}</td>
          <td>${fmt(m.winRate, 1)}%</td>
          <td>${fmt(m.profitFactor, 2)}</td>
          <td>${fmt(m.sharpe, 2)}</td>
          <td class="neg">${fmt(m.maxDrawdown, 0)}</td>
          <td>${fmt(m.avgTrade, 1)}</td>
          <td><div class="param-display">${params}</div></td>
        </tr>`;
      }).join("");

      // Row click -> show equity curve
      tbody.querySelectorAll("tr").forEach(tr => {
        tr.addEventListener("click", () => {
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
      if (worker) worker.terminate();
      worker = new Worker("js/worker.js");
      worker.onmessage = (e) => {
        if (e.data.type === "singleDone") {
          drawChart(e.data.result.equity, r);
        }
      };
      worker.postMessage({ type: "single", csvText, params: r.params });
    }

    function drawChart(equity, result) {
      const canvas = document.getElementById("chartCanvas");
      const ctx = canvas.getContext("2d");
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.offsetWidth;
      const h = 350;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      if (!equity || equity.length === 0) {
        ctx.fillStyle = "#8b949e";
        ctx.font = "14px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("No trades in this configuration", w / 2, h / 2);
        return;
      }

      const vals = equity.map(e => e.equity);
      const minV = Math.min(0, ...vals);
      const maxV = Math.max(...vals);
      const range = maxV - minV || 1;
      const pad = 50;

      // Grid lines
      ctx.strokeStyle = "#30363d";
      ctx.lineWidth = 1;
      ctx.font = "10px sans-serif";
      ctx.fillStyle = "#8b949e";
      for (let i = 0; i <= 4; i++) {
        const y = pad + ((h - pad * 1.5) / 4) * i;
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - 20, y); ctx.stroke();
        const val = maxV - (range / 4) * i;
        ctx.textAlign = "right";
        ctx.fillText(fmt(val, 0), pad - 5, y + 3);
      }

      // Equity line
      const n = equity.length;
      ctx.strokeStyle = result.metrics.netProfit >= 0 ? "#3fb950" : "#f85149";
      ctx.lineWidth = 2;
      ctx.beginPath();
      equity.forEach((e, i) => {
        const x = pad + ((w - pad - 20) / (n - 1 || 1)) * i;
        const y = pad + (h - pad * 1.5) * (1 - (e.equity - minV) / range);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Fill
      ctx.lineTo(pad + ((w - pad - 20) / (n - 1 || 1)) * (n - 1), pad + (h - pad * 1.5));
      ctx.lineTo(pad, pad + (h - pad * 1.5));
      ctx.closePath();
      ctx.fillStyle = result.metrics.netProfit >= 0 ? "rgba(63,185,80,0.1)" : "rgba(248,81,73,0.1)";
      ctx.fill();

      // Title
      ctx.fillStyle = "#e6edf3";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "left";
      const p = result.params;
      ctx.fillText(`Rank #${topResults.indexOf(result) + 1} — Profit: ${fmt(result.metrics.netProfit, 0)} | Trades: ${result.metrics.totalTrades} | Win: ${fmt(result.metrics.winRate, 1)}%`, pad, 20);
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