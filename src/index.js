const NSE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ============================================================================
// AUTHENTICATION - Google Authenticator (TOTP, RFC 6238) + signed session
// cookie. Secrets come from Worker secrets (env.TOTP_SECRET,
// env.SESSION_SECRET). Nothing is hardcoded here.
// ============================================================================

const SESSION_COOKIE = 'sid';
const SESSION_TTL_SECONDS = 12 * 60 * 60;   // 12 hours
const TOTP_PERIOD = 30;                      // Google Authenticator default
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;                       // accept +/- 30s clock drift
const MAX_FAILED_ATTEMPTS = 5;               // per IP
const FAIL_WINDOW_SECONDS = 10 * 60;

const enc = new TextEncoder();
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function toB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Base32 (RFC 4648) - the format Google Authenticator expects for secrets.
function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '').replace(/=+$/, '');
  let bits = 0, value = 0;
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = B32_ALPHABET.indexOf(clean[i]);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function hmacBytes(hash, keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, msgBytes);
  return new Uint8Array(sig);
}

// HOTP: HMAC-SHA1, dynamic truncation (RFC 4226 section 5.3)
async function hotp(keyBytes, counter) {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setUint32(0, Math.floor(counter / 4294967296));
  dv.setUint32(4, counter >>> 0);
  const h = await hmacBytes('SHA-1', keyBytes, new Uint8Array(buf));
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return String(bin % Math.pow(10, TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Which time step does this code belong to? 0 = current step, negative = past.
// Used to explain a rejection (clock skew) - it never widens what is accepted.
const MAX_SKEW_STEPS = 10;

async function totpMatchOffset(secretB32, code, nowMs) {
  const keyBytes = base32Decode(secretB32);
  if (keyBytes.length === 0) return null;
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== TOTP_DIGITS) return null;
  const counter = Math.floor((nowMs === undefined ? Date.now() : nowMs) / 1000 / TOTP_PERIOD);
  for (let d = -MAX_SKEW_STEPS; d <= MAX_SKEW_STEPS; d++) {
    const expected = await hotp(keyBytes, counter + d);
    if (safeEqual(expected, clean)) return d;
  }
  return null;
}

// Verify a 6-digit code against the current time step (+/- TOTP_WINDOW).
async function verifyTotp(secretB32, code, nowMs) {
  const offset = await totpMatchOffset(secretB32, code, nowMs);
  return offset !== null && Math.abs(offset) <= TOTP_WINDOW;
}

function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toB64url(bytes);
}

// Short, non-reversible ID for the configured TOTP key. Two different secrets
// never share one, so it shows at a glance whether the stored TOTP_SECRET is
// the one whose QR was scanned. It reveals nothing usable about the secret.
async function totpKeyInfo(secretB32) {
  const keyBytes = base32Decode(secretB32);
  if (!keyBytes.length) return { id: 'none', warning: 'TOTP_SECRET is empty or unreadable' };
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', keyBytes));
  const id = toB64url(digest).slice(0, 8).toUpperCase();
  const warning = keyBytes.length === 20 ? '' :
    'TOTP_SECRET decodes to ' + keyBytes.length + ' bytes but a Google Authenticator key is 20 - it probably has extra characters (a prefix, quotes or spaces).';
  return { id: id, warning: warning };
}

// Signed session token: "<expiryEpochSeconds>.<nonce>.<hmacB64url>"
// The nonce is fresh on every login, so each login gets its own session token
// (two logins in the same second no longer produce identical cookies).
async function signSession(expiry, sessionSecret, nonce) {
  const payload = String(expiry) + '.' + (nonce || randomNonce());
  const sig = await hmacBytes('SHA-256', enc.encode(sessionSecret), enc.encode('v1|' + payload));
  return payload + '.' + toB64url(sig);
}

async function verifySession(token, sessionSecret) {
  if (!token || typeof token !== 'string') return false;
  const sigIdx = token.lastIndexOf('.');
  if (sigIdx <= 0) return false;
  const payload = token.slice(0, sigIdx);
  const sigPart = token.slice(sigIdx + 1);
  const dotIdx = payload.indexOf('.');
  if (dotIdx <= 0) return false;
  const expiry = parseInt(payload.slice(0, dotIdx), 10);
  const nonce = payload.slice(dotIdx + 1);
  if (!nonce || nonce.length < 16) return false;
  if (!isFinite(expiry) || expiry * 1000 < Date.now()) return false;
  const expected = await hmacBytes('SHA-256', enc.encode(sessionSecret), enc.encode('v1|' + payload));
  return safeEqual(toB64url(expected), sigPart);
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function sessionCookieHeader(token, maxAge) {
  return SESSION_COOKIE + '=' + token + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + maxAge;
}

// Best-effort brute-force throttle (Cache API is per-datacenter, so this is a
// speed bump rather than a hard guarantee - the 12-hour signed cookie and the
// 1-in-a-million code space are the real protection).
function throttleKey(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return new Request('https://totp-throttle.internal/' + encodeURIComponent(ip));
}

async function recordFailure(request) {
  try {
    const cache = caches.default;
    const key = throttleKey(request);
    const hit = await cache.match(key);
    const count = hit ? (parseInt(await hit.text(), 10) || 0) + 1 : 1;
    await cache.put(key, new Response(String(count), {
      headers: { 'Cache-Control': 'max-age=' + FAIL_WINDOW_SECONDS }
    }));
  } catch (e) { /* ignore */ }
}

async function isThrottled(request) {
  try {
    const hit = await caches.default.match(throttleKey(request));
    if (!hit) return false;
    const count = parseInt(await hit.text(), 10) || 0;
    return count >= MAX_FAILED_ATTEMPTS;
  } catch (e) { return false; }
}

async function clearFailures(request) {
  try { await caches.default.delete(throttleKey(request)); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Login screen
// ---------------------------------------------------------------------------
function loginPage(errorMessage, status, keyInfo) {
  const err = errorMessage
    ? '<div class="err">' + errorMessage + '</div>'
    : '<div class="hint">Open Google Authenticator and enter the current 6-digit code.</div>';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Sign in - NIFTY Strategy Optimizer</title>
<style>
:root{--bg:#0d1117;--surface:#161b22;--surface2:#21262d;--border:#30363d;--text:#e6edf3;--dim:#8b949e;--accent:#58a6ff;--red:#f85149;--green:#3fb950}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:2rem;width:100%;max-width:380px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.4)}
.lock{font-size:2rem;line-height:1;margin-bottom:.75rem}
h1{font-size:1.05rem;font-weight:700;margin-bottom:.35rem}
.sub{font-size:.8rem;color:var(--dim);margin-bottom:1.5rem}
input{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:.85rem;font-size:1.5rem;letter-spacing:.4em;text-align:center;font-family:'SF Mono',Monaco,monospace;outline:none}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(88,166,255,.15)}
button{width:100%;margin-top:1rem;background:linear-gradient(135deg,var(--accent),#4f8ef7);color:#fff;border:none;border-radius:6px;padding:.8rem;font-size:.95rem;font-weight:700;cursor:pointer}
button:hover{transform:translateY(-1px)}
.err{background:rgba(248,81,73,.12);color:var(--red);border:1px solid rgba(248,81,73,.35);border-radius:6px;padding:.6rem;font-size:.8rem;margin-bottom:1rem}
.hint{color:var(--dim);font-size:.78rem;margin-bottom:1rem}
.foot{margin-top:1.5rem;font-size:.7rem;color:var(--dim)}
.warn{margin-top:.9rem;background:rgba(210,153,34,.12);border:1px solid rgba(210,153,34,.4);color:#d29922;border-radius:6px;padding:.5rem .6rem;font-size:.72rem;text-align:left;line-height:1.4}
</style>
</head>
<body>
<form class="card" method="POST" action="/auth">
<div class="lock">&#128274;</div>
<h1>NIFTY Strategy Optimizer</h1>
<div class="sub">Protected by Google Authenticator</div>
${err}
<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" autofocus required>
<button type="submit">Unlock</button>
<div class="foot">Session lasts 12 hours &middot; server time ${new Date().toISOString().slice(11, 19)} UTC &middot; key ID ${keyInfo && keyInfo.id ? keyInfo.id : '-'}</div>
</form>
${keyInfo && keyInfo.warning ? '<div class="warn">' + keyInfo.warning + '</div>' : ''}
</body>
</html>`;
  return new Response(html, {
    status: status || 401,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function configErrorPage(missing) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Worker not configured</title>
<style>body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;padding:3rem;line-height:1.6}
code{background:#21262d;padding:.15rem .4rem;border-radius:4px;font-size:.9em}
.box{max-width:640px;margin:0 auto;border:1px solid #30363d;border-radius:8px;padding:2rem;background:#161b22}
h1{font-size:1.1rem;color:#f85149;margin-bottom:1rem}</style></head><body><div class="box">
<h1>Worker secrets are missing</h1>
<p>This Worker needs <code>TOTP_SECRET</code> and <code>SESSION_SECRET</code> before it can run.</p>
<p>Missing: <code>${missing}</code></p>
<p>Set them from your project folder:</p>
<pre><code>npx wrangler secret put TOTP_SECRET
npx wrangler secret put SESSION_SECRET</code></pre>
<p>Then redeploy. The login screen appears once both are set.</p>
</div></body></html>`;
  return new Response(html, {
    status: 500,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

// ---------------------------------------------------------------------------
// NSE NIFTY futures EOD (from UDiFF bhavcopy zips at nsearchives.nseindia.com)
// ---------------------------------------------------------------------------

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

    // ---- Auth configuration check -------------------------------------
    const totpSecret = env.TOTP_SECRET;
    const sessionSecret = env.SESSION_SECRET;
    if (!totpSecret || !sessionSecret) {
      const missing = [!totpSecret ? 'TOTP_SECRET' : null, !sessionSecret ? 'SESSION_SECRET' : null].filter(Boolean).join(' + ');
      return configErrorPage(missing);
    }
    const keyInfo = await totpKeyInfo(totpSecret);

    // ---- Login submission ---------------------------------------------
    if (url.pathname === '/auth' && request.method === 'POST') {
      if (await isThrottled(request)) {
        return loginPage('Too many incorrect codes. Wait 10 minutes and try again.', 429, keyInfo);
      }
      let code = '';
      try {
        const ct = request.headers.get('Content-Type') || '';
        if (ct.includes('application/json')) {
          code = (await request.json()).code || '';
        } else {
          const raw = await request.text();
          const m = raw.match(/(?:^|&)code=([^&]*)/);
          code = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
        }
      } catch (e) { code = ''; }

      const offset = await totpMatchOffset(totpSecret, code);
      const ok = offset !== null && Math.abs(offset) <= TOTP_WINDOW;
      if (!ok) {
        await recordFailure(request);
        const digits = String(code || '').replace(/\D/g, '');
        let msg;
        if (digits.length !== TOTP_DIGITS) {
          msg = 'That was not a 6-digit code. Enter all six digits from the authenticator, with no spaces.';
        } else if (offset !== null) {
          const secs = Math.abs(offset) * TOTP_PERIOD;
          msg = offset < 0
            ? 'That code was valid about ' + secs + ' seconds ago - this device clock looks slow. Turn on automatic date and time, then enter the current code.'
            : 'That code is not valid yet - it starts working in about ' + secs + ' seconds. This device clock looks fast; turn on automatic date and time.';
        } else {
          msg = 'Incorrect code. If the current code from the authenticator keeps failing, the TOTP_SECRET stored in Cloudflare does not match the QR you scanned - compare the key ID at the bottom of this screen with the QR you enrolled.';
        }
        return loginPage(msg, 401, keyInfo);
      }

      await clearFailures(request);
      const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
      const token = await signSession(expiry, sessionSecret);
      return new Response(null, {
        status: 302,
        headers: {
          'Location': '/',
          'Set-Cookie': sessionCookieHeader(token, SESSION_TTL_SECONDS),
          'Cache-Control': 'no-store'
        }
      });
    }

    // ---- Logout --------------------------------------------------------
    if (url.pathname === '/logout') {
      return new Response(null, {
        status: 302,
        headers: {
          'Location': '/',
          'Set-Cookie': sessionCookieHeader('', 0),
          'Cache-Control': 'no-store'
        }
      });
    }

    // ---- Everything below requires a valid session ---------------------
    const sessionOk = await verifySession(getCookie(request, SESSION_COOKIE), sessionSecret);
    if (!sessionOk) {
      if (request.method === 'GET' || request.method === 'HEAD') return loginPage(null, 401, keyInfo);
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }

    // ---- NSE index futures EOD candles ---------------------------------
    // /api/nsefut?symbol=NIFTY&from=YYYY-MM-DD&to=YYYY-MM-DD (span <= 30 days)
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

    // ---- Yahoo Finance proxy (server-side fetch, no CORS issues) -------
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

    // ---- Static assets -------------------------------------------------
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
    newHeaders.set('X-Content-Type-Options', 'nosniff');
    newHeaders.set('Cache-Control', 'no-store');

    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers: newHeaders
    });
  }
};
