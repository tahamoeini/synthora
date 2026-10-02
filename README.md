<p align="center">
  <img src="assets/synthora-mark-on-light.svg" alt="Synthora logo" width="72" height="72" />
</p>

<h1 align="center">Synthora</h1>

<p align="center"><strong>Transparent investing decisions, built in your browser.</strong></p>

<p align="center">Synthora is a free, transparent, browser-first investment planning tool for conservative personal portfolios in Iran.</p>

<p align="center"><a href="https://synthora.negar.team/" target="_blank" rel="noopener noreferrer">Open the platform</a></p>

<p align="center">
  <a href="https://www.producthunt.com/products/synthora?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-synthora" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/badge/Product%20Hunt-View%20Synthora-DA552F?logo=producthunt&amp;logoColor=white" alt="View Synthora on Product Hunt" />
  </a>
</p>

It is a mathematical decision-support engine. It does not use an AI model to predict markets, make promises, or generate opaque recommendations.

For the maintained documentation map and the status of historical reviews and proposals, see the [documentation index](docs/README.md). Project attribution is in [CREATOR.md](CREATOR.md).

## Product behavior

- Persian is the default and base interface, using Vazirmatn. Settings also offer English, Russian, and Chinese. The locale affects translated text, page direction, and number formatting. Toman remains the default display currency in every language until the user selects another currency. Stored values and model calculations remain in toman.
- Visible static interface text, accessible labels, and reviewed runtime messages are translated for English, Russian, and Chinese; localization tests check the source strings.
- English source code, comments, README, and technical documentation.
- A catalog separates priceable instruments from eight decision sleeves: liquidity, fixed income, gold, FX, Iran equity, global equity, crypto, and commodities. Recommendations still use the established fixed-income, gold, currency, and silver categories until other sleeves have adequate data or explicit versioned assumptions.
- All Iranian currency inputs, market values, calculations, and exports use تومان. Display-currency conversion changes rendered values only. Legacy browser data and legacy exports are converted once on import; gold and silver quantities remain grams.
- Salary, profile inputs, recommendation snapshots, model assumptions, portfolio records, and interface preferences remain in browser storage by default. They are never sent to market or reference-data APIs. Optional manual sync sends only a client-encrypted allow-listed snapshot to `/api/sync` after the user creates a recovery key and explicitly uploads.
- Sync uses a user-held recovery key instead of an account. The browser encrypts profile, saved plans, portfolio ledger, model settings, and preferences; provider keys, session credentials, and market caches are excluded. Upload, restore, and delete are manual, revision-checked actions. The recovery key is not stored by the app and must be retained separately.
- The current versioned JSON transfer covers saved recommendation history and the personal portfolio ledger; it is not a full backup of profile inputs, model settings, interface preferences, caches, or credentials. Imported recommendation records merge by timestamp; an imported portfolio ledger replaces the current one only after confirmation.
- A personal portfolio tracker has one primary dated transaction-entry form and a separate advanced ledger for transfers, corrections, and cash flows. Manual prices are price history only; they never create transactions.
- Portfolio values are calculated from holdings at a selected date and the best available immutable market-history point. Missing history remains missing rather than being backfilled.
- Corrections and tracking restarts are versioned and audited. The interface confirms before a change can affect historical portfolio calculations.
- A monthly recommendation based on salary, an optional age input, goal, horizon, risk tolerance, income stability, and emergency-fund status.
- Separate net-worth, investable-capital, and liquid-asset totals, with emergency-reserve coverage shown in months of essential expenses.
- New-contribution rebalancing: the tool shows target/current drift and directs the next contribution toward underweight supported categories instead of telling the user what to sell. Other sleeves are identified as excluded from that calculation.
- Standalone simulations and backtests use only their own form inputs, public market data, and configured model assumptions. They do not read the user's portfolio or saved recommendation history, and never write to either.
- Historical backtesting uses complete, continuously observed price periods only. Missing asset history makes the run unavailable and is reported; assumptions are never substituted as observed history. Available results include total invested, final value, annualized outcome, inflation-adjusted return, maximum drawdown, volatility, Sortino, and best/worst starting periods.
- Monte Carlo output with P10, P50, and P90 nominal and inflation-adjusted outcomes. The baseline is retained; EWMA and three-month block-bootstrap methods are gated by walk-forward validation.
- Simulations execute in a browser Web Worker, keeping the interface responsive and cancelling stale calculations on navigation.
- Clear labels when a calculation uses observed historical data versus model assumptions.

## Architecture

The project intentionally has no frontend framework or runtime dependency.

```text
index.html                 Persian UI shell
styles.css                 Responsive presentation
app.js                     Browser state, rendering, and local storage
src/engine.js              Pure planning, simulation, backtest, and Monte Carlo engine
src/analysis.js            Analysis task router shared by the Worker and tests
src/analysis.worker.js     Background simulation and backtest worker
src/market/catalog.js      Instrument and sleeve registries
src/portfolio.js           Portfolio ledger, versioning, valuation, and performance metrics
src/history.js             Versioned recommendation and portfolio export/import validation
functions/api/market.js    Cloudflare Pages Function for selected-asset quotes and quality aggregation
functions/api/history.js   Cloudflare Pages Function for observed historical data
functions/api/fx.js        Cloudflare Pages Function for dated FX and metal references
functions/api/session.js   Signed, HttpOnly browser-session bootstrap
functions/api/sync.js     Optional encrypted personal-data snapshot endpoint
functions/api/inflation.js World Bank annual CPI reference
functions/api/migrations/ D1 sessions, quotas, cooldowns, and provider-response cache
src/sync.js                Browser-side recovery-key derivation and snapshot encryption
src/ui/preferences.js     Local locale, display-currency, and theme preferences
src/ui/localization.js    Locale catalog merge and Persian fallback
content/*.json            Persian base copy, en/ru/zh catalogs, and runtime-message translations
tests/engine.test.js      Core model and portfolio tests
tests/financial-model.test.js Seeded quantitative regression tests
tests/history-api.test.js History API and dated copper conversion tests
tests/market-expansion.test.js Market and provider expansion coverage
tests/localization.test.js Locale catalog merge and Persian fallback coverage
```

The calculation engine is isolated from the DOM and network layer. This keeps the model testable and makes it possible to replace the UI or data providers without changing the formulas.

## Portfolio accounting

The personal portfolio has three separate layers:

1. Market data is external, normalized, and treated as immutable input. A transaction can retain the market quote used when it was created, but the live market cache is never rewritten by portfolio edits.
2. The portfolio ledger stores opening balances, buys, sells, dividends, transfers, adjustments, deposits, and withdrawals. Each record has a date, creation timestamp, source, optional note, and audit reference.
3. The valuation engine replays the active portfolio version to any date, then calculates quantity multiplied by the market price available on that date. Manual تومان-denominated assets use unit price one because their entered quantity is already a value.

The primary form records an opening balance or purchase with its transaction time. Advanced corrections keep the original ledger and add a dated adjustment; a tracking restart closes the current version and creates a new baseline while preserving the previous version for audit.

The tracker reports current value, net invested amount, profit/loss, cash-flow-aware annualized return when it converges, inflation-adjusted value and return, allocation percentage, the tracking start date, and data-quality warnings. Portfolio charts begin at the first real ledger entry and show gaps when a historical price is unavailable.

## Market data design

The same-origin `/api/market`, `/api/history`, `/api/fx`, and `/api/inflation` routes use public sources for current quotes and dated reference data. The [market-data guide](docs/market-data-and-forecasting.md) is the maintained provider list and describes source units, conversions, observation times, response caches, and quality rules.

Each quote distinguishes a direct from a derived price, upstream observation time from retrieval time, and source provenance. Retrieval time is never presented as the market observation time. Public crypto quotes work without a provider key: Nobitex supplies direct Toman prices and the observed USDT/Toman rate; Binance BTCUSDT/ETHUSDT values are converted only with that observed tether rate, never as if USDT were USD. Coinbase and Kraken add USD-denominated BTC/ETH quotes, and Kraken adds a USDT/USD cross-check; public CoinMarketCap and Gold API provide additional keyless sources. USD-denominated values use the observed domestic dollar rate. Requests can select allow-listed assets, and conversion dependencies are fetched server-side. Providers run concurrently with bounded timeouts; domestic FX and metal fallbacks run only when needed, while TSETMC and TGJU are both queried for the Tehran index. The endpoint returns partial data when some sources fail.

A single source is shown with low confidence. Quotes are grouped by observation time before comparison; simultaneous values use median/MAD outlier screening and class-specific agreement thresholds. Conflicted prices are excluded from portfolio valuation. Public Nobitex daily OHLC history covers BTC, ETH, and USDT in direct Toman units. BTC and ETH add paged Coinbase and Binance history, recent Kraken history, and optional Gold API and CoinGecko history; source-specific date coverage and conversion requirements remain visible. The [market-data guide](docs/market-data-and-forecasting.md) lists historical alternatives and their limits. The response includes policy version, source counts, values, and response-time diagnostics; its initial interactive budget is 3.5 seconds.

The server's D1 provider-response cache coordinates selected upstream requests; it is not a canonical historical-observation store. Stale provider responses are marked and excluded from current quote aggregation. The browser may show a prior market value separately as a last-known value with its observation time and age. That browser fallback can be disabled in Settings; when disabled, an API failure leaves current market data unavailable.

Free public sources can be rate-limited, delayed, blocked, or change their response shape. The endpoint is therefore deliberately defensive and treats source coverage as part of the result.

## Model notes

### Allocation

The allocation engine uses transparent guardrails rather than price prediction. Short horizons, older age, unstable income, an incomplete emergency fund, and conservative risk tolerance increase the fixed-income weight. Longer horizons and higher risk tolerance allow a measured increase in hedge assets. The result is normalized to 100% and keeps silver as a small position.

### Future simulation

The simulation applies end-of-month contributions, explicit buy/sell costs, optional cadence- or threshold-based rebalancing, nominal return assumptions, and a separate inflation deflator. It shows nominal and today's-toman P10/P50/P90 values and labels data and assumptions. It is a planning scenario, not a forecast. The detailed calculation flow and its limits are documented in [the financial-model audit](docs/financial-model-audit.md).

### Historical backtest

The engine converts available provider history to monthly returns and tests every possible starting period for the selected horizon. Each reported period must have continuous observed data for every selected asset. If an asset history is absent or a monthly observation is missing, that period is excluded; if no complete period remains, the run is unavailable and identifies the missing assets. Model assumptions are not used to fill historical gaps.

The reported CAGR is a cash-flow-aware annualized outcome only when monthly IRR converges. Maximum drawdown uses the unitized return path, so contributions do not hide portfolio losses. Real drawdown uses the inflation-deflated unitized path; purchasing-power drawdown is separately measured against inflation-adjusted contributions.

### Monte Carlo

The simulation uses arithmetic monthly mean returns, sample volatility, and paired historical covariance when coverage is sufficient. Sparse correlations are blended toward disclosed asset-pair priors; missing or assumption-filled returns never enter historical covariance. It compares correlated lognormal Gaussian paths with three-month moving-block bootstrap paths when joint history is sufficient. P10/P50/P90 are simulated outcome percentiles, not confidence guarantees. Nominal and real values are shown separately, with real values deflated once by `(1 + annual inflation)^years`.

EWMA uses a 12-month half-life; moving-block bootstrap samples contiguous three-month blocks. The UI compares Gaussian and bootstrap results when eligible joint history is available. Fixed-income yield is modeled separately with mean-reverting (default), constant-current-yield, or configured-yield behavior; effective annual rates compound monthly as `(1 + y)^(1/12) - 1`. Sortino defaults to 0% MAR and is unavailable when observations or downside data are insufficient. Sharpe only appears when the fixed-income benchmark is explicitly selected. Goal projections and required-contribution search use the same assumptions and remain scenario outputs.

The default assumptions are intentionally visible in `src/engine.js` and are not presented as expected market returns. They exist so the tool remains usable when public historical data is incomplete.

## Local development

Serve the app over HTTP; opening `index.html` with `file://` does not support its module and copy-catalog requests. Planning, assumption-based simulations, manual quotes, and browser-stored records work without a provider key or database. Public market and reference sources work through same-origin Pages Functions in bounded read-only mode without D1; D1 adds durable rate limits, shared provider caching, and access to platform-paid provider keys. A user's own CoinGecko or CoinMarketCap key can add authenticated crypto quotes without D1. Sync requires API security configuration and a separate `USER_DATA_DB`. The [Cloudflare setup guide](docs/cloudflare-market-api.md#local-pages-preview) describes these options.

```bash
npm install
npm run format:check
npm run lint
npm run check
npx wrangler pages dev . --compatibility-date=2026-09-18
```

This starts the public-source fallback without D1. To test durable quotas and platform provider keys, bind a local `API_USAGE_DB` and set a local `API_SESSION_SIGNING_SECRET` as described in the Cloudflare guide. To test sync, bind a separate `USER_DATA_DB` and apply migration 0003 to that database only.

Open the local URL printed by Wrangler.

## Deploy with Cloudflare Pages and GitHub

Cloudflare Pages Functions run server-side code at the edge, so the static page and `/api/*` endpoints can be deployed from one repository. Follow the [market API setup guide](docs/cloudflare-market-api.md) to configure D1 quotas, provider secrets, and optional encrypted sync. Public no-platform-key data can work without D1, but use `API_USAGE_DB` for durable limits and platform provider credentials. See the official [Cloudflare Pages Functions documentation](https://developers.cloudflare.com/pages/functions/).

1. Open **Workers & Pages** in Cloudflare.
2. Choose **Create application** and select **Pages**.
3. Connect `tahamoeini/synthora`.
4. Set the production branch to `main`.
5. Use these build settings:
   - Framework preset: `None`
   - Root directory: empty
   - Build command: `npm run format:check && npm run lint && npm test && npm run check`
   - Build output directory: `.`
6. Deploy.
7. Test the function:

```text
https://YOUR-PAGES-DOMAIN.pages.dev/api/market
```

The response should contain `updatedAt`, `assets`, `funds`, `history`, `catalog`, `diagnostics`, and `sources`. With D1 configured, first visit obtains a signed `/api/session` cookie and uses durable quotas. Without D1, the endpoint serves only public sources through same-origin GETs with a best-effort per-edge-instance limit; platform-paid keys are not spent.

Do not put `wrangler pages deploy` inside the Pages build command. `npm run fix` rewrites formatting across the repository and runs automatic lint fixes; use it only when you intend a repository-wide rewrite.

## Verification checklist

```bash
npm test
npm run check
node -e "JSON.parse(require('fs').readFileSync('content/fa.json', 'utf8')); console.log('content/fa.json is valid JSON')"
```

Before publishing, also verify:

- `/api/market` returns no fabricated values when one or more providers fail.
- Provider count and median source values are visible in the JSON response.
- Salary and local history are not present in any network request.
- No-D1 public-source routes work only as same-origin GET requests, return no personal data, and never spend a configured platform-paid provider key.
- Sync uploads contain client-encrypted allow-listed records only; verify restore from another browser profile with the recovery key.
- Exported history can be imported into an empty browser and duplicate timestamps are not duplicated.
- The UI remains usable on a narrow mobile viewport.
- A partial historical response is excluded from backtest results and model-based future estimates are labelled as such.

## Limitations

This project is educational planning software, not financial advice, a broker statement, a fund NAV, or a guarantee of return. It does not model taxes, product fees, bid-ask spreads, liquidity constraints, purchase minimums, settlement delays, or every instrument available in Iran. Review those factors before acting.
