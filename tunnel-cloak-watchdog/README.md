# tunnel-cloak-watchdog

A Cloudflare Worker that monitors a URL on a cron schedule. When the target
goes **down**, it adds a Workers Route that points to another Worker
(effectively enabling it). When the target comes back **up**, it removes
that route (effectively disabling it).

Designed to pair with [`../tunnel-cloak-fallback`](../tunnel-cloak-fallback):
when your tunnel/origin dies, this Worker switches on the fallback page
(so visitors never see Cloudflare's default error page and the fact that
you're using Cloudflare Tunnel stays hidden); when the tunnel recovers, it
switches the fallback off again so the route stays free of Worker usage
while the origin is healthy.

## How it works

```
                          ┌─────────────────────────┐
                          │  tunnel-cloak-watchdog   │
   cron (every minute) ──▶│  (this repo)            │
                          └───────────┬─────────────┘
                                      │ probe MONITOR_URL
                                      ▼
                            ┌──────────────────┐
                            │  UP or DOWN?     │
                            └────────┬─────────┘
                  DOWN (≥ threshold) │  UP
            ┌────────────────────────┼────────────────────────┐
            ▼                                                  ▼
  POST /zones/{id}/workers/routes             DELETE /zones/{id}/workers/routes/{id}
  → adds route → tunnel-cloak-fallback        → removes route → tunnel-cloak-fallback
    enabled                                     disabled
```

State (current status, consecutive failures, the route id we own) is
persisted in a KV namespace so the Cloudflare REST API is only called on
**actual state transitions**, not on every cron tick.

## Prerequisites

- A Cloudflare account with the **target zone** added (the zone that owns
  the route pattern you want to toggle).
- The **fallback Worker** (e.g. `tunnel-cloak-fallback`) already deployed to the
  same account. Note its script name — that's `TARGET_SCRIPT`.
- `wrangler` logged in (`npx wrangler login`) or `CLOUDFLARE_API_TOKEN`
  exported in your shell.

## Deployment steps (required)

### 1. Create the KV namespace

The Worker stores its run-to-run state in KV.

```bash
npx wrangler kv namespace create STATUS_KV
```

The command prints something like:

```
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{
  "kv_namespaces": [
    { "binding": "STATUS_KV", "id": "abc123..." }
  ]
}
```

Copy the `id` value into `wrangler.jsonc` → `kv_namespaces[0].id`.

### 2. Find your Zone ID

The Zone ID of the zone that owns the route pattern (e.g. for
`fallback.example.com/*`, that's the `example.com` zone).

The easiest way is the Cloudflare dashboard: open the zone → on the
**Overview** tab, the right-hand sidebar shows **Zone ID** with a copy
button. Direct link: <https://dash.cloudflare.com/> → pick the zone.

Alternatively, if you already have any API token with zone read access,
list your zones via the REST API:

```bash
# Replace $CF_API_TOKEN with any token that has Zone:Read.
# Returns id + name for every zone on the account.
curl -sS https://api.cloudflare.com/client/v4/zones \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  | jq -r '.result[] | "\(.id)  \(.name)"'
```

Keep the Zone ID handy for step 4 — you'll set it as a secret, **not** in
`wrangler.jsonc`.

### 3. Configure the non-personal vars in `wrangler.jsonc`

Only the non-personal tunables live in the committed config. Open
`wrangler.jsonc` and adjust if needed:

| Var | Meaning | Default in repo |
|---|---|---|
| `TARGET_SCRIPT` | Name of the fallback Worker script. | `tunnel-cloak-fallback` |
| `PROBE_TIMEOUT_MS` | Probe timeout in ms. | `8000` |
| `FAILURE_THRESHOLD` | Consecutive failures before flipping to DOWN. | `2` |

> **Why not put personal values here?** Anything in `wrangler.jsonc` → `vars`
> is committed to the repo in plaintext. To keep your domain and zone ID out
> of a public repo, those go in as **secrets** (next step). At runtime both
> are accessed identically via `env.X`, so the code doesn't care.

### 4. Create the API token

This Worker needs to call the Cloudflare REST API to add/remove routes.
Create a token with the right scope:

1. Go to <https://dash.cloudflare.com/profile/api-tokens> → **Create Token**.
2. Use **Create Custom Token** with:
   - **Permissions**:
     - `Zone` → `Workers Routes` → **Edit**
   - **Zone Resources**:
     - `Include` → `Specific zone` → pick the zone from step 2
3. Copy the token value.

### 5. Set the secrets

Set **four** secrets. Three of them aren't traditionally "secret" (they
don't grant access), but using the secret store keeps your domain and zone
ID out of the repo.

```bash
# Real secret — grants API access.
npx wrangler secret put CF_API_TOKEN
# Your probe URL, e.g. https://app.example.com/health
npx wrangler secret put MONITOR_URL
# Zone ID from step 2.
npx wrangler secret put TARGET_ZONE_ID
# Route pattern that activates the fallback, e.g. fallback.example.com/*
npx wrangler secret put TARGET_PATTERN
```

Each command will prompt you to paste a value. Secrets are stored encrypted
on Cloudflare and attached to the Worker at runtime — they never touch your
repo.

> **Tip**: keep the same four values in a local `.dev.vars` file for
> development (see [Local development](#local-development) below). That file
> is gitignored.

### 6. (Optional) Set the cron frequency

In `wrangler.jsonc` → `triggers.crons`. Default is every minute:

```jsonc
"triggers": { "crons": ["* * * * *"] }
```

Plan limits ([docs](https://developers.cloudflare.com/workers/platform/limits/)):

| Plan | Cron triggers / account |
|---|---|
| Workers Free | 5 |
| Workers Paid | 250 |

> Cron changes can take up to 15 minutes to propagate.

### 7. Deploy

```bash
npx wrangler deploy
```

## Local development

Copy the example secrets file and fill in your values:

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars — paste in CF_API_TOKEN, MONITOR_URL, TARGET_ZONE_ID,
# and TARGET_PATTERN. This file is gitignored.
npx wrangler dev
```

To exercise the cron handler locally, run with the test flag and hit the
magic URL:

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
```

## Checking the current state

The Worker also exposes a small HTTP status page at its `workers.dev` URL
(or wherever you route it). GET it for a JSON snapshot:

```jsonc
{
  "monitor_url": "https://app.example.com/health",
  "managed_route": { "pattern": "fallback.example.com/*", "script": "tunnel-cloak-fallback" },
  "state": {
    "status": "up",
    "consecutiveFailures": 0,
    "routeId": null,
    "updatedAt": "2026-07-27T03:42:11.000Z"
  }
}
```

> **Heads-up for public repos**: this endpoint echoes `MONITOR_URL` and
> `TARGET_PATTERN`. If those values are sensitive, protect the endpoint with
> [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/)
> or remove the `fetch` handler from `worker.js`.

## Logs

Live tail:

```bash
npx wrangler tail
```

All logs are emitted as structured JSON (one object per line). Look for
`message` values like:

- `tick complete` — every cron tick, includes resulting state
- `route added — fallback worker enabled` — transition UP → DOWN
- `route removed — fallback worker disabled` — transition DOWN → UP
- `probe failed` — a single probe failed (not yet over threshold)

## Tuning guide

| Scenario | What to change |
|---|---|
| Want fewer false alarms during brief blips | Raise `FAILURE_THRESHOLD` |
| Want to react faster to outages | Lower cron interval (e.g. `*/30 * * * * *` is not valid — use the minimum `* * * * *`), lower `FAILURE_THRESHOLD` |
| Probe a slow endpoint | Raise `PROBE_TIMEOUT_MS` |
| Probe returns 4xx but origin is alive | No change needed — 4xx is treated as UP by design |

## Safety properties

- **No double-enabling / orphan routes on delete**: when removing a route,
  if the KV-stored `routeId` is missing, the Worker falls back to a
  `LIST` call and matches on **both** `pattern` and `script` before
  deleting — so it can never delete a route owned by another Worker.
- **State-machine transitions only**: the Cloudflare API is called
  exclusively on actual UP→DOWN / DOWN→UP transitions, never on every tick.
- **First-run assumes UP**: a fresh KV starts as `up`, so a brand-new
  deploy won't spuriously enable the fallback before it has actually probed.

## Related docs

- [Workers Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Workers Routes API](https://developers.cloudflare.com/api/resources/workers/subresources/routes/)
- [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
- [KV bindings](https://developers.cloudflare.com/kv/concepts/kv-bindings/)
