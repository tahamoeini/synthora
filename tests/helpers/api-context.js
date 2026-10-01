import { issueSession } from "../../functions/api/_security.js";

const SESSION_SECRET = "test-session-signing-secret-that-is-long-enough-for-hmac";

function createUsageDatabase() {
  const sessions = new Map();
  const routeUsage = new Map();
  const providerUsage = new Map();
  const providerHourlyUsage = new Map();
  const providerLastRequested = new Map();
  const providerCache = new Map();
  const issuance = new Map();

  return {
    prepare(statement) {
      let values = [];
      const query = {
        bind(...boundValues) {
          values = boundValues;
          return query;
        },
        async run() {
          if (
            statement.startsWith("DELETE FROM api_usage") ||
            statement.startsWith("DELETE FROM api_sessions") ||
            statement.startsWith("DELETE FROM api_session_issuance")
          )
            return { success: true };
          if (statement.includes("INSERT INTO api_sessions")) {
            sessions.set(values[0], { expires_at: values[2] });
            return { success: true };
          }
          if (statement.includes("INSERT INTO provider_quote_cache")) {
            providerCache.set(values[0], { quotes_json: values[1], fetched_at: values[2] });
            return { success: true };
          }
          if (statement.includes("UPDATE provider_monthly_usage")) {
            const [provider, month, nextAllowedAt] = values;
            const row = providerUsage.get([provider, month].join(":"));
            if (row) row.nextAllowedAt = Math.max(row.nextAllowedAt, nextAllowedAt);
            return { success: true };
          }
          throw new Error(`Unexpected test database statement: ${statement}`);
        },
        async first() {
          if (statement.includes("INSERT INTO provider_hourly_usage")) {
            const [provider, hour, limit, requestedAt, minimumInterval = 0] = values;
            const previousRequestedAt = providerLastRequested.get(provider);
            if (previousRequestedAt !== undefined && previousRequestedAt > requestedAt - minimumInterval) return null;
            const key = `${provider}:${hour}`;
            const count = (providerHourlyUsage.get(key) || 0) + 1;
            if (count > limit) return null;
            providerHourlyUsage.set(key, count);
            providerLastRequested.set(provider, requestedAt);
            return { request_count: count };
          }
          if (statement.includes("INSERT INTO api_session_issuance")) {
            const [clientHash, windowStart, limit] = values;
            const key = `${clientHash}:${windowStart}`;
            const count = issuance.get(key) || 0;
            if (count >= limit) return null;
            issuance.set(key, count + 1);
            return { request_count: count + 1 };
          }
          if (statement.includes("SELECT expires_at FROM api_sessions")) return sessions.get(values[0]) || null;
          if (statement.includes("INSERT INTO api_usage")) {
            const key = values.slice(0, 3).join(":");
            const requestCount = (routeUsage.get(key) || 0) + 1;
            routeUsage.set(key, requestCount);
            return { request_count: requestCount };
          }
          if (statement.includes("INSERT INTO provider_monthly_usage")) {
            const [provider, month, limit, now, nextAllowedAt, quotaUnits = 1] = values;
            const key = [provider, month].join(":");
            const previous = providerUsage.get(key);
            if (previous && (previous.nextAllowedAt > now || previous.requestCount + quotaUnits > limit)) return null;
            const requestCount = (previous?.requestCount || 0) + quotaUnits;
            providerUsage.set(key, { requestCount, nextAllowedAt });
            return { request_count: requestCount };
          }
          if (statement.includes("SELECT quotes_json, fetched_at FROM provider_quote_cache"))
            return providerCache.get(values[0]) || null;
          throw new Error(`Unexpected test database statement: ${statement}`);
        },
      };
      return query;
    },
  };
}

export async function createSecureApiContext(url, env = {}, headers = {}) {
  const origin = new URL(url).origin;
  const secureEnv = {
    ...env,
    API_SESSION_SIGNING_SECRET: SESSION_SECRET,
    API_USAGE_DB: createUsageDatabase(),
  };
  const sessionResponse = await issueSession(
    new Request(`${origin}/api/session`, { method: "POST", headers: { origin, "cf-connecting-ip": "192.0.2.1" } }),
    secureEnv,
  );
  if (!sessionResponse.ok) throw new Error(`Could not create test API session: ${sessionResponse.status}`);
  const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Test API session did not return a cookie");
  return {
    request: new Request(url, {
      headers: { cookie, origin, "sec-fetch-site": "same-origin", ...headers },
    }),
    env: secureEnv,
  };
}
