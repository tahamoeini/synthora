# Synthora — QA and design review

**Review date:** 2026-10-08  
**Checkout:** `9034368` base, with requested fixes on `codex/ux-audit-fixes`
**Live surface:** `https://synthora.negar.team/`  
**Review type:** production journey smoke, source review, automated checks, and visual/accessibility-tree inspection.
**Source visual truth:** current live Synthora UI at the URL above; no separate Figma or mock was supplied.  
**Implementation screenshot:** captured and inspected in the current Codex browser output at approximately 1265 × 722 px; no local file path is available because this browser surface exposes no save-to-workspace operation.

## Verdict

The PR #12 navigation and hydration fixes are present in the live experience and the main route journeys checked here work. The two implementation findings from the production recheck are addressed in this branch: both consequential confirmations now use explicit locale keys, and the Plan header spacing is reduced to bring the preview action higher. The source and catalog checks pass; Wrangler visual confirmation remains unavailable because the installed workerd runtime does not support the repository's required compatibility date.

## Findings

### [P1] Confirmation dialogs bypass the active locale — fixed in this branch

- **Location:** [app.js](app.js:4665) and [app.js](app.js:5683).
- **Evidence:** Backdated portfolio entry and deletion of all local records pass Persian literals directly to `window.confirm()`. English, Russian, and Chinese catalogs already contain translations of these messages, but native browser dialogs do not pass through `translateVisibleCopy()`.
- **Impact:** A user working in another language may not understand that a transaction changes historical calculations or that deleting local records is irreversible. The reset confirmation guards destructive loss, so its meaning must be clear.
- **Fix:** Both flows now call `window.confirm(text(...))` with dedicated `portfolio.backdateConfirm` and `settings.resetAllConfirm` keys in Persian, English, Russian, and Chinese. The existing native dialogs preserve their affirmative/negative result semantics, so cancel remains the safe path. Localization regression coverage checks all four catalogs and both call sites.

### [P2] Plan preview action is partly below the initial viewport — source adjustment applied; visual recheck pending

- **Location:** Plan page at `/#plan`, top of `#plan-form`, primary preview button.
- **Evidence:** The current production Plan screenshot was captured at approximately 1265 × 722 px. The shortened hero and primary inputs are visible, but only the upper portion of the dark “پیش‌نمایش پیشنهاد” button is visible at the bottom edge.
- **Impact:** The page advertises a first-step form but leaves its main action visually cut off. Users may miss it or need an avoidable scroll before they understand how to continue.
- **Fix:** Removed the extra 8 px bottom margin from the Plan page heading. This is narrowly scoped and leaves typography and assumption details intact. Visual recheck at 1280 × 720 and responsive viewports is pending because the installed Wrangler runtime rejects the required compatibility date (project requires 2026-10-08; installed runtime supports through 2026-07-08).

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
- **Spacing and layout:** Sidebar and content are coherent on the captured desktop viewport. The Plan hero now gives the form priority, but the last primary action still needs a small vertical-rhythm adjustment. Portfolio and Market use a consistent card structure.
- **Color and tokens:** Current captures show consistent light surfaces, teal action emphasis, and semantic warning treatments. This run did not repeat numeric contrast sampling; prior contrast evidence remains documented in the UX audit.
- **Assets:** The existing Synthora mark renders sharply and consistently. No replacement artwork is indicated.
- **Copy and content:** Product limits and market-data quality are explicit. Native confirmation copy is the concrete localization exception. The market page presents source counts, observation/retrieval timing, stale/outlier states, and unavailable values.
- **Accessibility:** The accessibility tree exposes named controls and useful form structure. A screen reader, real mobile keyboard/rotation, reduced-motion behavior, and spoken dialog/chart behavior were unavailable in this run. Do not claim full accessibility conformance from the captured pages.

## Verification

- `npm run lint`: passed after changes.
- `npm run format:check`: passed after changes.
- `npm run check`: passed after changes.
- `git diff --check`: passed after changes.
- Focused localization suite: 10 tests passed via `node --experimental-test-isolation=none --test tests/localization.test.js`.
- Full suite: 205 tests passed via `node --experimental-test-isolation=none --test`. The default `npm test` runner could not spawn child workers in the sandbox (`spawn EPERM`); disabling test isolation allowed the complete suite to run in-process.
- Local Pages preview was attempted, but Wrangler 4.107.0/workerd supports compatibility dates only through 2026-07-08; this repository build requires 2026-10-08. No viewport screenshot after the CSS adjustment is claimed.
- The PR #12 implementation record reports a local Pages preview journey across all seven routes and synthetic ledger, plan, locale, market, and settings cases. This review independently smoke-tested the live routes listed above, not every mutation flow.

## Remaining verification gaps

- Repeat all seven route/deep-link cases, Back/Forward, locale changes, and refresh on production with the deployed build identity recorded.
- Verify the complete Plan preview action at 1280 × 720, then test responsive layouts with viewport emulation and a real mobile device where available. The 8 px margin adjustment is source-reviewed only in this PR.
- Exercise import/restore with a synthetic backup in isolated browser storage. The previous local QA record says the file picker could not be driven in its browser surface; automated tests cover validation but not that interactive selection step.
- Run a screen-reader pass for navigation, destructive confirmations, drawers, charts, and validation messages.
- Re-run `npm test` where child process spawning is permitted.

## Unified implementation plan and current status

1. **Localized confirmations — implemented.** Explicit catalog keys exist in all locales, and localization regression coverage is passing.
2. **Plan CTA spacing — adjusted.** The header's extra 8 px bottom margin is removed; verify the resulting viewport geometry when a compatible local Pages runtime is available.
3. **Automated checks — passed.** Formatting, lint, syntax checks, and all 205 tests pass. Default worker-isolated test mode is unavailable in this sandbox, while in-process mode passes.
4. **Browser QA — partial.** Re-run the safe route, navigation, locale, import/restore, and Plan viewport scenarios when the required Wrangler/workerd build can run. Do not use personal records or sync for QA.
5. **Deployment — pending.** After merge/deployment, record the deployed build identity and recheck key journeys. No deployment or CI/CD change is part of this PR.

**Current result:** Confirmation localization is verified in source and automated checks. Plan spacing is adjusted but visual confirmation remains pending. Full automated suite passes in-process; default worker spawning is blocked by the sandbox.
