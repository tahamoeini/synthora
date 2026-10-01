import { extractTgjuChartData, normalizeHistorySeries, normalizeMetalHistory, normalizeTgjuHistory } from "./market.js";
import { INSTRUMENT_REGISTRY } from "../../src/market/catalog.js";
import {
  consumeRouteQuota,
  deferPlatformProviderRequest,
  hasDurableSessionSecurity,
  reservePlatformProviderRequest,
  reservePlatformProviderHourlyRequest,
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
const NOBITEX_HISTORY_BASE = "https://api.nobitex.ir/market/udf/history";
const BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines";
const COINBASE_CANDLES_BASE = "https://api.exchange.coinbase.com/products/";
const KRAKEN_OHLC_URL = "https://api.kraken.com/0/public/OHLC";
const FRED_COPPER_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=PCOPPUSDM";
const TSETMC_TEDPIX_CODE = "32097828799138957";
const TSETMC_INDEX_HISTORY_URL = `https://cdn.tsetmc.com/api/Index/GetIndexB2History/${TSETMC_TEDPIX_CODE}`;
const GOLD_API_HISTORY_URL = "https://api.gold-api.com/history";
const CHART_GOLD_URL = "https://www.chartgoldprice.com/api/data?history=both";
const TROY_OUNCE_TO_GRAMS = 31.1034768;
const COPPER_POUND_TO_GRAMS = 453.59237;
const REQUEST_TIMEOUT_MS = 8000;
const DAY_MS = 24 * 60 * 60 * 1000;
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
const NOBITEX_HISTORY_SYMBOLS = Object.freeze({ bitcoin: "BTCIRT", ethereum: "ETHIRT", tether: "USDTIRT" });
const MAX_NOBITEX_HISTORY_PAGES = 10;
const BINANCE_HISTORY_SYMBOLS = Object.freeze({ bitcoin: "BTCUSDT", ethereum: "ETHUSDT" });
const COINBASE_HISTORY_PRODUCTS = Object.freeze({ bitcoin: "BTC-USD", ethereum: "ETH-USD" });
const KRAKEN_HISTORY_PAIRS = Object.freeze({ bitcoin: "XBTUSD", ethereum: "ETHUSD", tether: "USDTUSD" });
const GOLD_API_HISTORY_ASSETS = Object.freeze({
  gold: { symbol: "XAU", factor: 0.75, divisor: TROY_OUNCE_TO_GRAMS },
  silver: { symbol: "XAG", factor: 1, divisor: TROY_OUNCE_TO_GRAMS },
  platinum: { symbol: "XPT", factor: 1, divisor: TROY_OUNCE_TO_GRAMS },
  palladium: { symbol: "XPD", factor: 1, divisor: TROY_OUNCE_TO_GRAMS },
  bitcoin: { symbol: "BTC", factor: 1, divisor: 1 },
  ethereum: { symbol: "ETH", factor: 1, divisor: 1 },
});
const SOURCE_URLS = Object.freeze({
  TGJU: "https://www.tgju.org/",
  "Yahoo Finance": "https://finance.yahoo.com/",
  CoinGecko: "https://www.coingecko.com/",
  Binance: "https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints#klinecandlestick-data",
  Coinbase: "https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles",
  Kraken: "https://docs.kraken.com/api-reference/market-data/get-ohlc-data",
  "FRED / IMF copper": "https://fred.stlouisfed.org/series/PCOPPUSDM",
  "Gold API": "https://gold-api.com/docs",
  TSETMC: TSETMC_INDEX_HISTORY_URL,
  Nobitex: "https://apidocs.nobitex.ir/market_data/%D8%AF%D8%B1%DB%8C%D8%A7%D9%81%D8%AA-%D8%AF%D8%A7%D8%AF%D9%87-%D9%87%D8%A7%DB%8C-ohlc",
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

async function fetchText(url, options = {}) {
  const response = await fetchResponse(url, options);
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
  if (points.length < 2) throw new Error("provider-history-empty");
  return { points, source: "TGJU", sourceUrl, currency: "TOMAN" };
}

async function fetchIndexSeries() {
  const sourceUrl = TGJU_BASE + "gc30";
  const raw = extractTgjuChartData(await fetchText(sourceUrl));
  const points = normalizeHistorySeries(raw).map((point) => ({ date: point.date, value: point.value, source: "TGJU" }));
  if (points.length < 2) throw new Error("provider-history-empty");
  return { points, source: "TGJU", sourceUrl, currency: "INDEX" };
}

function jalaliDateToIso(jalaliDate) {
  const match = String(jalaliDate || "").match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, rawYear, rawMonth, rawDay] = match;
  const jy = Number(rawYear);
  const jm = Number(rawMonth);
  const jd = Number(rawDay);
  if (jy < 1200 || jy > 1600 || jm < 1 || jm > 12 || jd < 1 || jd > (jm <= 6 ? 31 : 30)) return null;
  const shiftedYear = jy + 1595;
  let days =
    -355668 +
    365 * shiftedYear +
    Math.floor(shiftedYear / 33) * 8 +
    Math.floor(((shiftedYear % 33) + 3) / 4) +
    jd;
  days += jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186;
  let gy = 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * Math.floor(--days / 36524);
    days %= 36524;
    if (days >= 365) days += 1;
  }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  while (gm < monthLengths.length && gd > monthLengths[gm]) gd -= monthLengths[gm++];
  if (gm >= monthLengths.length) return null;
  return `${gy}-${String(gm + 1).padStart(2, "0")}-${String(gd).padStart(2, "0")}`;
}

function tsetmcDateToIso(value) {
  const text = String(value ?? "").trim();
  if (/^\d{8}$/.test(text)) {
    const year = Number(text.slice(0, 4));
    if (year >= 1200 && year <= 1600) return jalaliDateToIso(text);
    if (year >= 1900 && year <= 2100) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

async function fetchTsetmcIndexSeries() {
  const data = await fetchJson(TSETMC_INDEX_HISTORY_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  const rows = data?.indexB2 || data?.history || data?.data || [];
  const points = (Array.isArray(rows) ? rows : []).flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const date = tsetmcDateToIso(row.dEven ?? row.date ?? row.Date);
    const value = Number(row.xNivIn ?? row.indexValue ?? row.close ?? row.value);
    return date && Number.isFinite(value) && value > 0
      ? [{ date, value, source: "TSETMC", currency: "INDEX" }]
      : [];
  });
  if (points.length < 2) throw new Error("provider-history-empty");
  return { points, source: "TSETMC", sourceUrl: TSETMC_INDEX_HISTORY_URL, currency: "INDEX" };
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
  if (points.length < 2) throw new Error("provider-history-empty");
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
  if (points.length < 2) throw new Error("provider-history-empty");
  return { points, source: "Yahoo Finance", sourceUrl, currency: "USD" };
}

async function fetchFredCopperSeries() {
  const csv = await fetchText(FRED_COPPER_CSV_URL, { cf: { cacheTtl: 86400, cacheEverything: true } });
  const [header, ...rows] = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  if (!/^observation_date,PCOPPUSDM$/i.test(String(header || "").trim()))
    throw new Error("provider-history-invalid-response");
  const points = rows.flatMap((row) => {
    const [date, rawValue] = row.split(",");
    const usdPerMetricTon = Number(rawValue);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !Number.isFinite(usdPerMetricTon) || usdPerMetricTon <= 0)
      return [];
    return [
      {
        date,
        value: usdPerMetricTon / 1_000_000,
        source: "FRED / IMF copper",
        currency: "USD",
        observationType: "monthly-average",
      },
    ];
  });
  if (points.length < 2) throw new Error("provider-history-empty");
  return {
    points,
    source: "FRED / IMF copper",
    sourceUrl: SOURCE_URLS["FRED / IMF copper"],
    currency: "USD",
    frequency: "monthly",
  };
}

function convertMonthlyUsdHistoryToToman(usdPoints, dollarPoints) {
  const dollarsByMonth = new Map();
  normalizeObservedHistory(dollarPoints).forEach((point) => {
    const month = point.date.slice(0, 7);
    const observations = dollarsByMonth.get(month) || [];
    observations.push(point);
    dollarsByMonth.set(month, observations);
  });
  let missingFxCount = 0;
  const points = normalizeObservedHistory(usdPoints).flatMap((point) => {
    const dollarObservations = dollarsByMonth.get(point.date.slice(0, 7)) || [];
    if (dollarObservations.length < 2) {
      missingFxCount += 1;
      return [];
    }
    const averageDollarPrice =
      dollarObservations.reduce((sum, observation) => sum + observation.value, 0) / dollarObservations.length;
    const sourceNames = [...new Set(dollarObservations.map((observation) => observation.source))];
    return [
      {
        ...point,
        value: point.value * averageDollarPrice,
        currency: "TOMAN",
        observationType: "monthly-average",
        conversion: {
          formula: "monthly-average USD × monthly-average USD/TOMAN",
          dollarSources: sourceNames,
          dollarObservedFrom: dollarObservations[0].date,
          dollarObservedTo: dollarObservations.at(-1).date,
          dollarObservationCount: dollarObservations.length,
        },
      },
    ];
  });
  return { points, missingFxCount };
}

function requestedDayBounds(request = {}, defaultStartDate = "2017-01-01") {
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const rangeDays = HISTORY_RANGE_DAYS[request.range || "all"];
  const endMs = request.end
    ? new Date(`${request.end}T23:59:59.999Z`).getTime()
    : today + DAY_MS - 1;
  const startMs = request.start
    ? new Date(`${request.start}T00:00:00.000Z`).getTime()
    : rangeDays === null
      ? new Date(`${defaultStartDate}T00:00:00.000Z`).getTime()
      : Math.floor(endMs / DAY_MS) * DAY_MS - Math.max(0, rangeDays - 1) * DAY_MS;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs)
    throw new Error("invalid-history-range");
  return { startMs, endMs };
}

async function fetchGoldApiHistorySeries(assetId, env, request = {}) {
  const definition = GOLD_API_HISTORY_ASSETS[assetId];
  if (!definition) throw new Error("unsupported-gold-api-history");
  const apiKey = typeof env?.GOLD_API_KEY === "string" ? env.GOLD_API_KEY.trim() : "";
  if (!apiKey) throw new Error("goldapi-history-key-missing");
  if (!hasDurableSessionSecurity(env)) throw new Error("platform-key-security-not-configured");
  if (!(await reservePlatformProviderHourlyRequest(env, "goldapi-history", 9, 401)))
    throw new Error("provider-rate-limited");
  const { startMs, endMs } = requestedDayBounds(request, "1970-01-01");
  const url = new URL(GOLD_API_HISTORY_URL);
  url.searchParams.set("symbol", definition.symbol);
  url.searchParams.set("startTimestamp", String(Math.floor(startMs / 1000)));
  url.searchParams.set("endTimestamp", String(Math.floor(endMs / 1000)));
  url.searchParams.set("groupBy", "day");
  url.searchParams.set("aggregation", "avg");
  url.searchParams.set("orderBy", "asc");
  const data = await fetchJson(url, {
    headers: { "x-api-key": apiKey },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!Array.isArray(data)) throw new Error("provider-history-empty");
  const points = data.flatMap((row) => {
    const date = row?.day ?? row?.date ?? row?.month ?? row?.year;
    const value = Number(row?.avg_price ?? row?.price ?? row?.average_price);
    return date && Number.isFinite(value) && value > 0
      ? [
          {
            date,
            value: (value * definition.factor) / definition.divisor,
            source: "Gold API",
            currency: "USD",
          },
        ]
      : [];
  });
  if (points.length < 2) throw new Error("provider-history-empty");
  const sourceUrl = new URL("https://gold-api.com/docs").toString();
  return { points, source: "Gold API", sourceUrl, currency: "USD" };
}

async function fetchBinanceCryptoSeries(assetId, request = {}) {
  const symbol = BINANCE_HISTORY_SYMBOLS[assetId];
  if (!symbol) throw new Error("unsupported-binance-series");
  let { startMs, endMs } = requestedDayBounds(request, "2017-01-01");
  const chunkMs = 999 * DAY_MS;
  const maxChunks = 12;
  if (endMs - startMs > maxChunks * chunkMs) startMs = endMs - maxChunks * chunkMs;
  const chunks = [];
  for (let chunkStart = startMs; chunkStart <= endMs; ) {
    const chunkEnd = Math.min(endMs, chunkStart + chunkMs - 1);
    chunks.push({ start: chunkStart, end: chunkEnd });
    chunkStart = chunkEnd + 1;
  }
  const pages = await Promise.all(
    chunks.map(async ({ start, end }) => {
      const url = new URL(BINANCE_KLINES_URL);
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("interval", "1d");
      url.searchParams.set("startTime", String(start));
      url.searchParams.set("endTime", String(end));
      url.searchParams.set("limit", "1000");
      const rows = await fetchJson(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
      if (!Array.isArray(rows)) throw new Error("provider-history-empty");
      return rows.flatMap((row) => {
        const timestamp = Number(row?.[0]);
        const close = Number(row?.[4]);
        return Number.isFinite(timestamp) && Number.isFinite(close) && close > 0
          ? [{ date: timestamp, value: close, source: "Binance", currency: "USDT" }]
          : [];
      });
    }),
  );
  const points = normalizeObservedHistory(pages.flat(), "Binance").map((point) => ({
    ...point,
    currency: "USDT",
  }));
  if (points.length < 2) throw new Error("provider-history-empty");
  return { points, source: "Binance", sourceUrl: BINANCE_KLINES_URL, currency: "USDT" };
}

async function fetchCoinbaseCryptoSeries(assetId, request = {}) {
  const product = COINBASE_HISTORY_PRODUCTS[assetId];
  if (!product) throw new Error("unsupported-coinbase-series");
  const bounds = requestedDayBounds(request, "2015-01-01");
  const endMs = Math.floor(bounds.endMs / DAY_MS) * DAY_MS + DAY_MS - 1;
  const chunkDays = 290;
  const maxChunks = 16;
  const startMs = Math.max(bounds.startMs, endMs - maxChunks * chunkDays * DAY_MS);
  const chunks = [];
  for (let chunkStart = startMs; chunkStart <= endMs; ) {
    const chunkEnd = Math.min(endMs, chunkStart + chunkDays * DAY_MS - 1);
    chunks.push({ start: chunkStart, end: chunkEnd });
    chunkStart = chunkEnd + 1;
  }
  const pages = [];
  for (let offset = 0; offset < chunks.length; offset += 4) {
    const batch = await Promise.all(
      chunks.slice(offset, offset + 4).map(async ({ start, end }) => {
        const url = new URL(`${COINBASE_CANDLES_BASE}${product}/candles`);
        url.searchParams.set("granularity", "86400");
        url.searchParams.set("start", new Date(start).toISOString());
        url.searchParams.set("end", new Date(end).toISOString());
        const rows = await fetchJson(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
        if (!Array.isArray(rows)) throw new Error("provider-history-empty");
        return rows.flatMap((row) => {
          const timestamp = Number(row?.[0]);
          const close = Number(row?.[4]);
          return Number.isFinite(timestamp) && Number.isFinite(close) && close > 0
            ? [{ date: timestamp * 1000, value: close, source: "Coinbase", currency: "USD" }]
            : [];
        });
      }),
    );
    pages.push(...batch);
  }
  const points = normalizeObservedHistory(pages.flat(), "Coinbase");
  if (points.length < 2) throw new Error("provider-history-empty");
  return {
    points: points.map((point) => ({ ...point, source: "Coinbase", currency: "USD" })),
    source: "Coinbase",
    sourceUrl: `${COINBASE_CANDLES_BASE}${product}/candles`,
    currency: "USD",
  };
}

async function fetchKrakenCryptoSeries(assetId, request = {}) {
  const pair = KRAKEN_HISTORY_PAIRS[assetId];
  if (!pair) throw new Error("unsupported-kraken-series");
  const bounds = requestedDayBounds(request, "2017-01-01");
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  if (bounds.endMs < today) throw new Error("provider-history-window-unsupported");
  const startMs = Math.max(bounds.startMs, today - 719 * DAY_MS);
  const url = new URL(KRAKEN_OHLC_URL);
  url.searchParams.set("pair", pair);
  url.searchParams.set("interval", "1440");
  url.searchParams.set("since", String(Math.floor(startMs / 1000)));
  url.searchParams.set("assetVersion", "1");
  const data = await fetchJson(url, { cf: { cacheTtl: 900, cacheEverything: true } });
  if (Array.isArray(data?.error) && data.error.length) throw new Error("provider-history-empty");
  const entries = Object.entries(data?.result || {}).filter(([key, value]) => key !== "last" && Array.isArray(value));
  const rows = entries[0]?.[1] || [];
  const completedRows = rows.slice(0, -1);
  const points = completedRows.flatMap((row) => {
    const timestamp = Number(row?.[0]);
    const close = Number(row?.[4]);
    return Number.isFinite(timestamp) && Number.isFinite(close) && close > 0
      ? [{ date: timestamp * 1000, value: close, source: "Kraken", currency: "USD" }]
      : [];
  });
  if (points.length < 2) throw new Error("provider-history-empty");
  return { points, source: "Kraken", sourceUrl: url.origin + url.pathname, currency: "USD" };
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
  if (points.length < 2) throw new Error("provider-history-empty");
  return { points, source: "CoinGecko", sourceUrl, currency: "USD" };
}

async function fetchNobitexCryptoSeries(assetId, range, start, end) {
  const symbol = NOBITEX_HISTORY_SYMBOLS[assetId];
  if (!symbol) throw new Error("unsupported-nobitex-series");
  const now = Date.now();
  const rangeDays = HISTORY_RANGE_DAYS[range];
  const today = Math.floor(now / (24 * 60 * 60 * 1000)) * (24 * 60 * 60);
  const from = start
    ? Math.floor(new Date(`${start}T00:00:00.000Z`).getTime() / 1000)
    : rangeDays === null
      ? 0
      : today - rangeDays * 24 * 60 * 60;
  const to = end
    ? Math.floor(new Date(`${end}T23:59:59.999Z`).getTime() / 1000)
    : today + 24 * 60 * 60 - 1;
  const pageLimit = Math.min(
    MAX_NOBITEX_HISTORY_PAGES,
    Math.max(1, Math.ceil((to - from) / (500 * 24 * 60 * 60))),
  );
  const pages = await Promise.all(
    Array.from({ length: pageLimit }, (_, index) => index + 1).map(async (page) => {
      const url = new URL(NOBITEX_HISTORY_BASE);
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("resolution", "D");
      url.searchParams.set("from", String(from));
      url.searchParams.set("to", String(to));
      url.searchParams.set("page", String(page));
      const data = await fetchJson(url, {
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      if (data?.s === "no_data") return [];
      if (data?.s !== "ok" || !Array.isArray(data.t) || !Array.isArray(data.c))
        throw new Error("provider-history-empty");
      return data.t.flatMap((timestamp, index) => {
        const close = Number(data.c[index]);
        return Number.isFinite(Number(timestamp)) && Number.isFinite(close) && close > 0
          ? [{ date: Number(timestamp) * 1000, value: close / 10, source: "Nobitex", currency: "TOMAN" }]
          : [];
      });
    }),
  );
  const points = normalizeObservedHistory(pages.flat(), "Nobitex").map((point) => ({
    ...point,
    currency: "TOMAN",
  }));
  if (points.length < 2) throw new Error("provider-history-empty");
  return { points, source: "Nobitex", sourceUrl: SOURCE_URLS.Nobitex, currency: "TOMAN" };
}

function convertUsdtHistoryToToman(assetPoints, tetherPoints) {
  const tetherByDay = new Map(
    normalizeObservedHistory(tetherPoints || [], "Nobitex").map((point) => [point.date.slice(0, 10), point]),
  );
  let missingFxCount = 0;
  const points = normalizeObservedHistory(assetPoints).flatMap((point) => {
    const tether = tetherByDay.get(point.date.slice(0, 10));
    if (!tether) {
      missingFxCount += 1;
      return [];
    }
    return [
      {
        ...point,
        value: point.value * tether.value,
        currency: "TOMAN",
        conversion: {
          formula: "ASSET/USDT × USDT/TOMAN",
          tetherSource: tether.source,
          tetherObservedAt: tether.date,
        },
      },
    ];
  });
  return { points, missingFxCount };
}

async function fetchCryptoHistoryFallback(assetId, apiKey, userSuppliedKey, env, request, rawSeries) {
  const candidates = [];
  if (COINBASE_HISTORY_PRODUCTS[assetId]) {
    candidates.push(async () => {
      const series = await fetchCoinbaseCryptoSeries(assetId, request);
      const converted = convertUsdHistoryToToman(series.points, rawSeries.dollar?.points || []);
      if (converted.points.length < 2) throw new Error("no-matching-dated-fx");
      return { ...series, points: converted.points, currency: "TOMAN", missingFxCount: converted.missingFxCount };
    });
  }
  if (BINANCE_HISTORY_SYMBOLS[assetId]) {
    candidates.push(async () => {
      const series = await fetchBinanceCryptoSeries(assetId, request);
      let tetherPoints = rawSeries.tether?.points;
      if (!tetherPoints?.length) {
        const tether = await fetchNobitexCryptoSeries("tether", request.range, request.start, request.end);
        rawSeries.tether = tether;
        tetherPoints = tether.points;
      }
      const converted = convertUsdtHistoryToToman(series.points, tetherPoints);
      if (converted.points.length < 2) throw new Error("no-matching-dated-usdt");
      return { ...series, points: converted.points, currency: "TOMAN", missingFxCount: converted.missingFxCount };
    });
  }
  if (KRAKEN_HISTORY_PAIRS[assetId]) {
    candidates.push(async () => {
      const series = await fetchKrakenCryptoSeries(assetId, request);
      const converted = convertUsdHistoryToToman(series.points, rawSeries.dollar?.points || []);
      if (converted.points.length < 2) throw new Error("no-matching-dated-fx");
      return { ...series, points: converted.points, currency: "TOMAN", missingFxCount: converted.missingFxCount };
    });
  }
  if (GOLD_API_HISTORY_ASSETS[assetId] && env?.GOLD_API_KEY) {
    candidates.push(async () => {
      const series = await fetchGoldApiHistorySeries(assetId, env, request);
      const converted = convertUsdHistoryToToman(series.points, rawSeries.dollar?.points || []);
      if (converted.points.length < 2) throw new Error("no-matching-dated-fx");
      return { ...series, points: converted.points, currency: "TOMAN", missingFxCount: converted.missingFxCount };
    });
  }
  if (COINGECKO_IDS[assetId] && apiKey) {
    candidates.push(async () => {
      const series = await fetchCryptoSeries(assetId, apiKey, userSuppliedKey, env);
      const converted = convertUsdHistoryToToman(series.points, rawSeries.dollar?.points || []);
      if (converted.points.length < 2) throw new Error("no-matching-dated-fx");
      return { ...series, points: converted.points, currency: "TOMAN", missingFxCount: converted.missingFxCount };
    });
  }
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await candidate();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("nobitex-history-unavailable");
}

function errorReason(error) {
  if (error?.message === "coingecko-demo-key-missing") return "coingecko-demo-key-missing";
  if (error?.message === "goldapi-history-key-missing") return "goldapi-history-key-missing";
  if (error?.message === "platform-key-security-not-configured") return "platform-key-security-not-configured";
  if (error?.message === "platform-key-monthly-quota-exceeded") return "platform-key-monthly-quota-exceeded";
  if (error?.message === "provider-rate-limited") return "provider-rate-limited";
  if (error?.message === "yahoo-license-not-confirmed") return "yahoo-license-not-confirmed";
  if (error?.message === "provider-history-empty") return "provider-history-empty";
  if (error?.message === "nobitex-history-unavailable") return "nobitex-history-unavailable";
  return "provider-unavailable";
}

function historyCandidateSources(assetId, env, hasProviderKey) {
  const candidates = {
    dollar: ["TGJU"],
    gold: ["TGJU", "ChartGoldPrice"],
    silver: ["TGJU", "ChartGoldPrice"],
    bitcoin: ["Nobitex", "Coinbase", "Binance", "Kraken"],
    ethereum: ["Nobitex", "Coinbase", "Binance", "Kraken"],
    tether: ["Nobitex", "Kraken"],
    platinum: [],
    palladium: [],
    copper: ["FRED / IMF copper"],
    bourseIndex: ["TGJU", "TSETMC"],
    fixedIncome: [],
    cash: [],
  };
  const result = [...(candidates[assetId] || [])];
  if (YAHOO_SERIES[assetId] && env?.YAHOO_METALS_LICENSE_CONFIRMED === "true") {
    result.unshift("Yahoo Finance");
  }
  if (GOLD_API_HISTORY_ASSETS[assetId] && env?.GOLD_API_KEY && hasDurableSessionSecurity(env)) result.push("Gold API");
  if (COINGECKO_IDS[assetId] && hasProviderKey) result.push("CoinGecko");
  return result;
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

async function loadRawSeries(assetId, apiKey, userSuppliedKey, env, request = {}) {
  if (TGJU_PAGES[assetId]) {
    try {
      return await fetchTgjuSeries(assetId);
    } catch (tgjuError) {
      if (!["gold", "silver"].includes(assetId)) throw new Error("provider-unavailable");
      try {
        return await fetchAuxiliaryMetalSeries(assetId);
      } catch (chartGoldError) {
        if (!env?.GOLD_API_KEY) throw chartGoldError || tgjuError;
        return fetchGoldApiHistorySeries(assetId, env, request);
      }
    }
  }
  if (assetId === "bourseIndex") {
    try {
      return await fetchIndexSeries();
    } catch {
      return fetchTsetmcIndexSeries();
    }
  }
  if (YAHOO_SERIES[assetId]) {
    if (env?.YAHOO_METALS_LICENSE_CONFIRMED === "true") {
      try {
        return await fetchYahooSeries(assetId);
      } catch (yahooError) {
        if (assetId === "copper") {
          try {
            return await fetchFredCopperSeries();
          } catch {
            throw yahooError;
          }
        }
        if (!env?.GOLD_API_KEY || !GOLD_API_HISTORY_ASSETS[assetId]) throw yahooError;
        return fetchGoldApiHistorySeries(assetId, env, request);
      }
    }
    if (assetId === "copper") return fetchFredCopperSeries();
    if (env?.GOLD_API_KEY && GOLD_API_HISTORY_ASSETS[assetId])
      return fetchGoldApiHistorySeries(assetId, env, request);
    throw new Error("yahoo-license-not-confirmed");
  }
  if (NOBITEX_HISTORY_SYMBOLS[assetId]) {
    try {
      return await fetchNobitexCryptoSeries(assetId, request.range || "all", request.start, request.end);
    } catch {
      throw new Error("nobitex-history-unavailable");
    }
  }
  if (COINGECKO_IDS[assetId]) {
    if (apiKey) return fetchCryptoSeries(assetId, apiKey, userSuppliedKey, env);
    if (GOLD_API_HISTORY_ASSETS[assetId] && env?.GOLD_API_KEY)
      return fetchGoldApiHistorySeries(assetId, env, request);
  }
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
      await loadRawSeries(assetId, providerKey.key, providerKey.userSupplied, context.env, { range, start, end }),
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
  const unavailableCryptoAssets = rawAssets.filter((assetId) => NOBITEX_HISTORY_SYMBOLS[assetId] && !rawSeries[assetId]);
  await Promise.all(
    unavailableCryptoAssets.map(async (assetId) => {
      try {
        rawSeries[assetId] = await fetchCryptoHistoryFallback(
          assetId,
          providerKey.key,
          providerKey.userSupplied,
          context.env,
          { range, start, end },
          rawSeries,
        );
        delete errors[assetId];
      } catch {
        // Keep the original primary-source reason when every fallback fails.
      }
    }),
  );
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
        const converted =
          provider.frequency === "monthly"
            ? convertMonthlyUsdHistoryToToman(normalized, dollarPoints)
            : convertUsdHistoryToToman(normalized, dollarPoints);
        points = converted.points;
        missingFxCount = converted.missingFxCount;
        if (!points.length)
          reason = needsDollarHistory && !dollarPoints.length ? "dated-fx-unavailable" : "no-matching-dated-fx";
      } else {
        points = normalized;
        missingFxCount = Number(provider.missingFxCount) || 0;
      }
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
      coverage: rangeCoverage(points, provider?.source, range, reason, {
        missingFxCount,
        frequency: provider?.frequency || "daily",
        candidateSources: historyCandidateSources(assetId, context.env, Boolean(providerKey.key)),
      }),
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
