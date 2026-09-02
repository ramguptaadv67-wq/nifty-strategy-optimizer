export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Yahoo Finance proxy - server-side fetch (no CORS issues)
    if (url.pathname === '/api/yahoo') {
      const symbol = url.searchParams.get('symbol') || '^NSEI';
      const interval = url.searchParams.get('interval') || '1d';
      const range = url.searchParams.get('range') || '1y';
      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;

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
