import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "espree";
import { createLocalizedCatalog, translateCopy } from "../src/ui/localization.js";

function readCatalog(locale) {
  return JSON.parse(readFileSync(new URL("../content/" + locale + ".json", import.meta.url), "utf8"));
}

function runtimeCatalog(locale) {
  return createLocalizedCatalog(readCatalog("fa"), readCatalog(locale));
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

test("runtime-rendered copy is part of each complete locale resource", () => {
  for (const locale of ["en", "ru", "zh"]) {
    const phrases = readCatalog(locale).phrases;
    assert.ok(Object.keys(phrases).length >= 150, locale + " runtime phrase inventory is unexpectedly small");
    for (const [source, translation] of Object.entries(phrases)) {
      assert.ok(/[\u0600-\u06ff]/u.test(source), locale + " phrase source should be Persian");
      assert.ok(translation.length > 0, locale + " has an empty translation for " + source);
      assert.doesNotMatch(translation, /[\u0600-\u06ff]/u, locale + " leaves Persian in " + source);
    }
  }
});

test("Persian runtime text literals and template fragments have alternate translations", () => {
  const files = [new URL("../app.js", import.meta.url).pathname];
  const visitDirectory = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visitDirectory(path);
      else if (entry.name.endsWith(".js")) files.push(path);
    }
  };
  visitDirectory(new URL("../src", import.meta.url).pathname);
  const sources = new Set();
  const visitNode = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "Literal" && typeof node.value === "string") sources.add(node.value);
    if (node.type === "TemplateLiteral")
      node.quasis.forEach((part) => sources.add(part.value.cooked ?? part.value.raw));
    Object.values(node).forEach((value) => {
      if (Array.isArray(value)) value.forEach(visitNode);
      else if (value && typeof value === "object") visitNode(value);
    });
  };
  for (const path of files)
    visitNode(parse(readFileSync(path, "utf8"), { ecmaVersion: "latest", sourceType: "module" }));
  const visiblePersian = [...sources].filter(
    (value) => /[\u0600-\u06ff]/u.test(value) && /[\p{L}\p{M}]{2}/u.test(value),
  );
  for (const locale of ["en", "ru", "zh"]) {
    const phrases = runtimeCatalog(locale).phrases;
    for (const source of visiblePersian)
      assert.doesNotMatch(
        translateCopy(source, phrases),
        /[\u0600-\u06ff]/u,
        `${locale} leaves a runtime source literal untranslated: ${source}`,
      );
  }
  assert.ok(Object.keys(runtimeCatalog("en").phrases).length >= 150, "runtime phrase inventory is unexpectedly small");
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
    const catalog = runtimeCatalog(locale);
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

test("runtime-rendered messages stay in one language across locales", () => {
  const runtimeMessages = [
    "کمتر از یک ماه",
    "کلیدی ثبت نشده؛ در صورت نیاز، کلید CoinGecko Demo را وارد کن.",
    "تک‌محور",
    "ثبت‌شده",
    "نسبی",
    "بالا",
    "ناقص",
    "کامل",
    "TGJU · شاخص کل",
    "فاصله خرید و فروش",
    "P10 واقعی · افت دامنه",
    "P90 اسمی · دامنه بالاتر",
    "بازده اسمی سناریوی مرکزی (CAGR)",
    "بازده واقعی سناریوی مرکزی (CAGR)",
    "CAGR اسمی میانه",
    "CAGR واقعی میانه",
    "کلید Demo رمزارز تنظیم نشده",
    "برای نمایش تاریخچه رمزارز، کلید اختیاری CoinGecko Demo را در تنظیمات سرور قرار بده.",
    "تومان برای هر دلار",
    "اختلاف منابع؛ عدد میانه با اطمینان پایین",
    "اختلاف منابع؛ برآورد میانه",
    "زمان مشاهده‌ی برخی نرخ‌ها نامشخص",
    "اعتماد متوسط",
    "اطمینان پایین",
    "اعتماد بالا",
    "یک منبع",
    "قیمت‌های دریافت‌شده از منابع",
    "3 دسته دارایی در سبد ارزش‌گذاری شده است.",
    "بیشترین وزن تقریبا 75% است.",
    "برای 2 دارایی قیمت معتبر ثبت نشده است.",
    "همه دارایی‌های دارای موجودی، قیمت قابل استفاده دارند.",
    "12 ماه مشترک · 2024–2026",
    "بازده ماهانه مشترک برای همه دارایی‌های بازاری لازم است.",
    "مقادیر منابع متعارض",
    "وزن پیشنهادی",
    "دارایی‌های بازار",
    "نقد و درآمد ثابت",
    "دارایی‌های نام‌دار",
    "بازده مؤثر سالانه‌ی فرضی",
    "نوسان سالانه",
    "نوسان فرضی",
    "نمایش ارزش نهایی",
    "ارزش نهایی به تومان جاری",
    "ارزش نهایی به پول امروز",
    "شارپ نسبت به نرخ مؤثر درآمد ثابتِ انتخاب‌شده",
    "ارزش تومانی ثبت‌شده",
    "قیمت خودکار",
    "تاریخچه‌ی بازار",
    "داده‌های شخصی تا وقتی این گزینه را راه‌اندازی نکنی فقط در همین مرورگر می‌مانند. همگام‌سازی دستی است؛ پروفایل، برنامه‌ها، دفتر پرتفوی، فرض‌های مدل و ترجیحات ظاهری با کلیدی که فقط خودت داری، پیش از ارسال رمزگذاری می‌شوند. کلید را در جای امن نگه دار؛ اگر گم شود بازیابی داده ممکن نیست.",
  ];
  for (const locale of ["en", "ru", "zh"]) {
    const catalog = runtimeCatalog(locale);
    for (const message of runtimeMessages) {
      const translated = translateCopy(message, catalog.phrases);
      assert.doesNotMatch(translated, /[\u0600-\u06ff]/u, `${locale} leaves runtime copy untranslated: ${message}`);
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
