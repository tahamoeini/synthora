// @ts-check

import {
  ASSET_KEYS,
  DEFAULT_ALLOCATION,
  DEFAULT_ASSUMPTIONS,
  DEFAULT_TRANSACTION_COSTS,
  MIN_PAIRED_MONTHS,
  clamp,
  contributionRebalance,
  normalizeAllocation,
  portfolioFromHistory,
  recommendAllocation,
} from "./src/engine.js";
import { createHistoryExport, mergeHistory, normalizeHistoryEntries, parseHistoryExport } from "./src/history.js";
import { writeJsonBatch } from "./src/ui/atomic-storage.js";
import {
  PORTFOLIO_ASSETS,
  activePortfolioVersion,
  appendTransactions,
  assetIds,
  calculatePortfolio,
  createPortfolioAsset,
  createTransaction,
  marketPriceAt,
  normalizePortfolio,
  portfolioContributionSeries,
  portfolioCostBasis,
  portfolioSeries,
  validateImportedPortfolio,
} from "./src/portfolio.js";
import {
  CORE_PLAN_ASSET_KEYS,
  OPTIONAL_RECOMMENDATION_ASSETS,
  PLAN_ASSET_KEYS,
  SIMULATION_ASSET_KEYS,
  INSTRUMENT_REGISTRY,
} from "./src/market/catalog.js";
import { marketCacheAge } from "./src/market/cache.js";
import { prepareHistoricalAnalysis } from "./src/market/history.js";
import { lastKnownMarketQuote } from "./src/market/last-known.js";
import { reconcileMarketWithRecentAcceptedQuote } from "./src/market/reconcile.js";
import { AppShell } from "./src/ui/components.js";
import {
  allocationBarChartMarkup,
  barChartMarkup,
  clampTooltipCenter,
  donutChartMarkup,
  lineChartMarkup,
} from "./src/ui/charts.js";
import {
  LOCALES,
  applyUiPreferences,
  displayCurrencyValue,
  preferredCurrency,
  readUiPreferences,
  writeUiPreferences,
} from "./src/ui/preferences.js";
import { createLocalizedCatalog, translateCopy } from "./src/ui/localization.js";
import { createNavigationController } from "./src/ui/navigation.js";
import { createAppStore } from "./src/ui/state.js";
import { decryptSnapshot, encryptSnapshot, generateRecoveryKey, prepareSyncCredentials } from "./src/sync.js";

const HISTORY_KEY = "investment-plan-history-v4";
const MARKET_CACHE_KEY = "investment-plan-market-cache-v3";
const PROFILE_KEY = "investment-plan-profile-v1";
const PORTFOLIO_KEY = "invest-consult-portfolio-v1";
const SETTINGS_KEY = "synthora-model-settings-v1";
const MARKET_API_KEY_SESSION = "synthora-coingecko-key-session";
const MARKET_API_KEY_DEVICE = "synthora-coingecko-key-device";
const MARKET_API_KEY_MODE = "synthora-coingecko-key-mode";
const MARKET_CMC_KEY_SESSION = "synthora-coinmarketcap-key-session";
const MARKET_CMC_KEY_DEVICE = "synthora-coinmarketcap-key-device";
const INFLATION_CACHE_KEY = "synthora-inflation-cache-v1";
const HISTORY_MARKET_CACHE_KEY = "synthora-history-market-cache-v1";
const HISTORY_LIMIT = 60;
const MARKET_REQUEST_TIMEOUT_MS = 12000;
const CURRENCY_MIGRATION_KEY = "invest-consult-currency-toman-v1";
const UI_PREFERENCES_KEY = "synthora-ui-preferences-v1";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const form = $("#plan-form");
const resultPanel = $("#plan-output");
const marketDataEl = $("#market-data");
const statusEl = $("#live-status");
const historyListEl = $("#history-list");
const historySummaryEl = $("#history-summary");
const portfolioBreakdownEl = $("#portfolio-breakdown");
const historyChartEl = $("#history-chart");
const allocationListEl = $("#allocation-list");
const reasonListEl = $("#reason-list");
const contributionPlanEl = $("#contribution-plan");
const simulationSummaryEl = $("#simulation-summary");
const simulationChartEl = $("#simulation-chart");
const monteCarloEl = $("#monte-carlo-output");
const backtestEl = $("#backtest-output");
const portfolioAllocationEl = $("#portfolio-allocation");
const portfolioLedgerEl = $("#portfolio-ledger");
const portfolioAuditEl = $("#portfolio-audit");
const portfolioDonutEl = $("#portfolio-donut");
const portfolioTransferStatusEl = $("#portfolio-transfer-status");
const appStore = createAppStore();
const appShell = AppShell(document);
const navigationController = createNavigationController(appShell, appStore);

let copy;
let uiPreferences = readUiPreferences();
let fxData = null;
let fxLoadPromise = null;
let holdingsSort = { key: "value", direction: "desc" };
let holdingsFilter = "all";
let holdingsSearch = "";
let liveMarket = null;
let lastKnownMarket = null;
let lastPlan = null;
let dashboardRange = "ALL";
let historyComparisonRange = "1y";
let historyComparisonData = null;
let historyComparisonLoading = false;
let historyComparisonError = null;
let historyComparisonRequestId = 0;
let historyComparisonLoadedSignature = "";
let historyComparisonPendingSignature = "";
const historyComparisonSelection = new Set(["gold", "dollar", "silver"]);
const HISTORY_CHART_COLORS = Object.freeze({
  portfolio: "#126b62",
  dollar: "#4979a7",
  gold: "#c18a2c",
  silver: "#8997a0",
  bitcoin: "#d98232",
  ethereum: "#6d65b7",
  tether: "#278b78",
  platinum: "#5a7485",
  palladium: "#85617f",
  copper: "#ba6949",
  bourseIndex: "#348c84",
});
let storageWarning = false;
let planPreviewTimer = null;
let analysisWorkerTask = null;
let analysisRequestId = 0;
let legacyEmergencyFund = "partial";
let modelSettings;
let providerApiKey = "";
let providerCoinMarketCapKey = "";
let providerKeyStorageMode = "session";
let apiSessionReady = null;
let syncCredentials = null;
let syncRevision = null;
let historyComparisonMode = "return";
let historyComparisonCurrency = "TOMAN";
let historyCustomBounds = null;

const fallbackCopy = {
  status: {
    loading: "در حال خواندن داده بازار",
    connected: "داده زنده وصل است",
    cached: "در حال استفاده از داده ذخیره‌شده",
    unavailable: "داده زنده در دسترس نیست",
  },
  errors: { salary: "یک حقوق معتبر وارد کن." },
};

function text(key, fallback = "") {
  return key.split(".").reduce((value, part) => value && value[part], copy) ?? fallback;
}

const originalTextByNode = new WeakMap();
const originalAttributesByElement = new WeakMap();
let localeMutationObserver = null;
let copyRequestId = 0;

function translateInline(value) {
  return translateCopy(value, copy?.phrases || {});
}

function translateVisibleCopy(root = document.body) {
  if (!root || !copy?.phrases) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.parentElement || node.parentElement.closest("script,style,textarea,[data-user-content]")) continue;
    const previous = originalTextByNode.get(node);
    const source = previous && node.nodeValue === previous.rendered ? previous.source : node.nodeValue || "";
    const rendered = translateInline(source);
    originalTextByNode.set(node, { source, rendered });
    if (node.nodeValue !== rendered) node.nodeValue = rendered;
  }
  const elements =
    root.nodeType === Node.ELEMENT_NODE ? [root, ...root.querySelectorAll("*")] : [...root.querySelectorAll("*")];
  elements.forEach((element) => {
    if (element.closest?.("[data-user-content]")) return;
    const states = originalAttributesByElement.get(element) || {};
    ["placeholder", "title", "aria-label"].forEach((name) => {
      if (!element.hasAttribute(name)) return;
      const current = element.getAttribute(name) || "";
      const previous = states[name];
      const source = previous && current === previous.rendered ? previous.source : current;
      const rendered = translateInline(source);
      states[name] = { source, rendered };
      if (current !== rendered) element.setAttribute(name, rendered);
    });
    originalAttributesByElement.set(element, states);
  });
  if (!localeMutationObserver) {
    localeMutationObserver = new MutationObserver((records) => {
      records.forEach((record) =>
        record.addedNodes.forEach((added) => {
          if (added.nodeType === Node.TEXT_NODE) translateVisibleCopy(added.parentElement);
          else if (added.nodeType === Node.ELEMENT_NODE) translateVisibleCopy(added);
        }),
      );
    });
    localeMutationObserver.observe(document.body, { childList: true, subtree: true });
  }
}

function currencyName(currency) {
  const names = {
    fa: { TOMAN: "تومان", USD: "دلار", RUB: "روبل", CNY: "یوان" },
    en: { TOMAN: "Toman", USD: "USD", RUB: "RUB", CNY: "CNY" },
    ru: { TOMAN: "туман", USD: "доллар США", RUB: "рубль", CNY: "юань" },
    zh: { TOMAN: "托曼", USD: "美元", RUB: "俄罗斯卢布", CNY: "人民币" },
  };
  return names[uiPreferences.locale]?.[currency] || currency;
}

function activeFxQuotes() {
  const usd = liveMarket?.assets?.dollar;
  const usdToman = usd && usd.status !== "conflicted" && Number(usd.price) > 0 ? Number(usd.price) : null;
  const quotes = fxData?.quotes || {};
  return Object.fromEntries(
    ["USD", "RUB", "CNY"].map((currency) => {
      const quote = quotes[currency];
      const quotePerUsd = Number(quote?.quotePerUsd);
      const providerStatus = currency === "USD" && usdToman ? "available" : quote?.status || "unavailable";
      const status =
        !usdToman || providerStatus === "unavailable"
          ? "unavailable"
          : fxData?._clientStale || providerStatus === "stale" || usd?.status === "stale"
            ? "stale"
            : "available";
      return [
        currency,
        {
          ...quote,
          source: currency === "USD" ? usd?.source || quote?.source : quote?.source,
          observedAt: currency === "USD" ? usd?.observedAt || usd?.asOf || quote?.observedAt : quote?.observedAt,
          retrievedAt: currency === "USD" ? usd?.retrievedAt || quote?.retrievedAt : quote?.retrievedAt,
          rate:
            usdToman && currency === "USD" ? 1 / usdToman : usdToman && quotePerUsd > 0 ? quotePerUsd / usdToman : null,
          status,
          reason: !usdToman ? "usd-toman-reference-unavailable" : quotePerUsd > 0 ? null : quote?.reason || null,
        },
      ];
    }),
  );
}

function referenceStatusLabel(status) {
  return text(
    "reference.status." + (status === "available" ? "available" : status === "stale" ? "stale" : "unavailable"),
    status === "available" ? "در دسترس" : status === "stale" ? "کهنه" : "در دسترس نیست",
  );
}

function renderGlobalReferences() {
  const container = $("#market-global-references");
  if (!container) return;
  if (!fxData) {
    container.innerHTML =
      '<div class="empty-state">' +
      escapeHTML(text("reference.unavailable", "نرخ‌های مرجع روزانه پس از دریافت داده نمایش داده می‌شوند.")) +
      "</div>";
    return;
  }
  const quotes = fxData.quotes || {};
  const rateCards = ["USD", "CNY", "RUB"]
    .map((currency) => {
      const quote = quotes[currency];
      if (!quote) return "";
      const providerRate = Number(quote.quotePerUsd);
      const active = activeFxQuotes()[currency];
      const status = active?.status || quote.status || "unavailable";
      const oneUnitToman = Number(active?.rate) > 0 ? 1 / Number(active.rate) : null;
      const number = (value, digits = 4) =>
        Number.isFinite(Number(value))
          ? new Intl.NumberFormat(currentLocale().numberLocale, { maximumFractionDigits: digits }).format(Number(value))
          : "—";
      const quoteText =
        currency === "USD"
          ? oneUnitToman === null
            ? text("reference.conversionUnavailable", "تبدیل به تومان در دسترس نیست")
            : "1 USD = " + number(oneUnitToman, 0) + " " + currencyName("TOMAN")
          : Number.isFinite(providerRate) && providerRate > 0
            ? "1 USD = " + number(providerRate) + " " + currencyName(currency)
            : "—";
      const tomanText =
        currency === "USD"
          ? text("reference.iranRate", "Iran market reference rate")
          : oneUnitToman === null
            ? text("reference.conversionUnavailable", "تبدیل به تومان در دسترس نیست")
            : "1 " + currencyName(currency) + " ≈ " + number(oneUnitToman, 0) + " " + currencyName("TOMAN");
      const sourceKey = currency === "USD" ? "iran" : currency === "CNY" ? "cfets" : "cbr";
      return (
        '<article class="reference-rate-card"><div class="reference-rate-heading"><strong>' +
        escapeHTML(currencyName(currency)) +
        '</strong><span class="reference-status reference-status-' +
        escapeHTML(status) +
        '">' +
        escapeHTML(referenceStatusLabel(status)) +
        '</span></div><p class="reference-rate-value">' +
        escapeHTML(quoteText) +
        "</p><p>" +
        escapeHTML(tomanText) +
        "</p><small>" +
        escapeHTML(text("reference.source." + sourceKey, quote.source || "")) +
        " · " +
        escapeHTML(quote.observedAt ? formatDate(quote.observedAt) : text("market.observationUnknown")) +
        "</small></article>"
      );
    })
    .join("");
  const metals = fxData.preciousMetals;
  const rubPerToman = Number(activeFxQuotes().RUB?.rate);
  const metalRows = (metals?.references || [])
    .map((item) => {
      const title = text("assets." + item.asset + ".title", item.asset);
      const amount = new Intl.NumberFormat(currentLocale().numberLocale, { maximumFractionDigits: 2 }).format(
        Number(item.referenceRubPerGram),
      );
      const converted =
        rubPerToman > 0 && preferredCurrency(uiPreferences) !== "RUB"
          ? `<small>≈ ${escapeHTML(formatDisplayMoney(Number(item.referenceRubPerGram) / rubPerToman))}/g</small>`
          : "";
      return (
        "<li><span>" +
        escapeHTML(title) +
        "</span><strong>" +
        escapeHTML(amount) +
        " RUB/g</strong>" +
        converted +
        "</li>"
      );
    })
    .join("");
  const metalCard = metals
    ? '<article class="reference-rate-card reference-metals-card"><div class="reference-rate-heading"><strong>' +
      escapeHTML(text("reference.metalsTitle", "فلزات گران‌بها · روبل بر گرم")) +
      '</strong><span class="reference-status reference-status-' +
      escapeHTML(metals.status || "unavailable") +
      '">' +
      escapeHTML(referenceStatusLabel(metals.status)) +
      '</span></div><ul class="reference-metals-list">' +
      (metalRows || "<li>—</li>") +
      "</ul><small>" +
      escapeHTML(text("reference.source.metals", metals.source || "")) +
      " · " +
      escapeHTML(metals.observedAt ? formatDate(metals.observedAt) : text("market.observationUnknown")) +
      "</small></article>"
    : "";
  container.innerHTML =
    '<div class="section-heading"><div><span class="kicker">' +
    escapeHTML(text("reference.kicker", "داده بین‌المللی")) +
    "</span><h3>" +
    escapeHTML(text("reference.title", "نرخ‌های مرجع جهانی")) +
    "</h3><p>" +
    escapeHTML(text("reference.note", "این نرخ‌های روزانه برای تبدیل نمایشی هستند و قیمت خرده‌فروشی ایران نیستند.")) +
    '</p></div></div><div class="reference-rates-grid">' +
    rateCards +
    metalCard +
    "</div>";
}

async function loadFx() {
  if (fxLoadPromise) return fxLoadPromise;
  const lastUpdated = Date.parse(fxData?.updatedAt || "");
  if (Number.isFinite(lastUpdated) && Date.now() - lastUpdated < 60_000) return;
  const params = new URLSearchParams({ quotes: "USD,RUB,CNY", include: "metals" });
  fxLoadPromise = (async () => {
    try {
      await ensureApiSession();
      const response = await fetchWithTimeout("/api/fx?" + params.toString(), {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("FX reference request failed");
      const payload = await response.json();
      if (!payload || typeof payload !== "object" || !payload.quotes) throw new Error("FX response was invalid");
      fxData = payload;
    } catch {
      if (fxData) fxData = { ...fxData, _clientStale: true };
    } finally {
      fxLoadPromise = null;
      renderGlobalReferences();
      renderPortfolio();
      renderDashboard();
    }
  })();
  return fxLoadPromise;
}

function syncUiPreferenceControls() {
  const locale = $("#settings-locale");
  const currency = $("#settings-display-currency");
  const theme = $("#settings-theme");
  if (locale) locale.value = uiPreferences.locale;
  if (currency) currency.value = uiPreferences.currency || "auto";
  if (theme) theme.value = uiPreferences.theme;
}

function rerenderLocalizedViews() {
  translateVisibleCopy();
  renderMarket(liveMarket, lastKnownMarket);
  renderHistory();
  renderPortfolio();
  renderDashboard();
  renderSettingsAssumptions();
  renderGlobalReferences();
}

async function changeLocale(locale) {
  setUiPreferences({ ...uiPreferences, locale });
  syncUiPreferenceControls();
  await loadCopy();
  rerenderLocalizedViews();
  void loadFx();
}

function setUiPreferences(next) {
  uiPreferences = writeUiPreferences(next);
  applyUiPreferences(uiPreferences);
  syncUiPreferenceControls();
}
function formatToman(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? text("portfolio.unavailable", "Unavailable")
    : `${formatIRR(value)} ${escapeHTML(currencyName("TOMAN"))}`;
}

function formatDisplayMoney(tomanValue, { fallbackToToman = true } = {}) {
  const currency = preferredCurrency(uiPreferences);
  const converted = displayCurrencyValue(tomanValue, currency, activeFxQuotes());
  if (!converted) return fallbackToToman ? formatToman(tomanValue) : "—";
  const digits = currency === "TOMAN" ? 0 : converted.amount < 100 ? 2 : 0;
  const amount = new Intl.NumberFormat(currentLocale().numberLocale, { maximumFractionDigits: digits }).format(
    converted.amount,
  );
  return `${amount} ${escapeHTML(currencyName(currency))}`;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function currentLocale() {
  return LOCALES[uiPreferences?.locale] || LOCALES.fa;
}

function listSeparator() {
  if (uiPreferences.locale === "fa") return "، ";
  if (uiPreferences.locale === "zh") return "、";
  return ", ";
}

function normalizeDigits(value) {
  return String(value || "")
    .replace(/[\u06f0-\u06f9]/g, (digit) =>
      String("\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8\u06f9".indexOf(digit)),
    )
    .replace(/[\u0660-\u0669]/g, (digit) =>
      String("\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669".indexOf(digit)),
    )
    .replace(/[\u066c\u060c,\s]/g, "")
    .replace(/\u066b/g, ".");
}

function numberFromInput(value) {
  const parsed = Number(normalizeDigits(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function groupedNumber(value) {
  const normalized = normalizeDigits(value);
  const negative = normalized.trim().startsWith("-");
  const unsigned = normalized.replace(/[^0-9.]/g, "");
  if (!unsigned) return negative ? "-" : "";
  const [integerPart = "0", ...fractionParts] = unsigned.split(".");
  const fraction = fractionParts.join("").replace(/[^0-9]/g, "");
  const hasDecimal = unsigned.includes(".");
  const integer = integerPart.replace(/^0+(?=\d)/, "") || "0";
  const formattedInteger = new Intl.NumberFormat(currentLocale().numberLocale, {
    useGrouping: true,
    maximumFractionDigits: 0,
  }).format(Number(integer));
  const decimalSeparator = uiPreferences.locale === "fa" ? "٫" : ".";
  return `${negative ? "-" : ""}${formattedInteger}${hasDecimal ? `${decimalSeparator}${fraction}` : ""}`;
}

function formatNumberInput(event) {
  const input = event.currentTarget;
  const before = input.value.slice(0, input.selectionStart ?? input.value.length);
  const digitsBeforeCaret = normalizeDigits(before).replace(/\D/g, "").length;
  input.value = groupedNumber(input.value);
  let caret = 0;
  let seenDigits = 0;
  while (caret < input.value.length && seenDigits < digitsBeforeCaret) {
    if (/\d/.test(normalizeDigits(input.value[caret]))) seenDigits += 1;
    caret += 1;
  }
  if (typeof input.setSelectionRange === "function") input.setSelectionRange(caret, caret);
}

function formatIRR(value) {
  const numeric = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(numeric)
    ? "—"
    : new Intl.NumberFormat(currentLocale().numberLocale, { maximumFractionDigits: 0 }).format(Math.round(numeric));
}

function formatPercent(value, digits = 1) {
  const numeric = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(numeric)) return "—";
  const percent = new Intl.NumberFormat(currentLocale().numberLocale, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(numeric);
  return uiPreferences.locale === "fa" ? `${percent}\u066a` : `${percent}%`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "\u2014";
  return new Intl.DateTimeFormat(currentLocale().numberLocale, { dateStyle: "short" }).format(date);
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "\u2014";
  return new Intl.DateTimeFormat(currentLocale().numberLocale, { dateStyle: "short", timeStyle: "short" }).format(date);
}

function formatTrackingDuration(start, end = new Date()) {
  const startTime = new Date(start || 0).getTime();
  const endTime = new Date(end || 0).getTime();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) return "\u2014";
  const totalMonths = Math.floor((endTime - startTime) / ((365.25 * 24 * 60 * 60 * 1000) / 12));
  if (totalMonths < 1) return "کمتر از یک ماه";
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  const parts = [];
  if (years) parts.push(`${formatIRR(years)} سال`);
  if (months) parts.push(`${formatIRR(months)} ماه`);
  return parts.join(" و ") || "کمتر از یک ماه";
}

function showStorageWarning() {
  if (!storageWarning) return;
  const error = $("#app-error");
  if (!error) return;
  error.hidden = false;
  error.textContent =
    "بخشی از داده‌های محلی قابل خواندن یا ذخیره نبود؛ برنامه با حالت امن و بدون حدس‌زدن عددها ادامه داد. اگر این داده‌ها مهم‌اند، فایل پشتیبان قبلی را وارد کن.";
}

function setStatus(label, type = "loading") {
  statusEl.textContent = label;
  statusEl.className = `status-pill status-${type}`;
}

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value ?? fallback;
  } catch {
    storageWarning = true;
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    storageWarning = true;
    showStorageWarning();
    return false;
  }
}

function divideByTen(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number / 10 : value;
}

function isQuantityInToman(assetId) {
  return ["fixed", "stocks", "cash", "other"].includes(assetId) || String(assetId || "").startsWith("custom:");
}

function migrateHistoryCurrency(records) {
  return Array.isArray(records)
    ? records.map((entry) => {
        const next = { ...entry };
        ["salary", "total"].forEach((key) => {
          if (Number.isFinite(Number(next[key]))) next[key] = divideByTen(next[key]);
        });
        if (next.contributionPlan && typeof next.contributionPlan === "object") {
          next.contributionPlan = Object.fromEntries(
            Object.entries(next.contributionPlan).map(([key, value]) => [key, divideByTen(value)]),
          );
        }
        if (next.marketSnapshot && typeof next.marketSnapshot === "object") {
          next.marketSnapshot = {
            ...next.marketSnapshot,
            assets: Object.fromEntries(
              Object.entries(next.marketSnapshot.assets || {}).map(([key, item]) => [
                key,
                item && Number.isFinite(Number(item.price)) ? { ...item, price: divideByTen(item.price) } : item,
              ]),
            ),
          };
        }
        return next;
      })
    : records;
}

function migratePortfolioCurrency(portfolio) {
  if (!portfolio || typeof portfolio !== "object" || !Array.isArray(portfolio.versions)) return portfolio;
  const next = JSON.parse(JSON.stringify(portfolio));
  next.versions = next.versions.map((version) => ({
    ...version,
    transactions: Array.isArray(version.transactions)
      ? version.transactions.map((transaction) => {
          const result = { ...transaction };
          if (result.quantity !== undefined && isQuantityInToman(result.assetId))
            result.quantity = divideByTen(result.quantity);
          if (result.targetQuantity !== undefined && isQuantityInToman(result.targetAssetId))
            result.targetQuantity = divideByTen(result.targetQuantity);
          if (result.amount !== undefined) result.amount = divideByTen(result.amount);
          if (result.fee !== undefined) result.fee = divideByTen(result.fee);
          if (
            result.unitPrice !== undefined &&
            ["gold", "silver", "currency", "bitcoin", "ethereum", "tether", "platinum", "palladium", "copper"].includes(
              result.assetId,
            )
          )
            result.unitPrice = divideByTen(result.unitPrice);
          if (
            result.targetUnitPrice !== undefined &&
            ["gold", "silver", "currency", "bitcoin", "ethereum", "tether", "platinum", "palladium", "copper"].includes(
              result.targetAssetId,
            )
          )
            result.targetUnitPrice = divideByTen(result.targetUnitPrice);
          if (result.marketQuote && Number.isFinite(Number(result.marketQuote.price)))
            result.marketQuote = { ...result.marketQuote, price: divideByTen(result.marketQuote.price) };
          return result;
        })
      : [],
  }));
  return next;
}

function migrateMarketCurrency(market) {
  if (!market || typeof market !== "object") return market;
  const next = JSON.parse(JSON.stringify(market));
  if (next.assets && typeof next.assets === "object") {
    Object.values(next.assets).forEach((item) => {
      if (item && Number.isFinite(Number(item.price))) item.price = divideByTen(item.price);
    });
  }
  if (next.history && typeof next.history === "object") {
    Object.values(next.history).forEach((series) => {
      if (!Array.isArray(series)) return;
      series.forEach((point) => {
        if (Array.isArray(point) && Number.isFinite(Number(point[1]))) point[1] = divideByTen(point[1]);
        else if (point && typeof point === "object") {
          ["value", "price", "close", "c"].forEach((key) => {
            if (Number.isFinite(Number(point[key]))) point[key] = divideByTen(point[key]);
          });
        }
      });
    });
  }
  return next;
}

function migrateStoredCurrencyToToman() {
  if (readJson(CURRENCY_MIGRATION_KEY, false)) return;
  const history = readJson(HISTORY_KEY, null);
  if (Array.isArray(history)) writeJson(HISTORY_KEY, migrateHistoryCurrency(history));
  const legacyHistory = readJson("investment-plan-history-v3", null);
  if (Array.isArray(legacyHistory)) writeJson("investment-plan-history-v3", migrateHistoryCurrency(legacyHistory));
  const portfolio = readJson(PORTFOLIO_KEY, null);
  if (portfolio) writeJson(PORTFOLIO_KEY, migratePortfolioCurrency(portfolio));
  const market = readJson(MARKET_CACHE_KEY, null);
  if (market) writeJson(MARKET_CACHE_KEY, migrateMarketCurrency(market));
  writeJson(CURRENCY_MIGRATION_KEY, true);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = MARKET_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureApiSession() {
  if (!apiSessionReady) {
    apiSessionReady = fetchWithTimeout(
      "/api/session",
      { method: "POST", credentials: "same-origin", cache: "no-store" },
      8000,
    )
      .then((response) => response.ok)
      .catch(() => {
        apiSessionReady = null;
        return false;
      });
  }
  return apiSessionReady;
}

function providerRequestHeaders() {
  const headers = {};
  if (providerApiKey && providerApiKey.length <= 300 && !/[\r\n\0]/.test(providerApiKey))
    headers["X-CoinGecko-API-Key"] = providerApiKey;
  if (providerCoinMarketCapKey && providerCoinMarketCapKey.length <= 300 && !/[\r\n\0]/.test(providerCoinMarketCapKey))
    headers["X-CoinMarketCap-API-Key"] = providerCoinMarketCapKey;
  return headers;
}

function restoreProviderApiKey() {
  try {
    providerKeyStorageMode = localStorage.getItem(MARKET_API_KEY_MODE) || "session";
    if (!["page", "session", "device"].includes(providerKeyStorageMode)) providerKeyStorageMode = "session";
    providerApiKey =
      providerKeyStorageMode === "device"
        ? localStorage.getItem(MARKET_API_KEY_DEVICE) || ""
        : providerKeyStorageMode === "session"
          ? sessionStorage.getItem(MARKET_API_KEY_SESSION) || ""
          : "";
    providerCoinMarketCapKey =
      providerKeyStorageMode === "device"
        ? localStorage.getItem(MARKET_CMC_KEY_DEVICE) || ""
        : providerKeyStorageMode === "session"
          ? sessionStorage.getItem(MARKET_CMC_KEY_SESSION) || ""
          : "";
  } catch {
    providerApiKey = "";
    providerCoinMarketCapKey = "";
    providerKeyStorageMode = "page";
  }
  const mode = $("#provider-key-storage");
  if (mode) mode.value = providerKeyStorageMode;
  [
    ["coingecko", providerApiKey],
    ["coinmarketcap", providerCoinMarketCapKey],
  ].forEach(([provider, key]) => {
    const status = $(`#provider-key-status-${provider}`);
    if (!status) return;
    status.textContent = key
      ? text(
          providerKeyStorageMode === "device"
            ? "کلید روی همین دستگاه ذخیره است."
            : "کلید تا پایان نشست مرورگر ذخیره است.",
          providerKeyStorageMode === "device"
            ? "Key is saved on this device."
            : "Key is saved for this browser session.",
        )
      : text("کلیدی ثبت نشده؛ در صورت نیاز، کلید این منبع را وارد کن.");
    status.className = "transfer-status transfer-neutral";
  });
}

function saveProviderApiKey(event) {
  if (event.currentTarget?.id === "provider-key-form") event.preventDefault();
  const provider = event.currentTarget?.dataset.providerKeySave || document.activeElement?.dataset.providerKeyInput;
  if (!["coingecko", "coinmarketcap"].includes(provider)) return;
  const isCoinMarketCap = provider === "coinmarketcap";
  const input = $(`#provider-api-key-${provider}`);
  const key = String(input?.value || "").trim();
  const status = $(`#provider-key-status-${provider}`);
  if (!key || key.length > 300 || /[\r\n\0]/.test(key)) {
    if (status) {
      status.textContent = text("کلید معتبر وارد کن؛ مقدار خالی یا دارای نویسه‌ی کنترلی پذیرفته نمی‌شود.");
      status.className = "transfer-status transfer-warning";
    }
    return;
  }
  if (isCoinMarketCap) providerCoinMarketCapKey = key;
  else providerApiKey = key;
  providerKeyStorageMode = $("#provider-key-storage")?.value || "session";
  try {
    [MARKET_API_KEY_SESSION, MARKET_CMC_KEY_SESSION].forEach((storageKey) => sessionStorage.removeItem(storageKey));
    [MARKET_API_KEY_DEVICE, MARKET_CMC_KEY_DEVICE].forEach((storageKey) => localStorage.removeItem(storageKey));
    localStorage.setItem(MARKET_API_KEY_MODE, providerKeyStorageMode);
    if (providerKeyStorageMode === "session") {
      if (providerApiKey) sessionStorage.setItem(MARKET_API_KEY_SESSION, providerApiKey);
      if (providerCoinMarketCapKey) sessionStorage.setItem(MARKET_CMC_KEY_SESSION, providerCoinMarketCapKey);
    }
    if (providerKeyStorageMode === "device") {
      if (providerApiKey) localStorage.setItem(MARKET_API_KEY_DEVICE, providerApiKey);
      if (providerCoinMarketCapKey) localStorage.setItem(MARKET_CMC_KEY_DEVICE, providerCoinMarketCapKey);
    }
  } catch {
    if (isCoinMarketCap) providerCoinMarketCapKey = "";
    else providerApiKey = "";
    if (status) {
      status.textContent = text("مرورگر اجازه‌ی ذخیره نداد؛ کلید ذخیره نشد.");
      status.className = "transfer-status transfer-warning";
    }
    return;
  }
  if (input) input.value = "";
  if (status) {
    status.textContent =
      providerKeyStorageMode === "page"
        ? text("کلید فقط تا وقتی همین صفحه باز است نگه داشته می‌شود.")
        : providerKeyStorageMode === "device"
          ? text("کلید روی همین دستگاه ذخیره شد.")
          : text("کلید تا پایان نشست مرورگر ذخیره شد.");
    status.className = "transfer-status transfer-success";
  }
  loadMarket();
}

function clearProviderApiKey(event) {
  const provider = event.currentTarget?.dataset.providerKeyClear;
  if (!["coingecko", "coinmarketcap"].includes(provider)) return;
  const isCoinMarketCap = provider === "coinmarketcap";
  if (isCoinMarketCap) providerCoinMarketCapKey = "";
  else providerApiKey = "";
  const storageKeys = isCoinMarketCap
    ? { session: MARKET_CMC_KEY_SESSION, device: MARKET_CMC_KEY_DEVICE }
    : { session: MARKET_API_KEY_SESSION, device: MARKET_API_KEY_DEVICE };
  try {
    sessionStorage.removeItem(storageKeys.session);
    localStorage.removeItem(storageKeys.device);
  } catch {
    /* Storage may be unavailable; the in-memory key is still cleared. */
  }
  if ($(`#provider-api-key-${provider}`)) $(`#provider-api-key-${provider}`).value = "";
  const status = $(`#provider-key-status-${provider}`);
  if (status) {
    status.textContent = text("کلید از حافظه‌ی برنامه پاک شد.");
    status.className = "transfer-status transfer-success";
  }
  loadMarket();
}

function setSyncStatus(message, type = "neutral") {
  const status = $("#sync-status");
  if (!status) return;
  status.textContent = message;
  status.className = `transfer-status transfer-${type}`;
}

function updateSyncControls() {
  const connected = Boolean(syncCredentials);
  ["#sync-upload", "#sync-restore", "#sync-delete", "#sync-disconnect"].forEach((selector) => {
    const button = $(selector);
    if (button) button.disabled = !connected;
  });
  ["#sync-create", "#sync-connect", "#sync-recovery-key"].forEach((selector) => {
    const control = $(selector);
    if (control) control.disabled = connected;
  });
}

function currentSyncSnapshot() {
  if (storageWarning) throw new Error("sync.localDataUnavailable");
  const profile = readJson(PROFILE_KEY, null);
  if (profile !== null && (typeof profile !== "object" || Array.isArray(profile)))
    throw new Error("sync.localDataUnavailable");
  const snapshot = {
    profile,
    history: readHistory(),
    portfolio: readPortfolio(),
    modelSettings: modelSettings || defaultModelSettings(),
    preferences: {
      locale: uiPreferences.locale,
      currency: uiPreferences.currency,
      theme: uiPreferences.theme,
    },
  };
  if (storageWarning) throw new Error("sync.localDataUnavailable");
  return snapshot;
}

function validateSyncRecords(records) {
  const writes = [];
  if (Object.hasOwn(records, "profile")) {
    if (records.profile !== null && (typeof records.profile !== "object" || Array.isArray(records.profile)))
      throw new Error("sync.invalidSnapshot");
    writes.push([PROFILE_KEY, records.profile || {}]);
  }
  if (Object.hasOwn(records, "history")) {
    if (!Array.isArray(records.history) || records.history.length > HISTORY_LIMIT)
      throw new Error("sync.invalidSnapshot");
    const history = normalizeHistoryEntries(records.history, HISTORY_LIMIT);
    if (history.length !== records.history.length) throw new Error("sync.invalidSnapshot");
    writes.push([HISTORY_KEY, history], ["investment-plan-history-v3", []]);
  }
  if (Object.hasOwn(records, "portfolio")) {
    const validated = validateImportedPortfolio(records.portfolio);
    if (!validated.valid) throw new Error("sync.invalidSnapshot");
    writes.push([PORTFOLIO_KEY, validated.portfolio]);
  }
  if (Object.hasOwn(records, "modelSettings")) {
    if (!records.modelSettings || typeof records.modelSettings !== "object" || Array.isArray(records.modelSettings))
      throw new Error("sync.invalidSnapshot");
    writes.push([SETTINGS_KEY, normalizeModelSettings(records.modelSettings)]);
  }
  if (Object.hasOwn(records, "preferences")) {
    const preferences = records.preferences;
    if (
      !preferences ||
      typeof preferences !== "object" ||
      Array.isArray(preferences) ||
      Object.keys(preferences).some((key) => !["locale", "currency", "theme"].includes(key))
    )
      throw new Error("sync.invalidSnapshot");
    const locale = ["fa", "en", "ru", "zh"].includes(preferences?.locale) ? preferences.locale : null;
    const currency = [null, "TOMAN", "USD", "RUB", "CNY"].includes(preferences?.currency) ? preferences.currency : null;
    const theme = ["system", "light", "dark"].includes(preferences?.theme) ? preferences.theme : null;
    if (!locale || (currency === null && preferences.currency !== null) || !theme)
      throw new Error("sync.invalidSnapshot");
    writes.push([UI_PREFERENCES_KEY, { locale, currency, theme }]);
  }
  return writes;
}

async function requestSync(method, credentials = syncCredentials, body = undefined) {
  if (!credentials?.authToken) throw new Error("sync.notConnected");
  await ensureApiSession();
  const headers = { "X-Synthora-Sync-Token": credentials.authToken };
  const options = { method, credentials: "same-origin", cache: "no-store", headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetchWithTimeout("/api/sync", options, 20000);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function syncErrorMessage(error) {
  const apiError = error?.data?.error;
  if (apiError === "sync-storage-not-configured" || apiError === "api-security-not-configured")
    return text("sync.unavailable");
  if (apiError === "rate-limit-exceeded") return text("sync.rateLimited");
  if (apiError === "sync-conflict") return text("sync.conflict");
  if (apiError === "session-required" || apiError === "session-limit-unavailable")
    return text("sync.sessionUnavailable");
  const localError = typeof error?.message === "string" ? error.message.replace(/^sync\./u, "") : "";
  if (localError && copy?.sync?.[localError]) return text(`sync.${localError}`);
  return text("sync.requestFailed");
}

async function createEncryptedSync() {
  if (!window.confirm(text("sync.createConfirm"))) return;
  try {
    const snapshot = currentSyncSnapshot();
    const recoveryKey = await generateRecoveryKey();
    const credentials = await prepareSyncCredentials(recoveryKey);
    const payload = await encryptSnapshot(snapshot, credentials);
    const { response, data } = await requestSync("PUT", credentials, { revision: 0, payload });
    if (!response.ok) throw Object.assign(new Error("sync.requestFailed"), { data });
    syncCredentials = credentials;
    syncRevision = Number(data.revision);
    const output = $("#sync-recovery-output");
    if (output) {
      output.textContent = `${text("sync.recoveryKeyLabel")}\n${recoveryKey}\n\n${text("sync.recoveryKeyWarning")}`;
      output.hidden = false;
    }
    $("#sync-copy-recovery")?.removeAttribute("hidden");
    setSyncStatus(text("sync.created"), "success");
    updateSyncControls();
  } catch (error) {
    setSyncStatus(syncErrorMessage(error), "warning");
  }
}

async function connectEncryptedSync() {
  const input = $("#sync-recovery-key");
  const recoveryKey = String(input?.value || "").trim();
  if (input) input.value = "";
  $("#sync-recovery-output").hidden = true;
  $("#sync-copy-recovery")?.setAttribute("hidden", "");
  if (!recoveryKey) {
    setSyncStatus(text("sync.keyRequired"), "warning");
    return;
  }
  let credentials;
  try {
    credentials = await prepareSyncCredentials(recoveryKey);
  } catch {
    setSyncStatus(text("sync.invalidRecoveryKey"), "warning");
    return;
  }
  try {
    const { response, data } = await requestSync("GET", credentials);
    if (response.status === 404 && data.error === "sync-deleted") {
      setSyncStatus(text("sync.deleted"), "warning");
      return;
    }
    if (response.status === 404 && data.error === "sync-not-found") {
      syncCredentials = credentials;
      syncRevision = 0;
      setSyncStatus(text("sync.noRemoteCopy"), "neutral");
      updateSyncControls();
      return;
    }
    if (!response.ok) throw Object.assign(new Error("sync.requestFailed"), { data });
    const records = await decryptSnapshot(data.payload, credentials);
    validateSyncRecords(records);
    syncCredentials = credentials;
    syncRevision = Number(data.revision);
    setSyncStatus(text("sync.connected"), "success");
    updateSyncControls();
  } catch (error) {
    setSyncStatus(syncErrorMessage(error), "warning");
  }
}

async function uploadLocalSyncSnapshot() {
  try {
    const { response: latestResponse, data: latest } = await requestSync("GET");
    if (latestResponse.status === 404 && latest.error === "sync-deleted") {
      setSyncStatus(text("sync.deleted"), "warning");
      return;
    }
    if (latestResponse.status === 404 && latest.error === "sync-not-found") syncRevision = 0;
    else if (latestResponse.ok) {
      if (syncRevision !== Number(latest.revision)) {
        setSyncStatus(text("sync.remoteChanged"), "warning");
        return;
      }
      try {
        validateSyncRecords(await decryptSnapshot(latest.payload, syncCredentials));
      } catch {
        setSyncStatus(text("sync.invalidSnapshot"), "warning");
        return;
      }
    } else throw Object.assign(new Error("sync.requestFailed"), { data: latest });
    const payload = await encryptSnapshot(currentSyncSnapshot(), syncCredentials);
    const { response, data } = await requestSync("PUT", syncCredentials, { revision: syncRevision, payload });
    if (response.status === 409) {
      setSyncStatus(text("sync.conflict"), "warning");
      return;
    }
    if (!response.ok) throw Object.assign(new Error("sync.requestFailed"), { data });
    syncRevision = Number(data.revision);
    setSyncStatus(text("sync.uploaded"), "success");
  } catch (error) {
    setSyncStatus(syncErrorMessage(error), "warning");
  }
}

async function restoreRemoteSyncSnapshot() {
  try {
    const { response, data } = await requestSync("GET");
    if (response.status === 404 && data.error === "sync-not-found") {
      syncRevision = 0;
      setSyncStatus(text("sync.noRemoteCopy"), "neutral");
      return;
    }
    if (response.status === 404 && data.error === "sync-deleted") {
      setSyncStatus(text("sync.deleted"), "warning");
      return;
    }
    if (!response.ok) throw Object.assign(new Error("sync.requestFailed"), { data });
    const records = await decryptSnapshot(data.payload, syncCredentials);
    const writes = validateSyncRecords(records);
    if (!writes.length) throw new Error("sync.invalidSnapshot");
    if (!window.confirm(text("sync.restoreConfirm"))) return;
    if (!writeJsonBatch(localStorage, writes)) throw new Error("sync.localWriteFailed");
    syncRevision = Number(data.revision);
    modelSettings = loadModelSettings();
    uiPreferences = readUiPreferences();
    document.querySelector("#plan-form")?.reset();
    restoreProfile();
    applyUiPreferences(uiPreferences);
    syncUiPreferenceControls();
    await loadCopy();
    renderSettingsAssumptions();
    applyModelSettingsToSimulation();
    renderHistory();
    renderPortfolio();
    renderDashboard();
    renderMarket(liveMarket, lastKnownMarket);
    setSyncStatus(text("sync.restored"), "success");
  } catch (error) {
    setSyncStatus(
      error?.message === "sync.localWriteFailed" ? text("sync.localWriteFailed") : syncErrorMessage(error),
      "warning",
    );
  }
}

async function deleteRemoteSyncSnapshot() {
  if (!window.confirm(text("sync.deleteConfirm"))) return;
  try {
    const { response: latestResponse, data: latest } = await requestSync("GET");
    if (latestResponse.status === 404 && latest.error === "sync-deleted") {
      syncCredentials = null;
      syncRevision = null;
      updateSyncControls();
      setSyncStatus(text("sync.deleted"), "success");
      return;
    }
    if (latestResponse.status === 404 && latest.error === "sync-not-found") {
      syncRevision = 0;
      setSyncStatus(text("sync.noRemoteCopy"), "neutral");
      return;
    }
    if (!latestResponse.ok) throw Object.assign(new Error("sync.requestFailed"), { data: latest });
    const { response, data } = await requestSync("DELETE", syncCredentials, { revision: Number(latest.revision) });
    if (response.status === 409) {
      setSyncStatus(text("sync.conflict"), "warning");
      return;
    }
    if (!response.ok) throw Object.assign(new Error("sync.requestFailed"), { data });
    syncCredentials = null;
    syncRevision = null;
    $("#sync-recovery-output").hidden = true;
    $("#sync-copy-recovery")?.setAttribute("hidden", "");
    updateSyncControls();
    setSyncStatus(text("sync.deleted"), "success");
  } catch (error) {
    setSyncStatus(syncErrorMessage(error), "warning");
  }
}

function disconnectEncryptedSync() {
  syncCredentials = null;
  syncRevision = null;
  $("#sync-recovery-output").hidden = true;
  $("#sync-copy-recovery")?.setAttribute("hidden", "");
  updateSyncControls();
  setSyncStatus(text("sync.disconnected"), "neutral");
}

async function copyRecoveryKey() {
  const key = $("#sync-recovery-output")?.textContent.match(/SYN1(?:-[0-9A-F]{8}){9}/)?.[0];
  if (!key) return;
  try {
    await navigator.clipboard.writeText(key);
    setSyncStatus(text("sync.keyCopied"), "success");
  } catch {
    setSyncStatus(text("sync.copyUnavailable"), "warning");
  }
}

function readHistory() {
  const current = readJson(HISTORY_KEY, []);
  const old = readJson("investment-plan-history-v3", []);
  try {
    if (localStorage.getItem(HISTORY_KEY) !== null && !Array.isArray(current)) storageWarning = true;
    if (localStorage.getItem("investment-plan-history-v3") !== null && !Array.isArray(old)) storageWarning = true;
  } catch {
    storageWarning = true;
  }
  return mergeHistory(current, old, HISTORY_LIMIT);
}

function readPortfolio() {
  const raw = readJson(PORTFOLIO_KEY, null);
  try {
    const exists = localStorage.getItem(PORTFOLIO_KEY) !== null;
    if (
      exists &&
      (!raw || typeof raw !== "object" || raw.schema !== "invest-consult-portfolio" || !Array.isArray(raw.versions))
    )
      storageWarning = true;
  } catch {
    storageWarning = true;
  }
  return normalizePortfolio(raw);
}

function writePortfolio(portfolio) {
  return writeJson(PORTFOLIO_KEY, normalizePortfolio(portfolio));
}

function emergencyFundSnapshot(expenses = numberFromInput($("#essential-monthly-expenses")?.value)) {
  if (!(expenses > 0)) return { months: null, status: legacyEmergencyFund };
  const portfolio = calculatePortfolio(readPortfolio(), liveMarket || {});
  const months = portfolio.liquidTotal / expenses;
  return { months, status: months >= 6 ? "complete" : months >= 1 ? "partial" : "none" };
}

function localDateTimeValue(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function dateTimeInputToIso(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function createManualQuoteId() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return `manual-${cryptoApi.randomUUID()}`;
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return `manual-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return `manual-${Date.now()}-${performance.now().toFixed(3)}`;
}

function inflationRateForPortfolio() {
  const rate = Number(modelSettings?.inflationRate);
  return Number.isFinite(rate) ? rate : 0.3;
}

function getProfile() {
  const ageInput = $("#age").value.trim();
  const essentialMonthlyExpenses = Math.max(0, numberFromInput($("#essential-monthly-expenses")?.value));
  const emergency = emergencyFundSnapshot(essentialMonthlyExpenses);
  return {
    age: ageInput ? numberFromInput(ageInput) : undefined,
    horizonYears: numberFromInput($("#horizon").value),
    goal: $("#goal").value,
    riskTolerance: $("#risk-tolerance").value,
    incomeStability: $("#income-stability").value,
    emergencyFund: emergency.status,
    emergencyCoverageMonths: emergency.months,
    essentialMonthlyExpenses,
  };
}

function getPlanInputs() {
  const salary = numberFromInput($("#salary").value);
  const contributionRate = clamp(numberFromInput($("#contribution-rate").value), 5, 40);
  const profile = getProfile();
  return {
    salary,
    contributionRate,
    monthlyContribution: (salary * contributionRate) / 100,
    profile,
    selectedAssets: $$("[data-recommendation-asset]:checked").map((input) => input.dataset.recommendationAsset),
    allowMicroAllocation: Boolean($("#allow-micro-allocation")?.checked),
  };
}

function selectedPlanAssetKeys(selectedAssets = []) {
  const selected = new Set(selectedAssets);
  return [...CORE_PLAN_ASSET_KEYS, ...OPTIONAL_RECOMMENDATION_ASSETS.filter((assetId) => selected.has(assetId))];
}

function syncPlanState() {
  const inputs = getPlanInputs();
  appStore.setState({ profile: inputs.profile, monthlyInvestment: inputs.monthlyContribution });
}

function persistProfile() {
  const inputs = getPlanInputs();
  const profile = {
    ...inputs.profile,
    salary: inputs.salary,
    contributionRate: inputs.contributionRate,
  };
  writeJson(PROFILE_KEY, profile);
}

function restoreProfile() {
  const profile = readJson(PROFILE_KEY, null);
  if (!profile) return;
  ["age", "horizon"].forEach((key) => {
    const source = key === "age" ? profile.age : profile.horizonYears;
    if (source) $("#" + key).value = source;
  });
  legacyEmergencyFund = ["complete", "partial", "none"].includes(profile.emergencyFund)
    ? profile.emergencyFund
    : "partial";
  ["goal", "riskTolerance", "incomeStability"].forEach((key) => {
    const aliases = {
      riskTolerance: "risk-tolerance",
      incomeStability: "income-stability",
      emergencyFund: "emergency-fund",
    };
    const element = $("#" + (aliases[key] || key));
    if (element && profile[key]) element.value = profile[key];
  });
  if (Number.isFinite(Number(profile.salary)) && Number(profile.salary) > 0) $("#salary").value = profile.salary;
  if (Number.isFinite(Number(profile.essentialMonthlyExpenses)))
    $("#essential-monthly-expenses").value = Math.max(0, profile.essentialMonthlyExpenses);
  if (Number.isFinite(Number(profile.contributionRate)))
    $("#contribution-rate").value = clamp(profile.contributionRate, 5, 40);
}

function marketSnapshot(market) {
  if (!market) return null;
  const snapshot = { capturedAt: market.updatedAt || new Date().toISOString(), assets: {}, funds: {} };
  Object.entries(market.assets || {}).forEach(([key, item]) => {
    if (item && item.price !== null && Number.isFinite(Number(item.price)))
      snapshot.assets[key] = {
        price: Number(item.price),
        changePct:
          item.changePct !== null &&
          item.changePct !== undefined &&
          item.changePct !== "" &&
          Number.isFinite(Number(item.changePct))
            ? Number(item.changePct)
            : null,
        unit: item.unit || null,
        sourceCount: Number(item.sourceCount) || 0,
        configuredSourceCount: Number(item.configuredSourceCount) || 0,
        spreadPct:
          item.spreadPct !== null && item.spreadPct !== undefined && Number.isFinite(Number(item.spreadPct))
            ? Number(item.spreadPct)
            : null,
        sources: Array.isArray(item.sources) ? item.sources.slice(0, 8) : [],
        sourceValues: Array.isArray(item.sourceValues) ? item.sourceValues.slice(0, 8) : [],
        sleeveId: item.sleeveId || null,
        observedAt: item.observedAt || item.asOf || null,
        retrievedAt: item.retrievedAt || market.updatedAt || null,
        quoteType: item.quoteType || "direct",
        derivedFrom: Array.isArray(item.derivedFrom) ? item.derivedFrom.slice(0, 5) : [],
        dependencies: Array.isArray(item.dependencies) ? item.dependencies.slice(0, 5) : [],
        status: item.status || "healthy",
        confidence: item.confidence || null,
        consensusPolicyVersion: item.consensusPolicyVersion || null,
        consensusCalibrated: item.consensusCalibrated === true,
        agreementTolerancePct:
          item.agreementTolerancePct !== null &&
          item.agreementTolerancePct !== undefined &&
          Number.isFinite(Number(item.agreementTolerancePct))
            ? Number(item.agreementTolerancePct)
            : null,
        consensusMethod: item.consensusMethod || null,
        consensusDisagreement: item.consensusDisagreement === true,
        unknownObservationCount: Number(item.unknownObservationCount) || 0,
        acceptedSpreadPct: Number.isFinite(Number(item.acceptedSpreadPct)) ? Number(item.acceptedSpreadPct) : null,
      };
  });
  const fixed = market.funds && market.funds.fixedIncome;
  if (
    fixed &&
    fixed.effectiveAnnualReturn !== null &&
    fixed.effectiveAnnualReturn !== undefined &&
    Number.isFinite(Number(fixed.effectiveAnnualReturn))
  )
    snapshot.funds.fixedIncome = {
      effectiveAnnualReturn: Number(fixed.effectiveAnnualReturn),
      observedAt: fixed.observedAt || fixed.asOf || null,
      retrievedAt: fixed.retrievedAt || market.updatedAt || null,
      sourceCount: Number(fixed.sourceCount) || 0,
      sources: Array.isArray(fixed.sources) ? fixed.sources.slice(0, 8) : [],
    };
  return Object.keys(snapshot.assets).length || Object.keys(snapshot.funds).length ? snapshot : null;
}

function marketValueUnit(item, currency = "TOMAN") {
  if (item?.unit === "point") return "نقطه";
  if (item?.unit === "gram") return `${currencyName(currency)}/گرم`;
  if (item?.unit === "coin") return `${currencyName(currency)}/واحد`;
  return currencyName(currency);
}

function formatMarketPrice(price, item) {
  if (item?.unit === "point") return `${formatIRR(price)} ${marketValueUnit(item)}`;
  const currency = preferredCurrency(uiPreferences);
  const converted = displayCurrencyValue(price, currency, activeFxQuotes());
  const displayCurrency = converted ? currency : "TOMAN";
  const amount = converted
    ? new Intl.NumberFormat(currentLocale().numberLocale, {
        maximumFractionDigits: displayCurrency === "TOMAN" ? 0 : converted.amount < 100 ? 2 : 0,
      }).format(converted.amount)
    : formatIRR(price);
  return `${amount} ${marketValueUnit(item, displayCurrency)}`;
}

function marketUnavailableMessage(item, diagnostics) {
  if (item?.status === "conflicted" || diagnostics?.status === "conflicted") return text("market.conflicted");
  if (diagnostics?.reason === "currency_conflicted") return text("market.currencyConflict");
  if (diagnostics?.reason === "currency_unavailable") return text("market.currencyUnavailable");
  return text("market.unavailable");
}

function marketSourceCoverageLabel(item, diagnostics) {
  const accepted = Number(item?.sourceCount ?? diagnostics?.successful) || 0;
  const configured = Number(item?.configuredSourceCount ?? diagnostics?.attempted) || 0;
  const attempted = configured || Math.max(accepted, Array.isArray(item?.sources) ? item.sources.length : 0);
  if (attempted > 0)
    return text("market.sourceCoverage", "Accepted / attempted sources: {accepted}/{attempted}")
      .replaceAll("{accepted}", formatIRR(accepted))
      .replaceAll("{attempted}", formatIRR(attempted));
  return `${formatIRR(accepted)} ${text("market.sources", "source")}`;
}

function marketSourceLabelMarkup(source) {
  if (source === "MetalCharts")
    return `${escapeHTML(text("market.metalChartsCredit", "Metal prices by"))} <a href="https://metalcharts.org/" target="_blank" rel="noopener noreferrer">MetalCharts</a>`;
  if (source === "GoldPrice.com")
    return `<a href="https://goldprice.com/" target="_blank" rel="noopener noreferrer">GoldPrice.com</a>`;
  if (source === "Standard Bullion")
    return `${escapeHTML(text("market.standardBullionCredit", "Data by"))} <a href="https://standardbullion.com/market-data" target="_blank" rel="noopener noreferrer">Standard Bullion</a>`;
  return escapeHTML(source || "منبع بازار");
}

function lastKnownPriceMarkup(assetId, data, cachedMarket, currentItem) {
  const quote = lastKnownMarketQuote(assetId, data, cachedMarket);
  if (!quote) return "";
  const attribution = Array.isArray(quote.sources)
    ? quote.sources
        .filter((source) => ["MetalCharts", "GoldPrice.com", "Standard Bullion"].includes(source))
        .map((source) => ` · ${marketSourceLabelMarkup(source)}`)
        .join("")
    : "";
  return `<small class="market-last-known"><strong>${escapeHTML(text("market.lastKnown", "آخرین مقدار ثبت‌شده"))}:</strong> <bdi dir="auto">${escapeHTML(formatMarketPrice(quote.price, { unit: quote.unit || currentItem?.unit || INSTRUMENT_REGISTRY[assetId]?.unit }))}</bdi> · ${escapeHTML(text("market.lastKnownObserved", "مشاهده"))} ${escapeHTML(formatDateTime(quote.observedAt))} · ${escapeHTML(freshnessLabel(quote.observedAt))}${attribution}</small>`;
}

function marketConflictSourcesMarkup(item) {
  if (item?.status !== "conflicted" || !Array.isArray(item.sourceValues) || !item.sourceValues.length) return "";
  const values = item.sourceValues
    .map((source) => {
      const observed = source.observedAt ? formatDateTime(source.observedAt) : "زمان مشاهده نامشخص";
      return `<div class="market-conflict-source"><strong>${marketSourceLabelMarkup(source.source)}</strong><b><bdi dir="auto">${escapeHTML(formatMarketPrice(source.price, item))}</bdi></b><small>زمان مشاهده: ${escapeHTML(observed)}</small></div>`;
    })
    .join("");
  return `<div class="market-conflict-values" aria-label="مقادیر منابع متعارض">${values}</div>`;
}

function renderMarket(data, cachedMarket = lastKnownMarket) {
  if ((!data || !data.assets) && !cachedMarket) {
    marketDataEl.innerHTML = `<div class="empty-state">${escapeHTML(text("market.empty", "داده بازار در دسترس نیست."))}</div>`;
    $("#market-updated").textContent = "—";
    $("#market-coverage").textContent = "—";
    renderMarketDiagnostics(null);
    return;
  }
  const currentMarket = data && data.assets ? data : { assets: {}, funds: {}, history: {} };
  const labels = text("market.labels", {});
  const cards = Object.entries(labels)
    .map(([key, label]) => {
      const item = currentMarket.assets[key];
      const hasPrice =
        item && item.status !== "conflicted" && item.price !== null && Number.isFinite(Number(item.price));
      if (!hasPrice) {
        const assetDiagnostics = currentMarket.diagnostics?.assets?.[key];
        const detail = marketUnavailableMessage(item, assetDiagnostics);
        const coverage = marketSourceCoverageLabel(item, assetDiagnostics);
        const lastKnown = lastKnownPriceMarkup(key, currentMarket, cachedMarket, item);
        const conflictValues = marketConflictSourcesMarkup(item);
        return `<div class="market-row market-row-unavailable"><div><span class="asset-dot asset-${key === "dollar" ? "currency" : key}"></span><strong>${escapeHTML(label.title)}</strong><small>${escapeHTML(label.detail)}</small></div><div class="market-value"><strong>—</strong><small>${escapeHTML(detail)} · ${escapeHTML(coverage)}</small>${conflictValues}${lastKnown}</div></div>`;
      }
      const change =
        item.changePct === null || item.changePct === undefined || item.changePct === "" ? NaN : Number(item.changePct);
      const changeLabel = Number.isFinite(change)
        ? `${change > 0 ? "+" : ""}${formatPercent(change)}`
        : text("market.noChange", "\u2014");
      const changeClass = change > 0.05 ? "positive" : change < -0.05 ? "negative" : "muted";
      const timeLabels = marketTimeLabels(item, currentMarket.updatedAt);
      const quality = item.consensusDisagreement
        ? "اختلاف منابع؛ عدد میانه با اطمینان پایین"
        : text(`market.quality.${item.status || "healthy"}`);
      const basis = text(`market.quoteType.${item.quoteType || "direct"}`);
      const coverage = marketSourceCoverageLabel(item, currentMarket.diagnostics?.assets?.[key]);
      return `<div class="market-row"><div><span class="asset-dot asset-${key === "dollar" ? "currency" : key}"></span><strong>${escapeHTML(label.title)}</strong><small>${escapeHTML(label.detail)} · ${escapeHTML(basis)}</small></div><div class="market-value"><strong><bdi dir="auto">${escapeHTML(formatMarketPrice(item.price, item))}</bdi></strong><span class="${changeClass}"><bdi dir="auto">${changeLabel}</bdi></span><small>${escapeHTML(quality)} · ${escapeHTML(coverage)}</small><small>${escapeHTML(timeLabels)}</small>${marketConsensusNote(item)}${item.reconciliationNote ? `<small class="data-note-warning">${escapeHTML(item.reconciliationNote)}</small>` : ""}${marketSourceValuesMarkup(item)}</div></div>`;
    })
    .join("");
  const fixed = currentMarket.funds && currentMarket.funds.fixedIncome;
  const fixedCard =
    fixed &&
    fixed.effectiveAnnualReturn !== null &&
    fixed.effectiveAnnualReturn !== undefined &&
    Number.isFinite(Number(fixed.effectiveAnnualReturn))
      ? `<div class="market-row"><div><span class="asset-dot asset-fixed"></span><strong>${escapeHTML(text("assets.fixed.title"))}</strong><small>${escapeHTML(text("market.fixedDetail"))}</small></div><div class="market-value"><strong><bdi dir="auto">${formatPercent(fixed.effectiveAnnualReturn)}</bdi></strong><small>${escapeHTML(text("market.annual"))} · ${escapeHTML(marketSourceCoverageLabel(fixed, currentMarket.diagnostics?.funds?.fixedIncome))}</small><small>${escapeHTML(marketTimeLabels(fixed, currentMarket.updatedAt))}</small></div></div>`
      : `<div class="market-row market-row-unavailable"><div><span class="asset-dot asset-fixed"></span><strong>${escapeHTML(text("assets.fixed.title"))}</strong><small>${escapeHTML(text("market.fixedDetail"))}</small></div><div class="market-value"><strong>—</strong><small>${escapeHTML(text("market.unavailable"))} · ${escapeHTML(marketSourceCoverageLabel(null, currentMarket.diagnostics?.funds?.fixedIncome))}</small></div></div>`;
  marketDataEl.innerHTML =
    cards + fixedCard ||
    `<div class="empty-state">${escapeHTML(text("market.empty", "داده بازار در دسترس نیست."))}</div>`;
  $("#market-updated").textContent =
    currentMarket.diagnostics && currentMarket.updatedAt
      ? `${text("market.updated", "آخرین خوانش")} ${formatDateTime(currentMarket.updatedAt)}`
      : text("market.liveUnavailable", "قیمت زنده معتبر دریافت نشده است");
  const sourceTotal = Object.values(currentMarket.assets).reduce(
    (total, item) => total + (Number(item.sourceCount) || 0),
    0,
  );
  $("#market-coverage").textContent = `${sourceTotal} ${text("market.sourceQuotes", "قیمت معتبر")}`;
  renderMarketDiagnostics(data);
}

function latestPlanSnapshot() {
  if (lastPlan) return lastPlan;
  const latest = readHistory()[0];
  if (!latest) return null;
  return {
    inputs: {
      monthlyContribution: latest.total,
      contributionRate: latest.contributionRate,
      profile: latest.profile || { riskTolerance: "conservative", horizonYears: 5, emergencyFund: "partial" },
    },
    recommendation: { weights: latest.weights || {} },
    contribution: { amounts: latest.contributionPlan || {} },
    monteCarlo: null,
  };
}

function readDashboardPortfolio() {
  const portfolio = readPortfolio();
  const inflationRate = inflationRateForPortfolio();
  const result = calculatePortfolio(portfolio, liveMarket || {}, new Date().toISOString(), inflationRate);
  return { portfolio, result, hasTransactions: result.transactions.length > 0 };
}

function dashboardCurrency(value) {
  return Number.isFinite(Number(value)) ? formatDisplayMoney(value) : "—";
}

function setDashboardMetric(valueId, noteId, value, note, state = "ready") {
  const valueElement = $(`#${valueId}`);
  const noteElement = $(`#${noteId}`);
  if (valueElement) {
    valueElement.textContent = value;
    valueElement.classList.remove("positive", "negative", "muted");
  }
  if (noteElement) noteElement.textContent = note;
  const card = valueElement?.closest(".summary-card");
  if (card) {
    card.dataset.state = state;
    card.setAttribute("aria-busy", state === "loading" ? "true" : "false");
  }
}

function freshnessLabel(value) {
  if (value === null || value === undefined || value === "") return text("market.observationUnknown");
  const timestamp = new Date(value || 0).getTime();
  if (!Number.isFinite(timestamp)) return "زمان نامشخص";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  const relative = new Intl.RelativeTimeFormat(currentLocale().numberLocale, { numeric: "auto" });
  if (minutes < 2) return relative.format(0, "minute");
  if (minutes < 60) return relative.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return relative.format(-hours, "hour");
  return relative.format(-Math.round(hours / 24), "day");
}

function marketTimeLabels(item, retrievedFallback = null) {
  const observedAt = item?.observedAt || item?.asOf || null;
  const retrievedAt = item?.retrievedAt || retrievedFallback;
  const observed = observedAt
    ? `${text("market.observedAt")}: ${freshnessLabel(observedAt)}`
    : text("market.observationUnknown");
  const retrieved = retrievedAt ? `${text("market.retrievedAt")}: ${freshnessLabel(retrievedAt)}` : "";
  return retrieved ? `${observed} · ${retrieved}` : observed;
}

function confidenceLabel(item) {
  const count = Number(item?.sourceCount) || 0;
  if (item?.consensusDisagreement) return { label: "اختلاف منابع؛ برآورد میانه", className: "confidence-low" };
  if (Number(item?.unknownObservationCount) > 0)
    return { label: "زمان مشاهده‌ی برخی نرخ‌ها نامشخص", className: "confidence-low" };
  if (item?.status === "provisional" || item?.confidence === "medium")
    return { label: "اعتماد متوسط", className: "confidence-medium" };
  if (item?.confidence === "low" && count > 1) return { label: "اطمینان پایین", className: "confidence-low" };
  if (count >= 3) return { label: "اعتماد بالا", className: "confidence-high" };
  if (count === 2) return { label: "اعتماد متوسط", className: "confidence-medium" };
  if (count === 1) return { label: "یک منبع", className: "confidence-low" };
  return { label: "در دسترس نیست", className: "confidence-none" };
}

function marketSourceValuesMarkup(item) {
  const values = Array.isArray(item?.sourceValues) ? item.sourceValues : [];
  if (!values.length) return "";
  const accepted = new Set(Array.isArray(item?.sources) ? item.sources : []);
  return `<div class="market-source-list" aria-label="قیمت‌های دریافت‌شده از منابع">${values
    .slice(0, 5)
    .map((source) => {
      const conflict =
        item?.status === "conflicted" ||
        source.accepted === false ||
        (accepted.size > 0 && !accepted.has(source.source));
      const quote = `${formatMarketPrice(source.price, item)} · ${source.source}`;
      const observed = source.observedAt ? ` · ${formatDateTime(source.observedAt)}` : "";
      const exclusion =
        source.accepted === false
          ? source.exclusionReason === "older-observation"
            ? " · قدیمی‌تر از نرخ‌های تازه"
            : source.exclusionReason === "statistical-outlier"
              ? " · پرت؛ در برآورد لحاظ نشد"
              : " · در برآورد لحاظ نشد"
          : "";
      return `<span class="${conflict ? "is-outlier" : ""}" title="${escapeHTML(quote + observed + exclusion)}"><bdi dir="auto">${escapeHTML(formatMarketPrice(source.price, item))}</bdi> · ${marketSourceLabelMarkup(source.source)}${escapeHTML(exclusion)}</span>`;
    })
    .join("")}</div>`;
}

function marketConsensusNote(item) {
  if (!item?.consensusDisagreement && !(Number(item?.unknownObservationCount) > 0)) return "";
  const sourceCount = Number(item.sourceCount) || 0;
  const spread = Number(item.spreadPct);
  const notes = [];
  if (item.consensusDisagreement) {
    const spreadLabel = Number.isFinite(spread)
      ? `اختلاف حدود ${formatPercent(spread / 100, 2)} بین منابع`
      : "اختلاف بین منابع";
    notes.push(`${spreadLabel}؛ میانه‌ی ${formatIRR(sourceCount)} منبع به‌عنوان برآورد استفاده شده است.`);
  }
  if (Number(item.unknownObservationCount) > 0)
    notes.push(`زمان مشاهده‌ی ${formatIRR(item.unknownObservationCount)} منبع مشخص نیست.`);
  return `<small class="data-note-warning">${escapeHTML(notes.join(" "))}</small>`;
}

function dashboardPerformancePoints(portfolio, result) {
  if (!result.trackingStart || !result.transactions.length) return [];
  const asOf = new Date().toISOString();
  const inflationRate = inflationRateForPortfolio();
  return portfolioSeries(portfolio, liveMarket || {}, result.trackingStart, asOf, inflationRate).map((point) => {
    const state = calculatePortfolio(portfolio, liveMarket || {}, point.date, inflationRate);
    const complete = state.missingPrices.length === 0;
    return {
      date: point.date,
      label: formatDate(point.date),
      value: complete ? state.currentValue : null,
      realValue: complete ? state.realValue : null,
      invested: state.netInvested,
    };
  });
}

function filterDashboardRange(points) {
  if (dashboardRange === "ALL" || !points.length) return points;
  const days = dashboardRange === "1M" ? 31 : dashboardRange === "6M" ? 183 : 365;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const filtered = points.filter((point) => new Date(point.date).getTime() >= cutoff);
  const prior = points.filter((point) => new Date(point.date).getTime() < cutoff).at(-1);
  return prior ? [prior, ...filtered] : filtered;
}

function renderDashboardPerformance() {
  const container = $("#dashboard-performance-chart");
  if (!container) return;
  const { portfolio, result } = readDashboardPortfolio();
  const marketLoading =
    result.transactions.length > 0 && result.missingPrices.length > 0 && appStore.getState().marketStatus === "loading";
  if (marketLoading) {
    container.innerHTML = `<div class="chart-loading" aria-busy="true">در حال دریافت قیمت‌های لازم برای ارزش‌گذاری…</div>`;
    return;
  }
  const points = filterDashboardRange(dashboardPerformancePoints(portfolio, result));
  container.innerHTML = lineChartMarkup({
    series: [
      {
        name: text("dashboard.investedSeries", "سرمایه خالص"),
        color: "#8997a0",
        points: points.map((point) => ({ value: point.invested, label: point.label })),
      },
      {
        name: text("dashboard.nominalSeries", "ارزش اسمی"),
        color: "#126b62",
        points: points.map((point) => ({ value: point.value, label: point.label })),
      },
      {
        name: text("dashboard.realSeries", "ارزش پس از تورم"),
        color: "#c18a2c",
        points: points.map((point) => ({ value: point.realValue, label: point.label })),
      },
    ],
    ariaLabel: text("dashboard.performanceChart", "روند ارزش پرتفوی و سرمایه خالص"),
    emptyLabel: result.transactions.length
      ? "تاریخچه قیمت کافی برای رسم این روند نیست."
      : "با ثبت دارایی و دریافت قیمت تاریخی، روند اینجا نمایش داده می‌شود.",
    valueLabel: formatDisplayMoney,
    height: 280,
  });
}

function renderDashboardAllocation(result, plan, portfolio) {
  const chart = $("#dashboard-allocation-chart");
  const list = $("#dashboard-allocation-list");
  if (!chart || !list) return;
  const marketLoading =
    result.transactions.length > 0 && result.missingPrices.length > 0 && appStore.getState().marketStatus === "loading";
  if (marketLoading) {
    chart.innerHTML = `<div class="chart-loading" aria-busy="true">در حال دریافت قیمت‌های لازم…</div>`;
    list.innerHTML = `<div class="chart-loading allocation-loading" aria-busy="true">مقایسه فعلی و هدف بعد از به‌روزرسانی قیمت‌ها نمایش داده می‌شود.</div>`;
    return;
  }
  const complete = result.transactions.length > 0 && result.missingPrices.length === 0;
  const availableAssetIds = Object.keys(result.assets || {});
  const actual = availableAssetIds
    .map((assetId) => ({
      assetId,
      value: complete ? Number(result.values[assetId]?.value) || 0 : 0,
      percent: complete ? Number(result.allocation[assetId]) || 0 : 0,
    }))
    .filter((item) => item.value > 0);
  chart.innerHTML = donutChartMarkup({
    segments: actual.map((item) => ({
      name: portfolioAssetMeta(item.assetId, portfolio).title,
      userContent: Boolean(portfolio.assets?.[item.assetId] && portfolio.assets[item.assetId].kind !== "legacy-stock"),
      value: item.value,
      color: getAssetColor(item.assetId),
      percentLabel: formatPercent(item.percent),
    })),
    centerLabel: "ارزش سبد",
    centerValue: complete ? dashboardCurrency(result.currentValue) : "—",
    emptyLabel:
      result.transactions.length && result.missingPrices.length
        ? "برای بعضی دارایی‌ها قیمت در دسترس نیست."
        : "هنوز تخصیصی برای نمایش نیست.",
  });
  const target = plan?.recommendation?.weights || {};
  const planToPortfolioAsset = {
    fixed: "fixed",
    gold: "gold",
    currency: "currency",
    silver: "silver",
    bitcoin: "bitcoin",
    ethereum: "ethereum",
    platinum: "platinum",
    palladium: "palladium",
    copper: "copper",
  };
  const allocationBars = [...new Set([...Object.keys(target), ...PLAN_ASSET_KEYS])]
    .filter((planAssetId) => Object.hasOwn(planToPortfolioAsset, planAssetId))
    .map((planAssetId) => {
      const assetId = planToPortfolioAsset[planAssetId];
      return {
        label: portfolioAssetMeta(assetId, portfolio).title,
        actual: complete ? Number(result.allocation[assetId]) || 0 : null,
        target: Number.isFinite(Number(target[planAssetId])) ? Number(target[planAssetId]) : null,
        color: getAssetColor(assetId),
      };
    })
    .filter((item) => item.actual !== null || item.target !== null);
  const allocationBarsContainer = $("#dashboard-allocation-bars");
  if (allocationBarsContainer)
    allocationBarsContainer.innerHTML = allocationBarChartMarkup({
      items: allocationBars,
      ariaLabel: text("dashboard.allocationChart", "تخصیص فعلی و هدف برحسب درصد"),
      emptyLabel: text("dashboard.allocationChartEmpty", "داده تخصیص برای نمودار موجود نیست."),
      actualLabel: text("allocation.current", "فعلی"),
      targetLabel: text("allocation.target", "هدف"),
      valueLabel: (value) => formatPercent(value),
    });
  const rowAssetIds = [...new Set([...PLAN_ASSET_KEYS, ...actual.map((item) => item.assetId)])];
  const rows = rowAssetIds
    .filter((assetId) => actual.some((item) => item.assetId === assetId) || Number(target[assetId]) > 0)
    .map((assetId) => {
      const actualPercent = Number(result.allocation[assetId]) || 0;
      const targetPercent = Number(target[assetId]);
      const hasTarget = Number.isFinite(targetPercent);
      const delta = hasTarget ? actualPercent - targetPercent : null;
      const warning = hasTarget && Math.abs(delta) >= 10;
      const meta = portfolioAssetMeta(assetId, portfolio);
      return `<div class="allocation-compare-row"><div><span class="asset-dot ${escapeHTML(meta.dotClass)}"></span><strong${portfolioAssetUserContentAttribute(assetId, portfolio)}>${escapeHTML(meta.title)}</strong></div><span>${complete ? formatPercent(actualPercent) : "—"}</span><span>${hasTarget ? formatPercent(targetPercent) : "—"}</span><small class="${warning ? "allocation-warning" : ""}">${hasTarget ? `${delta > 0 ? "+" : ""}${formatPercent(delta)} ${warning ? "· نیازمند توجه" : ""}` : "هدف ثبت نشده"}</small></div>`;
    })
    .join("");
  list.innerHTML = rows || `<div class="empty-state">با ثبت پرتفوی یا ساخت برنامه، مقایسه نمایش داده می‌شود.</div>`;
}

function renderDashboardHealth(result, plan) {
  const container = $("#dashboard-health-list");
  if (!container) return;
  const transactions = result.transactions || [];
  const months = new Set(
    transactions
      .filter((item) => ["OPENING", "BUY", "DEPOSIT"].includes(item.type))
      .map((item) => String(item.date).slice(0, 7)),
  );
  const consistency = transactions.length
    ? months.size >= 3
      ? ["خوب", "ثبت واریز در چند ماه مختلف دیده می‌شود.", "health-good"]
      : ["اطلاعات کم", "برای قضاوت درباره نظم واریز، چند ماه دیگر سابقه لازم است.", "health-neutral"]
    : ["در دسترس نیست", "هنوز تراکنشی برای سنجش نظم واریز ثبت نشده.", "health-neutral"];
  const held = Object.values(result.values || {}).filter((item) => Number(item.quantity) > 0 && Number(item.value) > 0);
  const diversification = !held.length
    ? ["در دسترس نیست", "هنوز دارایی قابل ارزش‌گذاری ثبت نشده.", "health-neutral"]
    : held.length >= 3
      ? ["خوب", `${formatIRR(held.length)} دسته دارایی در سبد ارزش‌گذاری شده است.`, "health-good"]
      : ["تک‌محور", "تعداد دسته‌های دارایی کم است؛ این هشدار توصیه خرید نیست.", "health-warning"];
  const emergency = plan?.inputs?.profile?.emergencyFund;
  const emergencyState =
    emergency === "complete"
      ? ["ثبت‌شده", "صندوق اضطراری کامل اعلام شده است.", "health-good"]
      : emergency === "none"
        ? ["نیازمند توجه", "قبل از افزایش نرخ سرمایه‌گذاری، صندوق اضطراری را بررسی کن.", "health-warning"]
        : emergency === "partial"
          ? ["نسبی", "صندوق اضطراری کامل اعلام نشده است.", "health-warning"]
          : ["در دسترس نیست", "این گزینه در پروفایل برنامه ثبت نشده.", "health-neutral"];
  const maxAllocation = result.missingPrices.length
    ? null
    : Math.max(
        0,
        ...held.map(
          (item) =>
            Number(result.allocation[Object.keys(result.values).find((key) => result.values[key] === item)]) || 0,
        ),
      );
  const concentration =
    !held.length || maxAllocation === null
      ? ["در دسترس نیست", "برای سنجش تمرکز، ارزش‌گذاری کامل لازم است.", "health-neutral"]
      : maxAllocation > 75
        ? ["بالا", `بیشترین وزن تقریبا ${formatPercent(maxAllocation)} است.`, "health-warning"]
        : maxAllocation > 55
          ? ["متوسط", `بیشترین وزن تقریبا ${formatPercent(maxAllocation)} است.`, "health-warning"]
          : ["قابل قبول", `بیشترین وزن تقریبا ${formatPercent(maxAllocation)} است.`, "health-good"];
  const tracking = !transactions.length
    ? ["در دسترس نیست", "برای سنجش کامل بودن ردیابی، حداقل یک رویداد و قیمت معتبر لازم است.", "health-neutral"]
    : result.missingPrices.length
      ? ["ناقص", `برای ${formatIRR(result.missingPrices.length)} دارایی قیمت معتبر ثبت نشده است.`, "health-warning"]
      : ["کامل", "همه دارایی‌های دارای موجودی، قیمت قابل استفاده دارند.", "health-good"];
  const items = [
    ["نظم واریز", consistency],
    ["تنوع دارایی", diversification],
    ["صندوق اضطراری", emergencyState],
    ["ریسک تمرکز", concentration],
    ["کامل بودن ردیابی", tracking],
  ];
  container.innerHTML = items
    .map(
      ([label, [status, detail, className]]) =>
        `<div class="health-item"><span class="health-dot ${className}"></span><div><strong>${escapeHTML(label)}</strong><small>${escapeHTML(detail)}</small></div><b class="${className}">${escapeHTML(status)}</b></div>`,
    )
    .join("");
}

function getAssetColor(assetId) {
  return (
    {
      fixed: "#126b62",
      gold: "#c18a2c",
      currency: "#4979a7",
      silver: "#8997a0",
      stocks: "#8b5bb7",
      cash: "#4c9c6d",
      other: "#c56c4a",
      bitcoin: "#f7931a",
      ethereum: "#627eea",
      tether: "#26a17b",
      platinum: "#8a9aa8",
      palladium: "#6d7480",
      copper: "#b87333",
      bourseIndex: "#7c5cbf",
    }[assetId] || "#126b62"
  );
}

function renderMarketSnapshot(data, cachedMarket = lastKnownMarket) {
  const container = $("#dashboard-market-snapshot");
  const status = $("#dashboard-market-status");
  if (!container || !status) return;
  if ((!data || !data.assets) && !cachedMarket) {
    status.textContent = text(
      "dashboard.marketUnavailable",
      "داده بازار در دسترس نیست؛ عدد ساختگی نمایش داده نمی‌شود.",
    );
    status.className = "data-note data-note-warning";
    container.innerHTML = `<div class="empty-state">داده بازار در دسترس نیست. از صفحه بازار دوباره تلاش کن.</div>`;
    return;
  }
  const currentMarket = data && data.assets ? data : { assets: {}, funds: {}, history: {} };
  const sourceTotal = Object.values(currentMarket.assets).reduce(
    (total, item) => total + (Number(item?.sourceCount) || 0),
    0,
  );
  status.textContent =
    currentMarket.diagnostics && currentMarket.updatedAt
      ? `${formatIRR(sourceTotal)} قیمت معتبر · ${freshnessLabel(currentMarket.updatedAt)}`
      : text(
          "dashboard.marketUnavailable",
          "داده زنده بازار در دسترس نیست؛ مقدار ثبت‌شده فقط برای مرجع است و در ارزش‌گذاری جاری وارد نمی‌شود.",
        );
  status.className = "data-note";
  const marketKeys = ["gold", "dollar", "silver", "bitcoin", "ethereum", "bourseIndex"];
  const items = marketKeys.map((key) => {
    const item = currentMarket.assets[key];
    const label = text(`market.labels.${key}.title`, text(`assets.${key}.title`, key));
    const hasPrice =
      item &&
      item.status !== "conflicted" &&
      item.price !== null &&
      item.price !== undefined &&
      Number.isFinite(Number(item.price));
    if (!hasPrice) {
      const quality = marketUnavailableMessage(item, currentMarket.diagnostics?.assets?.[key]);
      const lastKnown = lastKnownPriceMarkup(key, currentMarket, cachedMarket, item);
      const conflictValues = marketConflictSourcesMarkup(item);
      return `<article class="market-snapshot-item is-unavailable"><strong>${escapeHTML(label)}</strong><b>—</b><small>${escapeHTML(quality)}</small>${conflictValues}${lastKnown}</article>`;
    }
    const change =
      item.changePct === null || item.changePct === undefined || item.changePct === "" ? NaN : Number(item.changePct);
    const changeClass = change > 0.05 ? "positive" : change < -0.05 ? "negative" : "muted";
    const changeLabel = Number.isFinite(change)
      ? `${change > 0 ? "+" : ""}${formatPercent(change)}`
      : text("market.noChange");
    return `<article class="market-snapshot-item"><div><span class="asset-dot asset-${key === "dollar" ? "currency" : key}"></span><strong>${escapeHTML(label)}</strong></div><b>${escapeHTML(formatMarketPrice(item.price, item))}</b><span class="${changeClass}">${escapeHTML(changeLabel)}</span><small>${escapeHTML(confidenceLabel(item).label)}</small><small>${escapeHTML(marketTimeLabels(item, currentMarket.updatedAt))}</small>${marketConsensusNote(item)}${item.reconciliationNote ? `<small class="data-note-warning">${escapeHTML(item.reconciliationNote)}</small>` : ""}${marketSourceValuesMarkup(item)}</article>`;
  });
  const fixed = currentMarket.funds?.fixedIncome;
  items.push(
    fixed &&
      fixed.effectiveAnnualReturn !== null &&
      fixed.effectiveAnnualReturn !== undefined &&
      Number.isFinite(Number(fixed.effectiveAnnualReturn))
      ? `<article class="market-snapshot-item"><div><span class="asset-dot asset-fixed"></span><strong>درآمد ثابت</strong></div><b>${formatPercent(fixed.effectiveAnnualReturn)}</b><span class="muted">بازده موثر سالانه</span><small>${escapeHTML(confidenceLabel(fixed).label)}</small><small>${escapeHTML(marketTimeLabels(fixed, currentMarket.updatedAt))}</small></article>`
      : `<article class="market-snapshot-item is-unavailable"><strong>درآمد ثابت</strong><b>—</b><small>داده در دسترس نیست</small></article>`,
  );
  container.innerHTML = items.join("");
}

function renderMarketDiagnostics(data) {
  const container = $("#market-diagnostics");
  if (!container) return;
  if (!data?.diagnostics) {
    container.innerHTML = `<div class="empty-state">تشخیص منبع برای این پاسخ در دسترس نیست.</div>`;
    return;
  }
  const providerNames = {
    providerA: "TGJU",
    providerB: "Bonbast",
    providerC: "Navasan",
    auxiliary: "ChartGoldPrice",
    coinGecko: "CoinGecko",
    coinMarketCap: "CoinMarketCap",
    nobitex: "Nobitex",
    binance: "Binance",
    coinbase: "Coinbase",
    kraken: "Kraken",
    goldApi: "Gold API",
    goldPrice: "GoldPrice.com",
    standardBullion: "Standard Bullion",
    metalCharts: "MetalCharts",
    metalsLive: "Metals.live",
    yahooMetals: "Yahoo Finance",
    tsetmc: "TSETMC",
    tgjuIndex: "TGJU · شاخص کل",
    tindex: "Tindex",
    fixedIncome: "کاریزما",
  };
  const providers = Object.entries(data.diagnostics.providers || {})
    .map(([id, item]) => {
      const status =
        item.status === "fulfilled"
          ? Number(item.quoteCount) > 0
            ? text("market.providerResponded")
            : text("market.providerEmpty")
          : item.status === "not_configured"
            ? text("market.providerNotConfigured")
            : item.status === "skipped"
              ? text("market.providerSkipped")
              : text("market.providerFailed");
      const failure = item.failureCode ? text(`market.providerFailure.${item.failureCode}`, "") : "";
      const statusDetail = [status, failure].filter(Boolean).join(" · ");
      const label = ["metalCharts", "goldPrice", "standardBullion"].includes(id)
        ? marketSourceLabelMarkup(providerNames[id])
        : escapeHTML(providerNames[id] || id);
      return `<div class="diagnostic-row"><div><strong>${label}</strong><small>${escapeHTML(statusDetail)}</small></div><b>${formatIRR(item.quoteCount || 0)} ${escapeHTML(text("market.providerQuotesReturned"))}</b></div>`;
    })
    .join("");
  const coverageItems = Object.entries(data.diagnostics.assets || {});
  const fixedIncomeDiagnostics = data.diagnostics.funds?.fixedIncome;
  if (fixedIncomeDiagnostics) coverageItems.push(["fixedIncome", fixedIncomeDiagnostics]);
  const assets = coverageItems
    .map(([id, item]) => {
      const label =
        id === "fixedIncome"
          ? text("assets.fixed.title")
          : text(`market.labels.${id}.title`, text(`assets.${id}.title`, id));
      const unavailable =
        item.status === "conflicted" || item.reason
          ? marketUnavailableMessage(null, item)
          : text("market.coverageUnavailable");
      const isUsable = Number(item.successful) > 0;
      return `<div class="diagnostic-row"><div><strong>${escapeHTML(label)}</strong><small>${formatIRR(item.successful || 0)} از ${formatIRR(item.attempted || 0)} منبع</small></div><b class="${isUsable ? "positive" : "negative"}">${isUsable ? escapeHTML(text("market.usable")) : escapeHTML(unavailable)}</b></div>`;
    })
    .join("");
  const consensusCalibrated = data.diagnostics.consensusCalibrated;
  const consensusNote =
    consensusCalibrated === true
      ? text("market.consensusCalibrated")
      : consensusCalibrated === false
        ? text("market.consensusUncalibrated")
        : text("market.consensusUnknown");
  const responseTime = Number.isFinite(Number(data.diagnostics.responseTimeMs))
    ? `<p>${escapeHTML(text("market.responseTime"))}: ${formatIRR(data.diagnostics.responseTimeMs)} ${escapeHTML(text("market.milliseconds"))} / ${formatIRR(data.diagnostics.interactiveBudgetMs || 3500)} ${escapeHTML(text("market.milliseconds"))}</p>`
    : "";
  container.innerHTML = `<div><span class="kicker">منابع</span>${providers || `<div class="empty-state">موردی نیست.</div>`}</div><div><span class="kicker">پوشش دارایی</span>${assets || `<div class="empty-state">موردی نیست.</div>`}</div><div class="diagnostic-method"><span class="kicker">روش تجمیع</span><p>${escapeHTML(text("market.aggregationPolicy"))} ${escapeHTML(consensusNote)}</p>${responseTime}</div>`;
}

function renderDashboard() {
  const onboarding = $("#dashboard-onboarding");
  const summary = $("#dashboard-current-value");
  if (!onboarding || !summary) return;
  const plan = latestPlanSnapshot();
  const { portfolio, result, hasTransactions } = readDashboardPortfolio();
  const complete = hasTransactions && result.missingPrices.length === 0;
  const marketLoading =
    hasTransactions && result.missingPrices.length > 0 && appStore.getState().marketStatus === "loading";
  const valuationState = !hasTransactions ? "empty" : marketLoading ? "loading" : complete ? "ready" : "unavailable";
  const empty = !plan && !hasTransactions;
  onboarding.classList.toggle("is-hidden", !empty);

  setDashboardMetric(
    "dashboard-current-value",
    "dashboard-current-value-note",
    complete ? dashboardCurrency(result.currentValue) : "—",
    !hasTransactions
      ? "هنوز دفتر پرتفوی ثبت نشده"
      : marketLoading
        ? "در حال دریافت قیمت‌های بازار"
        : result.missingPrices.length
          ? "قیمت بعضی دارایی‌ها در دسترس نیست"
          : `به‌روزشده ${freshnessLabel(liveMarket?.updatedAt)}`,
    valuationState,
  );
  setDashboardMetric(
    "dashboard-invested",
    "dashboard-invested-note",
    hasTransactions ? dashboardCurrency(result.netInvested) : "—",
    hasTransactions ? `${formatIRR(result.transactions.length)} رویداد در دفتر` : "از دفتر تراکنش‌ها",
    hasTransactions ? "ready" : "empty",
  );
  const pnlValue = complete ? `${result.profitLoss >= 0 ? "+" : ""}${dashboardCurrency(result.profitLoss)}` : "—";
  setDashboardMetric(
    "dashboard-profit-loss",
    "dashboard-profit-loss-note",
    pnlValue,
    complete
      ? "ارزش فعلی منهای سرمایه خالص"
      : marketLoading
        ? "در حال دریافت قیمت‌های بازار"
        : "وقتی ارزش‌گذاری کامل باشد",
    valuationState,
  );
  const pnlEl = $("#dashboard-profit-loss");
  if (complete) pnlEl.classList.add(result.profitLoss >= 0 ? "positive" : "negative");
  const profitLossPercent = complete && result.netInvested > 0 ? (result.profitLoss / result.netInvested) * 100 : null;
  setDashboardMetric(
    "dashboard-profit-loss-percent",
    "dashboard-profit-loss-percent-note",
    profitLossPercent === null ? "—" : `${profitLossPercent >= 0 ? "+" : ""}${formatPercent(profitLossPercent)}`,
    profitLossPercent === null
      ? !hasTransactions
        ? "نسبت به سرمایه خالص"
        : marketLoading
          ? "در حال دریافت قیمت‌های بازار"
          : "وقتی ارزش‌گذاری کامل و سرمایه خالص مشخص باشد"
      : "سود یا زیان تقسیم بر سرمایه خالص",
    profitLossPercent === null ? valuationState : "ready",
  );
  const pnlPercentEl = $("#dashboard-profit-loss-percent");
  if (pnlPercentEl && profitLossPercent !== null)
    pnlPercentEl.classList.add(profitLossPercent >= 0 ? "positive" : "negative");
  const currencyNote = $("#dashboard-currency-note");
  if (currencyNote) {
    const currency = preferredCurrency(uiPreferences);
    const fxQuote = activeFxQuotes()[currency];
    currencyNote.hidden = currency === "TOMAN" || fxQuote?.status === "available";
    currencyNote.textContent =
      fxQuote?.status === "stale"
        ? text("portfolio.fxStaleNote", "نرخ تبدیل کهنه است.")
        : text("portfolio.fxUnavailableNote", "نرخ تبدیل در دسترس نیست؛ مقادیر به تومان نمایش داده می‌شوند.");
  }
  const monthly = Number(plan?.inputs?.monthlyContribution);
  setDashboardMetric(
    "dashboard-monthly-contribution",
    "dashboard-monthly-contribution-note",
    Number.isFinite(monthly) ? dashboardCurrency(monthly) : "—",
    plan ? `${formatPercent(plan.inputs.contributionRate || 0, 0)} از حقوق ماهانه` : "هنوز برنامه‌ای ذخیره نشده",
    plan ? "ready" : "empty",
  );
  setDashboardMetric(
    "dashboard-tracking-duration",
    "dashboard-tracking-duration-note",
    result.trackingStart ? formatTrackingDuration(result.trackingStart) : "—",
    result.trackingStart ? `از ${formatDate(result.trackingStart)}` : "از شروع دفتر پرتفوی",
    result.trackingStart ? "ready" : "empty",
  );
  const topAllocation = complete
    ? Object.keys(result.assets || {})
        .map((assetId) => ({ id: assetId, value: Number(result.allocation[assetId]) || 0 }))
        .sort((a, b) => b.value - a.value)
        .filter((item) => item.value > 0)
        .slice(0, 2)
    : [];
  setDashboardMetric(
    "dashboard-allocation-summary",
    "dashboard-allocation-summary-note",
    topAllocation.length
      ? topAllocation
          .map((item) => `${portfolioAssetMeta(item.id, portfolio).title} ${formatPercent(item.value)}`)
          .join(" · ")
      : "—",
    complete
      ? "از ارزش فعلی دارایی‌ها"
      : marketLoading
        ? "در حال دریافت قیمت‌های بازار"
        : "برای نمایش، موجودی و قیمت لازم است",
    valuationState,
  );
  renderDashboardPerformance();
  renderDashboardAllocation(result, plan, portfolio);
  renderDashboardHealth(result, plan);
  const actionAmount = $("#dashboard-action-amount");
  const actionSuggestion = $("#dashboard-action-suggestion");
  const actionAllocation = $("#dashboard-action-allocation");
  const actionReason = $("#dashboard-action-reason");
  if (plan) {
    actionAmount.textContent = dashboardCurrency(monthly);
    actionSuggestion.textContent = "این مبلغ را طبق وزن‌های برنامه و بدون خرید اجباری بین دسته‌ها پخش کن.";
    const amounts = plan.contribution?.amounts || {};
    const allocationItems = Object.entries(amounts)
      .filter(([, amount]) => Number(amount) > 0)
      .sort((left, right) => Number(right[1]) - Number(left[1]))
      .slice(0, 3);
    if (actionAllocation)
      actionAllocation.innerHTML = allocationItems
        .map(
          ([assetId, amount]) =>
            `<span><i class="asset-dot ${escapeHTML(assetMeta(assetId).dotClass)}"></i>${escapeHTML(assetMeta(assetId).title)} ${escapeHTML(formatDisplayMoney(amount))}</span>`,
        )
        .join("");
    actionReason.textContent =
      plan.inputs.profile?.emergencyFund === "none"
        ? "صندوق اضطراری کامل نیست؛ نرخ و مبلغ را قبل از ثبت نهایی بازبینی کن."
        : "پیشنهاد از هدف، افق و تحمل ریسک ثبت‌شده ساخته شده است.";
  } else {
    actionAmount.textContent = "—";
    actionSuggestion.textContent = "برای دیدن مبلغ و تخصیص پیشنهادی، برنامه ماهانه بساز.";
    if (actionAllocation) actionAllocation.innerHTML = "";
    actionReason.textContent = "بدون ورودی کافی، عددی حدس زده نمی‌شود.";
  }
  renderMarketSnapshot(liveMarket, lastKnownMarket);
}

function assetMeta(key) {
  return text(`assets.${key}`, { title: key, description: "", dotClass: `asset-${key}` });
}

function portfolioAssetMeta(assetId, portfolio = null) {
  const custom = portfolio && portfolio.assets && portfolio.assets[assetId];
  if (custom)
    return {
      title: custom.kind === "legacy-stock" ? "سهام ثبت‌شده قدیمی" : custom.title,
      description: "دارایی سهامی ثبت‌شده توسط تو",
      dotClass: "asset-stocks",
      unit: custom.unit,
    };
  return assetMeta(assetId);
}

function portfolioAssetUserContentAttribute(assetId, portfolio = null) {
  const custom = portfolio?.assets?.[assetId];
  return custom && custom.kind !== "legacy-stock" ? ' data-user-content=""' : "";
}

function portfolioUnitLabel(assetId, unit) {
  if (unit === "gram") return "گرم";
  if (unit === "TOMAN" || unit === "IRR") return text("currencyUnit");
  return text(`portfolio.units.${assetId}`, unit || text("currencyUnit"));
}

function allocationRows(allocation, amounts = null, assetIds = CORE_PLAN_ASSET_KEYS, editable = false) {
  return assetIds
    .map((key) => {
      const meta = assetMeta(key);
      const weight = Number(allocation[key]) || 0;
      const amount = amounts ? amounts[key] : 0;
      const weightControl = editable
        ? `<label class="allocation-weight-input"><input type="number" min="0" max="100" step="0.1" data-plan-weight="${escapeHTML(key)}" aria-label="وزن پیشنهادی ${escapeHTML(meta.title)}" value="${weight}"><span>٪</span></label>`
        : "";
      return `<div class="allocation-row"><div class="allocation-name"><span class="asset-dot ${escapeHTML(meta.dotClass)}"></span><div><strong>${escapeHTML(meta.title)}</strong><small>${escapeHTML(meta.description)}</small></div></div>${weightControl}<div class="allocation-numbers"><strong>${formatPercent(weight)}</strong><small>${escapeHTML(formatDisplayMoney(amount))}</small></div></div>`;
    })
    .join("");
}

function renderReasons(profile, historyPortfolio) {
  const reasons = [];
  if (profile.emergencyFund === "none") reasons.push(text("reasons.emergency"));
  if (profile.horizonYears <= 3) reasons.push(text("reasons.shortHorizon"));
  if (profile.horizonYears >= 10) reasons.push(text("reasons.longHorizon"));
  if (profile.riskTolerance === "conservative") reasons.push(text("reasons.conservative"));
  if (historyPortfolio.totalInvested > 0) reasons.push(text("reasons.history"));
  reasons.push(text("reasons.noForecast"));
  reasonListEl.innerHTML = reasons
    .filter(Boolean)
    .slice(0, 4)
    .map((reason) => `<li>${escapeHTML(reason)}</li>`)
    .join("");
}

function renderContributionPlan(plan, assetIds = CORE_PLAN_ASSET_KEYS) {
  const rows = assetIds
    .map((key) => {
      const meta = assetMeta(key);
      const drift = Number(plan.drift?.[key]) || 0;
      const driftLabel = `${drift > 0 ? "+" : ""}${formatPercent(drift)} ${text("allocation.percentagePoints")}`;
      return `<div class="contribution-row"><span><span class="asset-dot ${escapeHTML(meta.dotClass)}"></span>${escapeHTML(meta.title)}<small>${escapeHTML(text("allocation.current"))} ${formatPercent(plan.currentWeights?.[key] || 0)} · ${escapeHTML(text("allocation.target"))} ${formatPercent(plan.weights[key])} · ${escapeHTML(text("allocation.drift"))} ${escapeHTML(driftLabel)}</small></span><strong>${escapeHTML(formatDisplayMoney(plan.amounts[key]))}</strong></div>`;
    })
    .join("");
  const excluded = Number(plan.excludedInvestableTotal) || 0;
  const note =
    excluded > 0
      ? `<p class="data-note">${escapeHTML(text("allocation.excludedHoldings"))} ${escapeHTML(formatDisplayMoney(excluded))}</p>`
      : "";
  const missingCount = Number(plan.excludedMissingCount) || 0;
  const missingNote =
    missingCount > 0
      ? `<p class="data-note">${escapeHTML(text("allocation.excludedMissingPrices"))} ${formatIRR(missingCount)}</p>`
      : "";
  contributionPlanEl.innerHTML = rows + note + missingNote;
}

function renderLineChart(container, points, valueKey = "nominal", label = "") {
  if (!container) return;
  container.innerHTML = lineChartMarkup({
    series: [
      {
        name: label,
        color: "#126b62",
        points: (Array.isArray(points) ? points : []).map((point) => ({
          value: point && point[valueKey],
          label: point?.date ? formatDate(point.date) : "",
        })),
      },
    ],
    ariaLabel: label || text("analysis.chart", "روند ارزش"),
    emptyLabel: text("analysis.chartEmpty", "داده کافی برای رسم نمودار وجود ندارد."),
    valueLabel: (value) => formatDisplayMoney(value),
  });
}

function formatPortfolioQuantity(assetId, quantity) {
  if (["gold", "silver", "platinum", "palladium", "copper"].includes(assetId))
    return new Intl.NumberFormat(currentLocale().numberLocale, { maximumFractionDigits: 3 }).format(
      Number(quantity) || 0,
    );
  if (["bitcoin", "ethereum", "tether"].includes(assetId))
    return new Intl.NumberFormat(currentLocale().numberLocale, { maximumFractionDigits: 8 }).format(
      Number(quantity) || 0,
    );
  return formatIRR(quantity);
}

function formatHoldingQuantity(assetId, quantity, unit) {
  if (unit === "TOMAN" || unit === "IRR") return formatDisplayMoney(quantity);
  return `${formatPortfolioQuantity(assetId, quantity)} ${portfolioUnitLabel(assetId, unit)}`;
}

function targetWeightForHolding(assetId, definition, plan) {
  const weights = plan?.recommendation?.weights || {};
  const direct = {
    fixed: "fixed",
    gold: "gold",
    currency: "currency",
    silver: "silver",
    bitcoin: "bitcoin",
    ethereum: "ethereum",
    tether: "tether",
    platinum: "platinum",
    palladium: "palladium",
    copper: "copper",
  }[assetId];
  if (direct && Number.isFinite(Number(weights[direct]))) return Number(weights[direct]);
  const sleeveKeys =
    {
      fixedIncome: ["fixed"],
      gold: ["gold"],
      fx: ["currency"],
      commodities: ["silver", "platinum", "palladium", "copper"],
      crypto: ["bitcoin", "ethereum", "tether"],
    }[definition?.sleeveId] || [];
  const targets = sleeveKeys.map((key) => Number(weights[key])).filter(Number.isFinite);
  return targets.length ? targets.reduce((total, value) => total + value, 0) : null;
}

function renderPortfolioHoldings(portfolio, result, plan, asOf) {
  const body = $("#portfolio-holdings-body");
  const count = $("#portfolio-holdings-count");
  if (!body) return;
  const basisByAsset = portfolioCostBasis(result.transactions, asOf);
  const holdings = assetIds(portfolio)
    .map((assetId) => {
      const definition = portfolio.assets?.[assetId] || PORTFOLIO_ASSETS[assetId];
      const item = result.values[assetId];
      if (!item || Math.abs(item.quantity) <= 1e-7) return null;
      const quote = definition?.marketKey ? liveMarket?.assets?.[definition.marketKey] : null;
      const basis = basisByAsset[assetId]?.basis ?? null;
      const disputed = !item.manualPrice && quote?.status === "conflicted";
      return {
        assetId,
        definition,
        asset: portfolioAssetMeta(assetId, portfolio).title,
        item,
        quote,
        quantity: item.quantity,
        value: item.value,
        allocation: result.missingPrices.length ? null : Number(result.allocation[assetId]) || 0,
        basis,
        profitLoss: item.value === null || basis === null ? null : item.value - basis,
        target: targetWeightForHolding(assetId, definition, plan),
        disputed,
      };
    })
    .filter(Boolean)
    .filter((row) => {
      if (holdingsFilter === "priced" && (row.item.value === null || row.disputed)) return false;
      if (holdingsFilter === "missing" && row.item.value !== null && !row.disputed) return false;
      if (!holdingsSearch) return true;
      const name = portfolioAssetMeta(row.assetId, portfolio).title.toLocaleLowerCase(currentLocale().numberLocale);
      return name.includes(holdingsSearch.toLocaleLowerCase(currentLocale().numberLocale));
    });
  holdings.sort((left, right) => {
    const leftValue =
      left[holdingsSort.key] ??
      (holdingsSort.key === "asset" ? portfolioAssetMeta(left.assetId, portfolio).title : null);
    const rightValue =
      right[holdingsSort.key] ??
      (holdingsSort.key === "asset" ? portfolioAssetMeta(right.assetId, portfolio).title : null);
    const comparison =
      typeof leftValue === "string" && typeof rightValue === "string"
        ? leftValue.localeCompare(rightValue, currentLocale().numberLocale)
        : (Number(leftValue) || Number.NEGATIVE_INFINITY) - (Number(rightValue) || Number.NEGATIVE_INFINITY);
    return comparison * (holdingsSort.direction === "asc" ? 1 : -1);
  });
  if (count) count.textContent = `${formatIRR(holdings.length)} ${text("portfolio.holdingCount", "دارایی")}`;
  $$("[data-holdings-sort]").forEach((button) => {
    const active = button.dataset.holdingsSort === holdingsSort.key;
    button
      .closest("th")
      ?.setAttribute("aria-sort", active ? (holdingsSort.direction === "asc" ? "ascending" : "descending") : "none");
  });
  body.innerHTML = holdings.length
    ? holdings
        .map((row) => {
          const meta = portfolioAssetMeta(row.assetId, portfolio);
          const quantity = formatHoldingQuantity(row.assetId, row.item.quantity, row.item.unit);
          const marketConflict = row.disputed;
          const missing = row.item.value === null;
          const quoteState = marketConflict
            ? text("portfolio.disputedPrice", "تعارض قیمت")
            : missing
              ? text("portfolio.missingPrice", "قیمت موجود نیست")
              : row.item.manualPrice
                ? text("portfolio.manualPrice", "قیمت دستی")
                : row.item.priceSource || row.quote?.source || text("market.observationUnknown");
          const quoteDate = row.item.priceObservedAt || row.quote?.observedAt || row.quote?.asOf;
          const quoteTime = quoteDate
            ? `${formatDateTime(quoteDate)} · ${freshnessLabel(quoteDate)}`
            : text("market.observationUnknown");
          const statusClass = marketConflict || missing ? "holdings-quote-warning" : "";
          const actualWeight = result.missingPrices.length ? null : Number(result.allocation[row.assetId]) || 0;
          const targetWeight = row.target;
          const pnlClass = row.profitLoss === null ? "muted" : row.profitLoss >= 0 ? "positive" : "negative";
          const pnl = row.profitLoss === null ? text("portfolio.unavailable", "—") : formatDisplayMoney(row.profitLoss);
          return (
            '<tr><th scope="row"><span class="holdings-asset-name"' +
            portfolioAssetUserContentAttribute(row.assetId, portfolio) +
            '><span class="asset-dot ' +
            escapeHTML(meta.dotClass) +
            '"></span>' +
            escapeHTML(meta.title) +
            "</span></th><td>" +
            escapeHTML(quantity) +
            "</td><td>" +
            (missing
              ? '<span class="holdings-quote-warning">' + escapeHTML(quoteState) + "</span>"
              : escapeHTML(formatDisplayMoney(row.item.value))) +
            "</td><td>" +
            (row.basis === null ? "—" : escapeHTML(formatDisplayMoney(row.basis))) +
            '</td><td class="' +
            pnlClass +
            '">' +
            escapeHTML(pnl) +
            (row.profitLoss !== null && row.basis > 0
              ? "<small>" + escapeHTML(formatPercent((row.profitLoss / row.basis) * 100)) + "</small>"
              : "") +
            "</td><td>" +
            (actualWeight === null ? "—" : escapeHTML(formatPercent(actualWeight))) +
            "</td><td>" +
            (targetWeight === null
              ? escapeHTML(text("portfolio.noTarget", "هدف ثبت نشده"))
              : escapeHTML(formatPercent(targetWeight))) +
            '</td><td class="' +
            statusClass +
            '"><strong>' +
            escapeHTML(quoteState) +
            "</strong><small>" +
            escapeHTML(quoteTime) +
            "</small></td></tr>"
          );
        })
        .join("")
    : `<tr><td colspan="8" class="holdings-empty">${escapeHTML(text("portfolio.noMatchingHoldings", "دارایی مطابق این فیلتر نیست."))}</td></tr>`;
  const note = $("#portfolio-currency-note");
  if (note) {
    const currency = preferredCurrency(uiPreferences);
    const activeQuote = activeFxQuotes()[currency];
    if (currency === "TOMAN")
      note.textContent = text("portfolio.tomanBasisNote", "مقادیر و بازده تاریخی بر پایه تومان محاسبه می‌شوند.");
    else if (activeQuote?.status === "unavailable")
      note.textContent = text(
        "portfolio.fxUnavailableNote",
        "نرخ تبدیل در دسترس نیست؛ مقادیر به تومان نمایش داده می‌شوند. دفتر و بازده تاریخی بر پایه تومان می‌مانند.",
      );
    else {
      const stale = activeQuote?.status === "stale";
      const freshness = activeQuote?.observedAt
        ? " · " + text("portfolio.fxAsOf", "نرخ مرجع") + ": " + formatDate(activeQuote.observedAt)
        : "";
      const staleLabel = stale ? " · " + text("portfolio.fxStaleNote", "نرخ تبدیل کهنه است.") : "";
      note.textContent =
        text(
          "portfolio.displayCurrencyNote",
          "مقادیر با نرخ مرجع روز به ارز نمایشی تبدیل شده‌اند؛ بازده تاریخی بر پایه تومان است.",
        ) +
        freshness +
        staleLabel;
    }
  }
}

function portfolioValueLabel(value) {
  return value === null || value === undefined
    ? text("portfolio.unavailable", "Unavailable")
    : formatDisplayMoney(value);
}

function renderPortfolioChart(series, portfolio, inflationRate) {
  const chart = $("#portfolio-chart");
  if (!series.length || series.length < 2) {
    chart.innerHTML = `<div class="empty-state">${escapeHTML(series.length ? "برای رسم روند حداقل دو نقطه زمانی لازم است." : text("portfolio.empty"))}</div>`;
    return;
  }
  const points = series.map((point) => {
    const state = calculatePortfolio(portfolio, liveMarket || {}, point.date, inflationRate);
    return {
      date: point.date,
      label: formatDate(point.date),
      invested: state.netInvested,
      value: point.value,
      realValue: point.realValue,
    };
  });
  chart.innerHTML = lineChartMarkup({
    series: [
      {
        name: "سرمایه خالص",
        color: "#8997a0",
        points: points.map((point) => ({ value: point.invested, label: point.label })),
      },
      {
        name: "ارزش اسمی",
        color: "#126b62",
        points: points.map((point) => ({ value: point.value, label: point.label })),
      },
      {
        name: "ارزش پس از تورم",
        color: "#c18a2c",
        points: points.map((point) => ({ value: point.realValue, label: point.label })),
      },
    ],
    ariaLabel: text("portfolio.chart"),
    emptyLabel: text("portfolio.missingPrices"),
    valueLabel: formatDisplayMoney,
    height: 260,
  });
}

function setPortfolioStatus(message, type = "neutral") {
  if (!portfolioTransferStatusEl) return;
  portfolioTransferStatusEl.textContent = message;
  portfolioTransferStatusEl.className = `transfer-status transfer-${type}`;
}

function populatePortfolioAssetOptions() {
  const portfolio = readPortfolio();
  const options = assetIds(portfolio)
    .map((assetId) => {
      const meta = portfolioAssetMeta(assetId, portfolio);
      return `<option value="${escapeHTML(assetId)}"${portfolioAssetUserContentAttribute(assetId, portfolio)}>${escapeHTML(meta.title)}</option>`;
    })
    .join("");
  [$("#advanced-asset"), $("#advanced-target-asset")].forEach((select) => {
    if (!select) return;
    const current = select.value;
    select.innerHTML = options;
    if (assetIds(portfolio).includes(current)) select.value = current;
  });
  const marketSelect = $("#portfolio-market-asset");
  if (marketSelect) {
    const portfolioIds = new Set(assetIds(portfolio));
    const marketIds = Object.entries(INSTRUMENT_REGISTRY)
      .filter(([, instrument]) => instrument.tradable !== false)
      .map(([instrumentId, instrument]) => instrument.recommendationAssetId || instrumentId);
    const coreIds = ["fixed", "cash", "other"];
    const manualIds = Object.keys(portfolio.assets || {});
    const supported = [...new Set([...marketIds, ...coreIds, ...manualIds])].filter((assetId) =>
      portfolioIds.has(assetId),
    );
    const current = marketSelect.value;
    const optionMarkup = (assetId) => {
      const meta = portfolioAssetMeta(assetId, portfolio);
      return `<option value="${escapeHTML(assetId)}"${portfolioAssetUserContentAttribute(assetId, portfolio)}>${escapeHTML(meta.title)}</option>`;
    };
    const marketOptions = supported
      .filter((assetId) => marketIds.includes(assetId))
      .map(optionMarkup)
      .join("");
    const coreOptions = supported
      .filter((assetId) => coreIds.includes(assetId))
      .map(optionMarkup)
      .join("");
    const manualOptions = supported
      .filter((assetId) => manualIds.includes(assetId))
      .map(optionMarkup)
      .join("");
    marketSelect.innerHTML =
      (marketOptions ? `<optgroup label="دارایی‌های بازار">${marketOptions}</optgroup>` : "") +
      (coreOptions ? `<optgroup label="نقد و درآمد ثابت">${coreOptions}</optgroup>` : "") +
      (manualOptions ? `<optgroup label="دارایی‌های نام‌دار">${manualOptions}</optgroup>` : "");
    if (supported.includes(current)) marketSelect.value = current;
    const unit = $("#portfolio-market-asset-unit");
    if (unit)
      unit.textContent = portfolioUnitLabel(
        marketSelect.value,
        portfolio.assets?.[marketSelect.value]?.unit || (marketSelect.value === "currency" ? "TOMAN" : ""),
      );
    updateMarketEntryAvailability();
  }
  const quoteSelect = $("#manual-quote-asset");
  if (quoteSelect) {
    const current = quoteSelect.value;
    const marketOptions = Object.entries(INSTRUMENT_REGISTRY)
      .filter(([, instrument]) => instrument.tradable !== false)
      .map(
        ([assetId, instrument]) =>
          `<option value="${escapeHTML(assetId)}">${escapeHTML(text(`market.labels.${assetId}.title`, text(`assets.${assetId}.title`, assetId)))}</option>`,
      )
      .join("");
    const customAssets = Object.entries(portfolio.assets || {}).filter(([assetId]) => assetId.startsWith("custom:"));
    const customOptions = customAssets
      .map(
        ([assetId, asset]) =>
          `<option value="${escapeHTML(assetId)}" data-user-content>${escapeHTML(asset.title)}</option>`,
      )
      .join("");
    quoteSelect.innerHTML =
      marketOptions + (customOptions ? `<optgroup label="دارایی‌های نام‌دار">${customOptions}</optgroup>` : "");
    if ([...quoteSelect.options].some((option) => option.value === current)) quoteSelect.value = current;
  }
}

function defaultModelSettings() {
  return {
    version: 3,
    inflationRate: 0.3,
    contributionGrowth: 0,
    paths: 2000,
    rebalance: true,
    targetDriftThresholdPercent: 3,
    assumptions: Object.fromEntries(
      SIMULATION_ASSET_KEYS.map((assetId) => [assetId, { ...DEFAULT_ASSUMPTIONS[assetId] }]),
    ),
    transactionCosts: Object.fromEntries(
      SIMULATION_ASSET_KEYS.map((assetId) => [assetId, { ...DEFAULT_TRANSACTION_COSTS[assetId] }]),
    ),
    inflationSource: null,
    inflationPeriod: null,
    inflationFetchedAt: null,
  };
}

function normalizeModelSettings(raw = {}) {
  const defaults = defaultModelSettings();
  const assumptions = Object.fromEntries(
    SIMULATION_ASSET_KEYS.map((assetId) => {
      const supplied = raw.assumptions?.[assetId] || {};
      const fallback = defaults.assumptions[assetId];
      const annualReturn = Number(supplied.annualReturn);
      const annualVolatility = Number(supplied.annualVolatility);
      return [
        assetId,
        {
          annualReturn: Number.isFinite(annualReturn) ? clamp(annualReturn, -0.99, 3) : fallback.annualReturn,
          annualVolatility: Number.isFinite(annualVolatility)
            ? clamp(annualVolatility, 0, 3)
            : fallback.annualVolatility,
        },
      ];
    }),
  );
  const rate = Number(raw.inflationRate);
  const growth = Number(raw.contributionGrowth);
  const paths = Number(raw.paths);
  const driftThreshold = Number(raw.targetDriftThresholdPercent);
  const transactionCosts = Object.fromEntries(
    SIMULATION_ASSET_KEYS.map((assetId) => {
      const supplied = raw.transactionCosts?.[assetId];
      const fallback = defaults.transactionCosts[assetId];
      if (!supplied) return [assetId, { ...fallback }];
      const fee = (key) => {
        if (Object.hasOwn(supplied, key) && (supplied[key] === null || supplied[key] === "")) return null;
        const value = Number(supplied[key]);
        return Number.isFinite(value) && value >= 0 ? clamp(value, 0, 0.99) : fallback[key];
      };
      return [assetId, { buyFee: fee("buyFee"), sellFee: fee("sellFee"), spread: fee("spread") }];
    }),
  );
  return {
    ...defaults,
    inflationRate: Number.isFinite(rate) ? clamp(rate, -0.2, 3) : defaults.inflationRate,
    contributionGrowth: Number.isFinite(growth) ? clamp(growth, -0.5, 2) : defaults.contributionGrowth,
    paths: [1000, 2000, 5000, 10000].includes(paths) ? paths : defaults.paths,
    rebalance: typeof raw.rebalance === "boolean" ? raw.rebalance : defaults.rebalance,
    targetDriftThresholdPercent: Number.isFinite(driftThreshold)
      ? clamp(driftThreshold, 0, 25)
      : defaults.targetDriftThresholdPercent,
    assumptions,
    transactionCosts,
    inflationSource: typeof raw.inflationSource === "string" ? raw.inflationSource.slice(0, 120) : null,
    inflationPeriod: typeof raw.inflationPeriod === "string" ? raw.inflationPeriod.slice(0, 40) : null,
    inflationFetchedAt: typeof raw.inflationFetchedAt === "string" ? raw.inflationFetchedAt : null,
  };
}

function loadModelSettings() {
  const saved = readJson(SETTINGS_KEY, null);
  if (saved && typeof saved === "object") return normalizeModelSettings(saved);
  const oldProfile = readJson(PROFILE_KEY, null);
  const migrated = defaultModelSettings();
  if (oldProfile && typeof oldProfile === "object") {
    if (Number.isFinite(Number(oldProfile.inflationRate)))
      migrated.inflationRate = clamp(Number(oldProfile.inflationRate) / 100, -0.2, 3);
    if (Number.isFinite(Number(oldProfile.contributionGrowth)))
      migrated.contributionGrowth = clamp(Number(oldProfile.contributionGrowth) / 100, -0.5, 2);
    if ([1000, 2000, 5000, 10000].includes(Number(oldProfile.paths))) migrated.paths = Number(oldProfile.paths);
    if (typeof oldProfile.rebalance === "boolean") migrated.rebalance = oldProfile.rebalance;
  }
  writeJson(SETTINGS_KEY, migrated);
  return migrated;
}

function saveModelSettings(next) {
  modelSettings = normalizeModelSettings(next);
  writeJson(SETTINGS_KEY, modelSettings);
  renderSettingsAssumptions();
  applyModelSettingsToSimulation();
}

function saveModelSettingsForm(event) {
  event.preventDefault();
  const assumptions = Object.fromEntries(
    SIMULATION_ASSET_KEYS.map((assetId) => [
      assetId,
      {
        annualReturn: clamp(numberFromInput($("#settings-return-" + assetId)?.value), -99, 300) / 100,
        annualVolatility: clamp(numberFromInput($("#settings-vol-" + assetId)?.value), 0, 300) / 100,
      },
    ]),
  );
  const transactionCosts = Object.fromEntries(
    SIMULATION_ASSET_KEYS.map((assetId) => {
      const readFee = (side) => {
        const input = document.querySelector("#settings-fee-" + side + "-" + assetId);
        if (!input?.value.trim()) return null;
        return clamp(numberFromInput(input.value), 0, 99) / 100;
      };
      return [assetId, { buyFee: readFee("buy"), sellFee: readFee("sell"), spread: readFee("spread") }];
    }),
  );
  saveModelSettings({
    ...modelSettings,
    inflationRate: numberFromInput($("#settings-inflation-rate")?.value) / 100,
    contributionGrowth: numberFromInput($("#settings-contribution-growth")?.value) / 100,
    paths: numberFromInput($("#settings-simulation-paths")?.value),
    rebalance: Boolean($("#settings-rebalancing")?.checked),
    targetDriftThresholdPercent: clamp(numberFromInput($("#settings-drift-threshold")?.value), 0, 25),
    assumptions,
    transactionCosts,
  });
  const status = $("#settings-model-status");
  if (status) {
    status.textContent = "پیش‌فرض‌های مدل برای برنامه‌ها و سناریوهای بعدی ذخیره شد.";
    status.className = "transfer-status transfer-success";
  }
}

async function refreshInflationAssumption() {
  const status = $("#settings-inflation-source");
  if (status) status.textContent = "در حال دریافت آخرین نرخ سالانه‌ی منتشرشده…";
  try {
    await ensureApiSession();
    const response = await fetchWithTimeout("/api/inflation", { credentials: "same-origin", cache: "no-store" }, 12000);
    if (!response.ok) throw new Error("inflation-unavailable");
    const data = await response.json();
    const value = Number(data.inflationRate);
    if (!Number.isFinite(value) || !Number.isFinite(Number(data.year))) throw new Error("inflation-invalid");
    modelSettings = normalizeModelSettings({
      ...modelSettings,
      inflationRate: value / 100,
      inflationSource: data.source || "World Bank",
      inflationPeriod: String(data.year),
      inflationFetchedAt: data.fetchedAt || new Date().toISOString(),
    });
    writeJson(SETTINGS_KEY, modelSettings);
    writeJson(INFLATION_CACHE_KEY, { ...data, cachedAt: new Date().toISOString() });
    renderSettingsAssumptions();
    applyModelSettingsToSimulation();
    const input = $("#settings-inflation-rate");
    if (input) input.value = String(Math.round(value * 10) / 10);
  } catch {
    if (status) status.textContent = "دریافت تورم مرجع ناموفق بود؛ مقدار فعلی دست‌نخورده ماند.";
  }
}

function applyModelSettingsToSimulation() {
  if (!modelSettings) return;
  const values = {
    "simulation-inflation": modelSettings.inflationRate * 100,
    "simulation-growth": modelSettings.contributionGrowth * 100,
    "simulation-path-count": modelSettings.paths,
  };
  Object.entries(values).forEach(([id, value]) => {
    const input = $("#" + id);
    if (input) input.value = String(value);
  });
  const rebalance = $("#simulation-rebalance");
  if (rebalance) rebalance.checked = modelSettings.rebalance;
}

function renderSimulationWeightInputs() {
  const grid = $("#simulation-weight-grid");
  if (!grid || grid.dataset.rendered === "true") return;
  grid.innerHTML = SIMULATION_ASSET_KEYS.map((assetId) => {
    const meta = assetMeta(assetId);
    return `<div class="field"><label for="sim-weight-${escapeHTML(assetId)}">${escapeHTML(meta.title)}</label><div class="unit-input"><input id="sim-weight-${escapeHTML(assetId)}" type="number" min="0" max="100" step="0.1" value="${Number(DEFAULT_ALLOCATION[assetId]) || 0}"><span>٪</span></div></div>`;
  }).join("");
  grid.dataset.rendered = "true";
}

function renderSettingsAssumptions() {
  if (!modelSettings) return;
  const assumptionGrid = $("#settings-assumption-grid");
  if (assumptionGrid && assumptionGrid.dataset.rendered !== "true") {
    assumptionGrid.innerHTML =
      `<div><strong>دارایی</strong><strong>بازده مؤثر سالانه‌ی فرضی</strong><strong>نوسان سالانه</strong></div>` +
      SIMULATION_ASSET_KEYS.map((assetId) => {
        const title = assetMeta(assetId).title;
        return `<div><span>${escapeHTML(title)}</span><input id="settings-return-${escapeHTML(assetId)}" aria-label="بازده مؤثر سالانه‌ی فرضی ${escapeHTML(title)}" type="number" min="-99" max="300"><input id="settings-vol-${escapeHTML(assetId)}" aria-label="نوسان فرضی ${escapeHTML(title)}" type="number" min="0" max="300"></div>`;
      }).join("");
    assumptionGrid.dataset.rendered = "true";
  }
  const feeGrid = $("#settings-transaction-cost-grid");
  if (feeGrid && feeGrid.dataset.rendered !== "true") {
    feeGrid.innerHTML =
      "<div><strong>دارایی</strong><strong>خرید</strong><strong>فروش</strong><strong>فاصله خرید و فروش</strong></div>" +
      SIMULATION_ASSET_KEYS.map((assetId) => {
        const title = assetMeta(assetId).title;
        return (
          "<div><span>" +
          escapeHTML(title) +
          '</span><input id="settings-fee-buy-' +
          escapeHTML(assetId) +
          '" aria-label="کارمزد خرید ' +
          escapeHTML(title) +
          '" type="number" min="0" max="99" step="0.1"><input id="settings-fee-sell-' +
          escapeHTML(assetId) +
          '" aria-label="کارمزد فروش ' +
          escapeHTML(title) +
          '" type="number" min="0" max="99" step="0.1"><input id="settings-fee-spread-' +
          escapeHTML(assetId) +
          '" aria-label="فاصله خرید و فروش ' +
          escapeHTML(title) +
          '" type="number" min="0" max="99" step="0.1"></div>'
        );
      }).join("");
    feeGrid.dataset.rendered = "true";
  }
  const scalarValues = {
    "settings-inflation-rate": modelSettings.inflationRate * 100,
    "settings-contribution-growth": modelSettings.contributionGrowth * 100,
    "settings-simulation-paths": modelSettings.paths,
    "settings-rebalancing": modelSettings.rebalance,
    "settings-drift-threshold": modelSettings.targetDriftThresholdPercent,
  };
  Object.entries(scalarValues).forEach(([id, value]) => {
    const input = $("#" + id);
    if (!input || document.activeElement === input) return;
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = String(value);
  });
  SIMULATION_ASSET_KEYS.forEach((assetId) => {
    const assumptions = modelSettings.assumptions[assetId];
    const returnInput = $("#settings-return-" + assetId);
    const volInput = $("#settings-vol-" + assetId);
    if (returnInput && document.activeElement !== returnInput)
      returnInput.value = String(assumptions.annualReturn * 100);
    if (volInput && document.activeElement !== volInput) volInput.value = String(assumptions.annualVolatility * 100);
    const costs = modelSettings.transactionCosts[assetId];
    ["buy", "sell", "spread"].forEach((side) => {
      const input = document.querySelector("#settings-fee-" + side + "-" + assetId);
      const value = side === "spread" ? costs?.spread : costs?.[side + "Fee"];
      if (input && document.activeElement !== input)
        input.value = value === null || value === undefined ? "" : String(value * 100);
    });
  });
  const source = $("#settings-inflation-source");
  if (source)
    source.textContent = modelSettings.inflationSource
      ? `منبع: ${modelSettings.inflationSource}${modelSettings.inflationPeriod ? ` · دوره ${modelSettings.inflationPeriod}` : ""}${modelSettings.inflationFetchedAt ? ` · دریافت ${formatDateTime(modelSettings.inflationFetchedAt)}` : ""}`
      : "فرض دستی/پیش‌فرض؛ برای دریافت داده‌ی مرجع، تازه‌سازی را بزن.";
}

function marketEntryPriceAt(assetId, dateValue) {
  const portfolio = readPortfolio();
  const quoteTime = new Date(dateValue).getTime();
  if (!Number.isFinite(quoteTime)) return null;
  const definition = portfolio.assets?.[assetId] || PORTFOLIO_ASSETS[assetId];
  const marketKey = definition?.marketKey;
  const key = marketKey || assetId;
  const priceMarket = {
    ...(liveMarket || {}),
    manualQuotes: portfolio.manualQuotes || [],
    assetDefinitions: { ...PORTFOLIO_ASSETS, ...(portfolio.assets || {}) },
  };
  const today = new Date().toISOString().slice(0, 10);
  if (dateValue.slice(0, 10) === today && marketKey) {
    const current = liveMarket?.assets?.[marketKey];
    const currentPrice = Number(current?.price);
    const observed = current?.observedAt || current?.asOf;
    if (
      Number.isFinite(currentPrice) &&
      currentPrice > 0 &&
      current.status !== "conflicted" &&
      current.status !== "unavailable" &&
      observed &&
      new Date(observed).getTime() <= quoteTime
    )
      return currentPrice;
  }
  return (
    marketPriceAt(priceMarket, assetId, new Date(quoteTime).toISOString()) ||
    (key !== assetId ? marketPriceAt(priceMarket, key, new Date(quoteTime).toISOString()) : null)
  );
}

function updateMarketEntryAvailability() {
  const assetId = $("#portfolio-market-asset")?.value;
  const dateValue = $("#portfolio-market-date")?.value;
  const creatingNamedAsset = Boolean($("#portfolio-new-stock-title")?.value.trim());
  const priceAtAcquisition = assetId && !creatingNamedAsset ? marketEntryPriceAt(assetId, dateValue) : null;
  const needsPrice = !(Number.isFinite(Number(priceAtAcquisition)) && Number(priceAtAcquisition) > 0);
  const transactionTime = new Date(dateValue).getTime();
  const isBackdated = Number.isFinite(transactionTime) && transactionTime < Date.now() - 60_000;
  const fields = $("#portfolio-market-acquisition-fields");
  const priceInput = $("#portfolio-market-acquisition-price");
  const hint = $("#portfolio-market-acquisition-hint");
  if (fields) fields.classList.toggle("is-hidden", !needsPrice && !isBackdated);
  if (priceInput) priceInput.required = needsPrice;
  if (hint)
    hint.textContent = needsPrice
      ? creatingNamedAsset
        ? "برای نماد تازه، قیمت واقعی خرید هر سهم را وارد کن. برای ارزش امروز، بعدا قیمت دستی ثبت کن."
        : "قیمت واقعی خرید را وارد کن؛ این عدد فقط بهای ثبت معامله است و قیمت امروز نیست."
      : isBackdated
        ? "قیمت بازار همان تاریخ مبناست؛ اگر رسید قیمت متفاوتی دارد، مبلغ واقعی را وارد کن."
        : "قیمت بازار مبناست؛ اگر قیمت واقعی خریدت متفاوت است، آن را وارد کن.";
}

function renderEmergencyCoverage(portfolioResult = null) {
  const result = portfolioResult || calculatePortfolio(readPortfolio(), liveMarket || {});
  const hasTransactions = result.transactions.length > 0;
  const essentialExpenses = Math.max(0, numberFromInput($("#essential-monthly-expenses")?.value));
  const coverageMonths = essentialExpenses > 0 ? result.liquidTotal / essentialExpenses : null;
  const coverageLabel =
    coverageMonths === null
      ? text("portfolio.coverageMissing")
      : `${new Intl.NumberFormat(currentLocale().numberLocale, { maximumFractionDigits: 1 }).format(coverageMonths)} ${text("portfolio.months")}`;
  const coverageMetric = $("#portfolio-emergency-coverage");
  if (coverageMetric) coverageMetric.textContent = coverageLabel;
  const emergencyStatus = $("#emergency-fund-status");
  if (emergencyStatus)
    emergencyStatus.textContent =
      coverageMonths === null
        ? text(`portfolio.emergency.${legacyEmergencyFund}`)
        : `${coverageLabel} · ${text(`portfolio.emergency.${coverageMonths >= 6 ? "complete" : coverageMonths >= 1 ? "partial" : "none"}`)}`;
  const liquidMetric = $("#portfolio-liquid-total");
  if (liquidMetric) liquidMetric.textContent = hasTransactions ? portfolioValueLabel(result.liquidTotal) : "—";
  return {
    coverageMonths,
    status:
      coverageMonths === null
        ? legacyEmergencyFund
        : coverageMonths >= 6
          ? "complete"
          : coverageMonths >= 1
            ? "partial"
            : "none",
  };
}

function renderPortfolio() {
  if (!portfolioAllocationEl) return;
  populatePortfolioAssetOptions();
  const portfolio = readPortfolio();
  const asOf = new Date().toISOString();
  const inflationRate = inflationRateForPortfolio();
  const result = calculatePortfolio(portfolio, liveMarket || {}, asOf, inflationRate);
  appStore.setState({ portfolio: result });
  const version = activePortfolioVersion(portfolio);
  const hasTransactions = result.transactions.length > 0;
  const completeValuation = hasTransactions && result.missingPrices.length === 0;
  $("#portfolio-current-value").textContent = completeValuation
    ? portfolioValueLabel(result.currentValue)
    : hasTransactions
      ? text("portfolio.unavailable", "در دسترس نیست")
      : "—";
  $("#portfolio-net-invested").textContent = portfolioValueLabel(result.netInvested);
  $("#portfolio-profit-loss").textContent = completeValuation
    ? portfolioValueLabel(result.profitLoss)
    : text("portfolio.unavailable", "در دسترس نیست");
  $("#portfolio-profit-loss").className = completeValuation
    ? result.profitLoss >= 0
      ? "positive"
      : "negative"
    : "muted";
  $("#portfolio-cagr").textContent =
    !completeValuation || result.cagr === null ? text("portfolio.unavailable") : formatPercent(result.cagr * 100);
  $("#portfolio-real-return").textContent =
    !completeValuation || result.inflationAdjustedReturn === null
      ? text("portfolio.unavailable")
      : formatPercent(result.inflationAdjustedReturn * 100);
  $("#portfolio-start-date").textContent = result.trackingStart
    ? formatDate(result.trackingStart)
    : text("portfolio.notStarted");
  $("#portfolio-net-worth").textContent =
    hasTransactions && !result.missingPrices.length
      ? portfolioValueLabel(result.netWorth)
      : text("portfolio.unavailable");
  $("#portfolio-investable-total").textContent =
    hasTransactions && !result.missingPrices.length
      ? portfolioValueLabel(result.investableTotal)
      : text("portfolio.unavailable");
  renderEmergencyCoverage(result);
  const versionLabel = version.label === "Initial portfolio" ? text("portfolio.initialLabel") : version.label;
  $("#portfolio-version-label").textContent = versionLabel;
  $("#portfolio-version-count").textContent = `${portfolio.versions.length} ${text("portfolio.versionCount")}`;
  $("#portfolio-audit-count").textContent = `${version.audit.length} ${text("portfolio.auditCount")}`;

  const heldAssetIds = assetIds(portfolio).filter((assetId) => Math.abs(result.values[assetId].quantity) > 1e-7);
  const allocationRows = heldAssetIds
    .map((assetId) => {
      const meta = portfolioAssetMeta(assetId, portfolio);
      const item = result.values[assetId];
      const quoteNote = item.priceObservedAt
        ? `${item.manualPrice ? "قیمت دستی" : "منبع بازار"} · ${formatDateTime(item.priceObservedAt)} · ${freshnessLabel(item.priceObservedAt)}`
        : item.priceSource || "زمان مشاهده نامشخص";
      return `<button type="button" class="allocation-row allocation-row-button" data-portfolio-asset="${escapeHTML(assetId)}"><span class="allocation-name"><span class="asset-dot ${escapeHTML(meta.dotClass)}"></span><span><strong${portfolioAssetUserContentAttribute(assetId, portfolio)}>${escapeHTML(meta.title)}</strong><small>${escapeHTML(formatHoldingQuantity(assetId, item.quantity, item.unit))} · ${escapeHTML(quoteNote)}</small></span></span><span class="allocation-numbers"><strong>${item.value === null || result.missingPrices.length ? "—" : formatPercent(result.allocation[assetId])}</strong><small>${escapeHTML(portfolioValueLabel(item.value))}</small></span></button>`;
    })
    .join("");
  portfolioAllocationEl.innerHTML =
    allocationRows || `<div class="empty-state">${escapeHTML(text("portfolio.empty"))}</div>`;
  if (portfolioDonutEl) {
    portfolioDonutEl.innerHTML = donutChartMarkup({
      segments: heldAssetIds.map((assetId) => ({
        name: portfolioAssetMeta(assetId, portfolio).title,
        userContent: Boolean(portfolio.assets?.[assetId] && portfolio.assets[assetId].kind !== "legacy-stock"),
        value: result.missingPrices.length ? 0 : Number(result.values[assetId].value) || 0,
        color: getAssetColor(assetId),
        percentLabel: result.missingPrices.length ? "—" : formatPercent(result.allocation[assetId] || 0),
      })),
      centerLabel: "ارزش فعلی",
      centerValue: result.missingPrices.length ? "—" : portfolioValueLabel(result.currentValue),
      emptyLabel: result.missingPrices.length ? text("portfolio.missingPrices") : text("portfolio.empty"),
    });
  }

  const quality = $("#portfolio-data-quality");
  if (!hasTransactions) quality.textContent = text("portfolio.empty");
  else if (result.missingPrices.length)
    quality.innerHTML = `${escapeHTML(text("portfolio.missingPrices"))} ${result.missingPrices
      .map((assetId) => {
        const title = portfolioAssetMeta(assetId, portfolio).title;
        return `<span${portfolioAssetUserContentAttribute(assetId, portfolio)}>${escapeHTML(title)}</span>`;
      })
      .join(escapeHTML(listSeparator()))}`;
  else {
    const manualCount = heldAssetIds.filter((assetId) => result.values[assetId]?.manualPrice).length;
    quality.textContent = manualCount
      ? `${text("portfolio.complete")} · ${formatIRR(manualCount)} قیمت دستی، با زمان مشاهده مشخص`
      : text("portfolio.complete");
  }
  quality.className = `data-note ${result.missingPrices.length ? "data-note-warning" : ""}`;

  const series = result.trackingStart
    ? portfolioSeries(portfolio, liveMarket || {}, result.trackingStart, asOf, inflationRate)
    : [];
  renderPortfolioChart(series, portfolio, inflationRate);
  const contributionChart = $("#portfolio-contribution-chart");
  if (contributionChart) {
    const monthlyContributions = portfolioContributionSeries(result.transactions, asOf, 12).map((point) => ({
      date: point.date,
      label: new Intl.DateTimeFormat(currentLocale().numberLocale, { month: "short", year: "2-digit" }).format(
        new Date(point.date),
      ),
      value: point.value,
    }));
    contributionChart.innerHTML = barChartMarkup({
      items: monthlyContributions,
      ariaLabel: text("portfolio.contributionChart", "واریزهای ثبت‌شده به تفکیک ماه، بر پایه تومان"),
      emptyLabel: text("portfolio.noContributionHistory", "داده ثبت‌شده‌ای برای نمایش واریز ماهانه نیست."),
      valueLabel: (value) => formatDisplayMoney(value),
    });
  }
  renderPortfolioHoldings(portfolio, result, latestPlanSnapshot(), asOf);
  if (
    hasTransactions &&
    result.trackingStart &&
    new Date(result.trackingStart).toDateString() === new Date(asOf).toDateString()
  ) {
    $("#portfolio-chart-note").textContent = text("portfolio.startsToday");
  } else {
    $("#portfolio-chart-note").textContent = text("portfolio.chartNote");
  }

  portfolioLedgerEl.innerHTML = hasTransactions
    ? result.transactions
        .slice()
        .reverse()
        .slice(0, 20)
        .map((transaction) => {
          const type = text(`portfolio.transactionTypes.${transaction.type}`, transaction.type);
          const meta = portfolioAssetMeta(transaction.assetId, portfolio);
          const quantity = transaction.quantity === undefined ? transaction.amount : transaction.quantity;
          const targetMeta = portfolioAssetMeta(transaction.targetAssetId, portfolio);
          const target =
            transaction.type === "TRANSFER"
              ? ` ${escapeHTML(text("portfolio.to"))} <span${portfolioAssetUserContentAttribute(transaction.targetAssetId, portfolio)}>${escapeHTML(targetMeta.title)}</span>`
              : "";
          const displayedAmount =
            transaction.quantity === undefined
              ? formatDisplayMoney(transaction.amount)
              : formatHoldingQuantity(transaction.assetId, quantity, meta.unit);
          return `<div class="ledger-row"><div><strong>${escapeHTML(type)}</strong><small>${escapeHTML(formatDateTime(transaction.date))} ${escapeHTML(text("history.separator"))} <span${portfolioAssetUserContentAttribute(transaction.assetId, portfolio)}>${escapeHTML(meta.title)}</span>${target}</small></div><div><strong>${escapeHTML(displayedAmount)}</strong></div></div>`;
        })
        .join("")
    : `<div class="empty-state">${escapeHTML(text("portfolio.noLedger"))}</div>`;

  const manualPriceLog = $("#portfolio-manual-price-log");
  if (manualPriceLog)
    manualPriceLog.innerHTML = portfolio.manualQuotes?.length
      ? portfolio.manualQuotes
          .slice()
          .sort((left, right) => new Date(right.observedAt).getTime() - new Date(left.observedAt).getTime())
          .slice(0, 12)
          .map((quote) => {
            const customQuoteAsset = portfolio.assets?.[quote.assetId];
            const quoteName =
              customQuoteAsset?.title ||
              text(
                `market.labels.${quote.assetId}.title`,
                text(`assets.${quote.assetId}.title`, portfolioAssetMeta(quote.assetId, portfolio).title),
              );
            return `<div class="history-item"><div><strong>${escapeHTML(quoteName)}</strong><small>قیمت دستی · مشاهده ${escapeHTML(formatDateTime(quote.observedAt))} · ${escapeHTML(freshnessLabel(quote.observedAt))}</small></div><div><strong>${escapeHTML(formatDisplayMoney(quote.price))}</strong><small>برای ارزش‌گذاری؛ بدون تراکنش</small></div></div>`;
          })
          .join("")
      : `<div class="empty-state">هنوز قیمت دستی ثبت نشده.</div>`;

  portfolioAuditEl.innerHTML = version.audit.length
    ? version.audit
        .slice()
        .reverse()
        .slice(0, 12)
        .map(
          (event) =>
            `<div class="audit-row"><div><strong>${escapeHTML(text(`portfolio.auditActions.${event.action}`, event.action))}</strong><small>${escapeHTML(formatDateTime(event.timestamp))}</small></div><span class="audit-${event.affectsHistory ? "history" : "normal"}">${escapeHTML(event.affectsHistory ? text("portfolio.auditHistory") : text("portfolio.auditNormal"))}</span></div>`,
        )
        .join("")
    : `<div class="empty-state">${escapeHTML(text("portfolio.noAudit"))}</div>`;
  renderStockList(portfolio, result);
  renderDashboard();
}

function renderStockList(portfolio, result) {
  const stockList = $("#portfolio-stock-list");
  if (!stockList) return;
  const stocks = Object.entries(portfolio.assets || {}).filter(
    ([, asset]) => asset.kind === "stock" || asset.kind === "legacy-stock",
  );
  stockList.innerHTML = stocks.length
    ? stocks
        .map(([assetId, asset]) => {
          const item = result.values[assetId];
          const value =
            item && Number.isFinite(item.value) ? portfolioValueLabel(item.value) : text("portfolio.unavailable");
          return `<div class="stock-row"><div><strong data-user-content>${escapeHTML(asset.title)}</strong><small>${escapeHTML(text("portfolio.stockAccount"))}</small></div><div><strong>${escapeHTML(value)}</strong><small>${escapeHTML(text("portfolio.editByReenter"))}</small></div></div>`;
        })
        .join("")
    : `<div class="empty-state">${escapeHTML(text("portfolio.noStocks"))}</div>`;
}

function openAssetDrawer(assetId) {
  const drawer = $("#asset-detail-drawer");
  const content = $("#asset-drawer-content");
  const title = $("#asset-drawer-title");
  if (!drawer || !content || !title) return;
  const portfolio = readPortfolio();
  const result = calculatePortfolio(portfolio, liveMarket || {}, new Date().toISOString(), inflationRateForPortfolio());
  const item = result.values[assetId];
  if (!item) return;
  const meta = portfolioAssetMeta(assetId, portfolio);
  title.textContent = meta.title;
  const transactions = result.transactions.filter(
    (transaction) => transaction.assetId === assetId || transaction.targetAssetId === assetId,
  ).length;
  const price = item.price === null ? "—" : portfolioValueLabel(item.price);
  content.innerHTML = `<div class="asset-detail-summary"><div><span>مقدار</span><strong>${escapeHTML(formatHoldingQuantity(assetId, item.quantity, item.unit))}</strong></div><div><span>قیمت مبنا/بازار</span><strong>${escapeHTML(price)}</strong></div><div><span>ارزش فعلی</span><strong>${escapeHTML(portfolioValueLabel(item.value))}</strong></div><div><span>سهم از سبد</span><strong>${item.value === null || result.missingPrices.length ? "—" : escapeHTML(formatPercent(result.allocation[assetId] || 0))}</strong></div></div><div class="data-note ${item.value === null ? "data-note-warning" : ""}">${item.value === null ? "برای این دارایی قیمت معتبر در داده بازار وجود ندارد؛ ارزش ریالی را حدس نمی‌زنیم." : `در دفتر فعال ${formatIRR(transactions)} رویداد مرتبط ثبت شده است.`}</div><button type="button" class="secondary-button" data-go-view="portfolio">ویرایش موجودی و تراکنش‌ها</button>`;
  if (typeof drawer.showModal === "function") drawer.showModal();
  else drawer.setAttribute("open", "");
}

function renderSimulation(simulation, monteCarlo, validation = null, methodComparison = null) {
  const available = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  const money = (value) => (available(value) ? formatDisplayMoney(Number(value)) : text("analysis.unavailable"));
  const percent = (value) => (available(value) ? formatPercent(Number(value) * 100) : text("analysis.unavailable"));
  const confidenceLabels = {
    high: text("analysis.confidenceHigh"),
    medium: text("analysis.confidenceMedium"),
    low: text("analysis.confidenceLow"),
  };
  const quality = monteCarlo.dataQuality || {};
  const qualityLabel = confidenceLabels[quality.quality] || text("analysis.unavailable");
  const probabilityLabel = (value) =>
    available(value) ? formatPercent(Number(value) * 100) : text("analysis.unavailable");
  const purchasingPowerLabel =
    {
      "above-inflation": text("analysis.aboveInflation"),
      "near-preservation": text("analysis.nearPreservation"),
      "below-inflation": text("analysis.belowInflation"),
      unavailable: text("analysis.unavailable"),
    }[monteCarlo.purchasingPowerChange?.status] || text("analysis.unavailable");
  const primaryMetrics = [
    ["P50 اسمی", money(monteCarlo.nominal?.p50), "ارزش نهایی به تومان جاری"],
    ["P50 واقعی", money(monteCarlo.real?.p50), "ارزش نهایی به پول امروز"],
    [
      text("analysis.inflationBeatProbability"),
      probabilityLabel(monteCarlo.probabilityBeatingInflation),
      purchasingPowerLabel,
    ],
    ["P10 واقعی · افت دامنه", money(monteCarlo.real?.p10), "سناریوی صدک ۱۰ به پول امروز"],
    ["P90 اسمی · دامنه بالاتر", money(monteCarlo.nominal?.p90), "سناریوی صدک ۹۰"],
    [text("analysis.volatility"), percent(monteCarlo.volatility), "انحراف معیار بازده ماهانه × √۱۲"],
    [text("analysis.realDrawdown"), percent(monteCarlo.realMaxDrawdown?.p50), "میانه افت شاخص واقعیِ بدون اثر واریز"],
    [
      text("analysis.dataQuality"),
      qualityLabel,
      `${formatIRR(quality.jointObservations || 0)} ${text("analysis.observations")}`,
    ],
  ];
  simulationSummaryEl.innerHTML = primaryMetrics
    .map(
      ([label, value, hint]) =>
        `<div class="metric simulation-primary-metric"><small>${escapeHTML(label)}</small><strong>${escapeHTML(value)}</strong><span>${escapeHTML(hint)}</span></div>`,
    )
    .join("");
  renderLineChart(
    simulationChartEl,
    simulation.points.filter(
      (point, index) =>
        index % Math.max(1, Math.floor(simulation.points.length / 18)) === 0 || index === simulation.points.length - 1,
    ),
    "nominal",
    text("analysis.path"),
  );
  const resultRows = (values) =>
    [
      [text("analysis.centralScenario"), simulation.finalValue, simulation.finalRealValue, "central"],
      [text("analysis.p10"), monteCarlo.nominal?.p10, monteCarlo.real?.p10, "p10"],
      [text("analysis.p50"), monteCarlo.nominal?.p50, monteCarlo.real?.p50, "p50"],
      [text("analysis.p90"), monteCarlo.nominal?.p90, monteCarlo.real?.p90, "p90"],
    ]
      .map(([label, nominal, real, id]) => {
        const value = values === "real" ? real : nominal;
        const unit = values === "real" ? text("analysis.real") : text("analysis.nominal");
        return `<div class="simulation-range-row simulation-range-${id}" role="row"><span role="cell">${escapeHTML(label)}</span><strong role="cell">${escapeHTML(money(value))}</strong><small role="cell">${escapeHTML(unit)}</small></div>`;
      })
      .join("");
  monteCarloEl.innerHTML = `<div class="simulation-view-tabs" role="tablist" aria-label="نمایش ارزش نهایی">
      <button type="button" role="tab" data-simulation-view="nominal" aria-selected="true">${escapeHTML(text("analysis.nominalView"))}</button>
      <button type="button" role="tab" data-simulation-view="real" aria-selected="false">${escapeHTML(text("analysis.realView"))}</button>
    </div>
    <div class="simulation-range-table" role="table" data-simulation-results="nominal" aria-label="ارزش‌های اسمی">
      <div class="simulation-range-heading" role="row"><span role="columnheader">سناریو</span><span role="columnheader">ارزش</span><span role="columnheader">${escapeHTML(text("analysis.nominal"))}</span></div>
      ${resultRows("nominal")}
    </div>
    <div class="simulation-range-table" role="table" data-simulation-results="real" aria-label="ارزش‌های واقعی به پول امروز" hidden>
      <div class="simulation-range-heading" role="row"><span role="columnheader">سناریو</span><span role="columnheader">ارزش</span><span role="columnheader">${escapeHTML(text("analysis.real"))}</span></div>
      ${resultRows("real")}
    </div>
    <p class="data-quality">${escapeHTML(text("analysis.p10Meaning"))} ${escapeHTML(text("analysis.p50Meaning"))} ${escapeHTML(text("analysis.p90Meaning"))}</p>
    <p class="data-note">${escapeHTML(text("analysis.simulationNotForecast"))}</p>`;
  const methodNames = {
    gaussian: text("analysis.modelGaussian"),
    ewma: text("analysis.modelEwma"),
    "block-bootstrap": text("analysis.modelBootstrap"),
  };
  const validationStatus = validation?.available
    ? text("analysis.validationPassed")
    : text("analysis.validationInsufficient");
  const assumptionVersion = monteCarlo.model?.fixed?.assumptionVersion || "ir-planning-v2";
  const methodNote = `${text("analysis.modelVersion")}: ${methodNames[monteCarlo.method] || methodNames.gaussian} · ${text("analysis.monteCarloVersion")}: ${monteCarlo.modelVersion} · ${text("analysis.modelAssumptionVersion")}: ${assumptionVersion} · ${text("analysis.validation")}: ${validationStatus}`;
  const modelOutput = $("#simulation-model-output");
  const methodFallback = monteCarlo.methodFallbackReason
    ? "روش بازنمونه‌گیری به دلیل تاریخچه مشترک ناکافی اجرا نشد؛ خروجی از روش گاوسی استفاده کرد."
    : "";
  const modeNames = {
    "mean-reverting": "بازگشت تدریجی نرخ به فرض بلندمدت",
    "constant-market": "ثابت ماندن نرخ مؤثر جاری",
    "user-expected": "نرخ مؤثر مورد انتظار تنظیم‌شده",
  };
  const fixedInfo = monteCarlo.fixedIncomeAssumption || {};
  const fixedModeLabel = fixedInfo.modeFallbackReason
    ? "نرخ مؤثر جاری در دسترس نبود؛ از نرخ مورد انتظار تنظیم‌شده استفاده شد"
    : modeNames[fixedInfo.mode] || modeNames["mean-reverting"];
  const fixedDetails = `<p>درآمد ثابت: ${escapeHTML(fixedModeLabel)} · فرض سالانه مؤثر ${escapeHTML(percent(fixedInfo.configuredEffectiveAnnualReturn))} · نرخ مؤثر جاری ${escapeHTML(percent(fixedInfo.currentMarketEffectiveAnnualReturn))} · نوسان نرخ سالانه ${escapeHTML(percent(fixedInfo.yieldVolatility))}. نرخ سالانه مؤثر با (۱ + نرخ)^(۱/۱۲) − ۱ ماهانه می‌شود؛ تاریخچه بازده صندوق یا ریسک قیمت اوراق در دسترس نیست.</p>`;
  const monthlyDates = quality.jointObservations
    ? `${quality.jointOldestMonth ? formatDate(`${quality.jointOldestMonth}-01T00:00:00.000Z`) : "—"} تا ${quality.jointLatestMonth ? formatDate(`${quality.jointLatestMonth}-01T00:00:00.000Z`) : "—"}`
    : text("analysis.unavailable");
  const qualityReason =
    quality.quality === "high"
      ? "همه دارایی‌های بازاری تاریخچه مشترک کافی دارند؛ این برچسب همچنان تضمین دقت نیست."
      : quality.quality === "medium"
        ? "تاریخچه پیوسته برای دارایی‌های بازاری موجود است، اما بخشی از ریسک یا بازده از فرض‌ها می‌آید."
        : "یک یا چند دارایی تاریخچه کافی ندارد؛ همبستگی یا بازده آن از فرض مدل می‌آید.";
  const assetRows = (quality.assets || [])
    .map((asset) => {
      const title = assetMeta(asset.assetId).title;
      const status =
        asset.status === "fixed-rate-scenario"
          ? text("analysis.fixedRateScenario")
          : asset.status === "historical"
            ? text("analysis.completeHistory")
            : asset.status === "insufficient-history"
              ? `${text("analysis.insufficientAssets")} · ${formatIRR(asset.observations)} بازده ماهانه`
              : text("analysis.fallbackAssets");
      const sources = (asset.sourceNames || []).join("، ") || asset.source || "—";
      const dates =
        asset.firstObservedAt && asset.lastObservedAt
          ? `${formatDate(asset.firstObservedAt)} تا ${formatDate(asset.lastObservedAt)}`
          : "—";
      const proxy = asset.proxy && asset.observations ? ` · ${text("analysis.proxyAssets")}` : "";
      const partialMonth = asset.partialMonthExcluded ? " · ماه ناقص از بازده ماهانه کنار گذاشته شد" : "";
      const basis = asset.transformation || asset.classification || "—";
      const fee = monteCarlo.transactionCosts?.assumptions?.find((item) => item.assetId === asset.assetId);
      const feeState = fee?.complete
        ? `خرید ${percent(fee.buyFee)} · فروش ${percent(fee.sellFee)} · فاصله ${available(fee.spread) ? percent(fee.spread) : "نامعلوم"}`
        : text("analysis.feeUnknown");
      const modelValues = `بازده اسمی سالانه‌شده بر پایه میانگین حسابی ${escapeHTML(percent(asset.arithmeticExpectedAnnualReturn))} · بازده هندسی تاریخی ${escapeHTML(percent(asset.geometricHistoricalAnnualReturn))} · نوسان سالانه ${escapeHTML(percent(asset.annualVolatility))}`;
      const sourceCoverage =
        asset.sourceCoverage?.observationCount !== undefined
          ? ` · ${formatIRR(asset.sourceCoverage.observationCount)} نقطه منبع`
          : "";
      const missingFx = asset.sourceCoverage?.missingFxCount
        ? ` · ${formatIRR(asset.sourceCoverage.missingFxCount)} تاریخ بدون نرخ تبدیل FX`
        : "";
      return `<div class="model-data-row"><strong>${escapeHTML(title)}</strong><span>${escapeHTML(status)}${escapeHTML(proxy)}${escapeHTML(partialMonth)} · پوشش ماهانه ${escapeHTML(percent(asset.coverage))}</span><small>${escapeHTML(sources)} · ${escapeHTML(dates)} · ${formatIRR(asset.observations)} بازده ماهانه${escapeHTML(sourceCoverage)}${escapeHTML(missingFx)}</small><small>طبقه‌بندی ${escapeHTML(asset.classification || "—")} · ${escapeHTML(basis)}</small><small>${modelValues}</small><small>منبع بازده: ${escapeHTML(asset.expectedReturnSource || "—")} · کارمزد: ${escapeHTML(feeState)}</small></div>`;
    })
    .join("");
  const correlationRows = (quality.correlationPairs || [])
    .map((pair) => {
      const names = pair.assets.map((assetId) => assetMeta(assetId).title).join(" و ");
      const label =
        pair.source === "paired-historical"
          ? text("analysis.historicalCorrelation")
          : pair.observations
            ? text("analysis.priorCorrelation")
            : text("analysis.assumedCorrelation");
      const prior =
        pair.source === "paired-historical"
          ? ""
          : ` · همبستگی پیش‌فرض ${formatPercent(pair.priorCorrelation * 100, 0)}`;
      return `<div class="correlation-row"><strong>${escapeHTML(names)}</strong><span>${escapeHTML(label)} · ${formatIRR(pair.observations)} مشاهده${escapeHTML(prior)}</span></div>`;
    })
    .join("");
  const sortinoHelp =
    {
      available: `میانه ${text("analysis.sortino")} در مسیرهای شبیه‌سازی‌شده: ${available(monteCarlo.sortino) ? Number(monteCarlo.sortino).toFixed(2) : text("analysis.unavailable")}`,
      "zero-downside-deviation": text("analysis.zeroDownside"),
      "insufficient-downside-observations": text("analysis.insufficientDownside"),
      "insufficient-observations": text("analysis.insufficientSortino"),
      "benchmark-unavailable": text("analysis.unavailableBenchmark"),
      "not-requested": text("analysis.unavailable"),
    }[monteCarlo.sortinoStatus] || text("analysis.unavailable");
  const advancedMetrics = [
    [text("analysis.invested"), money(simulation.totalInvested)],
    ["سود/زیان اسمی نسبت به کل واریزی", money(simulation.nominalGain)],
    ["ارزش واقعی واریزی‌ها به پول امروز", money(simulation.realInvested)],
    ["سود/زیان واقعی و تغییر قدرت خرید", money(simulation.realGain)],
    ["تغییر قدرت خرید در سناریوی مرکزی", percent(simulation.purchasingPowerChange)],
    ["بازده اسمی سناریوی مرکزی (CAGR)", percent(simulation.cagr)],
    ["بازده واقعی سناریوی مرکزی (CAGR)", percent(simulation.realCagr)],
    ["CAGR اسمی میانه", percent(monteCarlo.cagr)],
    ["CAGR واقعی میانه", percent(monteCarlo.realCagr)],
    ["تغییر قدرت خرید در مسیر میانه", percent(monteCarlo.purchasingPowerChange?.p50)],
    [text("analysis.drawdown"), percent(monteCarlo.maxDrawdown?.p50)],
    [text("analysis.realDrawdown"), percent(monteCarlo.realMaxDrawdown?.p50)],
    [text("analysis.purchasingPowerDrawdown"), percent(monteCarlo.purchasingPowerDrawdown?.p50)],
    ["انحراف نزولی سالانه‌شده", percent(monteCarlo.downsideDeviation)],
    [text("analysis.nominalLossProbability"), probabilityLabel(monteCarlo.nominalLossProbability)],
    [text("analysis.purchasingPowerLossProbability"), probabilityLabel(monteCarlo.purchasingPowerLossProbability)],
    [text("analysis.inflationBeatProbability"), probabilityLabel(monteCarlo.probabilityBeatingInflation)],
    [text("analysis.fixedIncomeBeatProbability"), probabilityLabel(monteCarlo.probabilityBeatingFixedIncome)],
    ["هزینه معامله میانه", money(monteCarlo.transactionCosts?.p50)],
    ["هزینه معامله صدک ۹۰", money(monteCarlo.transactionCosts?.p90)],
    [text("analysis.rebalancingTurnover"), money(monteCarlo.transactionCosts?.rebalancingTurnoverP50)],
  ];
  const sharpe =
    available(monteCarlo.sharpe) && available(monteCarlo.fixedIncomeBenchmark)
      ? `<div class="metric"><small>شارپ نسبت به نرخ مؤثر درآمد ثابتِ انتخاب‌شده</small><strong>${Number(monteCarlo.sharpe).toFixed(2)}</strong><span>میانگین مازاد بازده ماهانه × ۱۲ ÷ نوسان سالانه‌شده؛ فقط با انتخاب صریح نرخ مبنا.</span></div>`
      : "";
  const tail = monteCarlo.tailRisk?.available
    ? `<div class="data-note">VaR ماهانه ۹۵٪: ${escapeHTML(percent(monteCarlo.tailRisk.valueAtRisk))} · زیان مورد انتظار فراتر از آن: ${escapeHTML(percent(monteCarlo.tailRisk.expectedShortfall))} · ${escapeHTML(text("analysis.tailRiskModelBased"))}</div>`
    : `<div class="data-note">${escapeHTML(text("analysis.tailRiskUnavailable"))} (${formatIRR(monteCarlo.tailRisk?.observations || 0)} مشاهده)</div>`;
  const correlationSummary = `ماتریس همبستگی در صورت غیرمثبت‌معین بودن، با کاهش مشترک همبستگی‌های خارج قطر پایدار می‌شود؛ سهم همبستگی باقی‌مانده ${percent(monteCarlo.correlationOffDiagonalRetention)}. دارایی درآمد ثابت به‌صورت فرایند نرخ جداگانه مدل می‌شود و همبستگی تاریخی NAV ندارد.`;
  const comparisonMarkup = methodComparison?.available
    ? `<div class="method-comparison-grid"><div><strong>گاوسی · P50 اسمی</strong><span>${escapeHTML(money(methodComparison.gaussian?.nominal?.p50))}</span><small>P10 ${escapeHTML(money(methodComparison.gaussian?.nominal?.p10))} · P90 ${escapeHTML(money(methodComparison.gaussian?.nominal?.p90))}</small></div><div><strong>بازنمونه‌گیری بلوکی · P50 اسمی</strong><span>${escapeHTML(money(methodComparison.bootstrap?.nominal?.p50))}</span><small>P10 ${escapeHTML(money(methodComparison.bootstrap?.nominal?.p10))} · P90 ${escapeHTML(money(methodComparison.bootstrap?.nominal?.p90))}</small></div></div>`
    : `<p class="data-note">برای مقایسه منصفانه گاوسی و بازنمونه‌گیری، حداقل ${MIN_PAIRED_MONTHS} بازده ماهانه مشترک برای همه دارایی‌های بازاری لازم است. در این اجرا چنین تاریخچه‌ای موجود نیست؛ روش انتخاب‌شده: ${escapeHTML(methodNames[monteCarlo.method] || methodNames.gaussian)}.</p>`;
  if (modelOutput) {
    modelOutput.innerHTML = `<p class="data-note simulation-model-warning">${escapeHTML(text("analysis.simulationNotForecast"))}</p>
      <div class="model-overview"><div><strong>کیفیت داده: ${escapeHTML(qualityLabel)}</strong><span>${escapeHTML(qualityReason)}</span></div><div><strong>${formatIRR(quality.jointObservations || 0)} ماه مشترک · ${escapeHTML(monthlyDates)}</strong><span>فراوانی بازده: ماهانه · تعداد مسیر: ${formatIRR(monteCarlo.paths)} · بذر بازتولید: ${monteCarlo.seed ?? "سفارشی"}</span></div><div><strong>عامل تورم افق: ${available(monteCarlo.inflationFactor) ? Number(monteCarlo.inflationFactor).toFixed(4) : text("analysis.unavailable")}</strong><span>ارزش واقعی = ارزش اسمی ÷ (۱ + تورم سالانه)^افق؛ تورم دوباره به بازده دارایی افزوده نمی‌شود.</span></div></div>
      <p class="data-note">${escapeHTML(methodNote)} ${escapeHTML(methodFallback)}</p>
      ${fixedDetails}
      <p class="data-note">${escapeHTML(sortinoHelp)}. ${escapeHTML(text("analysis.sortinoDefinition"))} MAR: ${escapeHTML(percent(monteCarlo.minimumAcceptableReturn?.annual))} سالانه و ${escapeHTML(percent(monteCarlo.minimumAcceptableReturn?.monthly))} ماهانه.</p>
      <div class="metric-grid simulation-advanced-grid">${advancedMetrics.map(([label, value]) => `<div class="metric"><small>${escapeHTML(label)}</small><strong>${escapeHTML(value)}</strong></div>`).join("")}${sharpe}</div>
      ${tail}
      <p class="data-note">${escapeHTML(correlationSummary)}</p>
      <section class="model-data-section"><h3>دارایی‌ها و تاریخچه</h3><div class="model-data-list">${assetRows || `<p>${escapeHTML(text("analysis.unavailable"))}</p>`}</div>${quality.historyFetchError ? `<p class="data-note data-note-warning">${escapeHTML(text("analysis.dataFetchFailed"))}</p>` : ""}</section>
      <section class="model-data-section"><h3>${escapeHTML(text("analysis.correlationDetails"))}</h3><div class="correlation-list">${correlationRows || "<p>در این سبد دارایی بازاری برای مقایسه همبستگی نیست.</p>"}</div><p class="small-note">فرض همبستگی پیش‌فرض در دارایی‌های مرتبط برای جلوگیری از تنوع‌بخشیِ کاذب به کار می‌رود؛ با داده مشترک ناکافی، دقت تاریخی ادعا نمی‌شود.</p></section>
      <section class="model-data-section"><h3>${escapeHTML(text("analysis.methodComparison"))}</h3>${comparisonMarkup}<p class="small-note">P10، P50 و P90 صدک‌های توزیع خروجی مسیرهای شبیه‌سازی‌شده‌اند. بازنمونه‌گیری از بلوک‌های سه‌ماهه‌ی پیوسته استفاده می‌کند و روش گاوسی توزیع lognormal همبسته دارد؛ هر دو روش با فرض‌های داده و نرخ انتخاب‌شده محدود می‌شوند.</p></section>`;
  }
  const scenarioEl = $("#scenario-comparison");
  if (scenarioEl) {
    scenarioEl.innerHTML = `<p class="data-note">قدرت خرید در میانه: ${escapeHTML(purchasingPowerLabel)} · تغییر نسبت به قدرت خرید واریزی‌ها: ${escapeHTML(percent(monteCarlo.purchasingPowerChange?.p50))}.</p>`;
  }
}

function renderBacktest(result) {
  if (!result || !result.available) {
    const missing = result?.unobservedAssets || [];
    const missingText = missing.length
      ? ` داده‌ی مشاهده‌شده برای ${missing.map((asset) => (asset === "fixed" ? "درآمد ثابت" : assetMeta(asset).title)).join(listSeparator())} وجود ندارد.`
      : "";
    const observed = result?.observations
      ? ` ${formatIRR(result.observations)} ماه داده‌ی ماهانه‌ی قابل استفاده موجود است.`
      : "";
    backtestEl.innerHTML = `<div class="empty-state">بک‌تست برای این ترکیب داده‌ی تاریخیِ پیوسته و مشاهده‌شده‌ی کافی ندارد.${escapeHTML(missingText)}${escapeHTML(observed)} نتیجه با بازده فرضی جایگزین نمی‌شود.</div>`;
    return;
  }
  const metric = (label, value, percent = false) => {
    const formatted =
      value === null || value === undefined || !Number.isFinite(Number(value))
        ? "—"
        : percent
          ? formatPercent(Number(value) * 100)
          : formatDisplayMoney(value);
    return `<div class="metric"><small>${escapeHTML(label)}</small><strong>${escapeHTML(formatted)}</strong></div>`;
  };
  const riskMetrics = `${metric(text("backtest.medianVolatility"), result.median.volatility, true)}${metric(text("backtest.medianSortino"), result.median.sortino, true)}`;
  const sharpe = Number.isFinite(result.median.sharpe)
    ? `<details class="advanced-risk-metric"><summary>${escapeHTML(text("backtest.advancedSharpe"))}</summary><div class="metric-grid">${metric(text("backtest.medianSharpe"), result.median.sharpe, true)}<p class="data-note">${escapeHTML(text("backtest.sharpeReference"))}: ${escapeHTML(result.referenceAnnualReturn === null || !Number.isFinite(result.referenceAnnualReturn) ? text("analysis.unavailable") : formatPercent(result.referenceAnnualReturn * 100))} ${escapeHTML(text("backtest.referenceFixedIncome"))}</p></div></details>`
    : "";
  backtestEl.innerHTML = `<div class="backtest-note">${escapeHTML(result.estimated ? text("backtest.partial") : text("backtest.full"))} ${escapeHTML(text("backtest.observations"))}: ${escapeHTML(String(result.observations))}</div><div class="metric-grid">${metric(text("backtest.medianFinal"), result.median.finalValue)}${metric(text("backtest.medianCagr"), result.median.cagr, true)}${metric(text("backtest.medianReal"), result.median.inflationAdjustedReturn, true)}${metric(text("backtest.medianDrawdown"), result.median.maxDrawdown, true)}${riskMetrics}</div>${sharpe}<div class="best-worst"><div><small>${escapeHTML(text("backtest.best"))}</small><strong>${escapeHTML(result.best.start)} ${escapeHTML(text("to"))} ${escapeHTML(result.best.end)}</strong><span>${result.best.cagr === null ? escapeHTML(text("analysis.unavailable")) : formatPercent(result.best.cagr * 100)}</span></div><div><small>${escapeHTML(text("backtest.worst"))}</small><strong>${escapeHTML(result.worst.start)} ${escapeHTML(text("to"))} ${escapeHTML(result.worst.end)}</strong><span>${result.worst.cagr === null ? escapeHTML(text("analysis.unavailable")) : formatPercent(result.worst.cagr * 100)}</span></div></div>`;
}

function renderHistory() {
  const history = readHistory();
  appStore.setState({ history });
  const portfolio = portfolioFromHistory(history, liveMarket);
  const categories = PLAN_ASSET_KEYS.filter((key) => portfolio.categories[key].invested > 0)
    .map((key) => {
      const meta = assetMeta(key);
      const category = portfolio.categories[key];
      const gain = category.value - category.invested;
      return `<div class="portfolio-row"><div><span class="asset-dot ${escapeHTML(meta.dotClass)}"></span><strong>${escapeHTML(meta.title)}</strong></div><div><strong>${escapeHTML(formatDisplayMoney(category.value))}</strong><small>${escapeHTML(text("history.current"))}</small></div><div class="${gain >= 0 ? "positive" : "negative"}"><strong>${gain >= 0 ? "+" : ""}${escapeHTML(formatDisplayMoney(gain))}</strong><small>${escapeHTML(text("history.gain"))}</small></div></div>`;
    })
    .join("");
  historySummaryEl.innerHTML = [
    [text("history.invested"), formatDisplayMoney(portfolio.totalInvested)],
    [text("history.value"), formatDisplayMoney(portfolio.currentValue)],
    [text("history.gain"), `${portfolio.gain >= 0 ? "+" : ""}${formatDisplayMoney(portfolio.gain)}`],
    [text("history.records"), String(history.length)],
  ]
    .map(
      ([label, value]) =>
        `<div class="metric"><small>${escapeHTML(label)}</small><strong>${escapeHTML(value)}</strong></div>`,
    )
    .join("");
  portfolioBreakdownEl.innerHTML = portfolio.totalInvested
    ? categories
    : `<div class="empty-state">${escapeHTML(text("history.emptyBreakdown"))}</div>`;
  const chronological = history.slice().reverse();
  const chartPoints = chronological.map((entry, index) => ({
    nominal: portfolioFromHistory(chronological.slice(0, index + 1), liveMarket).currentValue,
  }));
  renderLineChart(historyChartEl, chartPoints, "nominal", text("history.chart"));
  historyListEl.innerHTML = history.length
    ? history
        .slice(0, 15)
        .map(
          (entry) =>
            `<div class="history-item"><div><strong>${formatDate(entry.createdAt)}</strong><small>${formatPercent(entry.contributionRate)} ${escapeHTML(text("history.separator"))} ${escapeHTML(text("history.monthly"))}</small></div><div><strong>${escapeHTML(formatDisplayMoney(entry.total))}</strong><small>${escapeHTML(text("history.saved"))}</small></div></div>`,
        )
        .join("")
    : `<div class="empty-state">${escapeHTML(text("history.empty"))}</div>`;
  renderHistoricalComparison();
}

function historyAssetDefinitions() {
  return Object.keys(INSTRUMENT_REGISTRY).map((assetId) => ({
    id: assetId,
    name: text("market.labels." + assetId + ".title", assetMeta(assetId).title),
    color: HISTORY_CHART_COLORS[assetId] || "#667785",
    dotClass: assetId === "dollar" ? "asset-currency" : "asset-" + assetId,
  }));
}

function historyCoverageMessage(assetId) {
  const coverage = historyComparisonData?.assets?.[assetId]?.coverage;
  if (!coverage) return historyComparisonLoading ? "در حال دریافت" : "برای بررسی آماده است";
  const alternatives = (coverage.candidateSources || []).filter((source) => source !== coverage.source);
  const sourceDetails = [
    coverage.source ? `منبع فعال: ${coverage.source}` : null,
    alternatives.length ? `گزینه‌های دیگر: ${alternatives.join("، ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const frequencyDetail = coverage.frequency === "monthly" ? " · میانگین ماهانه" : "";
  if (coverage.status === "available")
    return `${formatIRR(coverage.observationCount)} مشاهده${frequencyDetail}${sourceDetails ? ` · ${sourceDetails}` : ""}`;
  const reasons = {
    "coingecko-demo-key-missing": "کلید Demo رمزارز تنظیم نشده",
    "nobitex-history-unavailable": "منبع عمومی تاریخچه رمزارز پاسخ نداد",
    "dated-fx-unavailable": "نرخ دلار تاریخ‌دار موجود نیست",
    "no-matching-dated-fx": "نرخ دلار هم‌تاریخ پیدا نشد",
    "no-observed-history-source": "منبع تاریخچه ندارد",
    "provider-history-empty": "منبع تاریخچه‌ای برنگرداند",
    "provider-unavailable": "منبع پاسخ نداد",
    "history-unavailable": "تاریخچه در دسترس نیست",
  };
  const reason =
    reasons[coverage.reason] ||
    (coverage.status === "insufficient-history" ? "مشاهده کافی نیست" : "تاریخچه در دسترس نیست");
  return `${reason}${sourceDetails ? ` · ${sourceDetails}` : ""}`;
}

function renderHistoryAssetOptions() {
  const container = $("#history-asset-options");
  if (!container) return;
  const definitions = historyAssetDefinitions();
  const selectedCount = historyComparisonSelection.size;
  $("#history-selected-count").textContent = formatIRR(selectedCount) + " انتخاب";
  container.innerHTML = definitions
    .map((asset) => {
      const checked = historyComparisonSelection.has(asset.id) ? " checked" : "";
      const disabled = !checked && selectedCount >= 3 ? " disabled" : "";
      return `<label class="history-asset-option"><input type="checkbox" data-history-asset="${escapeHTML(asset.id)}"${checked}${disabled}><span class="asset-dot ${escapeHTML(asset.dotClass)}"></span><span class="history-asset-copy"><strong>${escapeHTML(asset.name)}</strong><small>${escapeHTML(historyCoverageMessage(asset.id))}</small></span></label>`;
    })
    .join("");
  $$("[data-history-range]").forEach((button) => {
    const active = button.dataset.historyRange === historyComparisonRange;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const startInput = $("#history-start");
  const endInput = $("#history-end");
  if (startInput && document.activeElement !== startInput) startInput.value = historyCustomBounds?.start || "";
  if (endInput && document.activeElement !== endInput) endInput.value = historyCustomBounds?.end || "";
}

function historyReasonLabel(reason) {
  if (reason === "nobitex-history-unavailable") return "منبع عمومی تاریخچه رمزارز پاسخ نداد؛ با اتصال دوباره تلاش کن.";
  if (reason === "coingecko-demo-key-missing")
    return "برای نمایش تاریخچه رمزارز، کلید اختیاری CoinGecko Demo را در تنظیمات سرور قرار بده.";
  if (reason === "dated-fx-unavailable" || reason === "no-matching-dated-fx")
    return "تاریخچه به تومان تبدیل نشد؛ نرخ دلار هم‌تاریخ موجود نیست.";
  if (reason === "no-observed-history-source") return "برای این مورد هنوز منبع تاریخچه مشاهده‌شده وجود ندارد.";
  return "تاریخچه معتبر این دارایی در این بازه در دسترس نیست.";
}

function renderHistoryMetrics(metrics) {
  const container = $("#historical-comparison-metrics");
  if (!container) return;
  container.innerHTML = metrics
    .map((metric) => {
      const returnValue =
        metric.periodReturn === null
          ? "—"
          : (metric.periodReturn > 0 ? "+" : "") + formatPercent(metric.periodReturn * 100);
      const annualizedValue = metric.annualizedReturn === null ? "—" : formatPercent(metric.annualizedReturn * 100);
      const drawdownValue = metric.maxDrawdown === null ? "—" : formatPercent(metric.maxDrawdown * 100);
      const volatility = metric.annualizedVolatility === null ? "—" : formatPercent(metric.annualizedVolatility * 100);
      const cvar = metric.cvar95 === null ? "—" : formatPercent(metric.cvar95 * 100);
      const riskLabels = { low: "کم", medium: "متوسط", high: "زیاد" };
      const risk = metric.riskLevel ? `${riskLabels[metric.riskLevel]} · نسبی` : "—";
      return `<article class="history-performance-card"><strong class="history-performance-title">${escapeHTML(metric.name)}</strong><small class="history-metric-period">${escapeHTML(formatDate(metric.from))} تا ${escapeHTML(formatDate(metric.to))}</small><div class="history-performance-values"><div><small>بازده دوره</small><b>${escapeHTML(returnValue)}</b></div><div><small>CAGR (از یک سال)</small><b>${escapeHTML(annualizedValue)}</b></div><div><small>نوسان سالانه‌شده</small><b>${escapeHTML(volatility)}</b></div><div><small>بیشترین افت</small><b>${escapeHTML(drawdownValue)}</b></div><div><small>CVaR ۹۵٪</small><b>${escapeHTML(cvar)}</b></div><div><small>ریسک نسبی</small><b>${escapeHTML(risk)}</b></div><div><small>تعداد مشاهده</small><b>${escapeHTML(formatIRR(metric.observationCount))}</b></div></div></article>`;
    })
    .join("");
}

function renderHistoricalComparison() {
  const chart = $("#historical-comparison-chart");
  const list = $("#historical-comparison-list");
  if (!chart || !list) return;
  renderHistoryAssetOptions();

  const assets = {};
  const selectedDefinitions = historyAssetDefinitions().filter((asset) => historyComparisonSelection.has(asset.id));
  selectedDefinitions.forEach((asset) => {
    assets[asset.id] = {
      name: asset.name,
      color: asset.color,
      points: historyComparisonData?.assets?.[asset.id]?.points || [],
    };
  });
  const comparison = prepareHistoricalAnalysis(assets, {
    range: historyCustomBounds ? "all" : historyComparisonRange,
    start: historyCustomBounds?.start,
    end: historyCustomBounds?.end,
    mode: historyComparisonMode,
    currency: historyComparisonCurrency,
    fxPoints: historyComparisonData?.assets?.dollar?.points || [],
  });
  const unitFor = (assetId) =>
    assetId === "dollar"
      ? "تومان برای هر دلار"
      : assetId === "bourseIndex"
        ? "نقطه"
        : historyComparisonCurrency === "USD"
          ? "دلار"
          : "تومان";
  const historyPriceLabel = (value, assetId) => {
    const unit =
      assetId === "bourseIndex"
        ? text("history.indexPoints", "نقطه")
        : assetId === "dollar"
          ? `${currencyName("TOMAN")} / ${currencyName("USD")}`
          : currencyName(historyComparisonCurrency);
    return `${formatIRR(value)} ${unit}`;
  };
  if (historyComparisonMode === "price") {
    chart.innerHTML = comparison.series.length
      ? comparison.series
          .map(
            (item) =>
              `<section class="history-price-chart"><h4>${escapeHTML(item.name)} · ${escapeHTML(unitFor(item.id))}</h4><div>${lineChartMarkup(
                {
                  series: [
                    { ...item, points: item.points.map((point) => ({ ...point, label: formatDate(point.date) })) },
                  ],
                  ariaLabel: `قیمت ${item.name} به ${unitFor(item.id)}`,
                  emptyLabel: "برای این بازه داده‌ی قیمت کافی در دسترس نیست.",
                  valueLabel: (value) => historyPriceLabel(value, item.id),
                  height: 280,
                },
              )}</div></section>`,
          )
          .join("")
      : `<div class="empty-state">برای این بازه داده‌ی قیمت کافی در دسترس نیست.</div>`;
  } else {
    const series = comparison.series.map((item) => ({
      ...item,
      points: item.points.map((point) => ({ ...point, label: formatDate(point.date) })),
    }));
    chart.innerHTML = lineChartMarkup({
      series,
      ariaLabel: "مقایسه‌ی بازده درصدی دارایی‌های بازار",
      emptyLabel: "برای این انتخاب‌ها، تاریخچه‌ی کافی در بازه وجود ندارد.",
      valueLabel: (value) => formatPercent(value, 2),
      height: 340,
    });
  }
  renderHistoryMetrics(comparison.metrics);

  const status = $("#historical-comparison-status");
  if (status) {
    if (historyComparisonLoading) status.textContent = "در حال دریافت تاریخچه منابع انتخاب‌شده…";
    else if (historyComparisonError)
      status.innerHTML =
        escapeHTML(historyComparisonError) +
        ' <button id="history-comparison-retry" class="text-button" type="button">تلاش دوباره</button>';
    else if (comparison.from && comparison.to)
      status.textContent = `داده‌ی مشاهده‌شده برای ${formatIRR(comparison.metrics.length)} دارایی · بازه‌ی قابل مشاهده ${formatDate(comparison.from)} تا ${formatDate(comparison.to)}. برای هر دارایی، دوره‌ی دقیق جداگانه در کارت آن آمده است.`;
    else status.textContent = "داده تاریخی کافی برای این ترکیب در دسترس نیست.";
  }
  list.innerHTML = selectedDefinitions
    .map((asset) => {
      const coverage = historyComparisonData?.assets?.[asset.id]?.coverage;
      const available = coverage?.status === "available";
      const detail = available ? historyCoverageMessage(asset.id) : historyReasonLabel(coverage?.reason);
      return `<div class="benchmark-item"><span class="health-dot ${available ? "health-good" : "health-neutral"}"></span><div><strong>${escapeHTML(asset.name)}</strong><small>${escapeHTML(detail)}</small></div><b>${available ? "قابل مقایسه" : "در دسترس نیست"}</b></div>`;
    })
    .join("");
}

function selectedHistoryMarketAssets() {
  const requested = new Set(historyComparisonSelection);
  if ([...requested].some((assetId) => !["dollar", "bourseIndex", "fixedIncome", "cash"].includes(assetId)))
    requested.add("dollar");
  return [...requested].sort();
}

async function loadHistoricalMarketHistory(force = false) {
  if (appStore.getState().activeView !== "history") return;
  const selectedAssets = selectedHistoryMarketAssets();
  const signature =
    historyComparisonRange +
    "|" +
    (historyCustomBounds?.start || "") +
    "|" +
    (historyCustomBounds?.end || "") +
    "|" +
    selectedAssets.join(",");
  if (!force && (signature === historyComparisonLoadedSignature || signature === historyComparisonPendingSignature))
    return;
  const historyCache = readJson(HISTORY_MARKET_CACHE_KEY, {});
  const cached = historyCache && historyCache[signature];
  if (!force && cached && Date.now() - Number(cached.cachedAt) < 60 * 60 * 1000) {
    historyComparisonData = cached.data;
    historyComparisonLoadedSignature = signature;
    historyComparisonPendingSignature = "";
    historyComparisonLoading = false;
    renderHistoricalComparison();
    return;
  }
  historyComparisonRequestId += 1;
  const requestId = historyComparisonRequestId;
  historyComparisonLoading = selectedAssets.length > 0;
  historyComparisonError = null;
  if (!selectedAssets.length) {
    historyComparisonData = { assets: {} };
    historyComparisonLoadedSignature = signature;
    historyComparisonPendingSignature = "";
    historyComparisonLoading = false;
    renderHistoricalComparison();
    return;
  }
  historyComparisonPendingSignature = signature;
  renderHistoricalComparison();
  try {
    await ensureApiSession();
    const query = new URLSearchParams({
      assets: selectedAssets.join(","),
      range: historyCustomBounds ? "all" : historyComparisonRange,
    });
    if (historyCustomBounds?.start) query.set("start", historyCustomBounds.start);
    if (historyCustomBounds?.end) query.set("end", historyCustomBounds.end);
    const response = await fetchWithTimeout(
      "/api/history?" + query.toString(),
      { cache: "no-store", credentials: "same-origin", headers: providerRequestHeaders() },
      20000,
    );
    if (!response.ok) throw new Error("history-api-unavailable");
    const data = await response.json();
    if (requestId !== historyComparisonRequestId) return;
    historyComparisonData = data;
    const nextCache = {
      ...(readJson(HISTORY_MARKET_CACHE_KEY, {}) || {}),
      [signature]: { cachedAt: Date.now(), data },
    };
    const cacheEntries = Object.entries(nextCache)
      .sort((left, right) => Number(right[1]?.cachedAt) - Number(left[1]?.cachedAt))
      .slice(0, 5);
    writeJson(HISTORY_MARKET_CACHE_KEY, Object.fromEntries(cacheEntries));
    historyComparisonLoadedSignature = signature;
    historyComparisonPendingSignature = "";
    historyComparisonLoading = false;
    renderHistoricalComparison();
  } catch {
    if (requestId !== historyComparisonRequestId) return;
    historyComparisonError = "تاریخچه دریافت نشد؛ اتصال منبع را بررسی کن.";
    historyComparisonLoadedSignature = signature;
    historyComparisonPendingSignature = "";
    historyComparisonLoading = false;
    renderHistoricalComparison();
  }
}

function hideChartTooltip(chart) {
  const tooltip = chart?.querySelector(".chart-tooltip");
  if (tooltip) tooltip.hidden = true;
  if (chart) delete chart.dataset.tooltipPinned;
}

function showChartTooltip(point, pinned = false) {
  const chart = point?.closest(".line-chart");
  const tooltip = chart?.querySelector(".chart-tooltip");
  if (!chart || !tooltip) return;
  tooltip.textContent = point.getAttribute("aria-label") || point.querySelector("title")?.textContent || "";
  tooltip.hidden = false;
  const chartRect = chart.getBoundingClientRect();
  const pointRect = point.getBoundingClientRect();
  const center = pointRect.left + pointRect.width / 2 - chartRect.left;
  tooltip.style.left = clampTooltipCenter(center, tooltip.offsetWidth, chartRect.width) + "px";
  tooltip.style.top = Math.max(4, pointRect.top - chartRect.top - tooltip.offsetHeight - 9) + "px";
  const svg = chart.querySelector("svg");
  const crosshairX = chart.querySelector('[data-axis="x"]');
  const crosshairY = chart.querySelector('[data-axis="y"]');
  if (svg && crosshairX && crosshairY) {
    const x = Number(point.dataset.x);
    const y = Number(point.dataset.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      crosshairX.setAttribute("x1", String(x));
      crosshairX.setAttribute("x2", String(x));
      crosshairX.hidden = false;
      crosshairY.setAttribute("y1", String(y));
      crosshairY.setAttribute("y2", String(y));
      crosshairY.hidden = false;
    }
  }
  if (pinned) chart.dataset.tooltipPinned = "true";
}

function nearestChartPoint(chart, clientX) {
  const svg = chart?.querySelector("svg");
  const rect = svg?.getBoundingClientRect();
  if (!svg || !rect || rect.width <= 0) return null;
  const viewWidth = Number(svg.viewBox?.baseVal?.width) || 760;
  const chartX = ((clientX - rect.left) / rect.width) * viewWidth;
  return (
    [...chart.querySelectorAll(".chart-dot")].reduce((nearest, point) => {
      const distance = Math.abs(Number(point.dataset.x) - chartX);
      return Number.isFinite(distance) && (!nearest || distance < nearest.distance) ? { point, distance } : nearest;
    }, null)?.point || null
  );
}

function chartPointsInDateOrder(chart) {
  return [...chart.querySelectorAll(".chart-dot, .chart-bar")].sort((left, right) => {
    const leftTime = Number(left.dataset.timestamp);
    const rightTime = Number(right.dataset.timestamp);
    const byDate = Number.isFinite(leftTime) && Number.isFinite(rightTime) ? leftTime - rightTime : 0;
    return byDate || Number(left.dataset.sequence) - Number(right.dataset.sequence);
  });
}

function bindChartTooltips() {
  document.addEventListener("pointermove", (event) => {
    const chart = event.target.closest?.(".line-chart");
    if (!chart || event.pointerType === "touch" || chart.dataset.tooltipPinned === "true") return;
    if (event.target.closest?.(".chart-bar")) return;
    const point = nearestChartPoint(chart, event.clientX);
    if (point) showChartTooltip(point);
  });
  document.addEventListener("pointerover", (event) => {
    const point = event.target.closest?.(".chart-dot, .chart-bar");
    if (point) showChartTooltip(point);
  });
  document.addEventListener("focusin", (event) => {
    const chart = event.target.closest?.(".line-chart");
    if (!chart) return;
    if (event.target.matches("svg")) {
      const first = chartPointsInDateOrder(chart)[0];
      first?.focus();
    } else if (event.target.matches(".chart-dot, .chart-bar")) showChartTooltip(event.target);
  });
  document.addEventListener("pointerout", (event) => {
    const chart = event.target.closest?.(".line-chart");
    if (
      !chart ||
      chart.contains(event.relatedTarget) ||
      chart.dataset.tooltipPinned === "true" ||
      chart.contains(document.activeElement)
    )
      return;
    hideChartTooltip(chart);
  });
  document.addEventListener("click", (event) => {
    const point = event.target.closest?.(".chart-dot, .chart-bar");
    if (!point) return;
    event.preventDefault();
    showChartTooltip(point, true);
  });
  document.addEventListener("pointerdown", (event) => {
    const point = event.target.closest?.(".chart-dot, .chart-bar");
    if (point) {
      showChartTooltip(point, true);
      return;
    }
    const chart = event.target.closest?.(".line-chart");
    if (chart) {
      const nearest = nearestChartPoint(chart, event.clientX);
      if (nearest) showChartTooltip(nearest, true);
      return;
    }
    $$(".line-chart").forEach(hideChartTooltip);
  });
  document.addEventListener("keydown", (event) => {
    const point = event.target.closest?.(".chart-dot, .chart-bar");
    if (!point || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const chart = point.closest(".line-chart");
    const points = chartPointsInDateOrder(chart);
    const currentIndex = points.indexOf(point);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? points.length - 1
          : Math.max(0, Math.min(points.length - 1, currentIndex + (event.key === "ArrowRight" ? 1 : -1)));
    if (points[nextIndex]) {
      event.preventDefault();
      points[nextIndex].focus();
    }
  });
}

function calculatePlan(inputs) {
  const assetKeys = selectedPlanAssetKeys(inputs.selectedAssets);
  const history = readHistory();
  const portfolio = portfolioFromHistory(history, liveMarket);
  const ledger = calculatePortfolio(readPortfolio(), liveMarket || {});
  const currentHoldings = ledger.transactions.length
    ? Object.fromEntries(PLAN_ASSET_KEYS.map((asset) => [asset, Math.max(0, Number(ledger.values[asset]?.value) || 0)]))
    : Object.fromEntries(PLAN_ASSET_KEYS.map((key) => [key, portfolio.categories[key].value]));
  const recommendation = recommendAllocation(inputs.profile, {
    enabledAssets: inputs.selectedAssets,
    assumptions: modelSettings?.assumptions || DEFAULT_ASSUMPTIONS,
    market: liveMarket || {},
    currentHoldings,
    inflationRate: modelSettings?.inflationRate,
    transactionCosts: modelSettings?.transactionCosts || DEFAULT_TRANSACTION_COSTS,
    allowMicroAllocation: inputs.allowMicroAllocation,
    includeCurrency: inputs.selectedAssets.includes("currency"),
  });
  const contribution = contributionRebalance(
    currentHoldings,
    recommendation.weights,
    inputs.monthlyContribution,
    assetKeys,
    {
      driftThresholdPercent: modelSettings?.targetDriftThresholdPercent ?? 3,
      transactionCosts: modelSettings?.transactionCosts || DEFAULT_TRANSACTION_COSTS,
    },
  );
  contribution.excludedInvestableTotal = ledger.transactions.length
    ? Math.max(0, ledger.investableTotal - Object.values(currentHoldings).reduce((total, value) => total + value, 0))
    : 0;
  contribution.excludedMissingCount = ledger.transactions.length ? ledger.missingPrices.length : 0;
  return { inputs, recommendation, contribution, portfolio, currentHoldings, assetKeys };
}

function cancelAnalysisWorker() {
  if (!analysisWorkerTask) return;
  analysisRequestId += 1;
  analysisWorkerTask.worker?.terminate();
  analysisWorkerTask.resolve(null);
  analysisWorkerTask = null;
}

function runAnalysisWorker(task) {
  cancelAnalysisWorker();
  const requestId = ++analysisRequestId;
  if (typeof Worker === "undefined") return Promise.reject(new Error("analysis-worker-unavailable"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./src/analysis.worker.js", import.meta.url), { type: "module" });
    analysisWorkerTask = { worker, resolve, taskType: task.type };
    worker.addEventListener("message", (event) => {
      if (event.data?.requestId !== requestId || analysisRequestId !== requestId) return;
      worker.terminate();
      analysisWorkerTask = null;
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.result);
    });
    worker.addEventListener(
      "error",
      () => {
        if (analysisRequestId !== requestId) return;
        worker.terminate();
        analysisWorkerTask = null;
        reject(new Error("analysis-worker-failed"));
      },
      { once: true },
    );
    worker.postMessage({ requestId, task });
  });
}

function renderPlanOutput(plan) {
  const { inputs, recommendation, contribution, portfolio } = plan;
  $("#monthly-investment").textContent = formatDisplayMoney(inputs.monthlyContribution);
  $("#monthly-rate").textContent = formatPercent(inputs.contributionRate);
  $("#profile-label").textContent = text(
    `profileLabels.${inputs.profile.riskTolerance}`,
    text("profileLabels.conservative"),
  );
  allocationListEl.innerHTML = allocationRows(recommendation.weights, contribution.amounts, plan.assetKeys, true);
  renderContributionPlan(contribution, plan.assetKeys);
  renderReasons(inputs.profile, portfolio);
  const saveButton = $("#save-plan-result");
  if (saveButton) saveButton.disabled = Boolean(plan.saved);
}

function renderPlan({ scrollIntoView = true, validate = true } = {}) {
  const inputs = getPlanInputs();
  if (!(inputs.salary > 0)) {
    if (validate) {
      $("#salary").focus();
      $("#salary").setCustomValidity(text("errors.salary", fallbackCopy.errors.salary));
      $("#salary").reportValidity();
    }
    return false;
  }
  $("#salary").setCustomValidity("");
  persistProfile();
  lastPlan = calculatePlan(inputs);
  lastPlan.saved = false;
  renderPlanOutput(lastPlan);
  appStore.setState({ profile: inputs.profile, monthlyInvestment: inputs.monthlyContribution, plan: lastPlan });
  resultPanel.classList.remove("is-hidden");
  const previewStatus = $("#plan-preview-status");
  if (previewStatus) {
    previewStatus.textContent = "پیش‌نمایش ذخیره نشده است؛ وزن‌ها را بازبینی و سپس همین نسخه را ثبت کن.";
    previewStatus.className = "transfer-status transfer-neutral";
  }
  renderDashboard();
  if (scrollIntoView) resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

function saveHistory(inputs, recommendation, contribution) {
  const history = readHistory();
  const entry = {
    createdAt: new Date().toISOString(),
    salary: inputs.salary,
    contributionRate: inputs.contributionRate,
    total: inputs.monthlyContribution,
    weights: recommendation.weights,
    contributionPlan: contribution.amounts,
    profile: inputs.profile,
    selectedAssets: inputs.selectedAssets,
    marketSnapshot: marketSnapshot(liveMarket),
  };
  return writeJson(HISTORY_KEY, mergeHistory([entry], history, HISTORY_LIMIT));
}

function savePlanPreview() {
  if (!lastPlan || lastPlan.saved) return;
  const previewStatus = $("#plan-preview-status");
  const cryptoWeight =
    (Number(lastPlan.recommendation.weights.bitcoin) || 0) + (Number(lastPlan.recommendation.weights.ethereum) || 0);
  if (cryptoWeight > 5 + 1e-6) {
    if (previewStatus) {
      previewStatus.textContent = "وزن مجموع بیت‌کوین و اتریوم نباید از ۵٪ بیشتر شود.";
      previewStatus.className = "transfer-status transfer-warning";
    }
    return;
  }
  if (!saveHistory(lastPlan.inputs, lastPlan.recommendation, lastPlan.contribution)) {
    if (previewStatus) {
      previewStatus.textContent = "این پیشنهاد ذخیره نشد؛ فضای ذخیره‌سازی مرورگر را بررسی کن.";
      previewStatus.className = "transfer-status transfer-warning";
    }
    return;
  }
  lastPlan.saved = true;
  appStore.setState({ plan: lastPlan });
  renderHistory();
  renderDashboard();
  if (previewStatus) {
    previewStatus.textContent = "همین نسخه‌ی پیشنهادی در سابقه‌ی این دستگاه ذخیره شد؛ دارایی و تراکنشی تغییر نکرد.";
    previewStatus.className = "transfer-status transfer-success";
  }
  const saveButton = $("#save-plan-result");
  if (saveButton) saveButton.disabled = true;
}

function updatePlanWeights(event) {
  const input = event.target.closest?.("[data-plan-weight]");
  if (!input || !lastPlan) return;
  const assetKeys = lastPlan.assetKeys;
  const raw = Object.fromEntries(
    assetKeys.map((assetId) => [assetId, Number($(`[data-plan-weight="${assetId}"]`)?.value)]),
  );
  if (Object.values(raw).some((weight) => !Number.isFinite(weight) || weight < 0)) {
    const previewStatus = $("#plan-preview-status");
    if (previewStatus) {
      previewStatus.textContent = "وزن‌ها باید عددی و نامنفی باشند.";
      previewStatus.className = "transfer-status transfer-warning";
    }
    const saveButton = $("#save-plan-result");
    if (saveButton) saveButton.disabled = true;
    return;
  }
  const total = Object.values(raw).reduce((sum, weight) => sum + weight, 0);
  const previewStatus = $("#plan-preview-status");
  const saveButton = $("#save-plan-result");
  if (total <= 0) {
    if (previewStatus) {
      previewStatus.textContent = "حداقل وزن یک دارایی باید بیشتر از صفر باشد.";
      previewStatus.className = "transfer-status transfer-warning";
    }
    if (saveButton) saveButton.disabled = true;
    return;
  }
  const weights = Object.fromEntries(assetKeys.map((assetId) => [assetId, (raw[assetId] / total) * 100]));
  const roundingKey = assetKeys
    .filter((assetId) => !["bitcoin", "ethereum"].includes(assetId))
    .sort((left, right) => weights[right] - weights[left])[0];
  assetKeys.forEach((assetId) => {
    weights[assetId] = Math.round(weights[assetId] * 10) / 10;
  });
  if (roundingKey) {
    const roundingDelta = Math.round((100 - Object.values(weights).reduce((sum, weight) => sum + weight, 0)) * 10) / 10;
    weights[roundingKey] = Math.max(0, weights[roundingKey] + roundingDelta);
  }
  const cryptoWeight = (weights.bitcoin || 0) + (weights.ethereum || 0);
  if (cryptoWeight > 5 + 1e-6) {
    if (previewStatus) {
      previewStatus.textContent = "وزن مجموع بیت‌کوین و اتریوم حداکثر ۵٪ است؛ سهم آن‌ها را کاهش بده.";
      previewStatus.className = "transfer-status transfer-warning";
    }
    if (saveButton) saveButton.disabled = true;
    return;
  }
  lastPlan.recommendation.weights = normalizeAllocation(weights, DEFAULT_ALLOCATION, assetKeys);
  const contribution = contributionRebalance(
    lastPlan.currentHoldings,
    lastPlan.recommendation.weights,
    lastPlan.inputs.monthlyContribution,
    assetKeys,
    {
      driftThresholdPercent: modelSettings?.targetDriftThresholdPercent ?? 3,
      transactionCosts: modelSettings?.transactionCosts || DEFAULT_TRANSACTION_COSTS,
    },
  );
  contribution.excludedInvestableTotal = lastPlan.contribution.excludedInvestableTotal;
  contribution.excludedMissingCount = lastPlan.contribution.excludedMissingCount;
  lastPlan.contribution = contribution;
  lastPlan.saved = false;
  renderPlanOutput(lastPlan);
  if (previewStatus) {
    previewStatus.textContent = "وزن‌ها به ۱۰۰٪ نرمال شدند؛ این پیشنهاد هنوز ذخیره نشده است.";
    previewStatus.className = "transfer-status transfer-neutral";
  }
  appStore.setState({ plan: lastPlan });
  renderDashboard();
}

function handleMarketAssetSubmit(event) {
  event.preventDefault();
  let assetId = $("#portfolio-market-asset").value;
  const quantity = Math.max(0, numberFromInput($("#portfolio-market-quantity").value));
  const acquisitionDate = $("#portfolio-market-date").value;
  const acquisitionIso = dateTimeInputToIso(acquisitionDate);
  const newTitle = $("#portfolio-new-stock-title").value.trim();
  const enteredPrice = Math.max(0, numberFromInput($("#portfolio-market-acquisition-price").value));
  if ((!assetId && !newTitle) || !(quantity > 0) || !acquisitionIso) {
    setPortfolioStatus("دارایی و مقدار معتبر وارد کن.", "warning");
    return;
  }
  const now = new Date().toISOString();
  let portfolio = readPortfolio();
  let createdCustom = false;
  if (newTitle) {
    const existing = Object.values(portfolio.assets || {}).find(
      (asset) => asset.title.toLocaleLowerCase() === newTitle.toLocaleLowerCase(),
    );
    if (existing) assetId = existing.id;
    else {
      const created = createPortfolioAsset(portfolio, { title: newTitle, kind: "stock", unit: "share" }, now);
      if (!created.asset) {
        setPortfolioStatus(text("portfolio.invalidStock"), "warning");
        return;
      }
      portfolio = created.portfolio;
      assetId = created.asset.id;
      createdCustom = true;
    }
  }
  const marketPrice = createdCustom ? null : marketEntryPriceAt(assetId, acquisitionDate);
  const unitPrice = enteredPrice > 0 ? enteredPrice : marketPrice;
  if (!(Number.isFinite(Number(unitPrice)) && Number(unitPrice) > 0)) {
    setPortfolioStatus("برای این تاریخ قیمت معتبر در دسترس نیست؛ بهای واقعی هر واحد را وارد کن.", "warning");
    $("#portfolio-market-acquisition-price").focus();
    return;
  }
  const isBackdated = new Date(acquisitionIso).getTime() < Date.now() - 60_000;
  if (
    isBackdated &&
    !window.confirm("این تراکنش با زمان گذشته ثبت می‌شود و روی محاسبات تاریخی پرتفوی اثر دارد. ادامه می‌دهی؟")
  )
    return;
  const type = activePortfolioVersion(portfolio).transactions.length ? "BUY" : "OPENING";
  const transaction = createTransaction(
    {
      type,
      assetId,
      quantity,
      unitPrice,
      source: "market-asset-entry",
      note: "Market asset entry",
      date: acquisitionIso,
    },
    liveMarket || {},
    now,
    portfolio,
  );
  if (!transaction) {
    setPortfolioStatus(text("portfolio.validation"), "warning");
    return;
  }
  const appended = appendTransactions(portfolio, [transaction], {
    action: type === "OPENING" ? "create-market-asset-opening" : "record-market-asset-purchase",
    affectsHistory: isBackdated,
    detail: assetId,
  });
  if (!appended.validation.valid || !writePortfolio(appended.portfolio)) {
    setPortfolioStatus(text("portfolio.validation"), "warning");
    return;
  }
  event.target.reset();
  $("#portfolio-market-date").value = localDateTimeValue();
  renderPortfolio();
  $("#portfolio-section").open = true;
  setPortfolioStatus("موجودی در دفتر ثبت شد. این ثبت هیچ سفارش خرید یا فروش واقعی ارسال نمی‌کند.", "success");
}

function handleManualQuoteSubmit(event) {
  event.preventDefault();
  const assetId = $("#manual-quote-asset").value;
  const price = Math.max(0, numberFromInput($("#manual-quote-price").value));
  const observedAt = dateTimeInputToIso($("#manual-quote-date").value);
  if (!assetId || !(price > 0) || !observedAt || new Date(observedAt).getTime() > Date.now() + 60_000) {
    setPortfolioStatus("دارایی، قیمت مثبت و زمان مشاهده‌ی معتبر وارد کن.", "warning");
    return;
  }
  const portfolio = readPortfolio();
  const manualQuotes = [
    ...(portfolio.manualQuotes || []),
    {
      id: createManualQuoteId(),
      assetId,
      price,
      observedAt,
      createdAt: new Date().toISOString(),
      source: "manual",
    },
  ].sort((left, right) => new Date(left.observedAt).getTime() - new Date(right.observedAt).getTime());
  if (!writePortfolio({ ...portfolio, manualQuotes })) {
    setPortfolioStatus("قیمت ذخیره نشد؛ فضای ذخیره‌سازی مرورگر را بررسی کن.", "warning");
    return;
  }
  event.target.reset();
  $("#manual-quote-date").value = localDateTimeValue();
  renderPortfolio();
  setPortfolioStatus("قیمت به تاریخچه‌ی قیمت‌ها اضافه شد؛ هیچ تراکنشی ساخته نشد.", "success");
}

function updateAdvancedTransactionFields() {
  const type = $("#advanced-type").value;
  const transfer = type === "TRANSFER";
  const cashFlow = ["DEPOSIT", "WITHDRAWAL"].includes(type);
  const quantityType = ["OPENING", "BUY", "SELL", "ADJUSTMENT", "TRANSFER"].includes(type);
  $("#advanced-quantity-label").textContent = quantityType ? text("portfolio.quantity") : text("portfolio.amount");
  $("#advanced-quantity").disabled = !quantityType;
  $("#advanced-amount").disabled = quantityType && type !== "TRANSFER";
  $("#advanced-asset").disabled = cashFlow;
  if (cashFlow) $("#advanced-asset").value = "cash";
  $("#advanced-target-asset").closest(".field").classList.toggle("is-hidden", !transfer);
  $("#advanced-target-quantity").closest(".field").classList.toggle("is-hidden", !transfer);
  $("#advanced-unit-price")
    .closest(".field")
    .classList.toggle("is-hidden", !quantityType || type === "TRANSFER");
}

function handleAdvancedTransactionSubmit(event) {
  event.preventDefault();
  const type = $("#advanced-type").value;
  const date = $("#advanced-date").value || localDateTimeValue();
  const now = new Date().toISOString();
  const dateTimestamp = new Date(date).getTime();
  const input = {
    type,
    assetId: ["DEPOSIT", "WITHDRAWAL"].includes(type) ? "cash" : $("#advanced-asset").value,
    targetAssetId: $("#advanced-target-asset").value,
    date,
    quantity: ["OPENING", "BUY", "SELL", "ADJUSTMENT", "TRANSFER"].includes(type)
      ? numberFromInput($("#advanced-quantity").value)
      : undefined,
    targetQuantity: numberFromInput($("#advanced-target-quantity").value),
    unitPrice: numberFromInput($("#advanced-unit-price").value) || undefined,
    amount: ["DIVIDEND", "DEPOSIT", "WITHDRAWAL"].includes(type)
      ? numberFromInput($("#advanced-amount").value)
      : undefined,
    fee: numberFromInput($("#advanced-fee").value),
    note: $("#advanced-note").value,
  };
  const transaction = createTransaction(input, liveMarket || {}, now, readPortfolio());
  if (!transaction) {
    setPortfolioStatus(text("portfolio.validation"), "warning");
    return;
  }
  const affectsHistory = type === "ADJUSTMENT" || dateTimestamp < Date.now() - 60_000;
  if (affectsHistory && !window.confirm(text("portfolio.confirmHistoryChange"))) return;
  const appended = appendTransactions(readPortfolio(), [transaction], {
    action: "add-advanced-transaction",
    affectsHistory,
    detail: type,
  });
  if (!appended.validation.valid || !writePortfolio(appended.portfolio)) {
    setPortfolioStatus(text("portfolio.validation"), "warning");
    return;
  }
  event.target.reset();
  $("#advanced-date").value = localDateTimeValue();
  updateAdvancedTransactionFields();
  renderPortfolio();
  setPortfolioStatus(text("portfolio.advancedSaved"), "success");
}

function setTransferStatus(message, type = "neutral") {
  [$("#history-transfer-status"), $("#settings-transfer-status")].filter(Boolean).forEach((element) => {
    element.textContent = message;
    element.className = `transfer-status transfer-${type}`;
  });
}

function previewPlanIfVisible() {
  if (resultPanel?.classList.contains("is-hidden")) return;
  if (numberFromInput($("#salary")?.value) <= 0) {
    window.clearTimeout(planPreviewTimer);
    resultPanel.classList.add("is-hidden");
    lastPlan = null;
    appStore.setState({ plan: null, monthlyInvestment: 0 });
    const previewStatus = $("#plan-preview-status");
    if (previewStatus) {
      previewStatus.textContent = "برای نمایش پیش‌نمایش، حقوق ماهانه معتبر را وارد کن.";
      previewStatus.className = "transfer-status transfer-warning";
    }
    return;
  }
  window.clearTimeout(planPreviewTimer);
  planPreviewTimer = window.setTimeout(() => {
    renderPlan({ scrollIntoView: false, validate: false });
  }, 180);
}

function clearAllLocalData() {
  [
    HISTORY_KEY,
    "investment-plan-history-v3",
    PORTFOLIO_KEY,
    PROFILE_KEY,
    SETTINGS_KEY,
    MARKET_CACHE_KEY,
    INFLATION_CACHE_KEY,
    HISTORY_MARKET_CACHE_KEY,
    CURRENCY_MIGRATION_KEY,
  ].forEach((key) => localStorage.removeItem(key));
  clearProviderApiKey();
  modelSettings = defaultModelSettings();
  writeJson(SETTINGS_KEY, modelSettings);
  lastPlan = null;
  window.clearTimeout(planPreviewTimer);
  liveMarket = null;
  storageWarning = false;
  appStore.setState({ market: null, history: [], portfolio: null, plan: null, monthlyInvestment: 0, error: null });
  form.reset();
  $("#contribution-output").textContent = formatPercent(Number($("#contribution-rate").value), 0);
  renderSettingsAssumptions();
  renderHistory();
  renderPortfolio();
  renderDashboard();
  renderMarket(null);
  renderSettingsAssumptions();
  applyModelSettingsToSimulation();
  setTransferStatus("داده‌های محلی حذف شد.", "success");
}

function exportHistory() {
  const records = readHistory();
  const portfolio = readPortfolio();
  const hasPortfolio = activePortfolioVersion(portfolio).transactions.length > 0;
  if (!records.length && !hasPortfolio) {
    setTransferStatus(text("history.transfer.empty"), "warning");
    return;
  }
  const payload = JSON.stringify(createHistoryExport(records, portfolio), null, 2);
  const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `synthora-history-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  const portfolioLabel = hasPortfolio ? ` ${text("history.separator")} ${text("portfolio.exported")}` : "";
  setTransferStatus(`${text("history.transfer.exported")} ${records.length}${portfolioLabel}`, "success");
}

async function importHistoryFile(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    setTransferStatus(text("history.transfer.tooLarge"), "warning");
    return;
  }
  try {
    const parsed = parseHistoryExport(JSON.parse(await file.text()));
    const importedRecords = parsed.currencyUnit === "TOMAN" ? parsed.records : migrateHistoryCurrency(parsed.records);
    const current = readHistory();
    const merged = mergeHistory(current, importedRecords, HISTORY_LIMIT);
    let portfolioRestored = false;
    let portfolioSkipped = false;
    let importedPortfolio = null;
    if (parsed.portfolio) {
      importedPortfolio =
        parsed.currencyUnit === "TOMAN" ? parsed.portfolio : migratePortfolioCurrency(parsed.portfolio);
      const currentPortfolio = readPortfolio();
      const currentHasPortfolio = activePortfolioVersion(currentPortfolio).transactions.length > 0;
      if (!currentHasPortfolio || window.confirm(text("portfolio.importConfirm"))) {
        portfolioRestored = true;
      } else {
        portfolioSkipped = true;
      }
    }
    const writes = [[HISTORY_KEY, merged]];
    if (portfolioRestored) writes.push([PORTFOLIO_KEY, importedPortfolio]);
    if (!writeJsonBatch(localStorage, writes)) throw new Error("storage-failed");
    renderHistory();
    renderPortfolio();
    const skipped = parsed.skipped
      ? ` ${text("history.separator")} ${text("history.transfer.skipped")} ${parsed.skipped}`
      : "";
    const portfolioStatus = portfolioRestored
      ? ` ${text("history.separator")} ${text("portfolio.imported")}`
      : portfolioSkipped
        ? ` ${text("history.separator")} ${text("portfolio.importSkipped")}`
        : "";
    setTransferStatus(`${text("history.transfer.imported")} ${merged.length}${skipped}${portfolioStatus}`, "success");
  } catch (error) {
    const key =
      error && error.message === "storage-failed" ? "history.transfer.storageFailed" : "history.transfer.invalid";
    setTransferStatus(text(key), "warning");
  }
}

async function runBacktest() {
  const inputs = getSimulationInputs();
  if (!inputs.valid) {
    backtestEl.innerHTML = `<div class="empty-state">برای بک‌تست حداقل یک وزن دارایی و افق معتبر انتخاب کن.</div>`;
    return;
  }
  backtestEl.innerHTML = `<div class="empty-state">${escapeHTML(text("backtest.running"))}</div>`;
  const historicalMarket = await loadSimulationHistory(inputs);
  const result = await runAnalysisWorker({
    type: "backtest",
    options: {
      market: historicalMarket,
      allocation: inputs.allocation,
      initialInvestment: inputs.initialInvestment,
      monthlyContribution: inputs.monthlyContribution,
      contributionGrowth: inputs.contributionGrowth,
      inflationRate: inputs.inflationRate,
      horizonYears: inputs.horizonYears,
      rebalance: inputs.rebalance,
      rebalanceCadence: inputs.rebalanceCadence,
      rebalanceThresholdPercent: inputs.rebalanceThresholdPercent,
      transactionCosts: inputs.transactionCosts,
      marType: inputs.marType,
      sharpeBenchmarkAnnualReturn: inputs.compareFixedIncomeBenchmark
        ? Number(liveMarket?.funds?.fixedIncome?.effectiveAnnualReturn) / 100
        : null,
      assumptions: modelSettings.assumptions,
    },
  }).catch(() => null);
  if (appStore.getState().activeView !== "simulation") return;
  if (result) renderBacktest(result);
  else backtestEl.innerHTML = `<div class="empty-state">${escapeHTML(text("analysis.failed"))}</div>`;
  $("#backtest-section").open = true;
}

function getSimulationInputs() {
  const rawAllocation = Object.fromEntries(
    SIMULATION_ASSET_KEYS.map((assetId) => [assetId, Math.max(0, numberFromInput($("#sim-weight-" + assetId)?.value))]),
  );
  const totalWeight = Object.values(rawAllocation).reduce((sum, value) => sum + value, 0);
  const horizonYears = clamp(numberFromInput($("#simulation-horizon")?.value), 1, 50);
  return {
    valid: totalWeight > 0 && horizonYears >= 1,
    allocation: normalizeAllocation(rawAllocation, DEFAULT_ALLOCATION, SIMULATION_ASSET_KEYS),
    initialInvestment: Math.max(0, numberFromInput($("#simulation-initial")?.value)),
    monthlyContribution: Math.max(0, numberFromInput($("#simulation-monthly")?.value)),
    horizonYears,
    contributionGrowth: clamp(numberFromInput($("#simulation-growth")?.value), -50, 200) / 100,
    inflationRate: clamp(numberFromInput($("#simulation-inflation")?.value), -20, 300) / 100,
    paths: [1000, 2000, 5000, 10000].includes(numberFromInput($("#simulation-path-count")?.value))
      ? numberFromInput($("#simulation-path-count").value)
      : modelSettings.paths,
    rebalance: Boolean($("#simulation-rebalance")?.checked),
    rebalanceCadence: ["monthly", "quarterly", "annually", "threshold"].includes(
      $("#simulation-rebalance-cadence")?.value,
    )
      ? $("#simulation-rebalance-cadence").value
      : "quarterly",
    rebalanceThresholdPercent: clamp(numberFromInput($("#simulation-rebalance-threshold")?.value), 0, 25),
    fixedIncomeMode: ["mean-reverting", "constant-market", "user-expected"].includes($("#simulation-fixed-mode")?.value)
      ? $("#simulation-fixed-mode").value
      : "mean-reverting",
    marType: ["zero", "inflation", "fixed-income"].includes($("#simulation-mar")?.value)
      ? $("#simulation-mar").value
      : "zero",
    compareFixedIncomeBenchmark: Boolean($("#simulation-fixed-benchmark")?.checked),
    transactionCosts: modelSettings.transactionCosts,
    seed: 42,
  };
}

async function loadSimulationHistory(inputs) {
  const selectedAssets = ASSET_KEYS.filter((assetId) => inputs.allocation[assetId] > 0);
  const marketKeyByPlanningAsset = Object.fromEntries(
    ASSET_KEYS.map((assetId) => [
      assetId,
      assetId === "fixed"
        ? "fixedIncome"
        : assetId === "currency"
          ? "dollar"
          : INSTRUMENT_REGISTRY[assetId]?.marketKey || null,
    ]),
  );
  const requestAssets = [
    ...new Set(selectedAssets.map((assetId) => marketKeyByPlanningAsset[assetId]).filter(Boolean)),
  ];
  if (!requestAssets.length)
    return { ...(liveMarket || {}), history: {}, historyCoverage: {}, historyFetchError: null };
  try {
    await ensureApiSession();
    const query = new URLSearchParams({ assets: requestAssets.join(","), range: "all" });
    const response = await fetchWithTimeout(
      "/api/history?" + query.toString(),
      { cache: "no-store", credentials: "same-origin", headers: providerRequestHeaders() },
      20000,
    );
    if (!response.ok) throw new Error("history-api-unavailable");
    const data = await response.json();
    const history = {};
    const historyCoverage = {};
    selectedAssets.forEach((assetId) => {
      const marketKey = marketKeyByPlanningAsset[assetId];
      if (assetId === "fixed") {
        historyCoverage.fixedIncome = data.assets?.fixedIncome?.coverage
          ? { ...data.assets.fixedIncome.coverage, sourceUrl: data.assets.fixedIncome.sourceUrl || null }
          : null;
        return;
      }
      const assetData = data.assets?.[marketKey];
      const source = assetData?.coverage?.source || null;
      history[marketKey] = (assetData?.points || []).map((point) => ({
        ...point,
        currency: point.currency || assetData?.currency || null,
        source: point.source || source,
      }));
      historyCoverage[marketKey] = assetData?.coverage
        ? { ...assetData.coverage, sourceUrl: assetData.sourceUrl || null }
        : null;
    });
    Object.entries(history).forEach(([marketKey, points]) => {
      if (points.length || !Array.isArray(liveMarket?.history?.[marketKey])) return;
      history[marketKey] = liveMarket.history[marketKey];
      historyCoverage[marketKey] = {
        ...(historyCoverage[marketKey] || {}),
        source: "live-market-fallback",
      };
    });
    return {
      ...(liveMarket || {}),
      funds: { ...(data.funds || {}), ...(liveMarket?.funds || {}) },
      history,
      historyCoverage,
      historyFetchError: null,
      historyAsOfDate: data.updatedAt || liveMarket?.updatedAt || null,
    };
  } catch {
    return {
      ...(liveMarket || {}),
      history: liveMarket?.history || {},
      historyCoverage: {},
      historyFetchError: "history-provider-unavailable",
    };
  }
}

async function runIndependentSimulation(event) {
  event.preventDefault();
  const inputs = getSimulationInputs();
  if (!inputs.valid) {
    simulationSummaryEl.innerHTML = `<div class="empty-state">حداقل یک وزن مثبت و افق بین ۱ تا ۵۰ سال وارد کن.</div>`;
    return;
  }
  simulationSummaryEl.innerHTML = '<div class="empty-state">در حال محاسبه‌ی سناریوهای مستقل…</div>';
  try {
    const market = await loadSimulationHistory(inputs);
    if (appStore.getState().activeView !== "simulation") return;
    const result = await runAnalysisWorker({
      type: "plan-analysis",
      options: { ...inputs, assumptions: modelSettings.assumptions, market },
    });
    if (!result || appStore.getState().activeView !== "simulation") return;
    renderSimulation(result.simulation, result.monteCarlo, result.validation, result.methodComparison);
    const note = $("#analysis-method-note");
    if (note)
      note.textContent = `دامنه‌ی سناریوها تخمینی است · افق ${formatIRR(inputs.horizonYears)} سال · وزن‌ها پس از نرمال‌سازی اعمال شدند · هیچ داده‌ی پرتفوی یا برنامه‌ی ذخیره‌شده استفاده نشد.`;
  } catch {
    if (appStore.getState().activeView === "simulation")
      simulationSummaryEl.innerHTML = `<div class="empty-state">محاسبه کامل نشد؛ مقدار ورودی‌ها را بررسی کن و دوباره اجرا کن.</div>`;
  }
}

async function loadMarket(force = false) {
  setStatus(text("status.loading", fallbackCopy.status.loading), "loading");
  appStore.setState({ marketStatus: "loading", error: null });
  const cacheDisabled = appStore.getState().marketCacheDisabled;
  const cachedMarket = cacheDisabled ? null : readJson(MARKET_CACHE_KEY, null);
  lastKnownMarket =
    cachedMarket && typeof cachedMarket === "object" && !Array.isArray(cachedMarket) ? cachedMarket : null;
  const cacheAge = marketCacheAge(lastKnownMarket);
  if (!force && !cacheDisabled && lastKnownMarket?.assets && cacheAge >= 0 && cacheAge < 90_000) {
    liveMarket = lastKnownMarket;
    appStore.setState({ market: liveMarket, marketStatus: "cached" });
    renderMarket(liveMarket, lastKnownMarket);
    renderHistory();
    renderPortfolio();
    renderDashboard();
    void loadFx();
    setStatus("از داده‌ی تازه‌ی ذخیره‌شده استفاده شد", "success");
    return;
  }
  try {
    await ensureApiSession();
    const assets = marketRequestAssets();
    const marketQuery = new URLSearchParams({ assets: assets.join(",") });
    if (syncCredentials) marketQuery.set("sync", "1");
    const response = await fetchWithTimeout(`/api/market?${marketQuery.toString()}`, {
      cache: "default",
      credentials: "same-origin",
      headers: providerRequestHeaders(),
    });
    if (!response.ok) throw new Error("Market request failed");
    const payload = await response.json();
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      !payload.assets ||
      typeof payload.assets !== "object" ||
      Array.isArray(payload.assets) ||
      !Number.isFinite(Date.parse(payload.updatedAt || ""))
    )
      throw new Error("Market response was invalid");
    liveMarket = reconcileMarketWithRecentAcceptedQuote(payload, lastKnownMarket);
    if (!liveMarket || typeof liveMarket !== "object") throw new Error("Market response could not be reconciled");
    const cacheDisabledNow = appStore.getState().marketCacheDisabled;
    if (!cacheDisabledNow) writeJson(MARKET_CACHE_KEY, liveMarket);
    else lastKnownMarket = null;
    appStore.setState({ market: liveMarket, marketStatus: "connected" });
    renderMarket(liveMarket, lastKnownMarket);
    renderHistory();
    renderPortfolio();
    renderDashboard();
    void loadFx();
    setStatus(text("status.connected", fallbackCopy.status.connected), "success");
  } catch {
    const cacheDisabledNow = appStore.getState().marketCacheDisabled;
    lastKnownMarket = cacheDisabledNow ? null : readJson(MARKET_CACHE_KEY, null);
    const cachedHistory = lastKnownMarket && typeof lastKnownMarket === "object" ? lastKnownMarket : null;
    liveMarket = cachedHistory
      ? {
          ...cachedHistory,
          assets: {},
          funds: {},
          diagnostics: null,
          _cachedFallbackOnly: true,
          _currentQuotesUnavailableAt: new Date().toISOString(),
        }
      : null;
    appStore.setState({ market: liveMarket, marketStatus: liveMarket ? "cached" : "unavailable" });
    renderMarket(liveMarket, lastKnownMarket);
    renderHistory();
    renderPortfolio();
    renderDashboard();
    void loadFx();
    setStatus(
      liveMarket
        ? text("status.cached", fallbackCopy.status.cached)
        : text("status.timeout", fallbackCopy.status.unavailable),
      "warning",
    );
  }
}

function marketRequestAssets() {
  const requested = new Set([...Object.keys(text("market.labels", {})), "fixedIncome"]);
  const supported = new Set(Object.keys(INSTRUMENT_REGISTRY));
  const portfolio = readPortfolio();
  assetIds(portfolio).forEach((assetId) => {
    const definition = portfolio.assets?.[assetId] || PORTFOLIO_ASSETS[assetId];
    const marketKey = definition?.marketKey;
    if (marketKey && supported.has(marketKey)) requested.add(marketKey);
  });
  return [...requested].filter((assetId) => supported.has(assetId) || assetId === "fixedIncome");
}

async function loadCopy() {
  const requestId = ++copyRequestId;
  const locale = uiPreferences.locale;
  try {
    const [baseResponse, localeResponse] = await Promise.all([
      fetch("content/fa.json", { cache: "no-store" }),
      locale === "fa"
        ? fetch("content/fa.json", { cache: "no-store" })
        : fetch("content/" + locale + ".json", { cache: "no-store" }),
    ]);
    if (!baseResponse.ok || !localeResponse.ok) throw new Error("Copy request failed");
    const baseCopy = await baseResponse.json();
    const localizedCopy = await localeResponse.json();
    if (requestId !== copyRequestId) return;
    copy = createLocalizedCatalog(baseCopy, localizedCopy);
  } catch {
    if (requestId !== copyRequestId) return;
    copy = fallbackCopy;
  }
  if (copy?.pageTitle) document.title = copy.pageTitle;
  translateVisibleCopy();
}

function bindEvents() {
  syncUiPreferenceControls();
  $("#settings-locale")?.addEventListener("change", (event) => void changeLocale(event.currentTarget.value));
  $("#settings-display-currency")?.addEventListener("change", (event) => {
    const currency = event.currentTarget.value;
    setUiPreferences({ ...uiPreferences, currency: currency === "auto" ? null : currency });
    rerenderLocalizedViews();
  });
  $("#settings-theme")?.addEventListener("change", (event) => {
    setUiPreferences({ ...uiPreferences, theme: event.currentTarget.value });
  });
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (uiPreferences.theme === "system") applyUiPreferences(uiPreferences);
  });
  $("#portfolio-holdings-search")?.addEventListener("input", (event) => {
    holdingsSearch = event.currentTarget.value.trim();
    renderPortfolio();
  });
  $("#portfolio-holdings-filter")?.addEventListener("change", (event) => {
    holdingsFilter = event.currentTarget.value;
    renderPortfolio();
  });
  $$("[data-holdings-sort]").forEach((button) =>
    button.addEventListener("click", () => {
      const key = button.dataset.holdingsSort;
      if (!key) return;
      holdingsSort = {
        key,
        direction: holdingsSort.key === key && holdingsSort.direction === "asc" ? "desc" : "asc",
      };
      renderPortfolio();
    }),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    renderPlan();
  });
  $("#save-plan-result")?.addEventListener("click", savePlanPreview);
  allocationListEl?.addEventListener("change", updatePlanWeights);
  $$("[data-go-view]").forEach((button) =>
    button.addEventListener("click", () => navigationController.goTo(button.dataset.goView)),
  );
  $$("[data-dashboard-range]").forEach((button) =>
    button.addEventListener("click", () => {
      dashboardRange = button.dataset.dashboardRange || "ALL";
      $$("[data-dashboard-range]").forEach((item) => item.classList.toggle("is-active", item === button));
      renderDashboardPerformance();
    }),
  );
  $$("[data-history-range]").forEach((button) =>
    button.addEventListener("click", () => {
      const nextRange = button.dataset.historyRange;
      if (!nextRange || nextRange === historyComparisonRange) return;
      historyComparisonRange = nextRange;
      historyCustomBounds = null;
      historyComparisonData = null;
      historyComparisonLoadedSignature = "";
      loadHistoricalMarketHistory();
    }),
  );
  $("#history-bounds-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const start = $("#history-start")?.value || "";
    const end = $("#history-end")?.value || "";
    if (!start || !end || start > end) {
      const status = $("#historical-comparison-status");
      if (status) status.textContent = "تاریخ شروع و پایان معتبر وارد کن؛ شروع باید قبل از پایان باشد.";
      return;
    }
    historyCustomBounds = { start, end };
    historyComparisonRange = "custom";
    historyComparisonData = null;
    historyComparisonLoadedSignature = "";
    loadHistoricalMarketHistory();
  });
  $("#history-view-mode")?.addEventListener("change", (event) => {
    historyComparisonMode = event.currentTarget.value === "price" ? "price" : "return";
    renderHistoricalComparison();
  });
  $("#history-currency")?.addEventListener("change", (event) => {
    historyComparisonCurrency = event.currentTarget.value === "USD" ? "USD" : "TOMAN";
    renderHistoricalComparison();
  });
  $("#history-asset-options")?.addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-history-asset]");
    if (!checkbox) return;
    if (!checkbox.checked && historyComparisonSelection.size <= 1) {
      checkbox.checked = true;
      return;
    }
    if (checkbox.checked && historyComparisonSelection.size >= 3) {
      checkbox.checked = false;
      return;
    }
    if (checkbox.checked) historyComparisonSelection.add(checkbox.dataset.historyAsset);
    else historyComparisonSelection.delete(checkbox.dataset.historyAsset);
    historyComparisonData = null;
    historyComparisonLoadedSignature = "";
    loadHistoricalMarketHistory();
  });
  $("#historical-comparison-status")?.addEventListener("click", (event) => {
    if (event.target.closest("#history-comparison-retry")) loadHistoricalMarketHistory(true);
  });
  $("#refresh-market").addEventListener("click", () => loadMarket(true));
  $("#run-backtest").addEventListener("click", runBacktest);
  $("#simulation-form")?.addEventListener("submit", runIndependentSimulation);
  monteCarloEl?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-simulation-view]");
    if (!button) return;
    const selected = button.dataset.simulationView;
    monteCarloEl.querySelectorAll("[data-simulation-view]").forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab === button));
    });
    monteCarloEl.querySelectorAll("[data-simulation-results]").forEach((view) => {
      view.hidden = view.dataset.simulationResults !== selected;
    });
  });
  $("#export-history").addEventListener("click", exportHistory);
  $("#import-history").addEventListener("click", () => $("#history-file").click());
  $("#history-file").addEventListener("change", importHistoryFile);
  $("#portfolio-market-asset-form")?.addEventListener("submit", handleMarketAssetSubmit);
  $("#manual-quote-form")?.addEventListener("submit", handleManualQuoteSubmit);
  $("#portfolio-new-stock-title")?.addEventListener("input", updateMarketEntryAvailability);
  $("#portfolio-market-asset")?.addEventListener("change", () => populatePortfolioAssetOptions());
  $("#portfolio-market-date")?.addEventListener("input", updateMarketEntryAvailability);
  $("#portfolio-market-date")?.addEventListener("change", updateMarketEntryAvailability);
  $("#advanced-transaction-form").addEventListener("submit", handleAdvancedTransactionSubmit);
  $("#advanced-type").addEventListener("change", updateAdvancedTransactionFields);
  $("#settings-model-form")?.addEventListener("submit", saveModelSettingsForm);
  $("#refresh-inflation")?.addEventListener("click", refreshInflationAssumption);
  $("#provider-key-form")?.addEventListener("submit", saveProviderApiKey);
  $$("[data-provider-key-save]").forEach((button) => button.addEventListener("click", saveProviderApiKey));
  $$("[data-provider-key-clear]").forEach((button) => button.addEventListener("click", clearProviderApiKey));
  $("#sync-create")?.addEventListener("click", () => void createEncryptedSync());
  $("#sync-connect")?.addEventListener("click", () => void connectEncryptedSync());
  $("#sync-upload")?.addEventListener("click", () => void uploadLocalSyncSnapshot());
  $("#sync-restore")?.addEventListener("click", () => void restoreRemoteSyncSnapshot());
  $("#sync-delete")?.addEventListener("click", () => void deleteRemoteSyncSnapshot());
  $("#sync-disconnect")?.addEventListener("click", disconnectEncryptedSync);
  $("#sync-copy-recovery")?.addEventListener("click", () => void copyRecoveryKey());
  updateSyncControls();
  const clearSavedHistory = () => {
    if (
      !window.confirm(
        text("history.transfer.clearConfirm", "Clear saved plans? This does not change the portfolio ledger."),
      )
    )
      return;
    localStorage.removeItem(HISTORY_KEY);
    localStorage.removeItem("investment-plan-history-v3");
    renderHistory();
    setTransferStatus(text("history.transfer.cleared"), "neutral");
    navigationController.goTo("history");
  };
  $("#clear-history").addEventListener("click", clearSavedHistory);
  $("#settings-sidebar-collapsed").addEventListener("change", (event) => {
    appStore.setState({ sidebarCollapsed: event.currentTarget.checked });
  });
  $("#settings-market-cache").addEventListener("change", (event) => {
    const disabled = event.currentTarget.checked;
    appStore.setState({ marketCacheDisabled: disabled });
    if (disabled) {
      localStorage.removeItem(MARKET_CACHE_KEY);
      lastKnownMarket = null;
      if (liveMarket?._cachedFallbackOnly || appStore.getState().marketStatus === "cached") {
        liveMarket = null;
        appStore.setState({ market: null, marketStatus: "unavailable" });
      }
      renderMarket(liveMarket, null);
      renderDashboard();
    }
    setStatus(
      disabled ? "ذخیره بازار خاموش است" : text("status.connected", fallbackCopy.status.connected),
      disabled ? "warning" : "success",
    );
  });
  $("#settings-clear-market-cache").addEventListener("click", () => {
    localStorage.removeItem(MARKET_CACHE_KEY);
    lastKnownMarket = null;
    if (liveMarket?._cachedFallbackOnly) {
      liveMarket = null;
      appStore.setState({ market: null, marketStatus: "unavailable" });
    }
    renderMarket(liveMarket, null);
    renderDashboard();
    setTransferStatus("داده بازار ذخیره‌شده حذف شد.", "success");
  });
  $("#settings-export-data").addEventListener("click", exportHistory);
  $("#settings-import-data").addEventListener("click", () => $("#settings-file").click());
  $("#settings-file").addEventListener("change", importHistoryFile);
  $("#settings-reset-all").addEventListener("click", () => {
    if (
      window.confirm(
        "همه برنامه‌ها، دفتر پرتفوی، پروفایل و داده بازار از این مرورگر حذف شود؟ این کار قابل بازگشت نیست.",
      )
    )
      clearAllLocalData();
  });
  $("#asset-drawer-close")?.addEventListener("click", () => $("#asset-detail-drawer")?.close());
  $("#portfolio-allocation")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-portfolio-asset]");
    if (button) openAssetDrawer(button.dataset.portfolioAsset);
  });
  bindChartTooltips();
  appStore.subscribe((state) => {
    const toggle = $("#settings-sidebar-collapsed");
    if (toggle) toggle.checked = state.sidebarCollapsed;
    const cacheToggle = $("#settings-market-cache");
    if (cacheToggle) cacheToggle.checked = state.marketCacheDisabled;
    if (state.activeView !== "simulation") cancelAnalysisWorker();
    if (state.activeView === "history") loadHistoricalMarketHistory();
  });
  $("#contribution-rate").addEventListener("input", (event) => {
    $("#contribution-output").textContent = formatPercent(Number(event.target.value), 0);
  });
  $$("[data-number-input]").forEach((input) => {
    input.value = groupedNumber(input.value);
    input.addEventListener("input", formatNumberInput);
  });
  $$("#plan-form select, #plan-form input").forEach((element) => {
    element.addEventListener("change", () => {
      persistProfile();
      syncPlanState();
      renderSettingsAssumptions();
      previewPlanIfVisible();
      renderDashboard();
      renderEmergencyCoverage();
    });
    element.addEventListener("input", () => {
      persistProfile();
      syncPlanState();
      renderSettingsAssumptions();
      previewPlanIfVisible();
      renderDashboard();
      renderEmergencyCoverage();
    });
  });
  window.addEventListener("error", () => {
    const error = $("#app-error");
    if (error) {
      error.hidden = false;
      error.textContent = "بخشی از رابط کاربری با خطا روبه‌رو شد؛ داده‌های ذخیره‌شده دست‌نخورده باقی مانده‌اند.";
    }
    appStore.setState({ error: "runtime" });
  });
  window.addEventListener("unhandledrejection", () => {
    const error = $("#app-error");
    if (error) {
      error.hidden = false;
      error.textContent = "دریافت داده کامل نشد؛ دوباره تلاش کن.";
    }
    appStore.setState({ error: "async" });
  });
}

async function init() {
  await loadCopy();
  syncUiPreferenceControls();
  migrateStoredCurrencyToToman();
  modelSettings = loadModelSettings();
  restoreProviderApiKey();
  renderSimulationWeightInputs();
  renderSettingsAssumptions();
  applyModelSettingsToSimulation();
  restoreProfile();
  $("#contribution-output").textContent = formatPercent(Number($("#contribution-rate").value), 0);
  bindEvents();
  renderHistory();
  renderPortfolio();
  renderDashboard();
  renderSettingsAssumptions();
  $("#advanced-date").value = localDateTimeValue();
  $("#portfolio-market-date").value = localDateTimeValue();
  $("#manual-quote-date").value = localDateTimeValue();
  updateMarketEntryAvailability();
  updateAdvancedTransactionFields();
  void loadMarket();
  applyModelSettingsToSimulation();
  const inflationFetchedAt = modelSettings.inflationFetchedAt ? Date.parse(modelSettings.inflationFetchedAt) : 0;
  if (
    !modelSettings.inflationSource ||
    !Number.isFinite(inflationFetchedAt) ||
    Date.now() - inflationFetchedAt > 30 * 24 * 60 * 60 * 1000
  ) {
    void refreshInflationAssumption();
  }
  showStorageWarning();
}

init();
