# Synthora documentation index

This index separates current product guidance from future proposals and historical review records. For implemented behavior, current source and tests take precedence over an older audit note.

## Current product and engineering guidance

| Document                                                                      | Status                        | Use it for                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Project README](../README.md)                                                | Current overview              | Product behavior, local development, deployment, limitations, and the main code map.                                                                                                                |
| [Architecture and portability](architecture-and-portability.md)               | Current boundary guide        | Browser/server responsibilities, D1 usage, API contracts, and hosting portability.                                                                                                                  |
| [Market data and forecasting boundary](market-data-and-forecasting.md)        | Current data guide            | Providers, units, conversion dependencies, observation times, cache behavior, quality states, and the no-price-prediction boundary.                                                                 |
| [Portfolio simulation and recommendation model](financial-model-audit.md)     | Implementation explainer      | Calculation paths, assumptions, metrics, and known limits. Its final comparison table is historical evidence, not a current result.                                                                 |
| [UX and financial-trust fixes](ux-financial-trust-2026-10.md)                 | Current implementation record | Verified audit findings, production smoke, localized confirmation changes, check results, and remaining viewport, device, screen-reader, and file-restore limits for the October 2026 QA follow-up. |
| [Cloudflare market API setup](cloudflare-market-api.md)                       | Current operations guide      | D1 bindings and migrations, secrets, route quotas, provider budgets, local Pages preview, and deployment checks. Recheck vendor limits before changing deployment settings.                         |
| [Synthora engineering skill](../.agents/skills/synthora-engineering/SKILL.md) | Contributor guardrails        | Required invariants for model, market-data, API-security, persistence, and hosting changes.                                                                                                         |
| [Repository instructions](../AGENTS.md)                                       | Contributor guardrails        | Product boundary, code map, data rules, and safe change workflow.                                                                                                                                   |

## Proposal

| Document                                                                     | Status                                     | Use it for                                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| [Data persistence, sync, and backup plan](data-persistence-and-sync-plan.md) | Mixed: current slice plus future proposals | The implemented opt-in encrypted snapshot sync and its limits, followed by research and possible future phases. |

## Historical review records

These documents preserve findings and evidence from the `feat/dashboard-trust-hardening` review. Their checkboxes, test counts, preview URLs, and manual QA results describe those review sessions only; they are not current release or deployment status.

| Document                                              | Historical scope                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [Dashboard hardening QA](dashboard-hardening-qa.md)   | Local checks, planned preview scenarios, and the browser-control limitation recorded in that review. |
| [Fintech dashboard audit](fintech-dashboard-audit.md) | Product, data-flow, accessibility, and dashboard decisions recorded during the hardening work.       |
| [Final QA checklist](qa-checklist.md)                 | Later preview and regression evidence recorded for that review.                                      |

The October 8, 2026 UX follow-up records the pre-fix production reproduction, post-merge production smoke, and the follow-up fixes proposed on this branch. Localized confirmations and focused regression coverage are implemented; Plan header spacing is adjusted, but a compatible Wrangler runtime is not available to visually verify the viewport result. The exact deployed asset identity, mobile/responsive and screen-reader checks, and interactive file restore remain unverified. For a later release, verify source and automated coverage in the current checkout, then repeat the relevant browser and deployment checks. Do not infer present status from older snapshots.

## Attribution

See [CREATOR.md](../CREATOR.md) for project creator attribution.

## Language and source freshness

Technical documentation is maintained in English. The app defaults to Persian and loads `content/fa.json` as its base copy. English, Russian, and Chinese visible static UI and reviewed runtime messages are covered by localization checks; Persian remains the fallback for keys not yet used by the visible interface.

Cloudflare, provider, browser-storage, and third-party service limits can change. Documents that include numeric limits record a check date and link to the primary vendor documentation; confirm those sources again before relying on the figures for a launch or cost decision.
