# Synthora — QA and design review

**Review date:** 2026-10-08
**Checkout:** `9034368` base, with requested fixes on `codex/ux-audit-fixes`
**Live surface:** `https://synthora.negar.team/`
**Review type:** production journey smoke, source review, automated checks, and visual/accessibility-tree inspection.
**Source visual truth:** current live Synthora UI at the URL above; no separate Figma or mock was supplied.
**Screenshots:** production baseline captured at approximately 1265 × 722 px; PR preview visually rechecked at approximately 1264 × 720 px. The browser surface does not provide a supported save-to-workspace operation, so neither capture has a local file path.

## Verdict

The PR #12 navigation and hydration fixes are present in the live experience and the main route journeys checked here work. Both findings from the production recheck are fixed in PR #13: consequential confirmations use explicit locale keys, and the Plan preview action is fully visible in the PR's Cloudflare Pages preview at approximately 1264 × 720. The preview corresponds to commit `e427940`. Automated checks pass. This PR is still open, so these changes are not yet merged or live on the production domain.

## Findings

### [P1] Confirmation dialogs bypass the active locale — fixed in this branch

- **Location:** [app.js](app.js:4665) and [app.js](app.js:5683).
- **Evidence:** Backdated portfolio entry and deletion of all local records pass Persian literals directly to `window.confirm()`. English, Russian, and Chinese catalogs already contain translations of these messages, but native browser dialogs do not pass through `translateVisibleCopy()`.
- **Impact:** A user working in another language may not understand that a transaction changes historical calculations or that deleting local records is irreversible. The reset confirmation guards destructive loss, so its meaning must be clear.
- **Fix:** Both flows now call `window.confirm(text(...))` with dedicated `portfolio.backdateConfirm` and `settings.resetAllConfirm` keys in Persian, English, Russian, and Chinese. The existing native dialogs preserve their affirmative/negative result semantics, so cancel remains the safe path. Localization regression coverage checks all four catalogs and both call sites.

### [P2] Plan preview action is partly below the initial viewport — fixed and visually verified in PR preview

- **Location:** Plan page at `/#plan`, top of `#plan-form`, primary preview button.
- **Original evidence:** The production Plan screenshot at approximately 1265 × 722 px showed only the upper portion of the dark “پیش‌نمایش پیشنهاد” button at the bottom edge.
- **Impact:** The page advertises a first-step form but leaves its main action visually cut off. Users may miss it or need an avoidable scroll before they understand how to continue.
- **Fix and verification:** Removed the extra 8 px bottom margin from the Plan page heading, leaving typography and assumption details intact. Opened the deployed PR preview at `/#plan`; at the available 1264 × 720 viewport, the complete preview button and its bottom edge are visible. The screenshot also confirms the page is Persian and hydrated. Exact 1280 × 720 and responsive viewport emulation were unavailable in this browser surface.

## Production journey evidence

Screens were captured and visually inspected in the Codex in-app browser during this review. The available capture surface did not expose a supported save-to-workspace operation, so there is no local screenshot file path; the captures remain in this review's browser-tool output.

| Journey                          | Result                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| Direct `/#portfolio`             | Opens Portfolio after hydration.                                                    |
| Legacy `/?view=portfolio`        | Canonicalizes to `/#portfolio` and opens Portfolio.                                 |
| Dashboard first-use holdings CTA | Opens Portfolio, expands the initial-entry section, and focuses the asset selector. |
| Portfolio → Plan → Back          | URL changes to `#plan`; Back restores `#portfolio` and Portfolio content.           |
| Market and Settings navigation   | Both views render with the expected title and content.                              |
| Hydration                        | The loading shell disappears; no four-language loading strip remains over the page. |

The production browser state used no entered personal records, recovery key, import, destructive action, or sync operation. Deployed asset hashes were not independently checked in this review; behavioral smoke confirms the visible fixes but does not prove the exact deployed commit.

## Design surface review

- **Typography:** Persian copy uses a clear hierarchy and the configured Vazirmatn/system fallbacks. The Plan headline and explanatory body remain readable; its action clipping is a layout issue, not a type-size fix.
- **Spacing and layout:** Sidebar and content are coherent on the captured desktop viewport. The Plan hero gives the form priority, and the complete preview action now fits in the PR preview viewport. Portfolio and Market use a consistent card structure.
- **Color and tokens:** Current captures show consistent light surfaces, teal action emphasis, and semantic warning treatments. This run did not repeat numeric contrast sampling; prior contrast evidence remains documented in the UX audit.
- **Assets:** The existing Synthora mark renders sharply and consistently. No replacement artwork is indicated.
- **Copy and content:** Product limits and market-data quality are explicit. The two reviewed native confirmations now use locale catalog keys. The market page presents source counts, observation/retrieval timing, stale/outlier states, and unavailable values.
- **Accessibility:** The accessibility tree exposes named controls and useful form structure. A screen reader, real mobile keyboard/rotation, reduced-motion behavior, and spoken dialog/chart behavior were unavailable in this run. Do not claim full accessibility conformance from the captured pages.

## Verification

- `npm run lint`: passed after changes.
- `npm run format:check`: passed after changes.
- `npm run check`: passed after changes.
- `git diff --check`: passed after changes.
- Focused localization suite: 10 tests passed via `node --experimental-test-isolation=none --test tests/localization.test.js`.
- Full suite: `npm test` passed outside the restricted sandbox: 205 tests passed, 0 failed. (`node --experimental-test-isolation=none --test` also passes in-process.)
- Local Pages preview was attempted, but Wrangler 4.107.0/workerd supports compatibility dates only through 2026-07-08; this repository build requires 2026-10-08. The Cloudflare Pages PR preview supplied by the PR deployment bot was used instead. Its commit identity was `e427940`, and the Plan CTA is fully visible at approximately 1264 × 720.
- The PR #12 implementation record reports a local Pages preview journey across all seven routes and synthetic ledger, plan, locale, market, and settings cases. This review independently smoke-tested the live routes listed above, not every mutation flow.

## Remaining verification gaps

- Repeat all seven route/deep-link cases, Back/Forward, locale changes, and refresh on production with the deployed build identity recorded.
- Verify the complete Plan preview action at exact 1280 × 720 and at responsive breakpoints when viewport emulation is available; it is already visually verified at approximately 1264 × 720 in the PR preview.
- Exercise import/restore with a synthetic backup in isolated browser storage. The previous local QA record says the file picker could not be driven in its browser surface; automated tests cover validation but not that interactive selection step.
- Run a screen-reader pass for navigation, destructive confirmations, drawers, charts, and validation messages.
- After merge and deployment, verify the production build identity and repeat key routes and the Plan CTA.

## Unified implementation plan and current status

1. **Localized confirmations — implemented.** Explicit catalog keys exist in all locales, and localization regression coverage is passing.
2. **Plan CTA spacing — visually verified.** The entire button is visible in the PR preview at approximately 1264 × 720; exact 1280 × 720 and responsive breakpoint checks remain.
3. **Automated checks — passed.** Formatting, lint, syntax checks, and the standard worker-isolated test run all pass; 205 tests passed, 0 failed.
4. **Browser QA — partial.** The Plan preview and main route journeys have been checked, but import/restore, responsive breakpoints, and assistive technology need more coverage. Do not use personal records or sync for QA.
5. **Merge and production deployment — pending.** PR #13 remains open. After it is merged and the hosting platform deploys it, record the deployed build identity and recheck key journeys. No production deployment or CI/CD change is part of this work.

**Current result:** The implementation and automated checks are complete, and the Plan CTA is visually verified in the PR preview. The repository change is awaiting PR review/merge and production deployment. Responsive/mobile, screen-reader, and interactive import/restore checks remain follow-up QA items.
