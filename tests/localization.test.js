import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLocalizedCatalog, translateCopy } from "../src/ui/localization.js";

function readCatalog(locale) {
  return JSON.parse(readFileSync(new URL("../content/" + locale + ".json", import.meta.url), "utf8"));
}

function assertCatalogCoverage(base, localized, path = "root") {
  for (const [key, value] of Object.entries(base)) {
    if (key === "phrases") continue;
    assert.ok(Object.hasOwn(localized, key), path + "." + key + " is missing");
    if (value && typeof value === "object" && !Array.isArray(value))
      assertCatalogCoverage(value, localized[key], path + "." + key);
    else if (typeof value === "string") {
      assert.equal(typeof localized[key], "string", path + "." + key + " must be text");
      assert.ok(localized[key].length > 0, path + "." + key + " is empty");
      if (/[\u0600-\u06ff]/u.test(value))
        assert.doesNotMatch(localized[key], /[\u0600-\u06ff]/u, path + "." + key + " remains Persian");
    }
  }
}

test("each static locale catalog contains the complete Persian base key shape", () => {
  const base = readCatalog("fa");
  for (const locale of ["en", "ru", "zh"]) {
    const source = readCatalog(locale);
    const merged = createLocalizedCatalog(base, source);
    assertCatalogCoverage(base, source);
    assert.equal(merged.pageTitle, source.pageTitle);
    for (const [phrase, translation] of Object.entries(source.phrases)) {
      assert.ok(phrase.length > 0, locale + " contains an empty phrase");
      assert.equal(typeof translation, "string", locale + " has an invalid translation for " + phrase);
      assert.ok(translation.length > 0, locale + " has an empty translation for " + phrase);
      assert.doesNotMatch(translation, /[\u0600-\u06ff]/u, locale + " leaves Persian in " + phrase);
    }
  }
});

test("visible page copy and accessibility text translate without Persian remnants", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gu, "")
    .replace(/<!--[\s\S]*?-->/gu, "");
  const visible = [];
  for (const match of html.matchAll(/>([^<>]*)<|\b(?:placeholder|title|aria-label|alt)="([^"]*)"/gu)) {
    const value = match[1] || match[2];
    if (/[\u0600-\u06ff]/u.test(value)) visible.push(value);
  }
  assert.ok(visible.length > 400, "page text inventory is unexpectedly small");
  for (const locale of ["en", "ru", "zh"]) {
    const catalog = createLocalizedCatalog(readCatalog("fa"), readCatalog(locale));
    for (const value of visible)
      assert.doesNotMatch(
        translateCopy(value, catalog.phrases),
        /[\u0600-\u06ff]/u,
        locale + " misses " + value.trim(),
      );
  }
});

test("locale catalogs preserve technical units and class identifiers", () => {
  const base = readCatalog("fa");
  for (const locale of ["en", "ru", "zh"]) {
    const source = readCatalog(locale);
    for (const [asset, value] of Object.entries(base.assets))
      assert.equal(source.assets[asset].dotClass, value.dotClass);
    for (const asset of ["fixed", "stocks", "other", "cash"])
      assert.equal(source.portfolio.units[asset], source.currencyUnit);
    for (const asset of ["gold", "silver", "platinum", "palladium", "copper"])
      assert.equal(source.portfolio.units[asset], source.portfolio.units.gold);
  }
});

test("portfolio, reference, and appearance controls have reviewed static translations", () => {
  for (const locale of ["en", "ru", "zh"]) {
    const catalog = createLocalizedCatalog(readCatalog("fa"), readCatalog(locale));
    for (const key of [
      "portfolio.tomanBasisNote",
      "portfolio.displayCurrencyNote",
      "portfolio.fxUnavailableNote",
      "portfolio.fxStaleNote",
      "portfolio.contributionChart",
      "portfolio.noContributionHistory",
      "portfolio.holdingCount",
      "portfolio.noTarget",
      "portfolio.disputedPrice",
      "portfolio.missingPrice",
      "portfolio.manualPrice",
      "reference.title",
      "reference.note",
      "reference.source.cfets",
      "reference.source.cbr",
      "reference.source.metals",
    ]) {
      const value = key.split(".").reduce((current, part) => current?.[part], catalog);
      assert.equal(typeof value, "string", locale + " missing " + key);
      assert.ok(value.length > 0, locale + " has empty " + key);
    }
    for (const key of [
      "نمای فهرستی دارایی‌ها",
      "جستجوی دارایی",
      "وزن فعلی",
      "وزن هدف",
      "ارز نمایشی پرتفوی",
      "همگام با سیستم",
      "تیره",
    ]) {
      assert.ok(catalog.phrases[key], locale + " has no static translation for " + key);
    }
  }
});

test("phrase translation does not replace short words inside longer Persian words", () => {
  const phrases = { تا: "to", نسخه: "version", ماه: "month", "تاریخچه برنامه": "Plan history" };
  assert.equal(translateCopy("تاریخچه", phrases), "تاریخچه");
  assert.equal(translateCopy("نسخه‌های اخیر", phrases), "نسخه‌های اخیر");
  assert.equal(translateCopy("۳ ماه", phrases), "۳ month");
  assert.equal(translateCopy("ماه،", phrases), "month،");
  assert.equal(translateCopy("تاریخچه برنامه", phrases), "Plan history");
  assert.equal(translateCopy("  تاریخچه\n  برنامه  ", phrases), "  Plan history  ");
});
