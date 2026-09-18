const NSE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ---- NSE NIFTY futures EOD (from UDiFF bhavcopy zips at nsearchives.nseindia.com) ----

function extractFrontMonthCsv(csvText, symbol) {
  const lines = csvText.split('\n');
  if (lines.length < 2) return null;
  const hdr = lines[0].split(',');
  const col = {};
  for (let i = 0; i < hdr.length; i++) col[hdr[i].trim()] = i;
  const need = ['TradDt', 'FinInstrmTp', 'TckrSymb', 'XpryDt', 'OpnPric', 'HghPric', 'LwPric', 'ClsPric', 'TtlTradgVol'];
  for (const n of need) if (col[n] === undefined) return null;
  let best = null, bestAny = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const f = line.split(',');
    if (f.length < hdr.length - 1) continue;
    if (f[col.FinInstrmTp] !== 'IDF') continue;   // IDF = index futures
    if (f[col.TckrSymb] !== symbol) continue;
    const xpry = f[col.XpryDt];
    const vol = parseFloat(f[col.TtlTradgVol]) || 0;
    const row = {
      expiry: xpry,
      open: parseFloat(f[col.OpnPric]),
      high: parseFloat(f[col.HghPric]),
      low: parseFloat(f[col.LwPric]),
      close: parseFloat(f[col.ClsPric]),
      volume: vol
    };
    if (!bestAny || xpry < bestAny.expiry) bestAny = row;
    if (vol > 0 && (!best || xpry < best.expiry)) best = row;
  }
  return best || bestAny;
}

async function inflateRaw(u8) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  return await new Response(stream).text();
}

async function parseNseFuturesZip(arrayBuffer, symbol) {
  const u8 = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  // Find End Of Central Directory record
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('invalid zip');
  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(ptr, true) !== 0x02014b50) break;
    const method = dv.getUint16(ptr + 10, true);
    const csize = dv.getUint32(ptr + 20, true);
    const fnLen = dv.getUint16(ptr + 28, true);
    const exLen = dv.getUint16(ptr + 30, true);
    const cmLen = dv.getUint16(ptr + 32, true);
    const lho = dv.getUint32(ptr + 42, true);
    const lfnLen = dv.getUint16(lho + 26, true);
    const lexLen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lfnLen + lexLen;
    const comp = u8.subarray(start, start + csize);
    if (method === 0) {
      const row = extractFrontMonthCsv(new TextDecoder().decode(comp), symbol);
      if (row) return row;
    } else if (method === 8) {
      const text = await inflateRaw(comp);
      const row = extractFrontMonthCsv(text, symbol);
      if (row) return row;
    }
    ptr += 46 + fnLen + exLen + cmLen;
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // NSE index futures EOD candles: /api/nsefut?symbol=NIFTY&from=YYYY-MM-DD&to=YYYY-MM-DD (span <= 30 days)
    if (url.pathname === '/api/nsefut') {
      const symbol = (url.searchParams.get('symbol') || 'NIFTY').toUpperCase();
      const fromStr = url.searchParams.get('from') || '';
      const toStr = url.searchParams.get('to') || '';
      const dates = [];
      if (/^\d{4}-\d{2}-\d{2}$/.test(fromStr) && /^\d{4}-\d{2}-\d{2}$/.test(toStr)) {
        const from = new Date(fromStr + 'T00:00:00Z'), to = new Date(toStr + 'T00:00:00Z');
        if (to >= from && (to - from) / 86400000 <= 30) {
          for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
            const dow = d.getUTCDay();
            if (dow !== 0 && dow !== 6) dates.push(d.toISOString().slice(0, 10));
          }
        }
      }
      if (dates.length === 0) {
        return new Response(JSON.stringify({ error: 'Provide from/to as YYYY-MM-DD, span <= 30 days' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const cache = caches.default;
      const out = [];
      const CONC = 6;
      for (let i = 0; i < dates.length; i += CONC) {
        const batch = dates.slice(i, i + CONC);
        const rows = await Promise.all(batch.map(async (d) => {
          const key = new Request('https://nse-fut-cache.internal/' + symbol + '/' + d);
          const hit = await cache.match(key);
          if (hit) { try { return await hit.json(); } catch (e) { return null; } }
          const zurl = 'https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_'
            + d.replace(/-/g, '') + '_F_0000.csv.zip';
          try {
            const resp = await fetch(zurl, { headers: { 'User-Agent': NSE_UA } });
            if (!resp.ok) return null; // weekend/holiday or missing day
            const buf = await resp.arrayBuffer();
            const row = await parseNseFuturesZip(buf, symbol);
            if (!row) return null;
            const obj = { date: d, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume, expiry: row.expiry };
            try { await cache.put(key, new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=604800' } })); } catch (e) {}
            return obj;
          } catch (e) { return null; }
        }));
        for (const r of rows) if (r) out.push(r);
      }
      out.sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : 0));
      return new Response(JSON.stringify({ symbol, candles: out }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
      });
    }

    // Yahoo Finance proxy - server-side fetch (no CORS issues)
    if (url.pathname === '/api/yahoo') {
      const symbol = url.searchParams.get('symbol') || '^NSEI';
      const interval = url.searchParams.get('interval') || '1d';
      const range = url.searchParams.get('range') || '1y';
      const period1 = url.searchParams.get('period1');
      const period2 = url.searchParams.get('period2');
      let yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}`;
      if (period1 && period2) {
        // Exact epoch window (used for chunked 1-min fetches to build 3-min candles)
        yahooUrl += `&period1=${period1}&period2=${period2}`;
      } else {
        yahooUrl += `&range=${range}`;
      }

      try {
        const resp = await fetch(yahooUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const data = await resp.text();
        return new Response(data, {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    // Serve static assets with correct content types
    const asset = await env.ASSETS.fetch(request);
    
    // Clone the response so we can modify headers
    const newHeaders = new Headers(asset.headers);
    
    // Ensure charset=utf-8 for HTML and JS
    const ct = newHeaders.get('Content-Type') || '';
    if (url.pathname === '/' || url.pathname.endsWith('.html')) {
      newHeaders.set('Content-Type', 'text/html; charset=utf-8');
    } else if (url.pathname.endsWith('.js')) {
      newHeaders.set('Content-Type', 'application/javascript; charset=utf-8');
    } else if (url.pathname.endsWith('.css')) {
      newHeaders.set('Content-Type', 'text/css; charset=utf-8');
    }

    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers: newHeaders
    });
  }
};
