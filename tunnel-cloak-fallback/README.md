# tunnel-cloak-fallback

The "cloak" itself — a tiny Cloudflare Worker that serves your **branded
503 maintenance page** when the upstream Tunnel is unreachable. It only
receives traffic while [`../tunnel-cloak-watchdog`](../tunnel-cloak-watchdog)
has wired a Workers Route in pointing at this Worker. While the origin is
healthy, no route exists, so this Worker is dormant and consumes no
invocations.

## How it works

The Worker runs on the **same route as the Tunnel**. A subrequest from the
Worker back to its own URL does **not** re-trigger the Worker (Cloudflare's
built-in recursion guard routes the subrequest straight to the origin /
Tunnel). So we can safely `fetch(request.url)` to probe the Tunnel without
infinite loops.

```
   request ──▶ Worker ──fetch(request.url)──▶ Tunnel
                                                │
                          ┌─────────────────────┴─────────────────────┐
                          │ 2xx/3xx/4xx                                │ 5xx or network error
                          ▼                                            ▼
                    forward as-is                              serve branded 503 page
                                                              (FALLBACK_HTML below)
```

- **2xx / 3xx / 4xx** → forwarded as-is. A 4xx still proves the origin is
  alive, so it is passed through.
- **5xx or network error / timeout** → the Tunnel is treated as down and
  the custom maintenance page is served with HTTP 503 and `Retry-After: 300`.

## Files

| File | Purpose |
|---|---|
| `worker.js` | The Worker. Inline edit `FALLBACK_HTML` and `TUNNEL_TIMEOUT` here. |
| `wrangler.jsonc` | Cloudflare config. **Important**: the `routes` array here is only a placeholder for a *direct* deploy — under the `tunnel-cloak` design, the watchdog manages this route dynamically and you should normally leave `routes` empty or remove it. |

## Configure

Open `worker.js` and edit the two tunables at the top:

```js
// Timeout for the upstream probe, in milliseconds.
const TUNNEL_TIMEOUT = 8000;

// When true, return an empty 503 so the browser shows its built-in error
// page. When false, serve FALLBACK_HTML below.
const USE_BROWSER_DEFAULT_PAGE = false;

// Custom fallback page. All assets must be inlined (free plan).
const FALLBACK_HTML = `<!doctype html>
...your HTML here...`;
```

- **`TUNNEL_TIMEOUT`** — how long to wait for the Tunnel before giving up
  and serving the fallback page. 8000ms is a safe default for most
  setups; lower it for faster failover (at the risk of false alarms on
  slow origins).
- **`USE_BROWSER_DEFAULT_PAGE`** — `true` returns an empty 503 so the
  visitor's browser shows its native error page (smaller response, but
  browser-branded rather than your-branded). `false` serves the
  `FALLBACK_HTML` string.
- **`FALLBACK_HTML`** — your branded maintenance page. Everything (CSS,
  images as data URIs, etc.) must be inlined because the Workers Free
  plan doesn't allow extra asset fetches from inside a Worker response.

## Deploy

If you're running this as part of `tunnel-cloak`, you normally **do not**
need a static route in `wrangler.jsonc` — the watchdog will add and remove
the route dynamically. Leave the `routes` array empty (or remove the key
entirely) for the standard setup:

```jsonc
{
  "name": "tunnel-cloak-fallback",
  "main": "worker.js",
  "compatibility_date": "2026-07-27",
  "observability": {
    "enabled": true,
    "logs": { "head_sampling_rate": 1 }
  }
}
```

Then:

```bash
npx wrangler deploy
```

## Local development

```bash
npx wrangler dev
```

Test the fallback path locally by pointing `wrangler dev` at a port that
nothing is listening on, or by setting `TUNNEL_TIMEOUT` very low.

## Logs

```bash
npx wrangler tail
```

All logs are emitted as structured JSON (one object per line). Look for
`message` values like:

- `tunnel returned 5xx` — the upstream responded 5xx, fallback served.
- `tunnel probe failed` — the subrequest threw (timeout or network
  error), fallback served. Includes `timeout_hit: true` when caused by
  the timeout.

## Related docs

- [Workers routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)
- [Workers runtime APIs · `fetch`](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
- [Cloudflare Tunnel docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- Companion worker: [`../tunnel-cloak-watchdog`](../tunnel-cloak-watchdog)