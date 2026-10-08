import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const index = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("dashboard exposes the complete financial summary contract", () => {
  [
    "dashboard-current-value",
    "dashboard-invested",
    "dashboard-profit-loss",
    "dashboard-profit-loss-percent",
    "dashboard-monthly-contribution",
    "dashboard-tracking-duration",
    "dashboard-performance-chart",
    "dashboard-allocation-chart",
    "dashboard-action-allocation",
  ].forEach((id) => assert.match(index, new RegExp(`id="${id}"`)));
});

test("all internal views remain sibling sections", () => {
  const views = [...index.matchAll(/<section\b(?=[^>]*\bdata-app-view="([^"]+)")[^>]*>/g)].map((match) => match[1]);
  assert.deepEqual(views, ["dashboard", "plan", "simulation", "history", "portfolio", "assets", "settings"]);
});

test("proposal previews wait for an explicit action before saving plan history", () => {
  assert.match(app, /renderPlan\(\{ scrollIntoView: false, validate: false \}\)/);
  assert.match(app, /function calculatePlan\(inputs\)/);
  assert.match(index, /id="save-plan-result"/);
  assert.match(app, /function savePlanPreview\(\)/);
  const preview = app.slice(app.indexOf("function renderPlan("), app.indexOf("function saveHistory("));
  assert.doesNotMatch(preview, /saveHistory\(/);
  assert.match(app, /addEventListener\("click", savePlanPreview\)/);
  assert.match(app, /Object\.keys\(result\.assets \|\| \{\}\)/);
});

test("advanced transaction dates reach localized field validation", () => {
  const form = index.match(/<form id="advanced-transaction-form"[\s\S]*?<\/form>/)?.[0] || "";
  assert.match(form, /novalidate/);
  assert.match(form, /id="advanced-transaction-error"[^>]*role="alert"/);
  assert.match(form, /id="advanced-date"[^>]*aria-describedby="advanced-transaction-error"/);
  assert.match(app, /if \(!date \|\| !dateTimeInputToIso\(date\)\)/);
});

test("primary holding and manual quote forms expose field-specific errors", () => {
  const holdingForm = index.match(/<form id="portfolio-market-asset-form"[\s\S]*?<\/form>/)?.[0] || "";
  const quoteForm = index.match(/<form id="manual-quote-form"[\s\S]*?<\/form>/)?.[0] || "";
  for (const form of [holdingForm, quoteForm]) {
    assert.match(form, /novalidate/);
    assert.match(form, /role="alert"/);
  }
  assert.match(holdingForm, /id="portfolio-market-quantity"[^>]*aria-describedby="portfolio-market-error"/);
  assert.match(holdingForm, /id="portfolio-market-date"[^>]*aria-describedby="portfolio-market-error"/);
  assert.match(quoteForm, /id="manual-quote-price"[^>]*aria-describedby="manual-quote-error"/);
  assert.match(app, /function showPortfolioFormError\(/);
  assert.match(app, /clearPortfolioFormError\("#portfolio-market-asset-form"\)/);
  assert.match(app, /clearPortfolioFormError\("#manual-quote-form"\)/);
});

test("holding dialog contains keyboard focus and restores it after close", () => {
  assert.match(index, /<dialog id="asset-detail-drawer"/);
  assert.match(app, /function containAssetDrawerTab\(event\)/);
  assert.match(app, /document\.addEventListener\("keydown", containAssetDrawerTab, true\)/);
  assert.match(app, /last\.focus\(\)/);
  assert.match(app, /first\.focus\(\)/);
  assert.match(app, /assetDrawerOpener\.focus\(\)/);
});
