# Cloudflare market API setup

The static browser app remains usable for planning, scenarios, manual portfolio tracking, and local import/export without API keys, Cloudflare bindings, or a database. With Pages Functions deployed, public market/reference routes also work without D1 through same-origin GETs and a best-effort in-memory edge-instance limit. That mode never spends platform-paid provider keys. Binding `API_USAGE_DB` and setting `API_SESSION_SIGNING_SECRET` enables signed sessions, durable per-session quotas, shared provider coordination, and platform keys. The browser portfolio, recommendation history, and user API key are not stored in `API_USAGE_DB`; it holds usage, cooldown, and selected public provider-response cache state. Manual encrypted snapshot sync is a separate, optional feature described below.

## 1. Create and bind the D1 database

1. In Cloudflare, open **Workers & Pages**, select the Pages project, then open **Settings → Functions → D1 database bindings**.
2. Create a D1 database for this project, then add a binding with the exact variable name `API_USAGE_DB`.
3. If you want durable API security and platform provider keys, apply active `API_USAGE_DB` migrations 0001, 0002, 0004, and 0005 in numeric order, after checking which migrations are already present. Migration 0001 creates session and route-quota tables, 0002 adds provider cooldown state and the shared provider-response cache, 0004 adds the session-bootstrap limit, and 0005 adds hourly provider usage for Gold API history. Do not run the migration directory as a batch. Public no-platform-key routes work without this database in the bounded fallback mode above.

Migration 0003 (`0003_private_sync.sql`) creates the optional sync table. It targets a dedicated `USER_DATA_DB` only; never apply it to `API_USAGE_DB`. Before enabling sync, inspect the separate production or preview user-data database and verify its schema. Apply migration 0003 there only if the table is absent and its current data/schema have been checked. Do not alter the migration or overwrite existing data.

4. Add the binding for production and preview environments. Deploy again after changing bindings.

The migrations store hashed API-session identifiers, request counters, provider coordination, and provider-response cache entries. D1 does not contain personal portfolio data or raw provider API keys.

## 2. Add encrypted secrets

In the Pages project, open **Settings → Variables and Secrets** and add these as **Secrets**, for each environment that should use the API:

| Secret                       | Required                 | Purpose                                                                                                                                                                                            |
| ---------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_SESSION_SIGNING_SECRET` | For D1 security and sync | HMAC signing key for the HttpOnly session cookie. Use a password manager or secure random generator to create at least 32 random characters. Public-source fallback does not use a session cookie. |
| `COINGECKO_DEMO_API_KEY`     | Optional                 | Platform CoinGecko Demo key. A valid user key takes precedence when the request includes one.                                                                                                      |
| `COINMARKETCAP_API_KEY`      | Optional                 | Platform CoinMarketCap key used for an additional crypto quote source.                                                                                                                             |
| `GOLD_API_KEY`               | Optional                 | Server-side Gold API key for daily metal/BTC/ETH history. Free history access is currently limited to 10 history/OHLC requests per hour; Synthora enforces an application-wide hourly ceiling of nine using migration 0005. |

Do not place these values in `app.js`, HTML, source control, build variables exposed to the browser, a URL, or a support screenshot. Pages Functions read the secrets from the server-side environment. Redeploy after adding or rotating a secret.

Optional, under **Variables** (not Secrets):

| Variable                           | Default | Allowed behavior                                                                                                                                                                            |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COINGECKO_PLATFORM_MONTHLY_LIMIT` | `8000`  | Application-level monthly request ceiling for the platform key. Values are clamped to 1–9,500 to leave headroom under CoinGecko's published 10,000-call Demo plan cap (checked 2026-09-26). |
| `YAHOO_METALS_LICENSE_CONFIRMED`   | unset   | Set to the exact string `true` only after confirming that the intended Yahoo metals data use is permitted.                                                                                  |

The platform key is used only when no valid user key is supplied. Once its D1 counter reaches the configured ceiling, requests stop using it until the next month.

## 3. Per-session request limits

The signed cookie is `HttpOnly`, `SameSite=Lax`, scoped to `/api`, and marked `Secure` on HTTPS. Its random identifier is HMAC-signed and only its SHA-256 digest is stored in D1. Refreshing a page keeps the browser session and does not reset its counters.

Current server-side limits are:

- `/api/market`: 120 requests per hour per signed session.
- `/api/history`: 24 requests per hour per signed session. Gold API history also has a shared nine-request-per-hour ceiling.
- `/api/inflation`: 6 requests per day per signed session.
- `/api/fx`: 60 requests per hour per signed session.
- `/api/sync`: 40 requests per hour per signed session, in addition to requiring a valid sync recovery token and `USER_DATA_DB` binding.
- Without a usable session secret or `API_USAGE_DB`, each public GET data route uses a best-effort 60 requests per hour per source IP in the current edge isolate. This fallback is not durable or shared across isolates and does not spend platform-paid provider keys.
- `POST /api/session`: 60 new sessions per hour per Cloudflare edge address, enforced atomically in D1. A valid existing session is reused without spending this allowance. Requests without `CF-Connecting-IP` fail closed.
- Platform CoinMarketCap key: 15,000 requests per month maximum, enforced by this application.
- Platform CoinGecko key: 8,000 requests per month by default, capped at 9,500 by the application.

The browser also reuses market responses for 90 seconds and history responses for one hour. Clearing cookies creates a new browser session, so per-session quotas are not an identity system; shared monthly and hourly provider ceilings protect platform keys from aggregate overuse. Gold API history is capped at nine requests per aligned hour and spaced by at least 401 seconds to remain within its published 10-request rolling-hour free allowance.

## 4. User-owned crypto provider keys

Users can add a [CoinGecko Demo key](https://support.coingecko.com/hc/en-us/articles/21880397454233-User-Guide-How-to-sign-up-for-CoinGecko-Demo-API-and-generate-an-API-key) and a CoinMarketCap key under **Settings → Market sources**. The browser sends keys to the Pages Function in `X-CoinGecko-API-Key` and `X-CoinMarketCap-API-Key` headers. The function forwards each key only to its matching provider, never places either in a request URL or API response, and does not write user keys to D1 or exported portfolio data. Without a user or server key, the public CoinMarketCap endpoint is still requested; authenticated user keys add provider requests.

The user chooses whether provider keys stay only in the open page, in session storage until the browser session ends, or in local storage on that device. The default is session storage. A key saved on the device is readable by JavaScript running on that same origin, so users should only choose that option on a device and browser profile they control. Provider keys are excluded from encrypted sync snapshots. With no D1, user-owned keys can be used directly for their requests; configured platform keys are never used without durable provider-budget storage.

## Optional encrypted personal-data sync

Sync is disabled until the user creates or enters a recovery key in Settings and explicitly uploads a snapshot. The recovery key derives separate encryption and authorization keys in the browser; it is not sent as-is, saved by the app, placed in a URL, or included in the snapshot. The user must retain the recovery key to reconnect or decrypt the snapshot on another device. The server stores an encrypted snapshot and revision/deletion metadata in `USER_DATA_DB`; it cannot decrypt snapshot contents. This is a manual snapshot workflow with optimistic revision checks, not an account, automatic/background sync, merge engine, or scheduled backup.

The snapshot allow-list includes profile, saved recommendation history, portfolio ledger, model settings, and user preferences. Provider keys, browser/API session credentials, caches, and derived market data are excluded. Local data is saved first and remains available if sync is not configured. The app must report a sync configuration or quota problem without blocking local planning and portfolio workflows.

To enable the feature in an environment:

1. Create a separate D1 database and bind it as `USER_DATA_DB` for the same Pages environment. Do not point it at `API_USAGE_DB`.
2. Inspect its schema and existing data, then apply `0003_private_sync.sql` only to this separate database if `sync_blobs` is absent.
3. Keep `API_USAGE_DB` and `API_SESSION_SIGNING_SECRET` configured as described above; the sync route uses the signed app session quota as an additional abuse control.
4. Verify `GET`, `PUT`, and `DELETE /api/sync` using a test recovery key and confirm ciphertext only is stored. Test restore on a fresh browser profile before inviting users to rely on sync.

Without `USER_DATA_DB`, sync reports that storage is unavailable, while local use continues. Do not claim production/preview sync is enabled until the bindings and migration have been checked in that environment.

## Local Pages preview

This repository does not commit account-specific Wrangler configuration. For a no-D1 preview, start Wrangler without a database binding; public market/reference GET routes use the same-origin fallback. For durable quotas and platform keys, use the configured preview steps below:

1. Create a local `.dev.vars` file containing an `API_SESSION_SIGNING_SECRET` with at least 32 random characters. Use a local-only value; never copy the production secret. Keep `.dev.vars` out of source control.
2. Bind a local D1 database as `API_USAGE_DB`, inspect its existing schema, then apply `0001_api_quotas.sql`, `0002_provider_coordination.sql`, `0004_api_session_bootstrap_limit.sql`, and `0005_provider_hourly_usage.sql` individually in numeric order if needed. Use `npx wrangler d1 execute API_USAGE_DB --local --file=functions/api/migrations/<migration-file>` for each active migration. Do not use the directory-wide migration command while migration 0003 remains in the directory.
3. Start the Pages preview with `npx wrangler pages dev . --compatibility-date=2026-09-18 --d1 API_USAGE_DB=<local-database-id>`. Use the same local database ID mapped in the Wrangler config; Wrangler uses local persistence by default. Do not add `--remote` or use a local preview command to apply migrations to production.

With Pages Functions deployed but `API_USAGE_DB` or the signing secret absent, same-origin public GET routes remain available through the bounded fallback; signed sessions, durable quotas, shared D1 cache, platform-paid keys, and sync are unavailable. The static interface and local workflows remain usable even if the Pages Functions themselves are unavailable. Sync additionally requires the separate `USER_DATA_DB` and migration 0003. See Cloudflare's [Pages binding guide](https://developers.cloudflare.com/pages/functions/bindings/), [local secrets guide](https://developers.cloudflare.com/workers/local-development/environment-variables/), and [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/) for current CLI details.

## 5. Verify configuration

After deployment, load the app and check these same-origin endpoints:

- `POST /api/session` should return `{ "ok": true }` and set the session cookie.
- `GET /api/market` should return market data or a partial-data response.
- `GET /api/inflation` should return a World Bank annual CPI observation and its year.
- `GET /api/history?assets=gold,dollar&range=1y` should return observed points and coverage details.
- `GET /api/fx?quotes=USD,RUB,CNY&include=metals` should return source quote records and daily precious-metal references when available. For RUB/CNY rates in Toman, also pass usdToman with the current Toman-per-USD quote from /api/market; otherwise those converted rates stay unavailable.

A `503` response with `api-security-not-configured` means the D1 binding or signing secret is missing or invalid. `429` means a session or provider quota was reached. Do not disable the checks to work around either response.

## Operational security

- Keep Pages deployments on HTTPS and rotate a secret immediately if it is exposed.
- Never log request headers containing `X-CoinGecko-API-Key` or `X-CoinMarketCap-API-Key`; the Pages Function code intentionally omits user keys from diagnostics and responses.
- The application enforces same-origin requests, a signed session cookie, route counters in D1, and an atomic monthly counter before spending the platform provider key.
- These controls reduce accidental refresh consumption and key exposure. They do not replace Cloudflare account MFA, least-privilege access, secret rotation, or provider-side usage alerts.

References: [Pages Functions bindings](https://developers.cloudflare.com/pages/functions/bindings/), [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [CoinGecko API plans](https://www.coingecko.com/en/api/pricing), [Gold API pricing](https://gold-api.com/pricing), and [World Bank API guidance](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392).
