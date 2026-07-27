/**
 * Cloudflare Tunnel Fallback Worker
 *
 * Serves a custom 503 page when the upstream Tunnel is unreachable.
 *
 * How it works:
 *   The Worker runs on the same route as the Tunnel. A subrequest from the
 *   Worker back to its own URL does NOT re-trigger the Worker (Cloudflare's
 *   built-in recursion guard routes the subrequest straight to the origin /
 *   Tunnel). So we can safely `fetch(request.url)` to probe the Tunnel.
 */

// Timeout for the upstream probe, in milliseconds.
const TUNNEL_TIMEOUT = 8000;

// When true, return an empty 503 so the browser shows its built-in error
// page. When false, serve FALLBACK_HTML below.
const USE_BROWSER_DEFAULT_PAGE = false;

// Custom fallback page. All assets must be inlined (free plan).
const FALLBACK_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>服務暫時中斷</title>
<style>
  :root { color-scheme: dark light; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
  .container { max-width: 560px; text-align: center; padding: 40px; background: rgba(30, 41, 59, 0.5); border-radius: 12px; border: 1px solid #334155; }
  h1 { font-size: 1.75rem; margin-bottom: 1rem; color: #f8fafc; }
  p { font-size: 1rem; line-height: 1.7; color: #94a3b8; margin-bottom: 1.5rem; }
  .status { display: inline-block; padding: 6px 12px; background: #dc2626; color: white; border-radius: 999px; font-size: 0.875rem; font-weight: 500; }
  .footer { margin-top: 2rem; font-size: 0.875rem; color: #64748b; }
</style>
</head>
<body>
  <div class="container">
    <h1>🚧 服務暫時中斷</h1>
    <p>我們的伺服器目前正在進行維護或遭遇網路連線問題。<br/>我們已經收到通知，正在努力恢復服務中。</p>
    <div class="status">OFFLINE</div>
    <div class="footer">
      若問題持續發生，請聯繫網站管理員。
    </div>
  </div>
</body>
</html>`;

function buildFallbackResponse() {
  if (USE_BROWSER_DEFAULT_PAGE) {
    // No body + no Content-Type → the browser renders its own 503 page.
    return new Response(null, {
      status: 503,
      headers: { 'Retry-After': '300' },
    });
  }
  return new Response(FALLBACK_HTML, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': '300',
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TUNNEL_TIMEOUT);

    const init = {
      method: request.method,
      headers: request.headers,
      redirect: 'manual',
      signal: controller.signal,
    };

    // Forward the request body for non-idempotent methods. Streaming a body
    // requires `duplex: 'half'` in the Workers runtime.
    if (!['GET', 'HEAD'].includes(request.method)) {
      init.body = request.body;
      init.duplex = 'half';
    }

    try {
      const response = await fetch(request.url, init);
      // 2xx, 3xx, 4xx → forward as-is. Only treat 5xx as an upstream outage.
      if (response.status < 500) {
        return response;
      }
      console.warn(JSON.stringify({
        message: 'tunnel returned 5xx',
        method: request.method,
        url: request.url,
        status: response.status,
      }));
      return buildFallbackResponse();
    } catch (error) {
      // AbortError (timeout) or network-level failure → Tunnel is down.
      console.error(JSON.stringify({
        message: 'tunnel probe failed',
        method: request.method,
        url: request.url,
        error: error instanceof Error ? error.name : String(error),
        timeout_hit: error instanceof Error && error.name === 'AbortError',
      }));
      return buildFallbackResponse();
    } finally {
      clearTimeout(timeoutId);
    }
  },
};
