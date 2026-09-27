# Agent instructions

## Product goal

The achievable current-release goal is to let an individual in Iran build an investment plan, compare transparent simulation scenarios, and track an auditable personal portfolio in a browser, while fetching public market and reference data through same-origin APIs. Keep those personal records in the browser and make each result clear about whether it is observed, assumed, or unavailable. Synthora is decision support: it does not predict market prices, promise returns, or execute trades.

The current product boundary is a static browser app with same-origin market and reference-data APIs. Personal profile, saved plans, portfolio ledger, and model settings stay in the browser. Keep changes small enough to review and support that boundary. Cloud sync, accounts, and backups described in [the data persistence and sync plan](docs/data-persistence-and-sync-plan.md) are a proposal, not authorization or current behavior.

## Start with the current tree

- Read [README.md](README.md) and [the architecture and portability guide](docs/architecture-and-portability.md) before changing system boundaries.
- Use [the documentation index](docs/README.md) to distinguish current behavior, implementation guidance, proposals, and historical audit records.
- For model, market, ledger, API-security, or persistence work, read [the Synthora engineering skill](.agents/skills/synthora-engineering/SKILL.md) and the linked domain documents relevant to that change.
- Check the working tree before editing. Preserve existing modified and untracked files, including user-authored drafts. Do not reset, clean, or overwrite work outside the requested scope.
- Audit records in docs may describe a past branch or deployment. Confirm behavior in current source and tests before treating an audit note as current state.

## Code map

| Area                        | Main files                                             | Responsibility                                                                                                  |
| --------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Browser shell and workflows | index.html, app.js, styles.css                         | Views, browser state, rendering, forms, local storage, and same-origin API calls                                |
| Planning and analysis       | src/engine.js, src/analysis.js, src/analysis.worker.js | Pure financial calculations and browser Web Worker task routing                                                 |
| Portfolio and saved history | src/portfolio.js, src/history.js                       | Versioned transaction ledger, valuation, validation, and JSON import/export                                     |
| Market and UI modules       | src/market/, src/ui/                                   | Instrument catalog, observed-history preparation, quote helpers, navigation, state, and SVG charts              |
| Server routes               | functions/api/                                         | Cloudflare Pages Functions for session security, market data, history, inflation, FX, and provider coordination |
| D1 schema                   | functions/api/migrations/                              | Ordered SQL migrations for API sessions, quotas, provider cooldowns, and shared response-cache coordination     |
| Copy and checks             | content/*.json, tests/, package.json                   | Persian base copy, partial alternate locale catalogs, Node tests, formatting, lint, and syntax-check scripts    |

## Preserve these product and data rules

- Keep account values, portfolio ledger amounts, and model calculations in تومان. Display-currency conversion must not rewrite the saved ledger or change model units.
- Preserve versioned portfolio and history exports, legacy import handling, currency migrations, audit references, and confirmation steps around destructive replacement or history-changing edits.
- Profile values, salary, portfolio records, and transaction notes are local data. Do not send them to a market or reference-data endpoint. Do not include provider keys, cookies, or secrets in URLs, logs, or exports.
- A quote's observedAt and retrieval time describe different events. Keep source, unit, quote type, conversion dependencies, and quality status attached to market data. Unknown observation time stays unknown.
- Missing or conflicted prices remain unavailable for valuation. Do not silently substitute stale cache values, assumed returns, partial holdings, or synthetic history for observed data.
- Backtests use observed, continuous history only. Scenario assumptions belong to simulations and must remain labeled as assumptions. Material changes to model assumptions or interpretation require an explicit rationale and appropriate versioning.
- Keep src/engine.js, portfolio calculations, and shared normalization logic independent of the DOM, network providers, Cloudflare bindings, and storage APIs.
- Keep Persian as the default and base copy. The application loads partial English, Russian, and Chinese catalogs and falls back to Persian for untranslated entries; preserve this behavior and do not describe the alternate locales as complete localization until coverage is complete.
- Preserve accessible labels, keyboard interaction, narrow-screen layouts, and explicit empty, loading, error, and unavailable states.

## Hosting and portability

- Cloudflare Pages with Pages Functions is the first deployment target. Keep browser requests same-origin under /api/* and preserve the documented JSON contracts when changing route implementations.
- Cloudflare is an adapter, not the product domain. Keep context.env, D1 SQL, Cloudflare cf fetch options, and platform bindings at the server boundary. Do not put them in src/ calculation or portfolio modules.
- The current API security and provider-cache code uses D1 directly. A future non-Cloudflare host needs an explicit storage adapter that preserves durable sessions, atomic quotas, provider budgets, and shared provider-cache semantics. In-memory maps may coalesce work within a running process; they are not durable or shared storage.
- Use standard JavaScript Web APIs at shared boundaries where practical. A small single-server deployment may use a local database if its single-process limits are acceptable; a multi-instance deployment needs shared durable storage and equivalent atomic operations. Do not claim that Pages Functions or D1 run unchanged on another host.
- Keep provider credentials server-side, preserve same-origin and rate-limit checks, and fail closed when required security configuration is absent. Review provider use, attribution, caching, and redistribution terms before adding or persisting a source.
- Apply SQL migrations in numeric order and inspect the current schema before changing deployment instructions. Do not edit a migration that may already have been applied; add a new migration for schema changes.
- No CI/CD is requested. Do not add GitHub Actions, deploy workflows, or other pipeline automation.

## Change workflow

1. Trace the requested behavior through the current UI, domain module, API route, persistence path, and relevant tests before editing.
2. Keep the change focused. Avoid new runtime dependencies and platform abstractions until a concrete feature needs them.
3. Update the relevant documentation when behavior, API contracts, storage schemas, deployment bindings, or model assumptions change.
4. Prefer existing tests and deterministic provider fixtures. When verification is requested or needed for an implementation change, use the narrowest relevant checks and account for the fact that npm run check explicitly lists files.
5. Format only files in scope; do not run a repository-wide fixer over an existing working tree with unrelated changes.

Available project commands are defined in package.json: npm run format:check, npm run lint, npm test, and npm run check. Local Pages Functions development is documented in README.md.
