# tunnel-cloak

Hide the fact that you're using Cloudflare Tunnel, and keep Worker usage near
zero while your origin is healthy.

`tunnel-cloak` is a pair of small Cloudflare Workers that work together to
mask Cloudflare's default error pages behind your own branded maintenance
page **only when your server or Tunnel is down**. When the origin is
healthy, no Worker runs on your public route at all — so you don't burn
Worker invocations or add latency on normal traffic.

## Why

When a Cloudflare Tunnel goes down, Cloudflare serves its own branded error
page (e.g. 1033 / 5xx). That page:

- Reveals that the site is fronted by Cloudflare Tunnel.
- Looks unprofessional to end users.

`tunnel-cloak` replaces that page with your own custom 503 page the moment
the origin is detected as down, and removes it again the moment the origin
recovers — without keeping a Worker permanently on the route.

## How it works

```
                          Healthy (normal traffic)
                          ───────────────────────
   visitor ──▶ Cloudflare ──▶ Tunnel ──▶ your origin
                  (no Worker on the route — zero Worker usage)


                          Origin DOWN
                          ───────────
   visitor ──▶ Cloudflare ──▶ tunnel-cloak-fallback ──▶ branded 503 page
                  ▲                  ▲
                  │                  │ route added by tunnel-cloak-watchdog
                  │                  │   (cron detects DOWN → POST /workers/routes)
                  │
                  │ when origin recovers:
                  │   watchdog removes the route (DELETE /workers/routes/{id})
                  │   → traffic flows straight to Tunnel again, no Worker involved
```

Two Workers, each with one job:

| Worker | Role | When does it run? |
|---|---|---|
| [`tunnel-cloak-watchdog`](./tunnel-cloak-watchdog) | Health probe on a cron schedule. Adds/removes a Workers Route that points at the fallback Worker. | Every cron tick (e.g. once a minute). Only calls the Cloudflare API on actual UP↔DOWN transitions. |
| [`tunnel-cloak-fallback`](./tunnel-cloak-fallback) | Serves your custom 503 maintenance page. Only receives traffic when the watchdog has wired its route in. | Only while the origin is DOWN. |

The watchdog stores its run-to-run state (current status, consecutive
failures, the route id it owns) in a KV namespace, so the Cloudflare REST
API is only called on **actual state transitions**, not on every tick —
keeping both Worker usage and API calls to the bare minimum.

## Repository layout

```
tunnel-cloak/
├── README.md                       ← you are here
├── tunnel-cloak-watchdog/          ← cron-driven health probe + route toggle
│   ├── worker.js
│   ├── wrangler.jsonc
│   ├── README.md
│   └── ...
└── tunnel-cloak-fallback/          ← branded 503 page served on the route
    ├── worker.js
    ├── wrangler.jsonc
    ├── README.md
    └──...
```

## Quick start

Deploy the **fallback first**, then the watchdog — the watchdog needs the
fallback's script name to exist before it can point a route at it.

```bash
# 1. Deploy the fallback Worker.
cd tunnel-cloak-fallback
npx wrangler deploy

# 2. Deploy the watchdog Worker.
cd ../tunnel-cloak-watchdog
# Follow the deployment steps in its README (KV namespace, secrets, etc.)
npx wrangler deploy
```

Each subproject has its own `README.md` with full setup instructions:

- [`tunnel-cloak-watchdog/README.md`](./tunnel-cloak-watchdog/README.md) —
  KV namespace, API token, secrets, cron config, tuning guide.
- [`tunnel-cloak-fallback/README.md`](./tunnel-cloak-fallback/README.md) —
  route config, customising the maintenance page, browser default page mode.

## Cost characteristics

- **Healthy origin**: the fallback Worker gets zero requests (no route
  wired in). The watchdog runs once per cron tick — one cheap `fetch` probe
  per tick, no Cloudflare API calls. Well within the Workers Free plan.
- **Origin down**: the fallback Worker runs once per visitor request,
  serving the inlined HTML 503 page (sub-millisecond CPU). The watchdog
  keeps probing; once the origin recovers, it removes the route and the
  fallback Worker goes quiet again.

## Related Cloudflare docs

- [Workers Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Workers Routes API](https://developers.cloudflare.com/api/resources/workers/subresources/routes/)
- [KV bindings](https://developers.cloudflare.com/kv/concepts/kv-bindings/)
- [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)