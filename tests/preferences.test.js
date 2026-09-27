import test from "node:test";
import assert from "node:assert/strict";
import {
  UI_PREFERENCES_KEY,
  LOCALES,
  applyUiPreferences,
  displayCurrencyValue,
  preferredCurrency,
  readUiPreferences,
  resolveTheme,
  writeUiPreferences,
} from "../src/ui/preferences.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) || null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

test("UI preferences default to Persian, auto currency, and system theme", () => {
  const storage = memoryStorage();
  const preferences = readUiPreferences(storage);
  assert.deepEqual(preferences, { locale: "fa", currency: null, theme: "system" });
  assert.equal(preferredCurrency(preferences), "TOMAN");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(UI_PREFERENCES_KEY, "synthora-ui-preferences-v1");
});

test("Toman remains the default display currency in every locale unless the user overrides it", () => {
  assert.equal(preferredCurrency({ locale: "fa", currency: null }), "TOMAN");
  assert.equal(preferredCurrency({ locale: "en", currency: null }), "TOMAN");
  assert.equal(preferredCurrency({ locale: "ru", currency: null }), "TOMAN");
  assert.equal(preferredCurrency({ locale: "zh", currency: null }), "TOMAN");
  assert.equal(preferredCurrency({ locale: "zh", currency: "CNY" }), "CNY");
  assert.equal(preferredCurrency({ locale: "zh", currency: "TOMAN" }), "TOMAN");
  assert.deepEqual(LOCALES, {
    fa: { language: "fa", direction: "rtl", numberLocale: "fa-IR", defaultCurrency: "TOMAN" },
    en: { language: "en", direction: "ltr", numberLocale: "en-US", defaultCurrency: "TOMAN" },
    ru: { language: "ru", direction: "ltr", numberLocale: "ru-RU", defaultCurrency: "TOMAN" },
    zh: { language: "zh-CN", direction: "ltr", numberLocale: "zh-CN", defaultCurrency: "TOMAN" },
  });
});

test("preference overrides persist and invalid values fall back safely", () => {
  const storage = memoryStorage();
  assert.deepEqual(writeUiPreferences({ locale: "ru", currency: "RUB", theme: "dark" }, storage), {
    locale: "ru",
    currency: "RUB",
    theme: "dark",
  });
  assert.deepEqual(readUiPreferences(storage), { locale: "ru", currency: "RUB", theme: "dark" });
  const badStorage = memoryStorage({
    [UI_PREFERENCES_KEY]: JSON.stringify({ locale: "xx", currency: "BTC", theme: "sepia" }),
  });
  assert.deepEqual(readUiPreferences(badStorage), { locale: "fa", currency: null, theme: "system" });
});

test("document language, direction, and system-following theme apply without storage access", () => {
  const root = { dataset: {} };
  const themeColor = { content: "" };
  const documentRef = { documentElement: root, querySelector: () => themeColor };
  applyUiPreferences({ locale: "fa", theme: "system" }, documentRef, {
    matchMedia: () => ({ matches: true }),
  });
  assert.equal(root.lang, "fa");
  assert.equal(root.dir, "rtl");
  assert.equal(root.dataset.theme, "dark");
  assert.equal(themeColor.content, "#10191f");
  applyUiPreferences({ locale: "zh", theme: "light" }, documentRef, {
    matchMedia: () => ({ matches: true }),
  });
  assert.equal(root.lang, "zh-CN");
  assert.equal(root.dir, "ltr");
  assert.equal(root.dataset.theme, "light");
});

test("display conversion uses accepted quotes without mutating the Toman input", () => {
  const ledgerValue = 100_000;
  const converted = displayCurrencyValue(ledgerValue, "USD", {
    USD: { rate: 0.00001, status: "available" },
  });
  assert.deepEqual(converted, {
    amount: 1,
    currency: "USD",
    converted: true,
    quote: { rate: 0.00001, status: "available" },
  });
  assert.equal(ledgerValue, 100_000);
  assert.deepEqual(displayCurrencyValue(ledgerValue, "TOMAN", {}), {
    amount: 100_000,
    currency: "TOMAN",
    converted: false,
  });
  assert.equal(displayCurrencyValue(ledgerValue, "RUB", { RUB: { rate: null, status: "unavailable" } }), null);
});

test("all supported display currencies convert the same Toman base without changing it", () => {
  const tomanValue = 12_500_000;
  const quotes = {
    USD: { rate: 0.00002, status: "available" },
    RUB: { rate: 0.0015, status: "available" },
    CNY: { rate: 0.00014, status: "available" },
  };
  for (const currency of ["USD", "RUB", "CNY"]) {
    const result = displayCurrencyValue(tomanValue, currency, quotes);
    assert.equal(result.amount, tomanValue * quotes[currency].rate);
    assert.equal(result.currency, currency);
    assert.equal(result.converted, true);
  }
  assert.equal(displayCurrencyValue(tomanValue, "TOMAN", quotes).amount, tomanValue);
  assert.equal(tomanValue, 12_500_000);
});
