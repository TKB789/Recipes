/**
 * Recipe fetch proxy — Cloudflare Worker
 *
 * Deploy: dash.cloudflare.com → Workers & Pages → Create → Worker →
 * paste this in, Deploy. Copy the *.workers.dev URL and put it in app.js as:
 *   const MY_PROXY = 'https://your-worker.workers.dev/?url=';
 *
 * Usage: https://your-worker.workers.dev/?url=https%3A%2F%2Fexample.com%2Frecipe
 */

// Only these hosts can be fetched through the proxy. Add sites as you need them.
const ALLOWED_HOSTS = [
  'seriouseats.com',      // the one you're fixing
  'smittenkitchen.com',
  'bonappetit.com',
  'epicurious.com',
  'food52.com',
  'allrecipes.com',
  'kingarthurbaking.com',
  'thekitchn.com',
  'budgetbytes.com',
  'bbcgoodfood.com',
  'cooking.nytimes.com'
  // Add more the same way: a comma after the line above, then 'newsite.com'
];

// Restrict to your own site so the Worker isn't a free open proxy for everyone.
// This is scheme + domain only -- no repo name, no trailing slash. It stays the
// same no matter which repo the site is served from.
const ALLOWED_ORIGINS = [
  'https://tkb789.github.io'
];

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1'
};

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function hostAllowed(hostname) {
  const h = hostname.replace(/^www\./, '').toLowerCase();
  return ALLOWED_HOSTS.some(a => h === a || h.endsWith('.' + a));
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) {
      return new Response('Missing ?url=', { status: 400, headers: cors });
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return new Response('Bad url', { status: 400, headers: cors });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return new Response('Bad protocol', { status: 400, headers: cors });
    }
    if (!hostAllowed(parsed.hostname)) {
      return new Response('Host not allowed', { status: 403, headers: cors });
    }

    let upstream;
    try {
      upstream = await fetch(parsed.toString(), {
        headers: { ...BROWSER_HEADERS, Referer: parsed.origin + '/' },
        redirect: 'follow',
        // Cache each recipe page for a day — keeps you well inside the free tier.
        cf: { cacheTtl: 86400, cacheEverything: true }
      });
    } catch (e) {
      return new Response('Upstream fetch failed: ' + e.message, {
        status: 502,
        headers: cors
      });
    }

    if (!upstream.ok) {
      return new Response(`Upstream returned ${upstream.status}`, {
        status: 502,
        headers: cors
      });
    }

    const html = await upstream.text();

    return new Response(html, {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  }
};
