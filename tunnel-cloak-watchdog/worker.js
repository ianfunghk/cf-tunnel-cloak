/**
 * Cloudflare Worker — Status Check & Route Toggle
 *
 * Monitors a configurable URL on a cron schedule. When the target is
 * detected as down, the route to ANOTHER Worker is added (enabling it).
 * When the target comes back online, the route is removed (disabling it).
 *
 * State is persisted in KV so we only call the Cloudflare API on actual
 * state transitions (down → up, up → down), not on every cron tick.
 *
 * All runtime configuration comes from environment variables / secrets
 * (see wrangler.jsonc bindings and `.dev.vars.example`). No secrets in
 * source.
 */

// ---------------------------------------------------------------------------
// Tunables (defaults can be overridden via env)
// ---------------------------------------------------------------------------

/** Probe timeout in ms. */
const DEFAULT_TIMEOUT_MS = 8000;
/** Consecutive failures required before flipping to DOWN (anti-flap). */
const DEFAULT_FAILURE_THRESHOLD = 2;
/** User-Agent used for the probe. */
const PROBE_USER_AGENT = 'tunnel-cloak-watchdog/1.0 (+cron)';

// ---------------------------------------------------------------------------
// Config validation — fail fast on missing/malformed secrets so we never
// send a request to /zones/<undefined>/workers/routes and produce confusing
// API errors. Returns { ok: true } or { ok: false, error }.
// ---------------------------------------------------------------------------
function validateConfig(env) {
  const required = ['MONITOR_URL', 'TARGET_ZONE_ID', 'TARGET_PATTERN', 'CF_API_TOKEN'];
  const missing = required.filter((k) => !env[k] || typeof env[k] !== 'string' || env[k].trim() === '');
  if (missing.length) {
    return { ok: false, error: `missing required secrets: ${missing.join(', ')}` };
  }
  if (!/^https?:\/\//i.test(env.MONITOR_URL)) {
    return { ok: false, error: `MONITOR_URL must be an http(s) URL, got: ${env.MONITOR_URL}` };
  }
  // Cloudflare zone ids are 32 lowercase hex chars.
  if (!/^[0-9a-f]{32}$/i.test(env.TARGET_ZONE_ID)) {
    return { ok: false, error: `TARGET_ZONE_ID should be a 32-hex-char zone id, got: ${env.TARGET_ZONE_ID}` };
  }
  if (!env.STATUS_KV || typeof env.STATUS_KV.get !== 'function') {
    return { ok: false, error: 'STATUS_KV binding is missing — check kv_namespaces in wrangler.jsonc' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Probe the target URL. Returns true when the site is considered UP.
 *
 * UP   = any 1xx/2xx/3xx/4xx response.
 * DOWN = 5xx response, network error, or timeout.
 *
 * (4xx is treated as UP because a 404/401 still proves the origin is alive.)
 */
async function isSiteUp(url, timeoutMs, signal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Combine the caller's signal (e.g. cron cancellation) with our timeout.
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': PROBE_USER_AGENT },
      signal: controller.signal,
      // Don't read the body — we only care about the status code, and the
      // body may be large. cf/workers best practice: never await .text()
      // on unbounded payloads.
    });
    return response.status < 500;
  } catch (error) {
    // AbortError (timeout) or a network-level failure → site is down.
    console.warn(JSON.stringify({
      message: 'probe failed',
      url,
      error: error instanceof Error ? error.name : String(error),
    }));
    return false;
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Read the persisted state from KV. Returns a normalized object even when
 * no prior state exists.
 */
async function readState(kv) {
  const raw = await kv.get('monitor:state', 'json');
  if (raw && typeof raw === 'object') {
    return {
      status: raw.status === 'down' ? 'down' : 'up',
      consecutiveFailures: Number(raw.consecutiveFailures) || 0,
      routeId: typeof raw.routeId === 'string' ? raw.routeId : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    };
  }
  // Fresh start: assume UP so we don't spuriously enable the fallback on
  // the very first run before we've actually probed.
  return { status: 'up', consecutiveFailures: 0, routeId: null, updatedAt: null };
}

/** Write the state back to KV. */
async function writeState(kv, state) {
  await kv.put('monitor:state', JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Cloudflare REST API helpers (Workers Routes)
//   Docs: https://developers.cloudflare.com/api/resources/workers/subresources/routes/
// ---------------------------------------------------------------------------

async function cfApiFetch(token, method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Don't read an unbounded body — cap it. API responses are tiny JSON.
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep null */ }

  if (!res.ok || !json || json.success !== true) {
    const errMsg = json?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ')
      || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API ${method} ${path} failed: ${errMsg}`);
  }
  return json.result;
}

/** Create a route mapping `pattern` to `script`. Returns {id, pattern, script}. */
function createRoute(token, zoneId, pattern, script) {
  return cfApiFetch(token, 'POST', `/zones/${zoneId}/workers/routes`, { pattern, script });
}

/** List all routes for a zone. Returns [{id, pattern, script}, ...]. */
function listRoutes(token, zoneId) {
  return cfApiFetch(token, 'GET', `/zones/${zoneId}/workers/routes`);
}

/** Delete a route by id. */
function deleteRoute(token, zoneId, routeId) {
  return cfApiFetch(token, 'DELETE', `/zones/${zoneId}/workers/routes/${routeId}`);
}

/**
 * Find the route id for our managed (pattern, script) pair. We match on
 * BOTH fields so we never accidentally delete a route owned by another
 * Worker or pointing at a different pattern.
 */
async function findManagedRouteId(token, zoneId, pattern, script) {
  const routes = await listRoutes(token, zoneId);
  const match = (Array.isArray(routes) ? routes : []).find(
    (r) => r && r.pattern === pattern && r.script === script,
  );
  return match ? match.id : null;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * Enable the fallback Worker by adding its route.
 * Stores the resulting route id in state so we can delete it later without
 * another list call.
 */
async function enableFallback(env, state) {
  const route = await createRoute(
    env.CF_API_TOKEN,
    env.TARGET_ZONE_ID,
    env.TARGET_PATTERN,
    env.TARGET_SCRIPT,
  );
  console.log(JSON.stringify({
    message: 'route added — fallback worker enabled',
    pattern: env.TARGET_PATTERN,
    script: env.TARGET_SCRIPT,
    route_id: route?.id,
  }));
  return { ...state, status: 'down', routeId: route?.id ?? null };
}

/**
 * Disable the fallback Worker by removing its route. Resolves the route id
 * from state, falling back to a list lookup if missing.
 */
async function disableFallback(env, state) {
  let routeId = state.routeId;
  if (!routeId) {
    routeId = await findManagedRouteId(
      env.CF_API_TOKEN,
      env.TARGET_ZONE_ID,
      env.TARGET_PATTERN,
      env.TARGET_SCRIPT,
    );
  }

  if (routeId) {
    await deleteRoute(env.CF_API_TOKEN, env.TARGET_ZONE_ID, routeId);
    console.log(JSON.stringify({
      message: 'route removed — fallback worker disabled',
      pattern: env.TARGET_PATTERN,
      script: env.TARGET_SCRIPT,
      route_id: routeId,
    }));
  } else {
    // Idempotent: nothing to remove. Likely the route was deleted out of
    // band, or a previous delete succeeded but KV write failed.
    console.warn(JSON.stringify({
      message: 'disableFallback: no managed route found',
      pattern: env.TARGET_PATTERN,
      script: env.TARGET_SCRIPT,
    }));
  }
  return { ...state, status: 'up', routeId: null };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default {
  /**
   * Cron entry point.
   *
   * @param {ScheduledController} _controller
   * @param {Record<string, any>} env
   * @param {ExecutionContext} _ctx
   */
  async scheduled(_controller, env, _ctx) {
    // Fail fast on missing/malformed config so we never send a request to
    // /zones/<undefined>/workers/routes and produce a confusing 7003 error.
    const cfg = validateConfig(env);
    if (!cfg.ok) {
      console.error(JSON.stringify({
        message: 'config invalid, aborting tick',
        error: cfg.error,
      }));
      return;
    }

    const timeoutMs = Number(env.PROBE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    const threshold = Number(env.FAILURE_THRESHOLD) || DEFAULT_FAILURE_THRESHOLD;

    const up = await isSiteUp(env.MONITOR_URL, timeoutMs);

    const state = await readState(env.STATUS_KV);
    const now = new Date().toISOString();
    let nextState = state;

    if (up) {
      if (state.status === 'down') {
        // Recovered — remove the route to disable the fallback Worker.
        nextState = {
          ...(await disableFallback(env, state)),
          consecutiveFailures: 0,
          updatedAt: now,
        };
      } else {
        // Still up — just reset the failure counter.
        nextState = { ...state, consecutiveFailures: 0, updatedAt: now };
      }
    } else {
      const failures = state.consecutiveFailures + 1;
      if (state.status === 'up' && failures >= threshold) {
        // Just went down — add the route to enable the fallback Worker.
        nextState = {
          ...(await enableFallback(env, state)),
          consecutiveFailures: failures,
          updatedAt: now,
        };
      } else {
        // Still below threshold, or already down — just record the failure.
        nextState = { ...state, consecutiveFailures: failures, updatedAt: now };
        console.log(JSON.stringify({
          message: 'probe failed',
          consecutive_failures: failures,
          threshold,
          current_status: state.status,
        }));
      }
    }

    await writeState(env.STATUS_KV, nextState);
    console.log(JSON.stringify({
      message: 'tick complete',
      probe_up: up,
      status: nextState.status,
      consecutive_failures: nextState.consecutiveFailures,
      route_id: nextState.routeId,
      updated_at: nextState.updatedAt,
    }));
  },

  /**
   * Optional HTTP handler — handy for a quick human-readable status page.
   * Protect this with Cloudflare Access if you don't want it public.
   */
  async fetch(_request, env) {
    const state = await readState(env.STATUS_KV);
    const body = JSON.stringify(
      {
        monitor_url: env.MONITOR_URL,
        managed_route: { pattern: env.TARGET_PATTERN, script: env.TARGET_SCRIPT },
        state,
      },
      null,
      2,
    );
    return new Response(body + '\n', {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
};
