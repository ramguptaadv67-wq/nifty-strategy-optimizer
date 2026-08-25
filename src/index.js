// Cloudflare Worker entry point
// Handles /api/yahoo proxy AND serves static assets via ASSETS binding

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // API route: /api/yahoo
    if (url.pathname === "/api/yahoo") {
      return handleYahooApi(request, url);
    }

    // Everything else: serve static assets
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleYahooApi(request, url) {
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

    const corsHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    };

    if (!resp.ok) {
      return new Response(
        JSON.stringify({ error: `Yahoo API returned ${resp.status}` }),
        { status: resp.status, headers: corsHeaders }
      );
    }

    const data = await resp.text();
    return new Response(data, { headers: corsHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}
