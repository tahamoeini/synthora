const SESSION_COOKIE = "synthora_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const SESSION_BOOTSTRAP_LIMIT = 60;
const SESSION_BOOTSTRAP_WINDOW_SECONDS = 60 * 60;
const CLEANUP_BATCH_SIZE = 100;
const LOCAL_PUBLIC_LIMIT = 60;
const LOCAL_PUBLIC_WINDOW_SECONDS = 60 * 60;
const LOCAL_PUBLIC_MAX_BUCKETS = 5000;
const encoder = new TextEncoder();
const localPublicUsage = new Map();

const ROUTE_LIMITS = Object.freeze({
  market: { count: 120, windowSeconds: 60 * 60 },
  history: { count: 24, windowSeconds: 60 * 60 },
  inflation: { count: 6, windowSeconds: 24 * 60 * 60 },
  fx: { count: 60, windowSeconds: 60 * 60 },
  sync: { count: 40, windowSeconds: 60 * 60 },
});

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function secretFor(env) {
  const secret = env?.API_SESSION_SIGNING_SECRET;
  return typeof secret === "string" && secret.length >= 32 ? secret : null;
}

function databaseFor(env) {
  return env?.API_USAGE_DB && typeof env.API_USAGE_DB.prepare === "function" ? env.API_USAGE_DB : null;
}

export function hasDurableSessionSecurity(env) {
  return Boolean(secretFor(env) && databaseFor(env));
}

async function signingKey(secret, usages = ["sign", "verify"]) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

function base64Url(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function cookieValue(request) {
  const header = request.headers.get("cookie") || "";
  const prefix = `${SESSION_COOKIE}=`;
  const entry = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : "";
}

function originAllowed(request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function reserveSessionBootstrap(request, db, now, secret) {
  const clientAddress = request.headers.get("cf-connecting-ip")?.trim();
  if (!clientAddress || clientAddress.length > 128)
    return { error: jsonResponse({ error: "session-limit-unavailable" }, 503) };

  const hashBytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await signingKey(secret),
      encoder.encode(`synthora-session-bootstrap-v1:${clientAddress}`),
    ),
  );
  const clientHash = [...hashBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const windowStart = Math.floor(now / SESSION_BOOTSTRAP_WINDOW_SECONDS) * SESSION_BOOTSTRAP_WINDOW_SECONDS;
  try {
    const row = await db
      .prepare(
        "INSERT INTO api_session_issuance (client_hash, window_start, request_count) VALUES (?1, ?2, 1) ON CONFLICT(client_hash, window_start) DO UPDATE SET request_count = request_count + 1 WHERE request_count < ?3 RETURNING request_count",
      )
      .bind(clientHash, windowStart, SESSION_BOOTSTRAP_LIMIT)
      .first();
    if (!row) {
      const retryAfter = Math.max(1, windowStart + SESSION_BOOTSTRAP_WINDOW_SECONDS - now);
      return {
        error: jsonResponse({ error: "rate-limit-exceeded", retryAfterSeconds: retryAfter }, 429, {
          "retry-after": String(retryAfter),
        }),
      };
    }

    await db
      .prepare(
        "DELETE FROM api_usage WHERE session_hash IN (SELECT session_hash FROM api_sessions WHERE expires_at <= ?1 ORDER BY expires_at LIMIT ?2)",
      )
      .bind(now, CLEANUP_BATCH_SIZE)
      .run();
    await db
      .prepare(
        "DELETE FROM api_sessions WHERE session_hash IN (SELECT session_hash FROM api_sessions WHERE expires_at <= ?1 ORDER BY expires_at LIMIT ?2)",
      )
      .bind(now, CLEANUP_BATCH_SIZE)
      .run();
    await db
      .prepare(
        "DELETE FROM api_session_issuance WHERE (client_hash, window_start) IN (SELECT client_hash, window_start FROM api_session_issuance WHERE window_start < ?1 ORDER BY window_start LIMIT ?2)",
      )
      .bind(windowStart, CLEANUP_BATCH_SIZE)
      .run();
    return {};
  } catch {
    return { error: jsonResponse({ error: "api-quota-unavailable" }, 503) };
  }
}

export async function readSession(request, env) {
  const secret = secretFor(env);
  const db = databaseFor(env);
  if (!secret || !db) return { error: jsonResponse({ error: "api-security-not-configured" }, 503) };
  const token = cookieValue(request);
  const [id, expiresText, signatureText, extra] = token.split(".");
  const expiresAt = Number(expiresText);
  if (!id || extra !== undefined || !Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000))
    return { error: null };
  try {
    const signature = fromBase64Url(signatureText || "");
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret),
      signature,
      encoder.encode(`${id}.${expiresText}`),
    );
    if (!valid) return { error: null };
    const sessionHash = await sha256(id);
    const row = await db
      .prepare("SELECT expires_at FROM api_sessions WHERE session_hash = ?1")
      .bind(sessionHash)
      .first();
    if (!row || Number(row.expires_at) <= Math.floor(Date.now() / 1000)) return { error: null };
    return { sessionHash, expiresAt: Number(row.expires_at) };
  } catch {
    return { error: jsonResponse({ error: "api-security-unavailable" }, 503) };
  }
}

export async function issueSession(request, env) {
  if (!originAllowed(request)) return jsonResponse({ error: "same-origin-required" }, 403);
  const existing = await readSession(request, env);
  if (existing.error) return existing.error;
  if (existing.sessionHash) return jsonResponse({ ok: true, expiresAt: existing.expiresAt });
  const secret = secretFor(env);
  const db = databaseFor(env);
  if (!secret || !db) return jsonResponse({ error: "api-security-not-configured" }, 503);
  const now = Math.floor(Date.now() / 1000);
  const bootstrap = await reserveSessionBootstrap(request, db, now, secret);
  if (bootstrap.error) return bootstrap.error;
  const idBytes = crypto.getRandomValues(new Uint8Array(32));
  const id = base64Url(idBytes);
  const expiresAt = now + SESSION_TTL_SECONDS;
  const expiresText = String(expiresAt);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(`${id}.${expiresText}`)),
  );
  const token = `${id}.${expiresText}.${base64Url(signature)}`;
  const sessionHash = await sha256(id);
  try {
    await db
      .prepare("INSERT INTO api_sessions (session_hash, created_at, expires_at) VALUES (?1, ?2, ?3)")
      .bind(sessionHash, now, expiresAt)
      .run();
  } catch {
    return jsonResponse({ error: "api-security-unavailable" }, 503);
  }
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return jsonResponse({ ok: true, expiresAt }, 200, {
    "set-cookie": `${SESSION_COOKIE}=${token}; Path=/api; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure}`,
  });
}

function consumeLocalPublicQuota(request, route) {
  if (request.method !== "GET") return { error: jsonResponse({ error: "method-not-allowed" }, 405) };
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin !== new URL(request.url).origin && fetchSite !== "same-origin")
    return { error: jsonResponse({ error: "same-origin-required" }, 403) };
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / LOCAL_PUBLIC_WINDOW_SECONDS) * LOCAL_PUBLIC_WINDOW_SECONDS;
  const clientAddress = request.headers.get("cf-connecting-ip")?.trim() || "unattributed";
  let key = `${clientAddress}:${route}:${windowStart}`;
  if (localPublicUsage.size >= LOCAL_PUBLIC_MAX_BUCKETS) {
    for (const [bucket, value] of localPublicUsage) {
      if (value.windowStart < windowStart) localPublicUsage.delete(bucket);
      if (localPublicUsage.size < LOCAL_PUBLIC_MAX_BUCKETS) break;
    }
  }
  if (localPublicUsage.size >= LOCAL_PUBLIC_MAX_BUCKETS && !localPublicUsage.has(key))
    key = `overflow:${route}:${windowStart}`;
  const count = (localPublicUsage.get(key)?.count || 0) + 1;
  if (count > LOCAL_PUBLIC_LIMIT) {
    const retryAfter = Math.max(1, windowStart + LOCAL_PUBLIC_WINDOW_SECONDS - now);
    return {
      error: jsonResponse({ error: "rate-limit-exceeded", retryAfterSeconds: retryAfter }, 429, {
        "retry-after": String(retryAfter),
      }),
    };
  }
  localPublicUsage.set(key, { count, windowStart });
  return { unmetered: true, db: null };
}

export async function consumeRouteQuota(context, route, { allowPublicWhenUnconfigured = false } = {}) {
  const request = context.request;
  if (!request || !originAllowed(request)) return { error: jsonResponse({ error: "same-origin-required" }, 403) };
  const db = databaseFor(context.env);
  if (allowPublicWhenUnconfigured && (!secretFor(context.env) || !db)) return consumeLocalPublicQuota(request, route);
  const session = await readSession(request, context.env);
  if (session.error) return { error: session.error };
  if (!session.sessionHash) return { error: jsonResponse({ error: "session-required" }, 401) };
  const limit = ROUTE_LIMITS[route];
  if (!limit) return { error: jsonResponse({ error: "route-quota-unavailable" }, 503) };
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / limit.windowSeconds) * limit.windowSeconds;
  try {
    const row = await db
      .prepare(
        "INSERT INTO api_usage (session_hash, route, window_start, request_count) VALUES (?1, ?2, ?3, 1) ON CONFLICT(session_hash, route, window_start) DO UPDATE SET request_count = request_count + 1 RETURNING request_count",
      )
      .bind(session.sessionHash, route, windowStart)
      .first();
    if (!row || Number(row.request_count) > limit.count) {
      return {
        error: jsonResponse(
          { error: "rate-limit-exceeded", retryAfterSeconds: windowStart + limit.windowSeconds - now },
          429,
          { "retry-after": String(Math.max(1, windowStart + limit.windowSeconds - now)) },
        ),
      };
    }
    return { sessionHash: session.sessionHash, db };
  } catch {
    return { error: jsonResponse({ error: "api-quota-unavailable" }, 503) };
  }
}

export async function reservePlatformProviderRequest(
  env,
  provider = "coingecko",
  { monthlyLimit, minimumIntervalSeconds = 60, quotaUnits = 1 } = {},
) {
  const db = databaseFor(env);
  if (!db) return false;
  const limitName = `${provider.toUpperCase()}_PLATFORM_MONTHLY_LIMIT`;
  const configuredLimit = Number(env?.[limitName]);
  const defaultLimit = provider === "coinmarketcap" ? 15000 : 8000;
  const maximumLimit = provider === "coinmarketcap" ? 15000 : 9500;
  const requestedLimit = Number.isFinite(configuredLimit) ? configuredLimit : Number(monthlyLimit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(maximumLimit, Math.floor(requestedLimit)))
    : defaultLimit;
  const month = new Date().toISOString().slice(0, 7);
  const now = Math.floor(Date.now() / 1000);
  const nextAllowedAt = now + Math.max(60, Math.floor(Number(minimumIntervalSeconds) || 60));
  try {
    const row = await db
      .prepare(
        "INSERT INTO provider_monthly_usage (provider, month_key, request_count, next_allowed_at) VALUES (?1, ?2, ?6, ?5) ON CONFLICT(provider, month_key) DO UPDATE SET request_count = request_count + ?6, next_allowed_at = ?5 WHERE provider_monthly_usage.next_allowed_at <= ?4 AND provider_monthly_usage.request_count + ?6 <= ?3 RETURNING request_count",
      )
      .bind(provider, month, limit, now, nextAllowedAt, Math.max(1, Math.floor(Number(quotaUnits) || 1)))
      .first();
    return Boolean(row && Number(row.request_count) <= limit);
  } catch {
    return false;
  }
}

export async function readPlatformProviderCache(env, provider) {
  const db = databaseFor(env);
  if (!db) return null;
  try {
    const row = await db
      .prepare("SELECT quotes_json, fetched_at FROM provider_quote_cache WHERE provider = ?1")
      .bind(provider)
      .first();
    const quotes = JSON.parse(row?.quotes_json || "null");
    return quotes !== null && Number.isFinite(Number(row?.fetched_at))
      ? { quotes, fetchedAt: Number(row.fetched_at) * 1000 }
      : null;
  } catch {
    return null;
  }
}

export async function waitForPlatformProviderCache(env, provider, previousFetchedAt = 0, waitMs = 900) {
  const deadline = Date.now() + Math.max(0, Math.min(2000, waitMs));
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const cached = await readPlatformProviderCache(env, provider);
    if (cached && cached.fetchedAt > previousFetchedAt) return cached;
  }
  return await readPlatformProviderCache(env, provider);
}

export async function writePlatformProviderCache(env, provider, quotes, fetchedAt = Date.now()) {
  const db = databaseFor(env);
  if (!db || quotes === undefined) return false;
  try {
    await db
      .prepare(
        "INSERT INTO provider_quote_cache (provider, quotes_json, fetched_at) VALUES (?1, ?2, ?3) ON CONFLICT(provider) DO UPDATE SET quotes_json = excluded.quotes_json, fetched_at = excluded.fetched_at",
      )
      .bind(provider, JSON.stringify(quotes), Math.floor(fetchedAt / 1000))
      .run();
    return true;
  } catch {
    return false;
  }
}

export async function deferPlatformProviderRequest(env, provider, seconds = 60) {
  const db = databaseFor(env);
  if (!db) return false;
  const now = Math.floor(Date.now() / 1000);
  const nextAllowedAt = now + Math.max(60, Math.min(24 * 60 * 60, Math.floor(Number(seconds) || 60)));
  try {
    await db
      .prepare(
        "UPDATE provider_monthly_usage SET next_allowed_at = MAX(next_allowed_at, ?3) WHERE provider = ?1 AND month_key = ?2",
      )
      .bind(provider, new Date().toISOString().slice(0, 7), nextAllowedAt)
      .run();
    return true;
  } catch {
    return false;
  }
}

export function selectedProviderKey(request, env) {
  const userKey = String(request?.headers?.get("x-coingecko-api-key") || "").trim();
  if (userKey.length > 0 && userKey.length <= 300 && !/[\r\n\0]/.test(userKey))
    return { key: userKey, userSupplied: true };
  return {
    key: typeof env?.COINGECKO_DEMO_API_KEY === "string" ? env.COINGECKO_DEMO_API_KEY : "",
    userSupplied: false,
  };
}

export function securityJson(body, status = 200, headers = {}) {
  return jsonResponse(body, status, headers);
}
