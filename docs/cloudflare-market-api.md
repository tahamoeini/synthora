# Cloudflare market API setup

The market, history, inflation, and FX endpoints require a Cloudflare Pages Functions deployment. API requests are session-limited; the browser portfolio, recommendation history, and user API key are not stored in D1. D1 also holds shared provider cooldown state and selected public provider-response cache entries; those caches are not user records or canonical historical price storage.

## 1. Create and bind the D1 database

1. In Cloudflare, open **Workers & Pages**, select the Pages project, then open **Settings → Functions → D1 database bindings**.
2. Create a D1 database for this project, then add a binding with the exact variable name `API_USAGE_DB`.
3. Apply active `API_USAGE_DB` migrations 0001, 0002, and 0004 in numeric order, after checking which migrations are already present. Migration 0001 creates session and route-quota tables, 0002 adds provider cooldown state and the shared provider-response cache, and 0004 adds the session-bootstrap limit. Do not run the migration directory as a batch.

Migration 0003 (`0003_private_sync.sql`) is retained as a historical artifact because its deployment state has not been verified. It targets a dedicated `USER_DATA_DB` only; never apply it to `API_USAGE_DB`. Do not remove or alter that migration until production and preview bindings and any associated data have been verified.

4. Add the binding for production and preview environments. Deploy again after changing bindings.

The migrations store hashed API-session identifiers, request counters, provider coordination, and provider-response cache entries. D1 does not contain personal portfolio data or raw provider API keys.

## 2. Add encrypted secrets

In the Pages project, open **Settings → Variables and Secrets** and add these as **Secrets**, for each environment that should use the API:

| Secret                       | Required | Purpose                                                                                                                                      |
| ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_SESSION_SIGNING_SECRET` | Yes      | HMAC signing key for the HttpOnly session cookie. Use a password manager or secure random generator to create at least 32 random characters. |
| `COINGECKO_DEMO_API_KEY`     | Optional | Platform CoinGecko Demo key. A valid user key takes precedence when the request includes one.                                                |
| `COINMARKETCAP_API_KEY`      | Optional | Platform CoinMarketCap key used for an additional crypto quote source.                                                                       |

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
- `/api/history`: 24 requests per hour per signed session.
- `/api/inflation`: 6 requests per day per signed session.
- `/api/fx`: 60 requests per hour per signed session.
- `POST /api/session`: 60 new sessions per hour per Cloudflare edge address, enforced atomically in D1. A valid existing session is reused without spending this allowance. Requests without `CF-Connecting-IP` fail closed.
- Platform CoinMarketCap key: 15,000 requests per month maximum, enforced by this application.
- Platform CoinGecko key: 8,000 requests per month by default, capped at 9,500 by the application.

The browser also reuses market responses for 90 seconds and history responses for one hour. Clearing cookies creates a new browser session, so per-session quotas are not an identity system; the shared monthly provider ceiling protects the platform key from aggregate overuse.

## 4. User-owned CoinGecko key

Users can add a [CoinGecko Demo key](https://support.coingecko.com/hc/en-us/articles/21880397454233-User-Guide-How-to-sign-up-for-CoinGecko-Demo-API-and-generate-an-API-key) under **Settings → Market sources**. The app sends it to the Pages Function in the `X-CoinGecko-API-Key` header; the function forwards it to CoinGecko in its required header and never places it in the URL or API response. User keys are not written to D1 or included in exported portfolio data.

The user chooses whether the key stays only in the open page, in session storage until the browser session ends, or in local storage on that device. The default is session storage. A key saved on the device is readable by JavaScript running on that same origin, so users should only choose that option on a device and browser profile they control.

## Local Pages preview

This repository does not commit account-specific Wrangler configuration. For a local preview with working API routes:

1. Create a local `.dev.vars` file containing an `API_SESSION_SIGNING_SECRET` with at least 32 random characters. Use a local-only value; never copy the production secret. Keep `.dev.vars` out of source control.
2. Bind a local D1 database as `API_USAGE_DB`, inspect its existing schema, then apply `0001_api_quotas.sql`, `0002_provider_coordination.sql`, and `0004_api_session_bootstrap_limit.sql` individually in numeric order if needed. Use `npx wrangler d1 execute API_USAGE_DB --local --file=functions/api/migrations/<migration-file>` for each active migration. Do not use the directory-wide migration command while migration 0003 remains in the directory.
3. Start the Pages preview with `npx wrangler pages dev . --compatibility-date=2026-09-18 --d1 API_USAGE_DB=<local-database-id>`. Use the same local database ID mapped in the Wrangler config; Wrangler uses local persistence by default. Do not add `--remote` or use a local preview command to apply migrations to production.

If the D1 binding, local schema, or signing secret is absent, security-protected API routes return `api-security-not-configured` or a database error. The static interface can still be inspected, but market and reference-data requests will not work. See Cloudflare's [Pages binding guide](https://developers.cloudflare.com/pages/functions/bindings/), [local secrets guide](https://developers.cloudflare.com/workers/local-development/environment-variables/), and [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/) for current CLI details.

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
- Never log request headers containing `X-CoinGecko-API-Key`; the Pages Function code intentionally omits the key from diagnostics and responses.
- The application enforces same-origin requests, a signed session cookie, route counters in D1, and an atomic monthly counter before spending the platform provider key.
- These controls reduce accidental refresh consumption and key exposure. They do not replace Cloudflare account MFA, least-privilege access, secret rotation, or provider-side usage alerts.

References: [Pages Functions bindings](https://developers.cloudflare.com/pages/functions/bindings/), [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [CoinGecko API plans](https://www.coingecko.com/en/api/pricing), and [World Bank API guidance](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392).
