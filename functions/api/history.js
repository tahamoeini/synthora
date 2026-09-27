import { extractTgjuChartData, normalizeHistorySeries, normalizeMetalHistory, normalizeTgjuHistory } from "./market.js";
import { INSTRUMENT_REGISTRY } from "../../src/market/catalog.js";
import {
  consumeRouteQuota,
  deferPlatformProviderRequest,
  hasDurableSessionSecurity,
  reservePlatformProviderRequest,
  securityJson,
  selectedProviderKey,
} from "./_security.js";
import {
  HISTORY_RANGE_DAYS,
  convertUsdHistoryToToman,
  filterHistoryRange,
  normalizeObservedHistory,
} from "../../src/market/history.js";

const HISTORY_ASSETS = new Set([...Object.keys(INSTRUMENT_REGISTRY), "fixedIncome", "cash"]);
const DEFAULT_HISTORY_ASSETS = ["dollar", "gold", "silver"];
const TGJU_BASE = "https://www.tgju.org/profile/";
const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";
const COINGECKO_BASE = "https://api.coingecko.com/api/v3/coins/";
const CHART_GOLD_URL = "https://www.chartgoldprice.com/api/data?history=both";
const TROY_OUNCE_TO_GRAMS = 31.1034768;
const COPPER_POUND_TO_GRAMS = 453.59237;
const REQUEST_TIMEOUT_MS = 8000;
const HEADERS = {
  "User-Agent": "invest-consult/2.0 (+https://github.com/tahamoeini/invest-consult)",
  Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
};

const TGJU_PAGES = Object.freeze({ dollar: "price_dollar_rl", gold: "geram18", silver: "silver_999" });
const YAHOO_SERIES = Object.freeze({
  platinum: { symbol: "PL=F", divisor: TROY_OUNCE_TO_GRAMS },
  palladium: { symbol: "PA=F", divisor: TROY_OUNCE_TO_GRAMS },
  copper: { symbol: "HG=F", divisor: COPPER_POUND_TO_GRAMS },
});
const COINGECKO_IDS = Object.freeze({ bitcoin: "bitcoin", ethereum: "ethereum", tether: "tether" });
const SOURCE_URLS = Object.freeze({
  TGJU: "https://www.tgju.org/",
  "Yahoo Finance": "https://finance.yahoo.com/",
  CoinGecko: "https://www.coingecko.com/",
  ChartGoldPrice: "https://www.chartgoldprice.com/gold-price-api",
});

function asUrl(urlLike) {
  return urlLike instanceof URL ? urlLike : new URL(String(urlLike || "https://invest-consult.local/api/history"));
}

export function parseHistoryRequest(urlLike) {
  const url = asUrl(urlLike);
  const range = url.searchParams.get("range") || "all";
  if (!Object.hasOwn(HISTORY_RANGE_DAYS, range)) return { error: "invalid-range" };
  const suppliedAssets = url.searchParams.get("assets");
  const assets =
    suppliedAssets === null
      ? DEFAULT_HISTORY_ASSETS.slice()
      : [
          ...new Set(
            suppliedAssets
              .split(",")
              .map((asset) => asset.trim())
              .filter((asset) => HISTORY_ASSETS.has(asset)),
          ),
        ];
  if (!assets.length) return { error: "no-supported-assets" };
  const start = url.searchParams.get("start") || null;
  const end = url.searchParams.get("end") || null;
  const validDate = (value) => {
    if (!value) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (!validDate(start) || !validDate(end) || (start && end && start > end)) return { error: "invalid-date-range" };
  if (
    start &&
    end &&
    new Date(`${end}T00:00:00.000Z`).getTime() - new Date(`${start}T00:00:00.000Z`).getTime() >
      50 * 366 * 24 * 60 * 60 * 1000
  )
    return { error: "date-range-too-large" };
  return { assets, range, start, end };
}

async function fetchResponse(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { ...HEADERS, ...(options.headers || {}) },
    });
    if (!response.ok) {
      const error = new Error("provider-response-not-ok");
      error.status = response.status;
      const retryAfter = response.headers.get("retry-after");
      const seconds = Number(retryAfter);
      const date = Date.parse(retryAfter || "");
      error.retryAfterSeconds =
        Number.isFinite(seconds) && seconds > 0
          ? Math.min(24 * 60 * 60, Math.ceil(seconds))
          : Number.isFinite(date)
            ? Math.max(1, Math.min(24 * 60 * 60, Math.ceil((date - Date.now()) / 1000)))
            : null;
      throw error;
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url) {
  const response = await fetchResponse(url);
  return response.text();
}

async function fetchJson(url, options = {}) {
  const response = await fetchResponse(url, options);
  return response.json();
}

async function fetchTgjuSeries(assetId) {
  const page = TGJU_PAGES[assetId];
  if (!page) throw new Error("unsupported-tgju-series");
  const sourceUrl = TGJU_BASE + page;
  const raw = extractTgjuChartData(await fetchText(sourceUrl));
  const points = normalizeTgjuHistory(raw).map((point) => ({ date: point.date, value: point.value, source: "TGJU" }));
  return { points, source: "TGJU", sourceUrl, currency: "TOMAN" };
}

async function fetchIndexSeries() {
  const sourceUrl = TGJU_BASE + "gc30";
  const raw = extractTgjuChartData(await fetchText(sourceUrl));
  const points = normalizeHistorySeries(raw).map((point) => ({ date: point.date, value: point.value, source: "TGJU" }));
  return { points, source: "TGJU", sourceUrl, currency: "INDEX" };
}

async function fetchAuxiliaryMetalSeries(assetId) {
  const data = await fetchJson(CHART_GOLD_URL);
  const rawHistory = data?.history?.[assetId] || data?.history?.series?.[assetId] || [];
  const factor = assetId === "gold" ? 0.75 : 1;
  const points = normalizeMetalHistory(rawHistory).map((point) => ({
    date: point.date,
    value: point.value * factor,
    source: "ChartGoldPrice",
    currency: "USD",
  }));
  return { points, source: "ChartGoldPrice", sourceUrl: SOURCE_URLS.ChartGoldPrice, currency: "USD" };
}

async function fetchYahooSeries(assetId) {
  const definition = YAHOO_SERIES[assetId];
  if (!definition) throw new Error("unsupported-yahoo-series");
  const sourceUrl = YAHOO_BASE + encodeURIComponent(definition.symbol) + "?range=max&interval=1d";
  const data = await fetchJson(sourceUrl);
  const result = data?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const points = timestamps.flatMap((timestamp, index) => {
    const value = Number(closes[index]);
    return Number.isFinite(value) && value > 0
      ? [{ date: timestamp * 1000, value: value / definition.divisor, source: "Yahoo Finance", currency: "USD" }]
      : [];
  });
  if (!points.length) throw new Error("provider-history-empty");
  return { points, source: "Yahoo Finance", sourceUrl, currency: "USD" };
}

async function fetchCryptoSeries(assetId, apiKey, userSuppliedKey, env) {
  if (!apiKey) throw new Error("coingecko-demo-key-missing");
  if (!userSuppliedKey && !hasDurableSessionSecurity(env)) throw new Error("platform-key-security-not-configured");
  const hasDurableQuota = typeof env?.API_USAGE_DB?.prepare === "function";
  let providerId = "coingecko";
  const budget = { minimumIntervalSeconds: 60 };
  if (userSuppliedKey) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
    providerId =
      "coingecko-user-" +
      [...new Uint8Array(digest)]
        .slice(0, 10)
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
    budget.monthlyLimit = 9500;
  } else {
    budget.monthlyLimit = 8000;
  }
  if ((hasDurableQuota || !userSuppliedKey) && !(await reservePlatformProviderRequest(env, providerId, budget)))
    throw new Error("provider-rate-limited");
  const sourceUrl =
    COINGECKO_BASE +
    encodeURIComponent(COINGECKO_IDS[assetId]) +
    "/market_chart?vs_currency=usd&days=365&precision=full";
  let data;
  try {
    data = await fetchJson(sourceUrl, { headers: { "x-cg-demo-api-key": apiKey } });
  } catch (error) {
    if (Number(error?.status) === 429 && error.retryAfterSeconds)
      await deferPlatformProviderRequest(env, providerId, error.retryAfterSeconds);
    throw error;
  }
  const points = normalizeObservedHistory(data?.prices, "CoinGecko").map((point) => ({
    ...point,
    source: "CoinGecko",
    currency: "USD",
  }));
  if (!points.length) throw new Error("provider-history-empty");
  return { points, source: "CoinGecko", sourceUrl, currency: "USD" };
}

function errorReason(error) {
  if (error?.message === "coingecko-demo-key-missing") return "coingecko-demo-key-missing";
  if (error?.message === "platform-key-security-not-configured") return "platform-key-security-not-configured";
  if (error?.message === "platform-key-monthly-quota-exceeded") return "platform-key-monthly-quota-exceeded";
  if (error?.message === "provider-rate-limited") return "provider-rate-limited";
  if (error?.message === "yahoo-license-not-confirmed") return "yahoo-license-not-confirmed";
  if (error?.message === "provider-history-empty") return "provider-history-empty";
  return "provider-unavailable";
}

function rangeCoverage(points, source, range, reason = null, extra = {}) {
  return {
    status: points.length >= 2 ? "available" : points.length ? "insufficient-history" : "unavailable",
    range,
    observationCount: points.length,
    firstObservedAt: points[0]?.date || null,
    lastObservedAt: points.at(-1)?.date || null,
    source: source || null,
    reason: points.length >= 2 ? null : reason || "history-unavailable",
    ...extra,
  };
}

async function loadRawSeries(assetId, apiKey, userSuppliedKey, env) {
  if (TGJU_PAGES[assetId]) {
    try {
      return await fetchTgjuSeries(assetId);
    } catch {
      if (!["gold", "silver"].includes(assetId)) throw new Error("provider-unavailable");
      return await fetchAuxiliaryMetalSeries(assetId);
    }
  }
  if (assetId === "bourseIndex") return fetchIndexSeries();
  if (YAHOO_SERIES[assetId]) {
    if (env?.YAHOO_METALS_LICENSE_CONFIRMED !== "true") throw new Error("yahoo-license-not-confirmed");
    return fetchYahooSeries(assetId);
  }
  if (COINGECKO_IDS[assetId]) return fetchCryptoSeries(assetId, apiKey, userSuppliedKey, env);
  throw new Error("history-unavailable");
}

export async function onRequestGet(context = {}) {
  const quota = await consumeRouteQuota(context, "history", { allowPublicWhenUnconfigured: true });
  if (quota.error) return quota.error;
  const request = parseHistoryRequest(context.request?.url);
  if (request.error) return securityJson({ error: request.error }, 400);

  const { assets: selectedAssets, range, start, end } = request;
  const needsDollarHistory = selectedAssets.some((assetId) =>
    ["gold", "silver", "bitcoin", "ethereum", "tether", "platinum", "palladium", "copper"].includes(assetId),
  );
  const rawAssets = [
    ...new Set([
      ...selectedAssets.filter((assetId) => assetId !== "fixedIncome" && assetId !== "cash"),
      ...(needsDollarHistory && !selectedAssets.includes("dollar") ? ["dollar"] : []),
    ]),
  ];
  const selectedKey = selectedProviderKey(context.request, context.env);
  const providerKey =
    !hasDurableSessionSecurity(context.env) && !selectedKey.userSupplied ? { ...selectedKey, key: "" } : selectedKey;
  const settled = await Promise.allSettled(
    rawAssets.map(async (assetId) => [
      assetId,
      await loadRawSeries(assetId, providerKey.key, providerKey.userSupplied, context.env),
    ]),
  );
  const rawSeries = {};
  const errors = {};
  settled.forEach((outcome, index) => {
    const assetId = rawAssets[index];
    if (outcome.status === "fulfilled") rawSeries[outcome.value[0]] = outcome.value[1];
    else errors[assetId] = errorReason(outcome.reason);
  });

  const dollarPoints = normalizeObservedHistory(rawSeries.dollar?.points || [], rawSeries.dollar?.source || "TGJU");
  const responseAssets = {};
  const responseAssetIds = [
    ...new Set([...selectedAssets, ...(needsDollarHistory && rawSeries.dollar ? ["dollar"] : [])]),
  ];
  responseAssetIds.forEach((assetId) => {
    let provider = rawSeries[assetId];
    let points = [];
    let reason = errors[assetId] || null;
    let missingFxCount = 0;
    if (provider) {
      const normalized = normalizeObservedHistory(provider.points, provider.source);
      if (provider.currency === "USD") {
        const converted = convertUsdHistoryToToman(normalized, dollarPoints);
        points = converted.points;
        missingFxCount = converted.missingFxCount;
        if (!points.length)
          reason = needsDollarHistory && !dollarPoints.length ? "dated-fx-unavailable" : "no-matching-dated-fx";
      } else points = normalized;
    } else if (assetId === "fixedIncome" || assetId === "cash") {
      reason = "no-observed-history-source";
    }
    points = filterHistoryRange(points, range, Date.now(), { start, end });
    responseAssets[assetId] = {
      unit: assetId === "bourseIndex" ? "point" : assetId === "dollar" ? "TOMAN/USD" : "TOMAN",
      priceUnit:
        assetId === "bourseIndex"
          ? "index point"
          : assetId === "dollar"
            ? "TOMAN/USD"
            : `TOMAN/${INSTRUMENT_REGISTRY[assetId]?.unit || "unit"}`,
      currency: assetId === "bourseIndex" ? "INDEX" : "TOMAN",
      sourceUrl: provider?.sourceUrl || null,
      points,
      coverage: rangeCoverage(points, provider?.source, range, reason, { missingFxCount }),
    };
  });

  return securityJson(
    {
      updatedAt: new Date().toISOString(),
      requestedRange: range,
      requestedStart: start,
      requestedEnd: end,
      assets: responseAssets,
      sources: SOURCE_URLS,
    },
    200,
    { "cache-control": "private, no-store" },
  );
}
