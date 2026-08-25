// Cloudflare Pages Function: /api/yahoo
// Proxies Yahoo Finance API calls to bypass CORS restrictions
// Deploy this at: functions/api/yahoo.js

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol") || "^NSEI";
  const interval = url.searchParams.get("interval") || "1d";
  const range = url.searchParams.get("range") || "1mo";

  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;

  try {
    const resp = await fetch(yahooUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });

    if (!resp.ok) {
      return new Response(JSON.stringify({ error: `Yahoo API returned ${resp.status}` }), {
        status: resp.status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const data = await resp.json();
    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300", // cache 5 min
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}
