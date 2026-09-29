import { INSTRUMENT_REGISTRY, SLEEVE_REGISTRY } from "../../src/market/catalog.js";
import {
  consumeRouteQuota,
  deferPlatformProviderRequest,
  hasDurableSessionSecurity,
  readPlatformProviderCache,
  reservePlatformProviderRequest,
  selectedCoinMarketCapKey,
  selectedProviderKey,
  writePlatformProviderCache,
  waitForPlatformProviderCache,
} from "./_security.js";

const TGJU_BASE = "https://www.tgju.org/profile/";
const BONBAST_BASE = "https://www.bonbast.com";
const NAVASAN_RAW_BASE = "https://raw.githubusercontent.com/HosseinOdd/Navasan-API/main/data/";
const CHART_GOLD_URL = "https://www.chartgoldprice.com/api/data?history=both";
const COINGECKO_SIMPLE_URL = "https://api.coingecko.com/api/v3/simple/price";
const COINMARKETCAP_QUOTES_URL = "https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest";
const COINMARKETCAP_PUBLIC_URL = "https://pro-api.coinmarketcap.com/public-api/v2/simple/price";
const BINANCE_TICKER_URL = "https://api.binance.com/api/v3/ticker/24hr";
const NOBITEX_STATS_URL = "https://api.nobitex.ir/market/stats";
const GOLD_API_PRICE_BASE = "https://api.gold-api.com/price/";
const METALS_LIVE_URL = "https://api.metals.live/v1/spot";
const YAHOO_METAL_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";
const TSETMC_INDEX_URL = "https://cdn.tsetmc.com/api/Index/GetIndexB1LastDay";
const TROY_OUNCE_TO_GRAMS = 31.1034768;
const sourcePages = { dollar: "price_dollar_rl", gold: "geram18", silver: "silver_999" };
const fundPages = { fixedIncome: "https://charisma.ir/funds/fixedincomefund" };
// Keep each upstream bounded so parallel sources fit the interactive budget.
const UPSTREAM_TIMEOUT_MS = 1800;
const INTERACTIVE_BUDGET_MS = 3500;
const CONSENSUS_POLICY = Object.freeze({
  version: "quote-consensus-v3-robust-median",
  calibrated: false,
  agreementTolerancePct: Object.freeze({ fx: 0.25, gold: 0.1, commodities: null, crypto: null, iranEquity: null }),
  spreadWarningPct: Object.freeze({ fx: 0.25, gold: 0.1, commodities: 1, crypto: 1, iranEquity: 0.5 }),
});
const DEFAULT_MARKET_ASSETS = Object.freeze([
  "dollar",
  "gold",
  "silver",
  "bitcoin",
  "ethereum",
  "tether",
  "platinum",
  "palladium",
  "copper",
  "bourseIndex",
  "fixedIncome",
]);
export const SERVER_MARKET_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const SERVER_MARKET_CACHE_PREFIX = "market-response-v1:";
const headers = {
  "User-Agent": "invest-consult/2.0 (+https://github.com/tahamoeini/invest-consult)",
  Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
};

function normalizeDigits(value) {
  return String(value || "")
    .replace(/[\u06f0-\u06f9]/g, (digit) =>
      String("\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8\u06f9".indexOf(digit)),
    )
    .replace(/[\u0660-\u0669]/g, (digit) =>
      String("\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669".indexOf(digit)),
    );
}

function parseNumber(value) {
  const normalized = normalizeDigits(value)
    .replace(/[\u066c\u060c,\s]/g, "")
    .replace(/%/g, "")
    .replace(/\u066a/g, "")
    .replace(/\u066b/g, ".");
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  let date;
  if (typeof value === "number" || (typeof value === "string" && /^\d{10,13}$/.test(value.trim()))) {
    const numeric = Number(value);
    if (numeric <= 0) return null;
    date = new Date(Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric);
  } else date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstNumberAfter(html, marker, windowSize = 800) {
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const sample = html
    .slice(start + marker.length, start + windowSize)
    .replace(/^>\s*/, "")
    .replace(/<[^>]*>/g, " ")
    .trim();
  const token = sample.split(/\s+/)[0] || "";
  const match = token.match(/[-+]?[0-9\u06f0-\u06f9\u0660-\u0669]+(?:[.,\u066b][0-9\u06f0-\u06f9\u0660-\u0669]+)*/);
  return match ? parseNumber(match[0]) : null;
}

function quote(asset, price, source, metadata = {}) {
  if (!Number.isFinite(Number(price)) || Number(price) <= 0) return null;
  const sourceTime = normalizeTimestamp(metadata.observedAt ?? metadata.sourceTime);
  return {
    ...metadata,
    asset,
    price: Number(price),
    source,
    observedAt: sourceTime,
    sourceTime,
    retrievedAt: new Date().toISOString(),
    quoteType: metadata.quoteType === "derived" ? "derived" : "direct",
    derivedFrom: Array.isArray(metadata.derivedFrom) ? metadata.derivedFrom : [],
  };
}

function isPositiveNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function safeProviderFailureCode(error) {
  if (error?.name === "AbortError") return "timeout";
  if (Number(error?.status) === 429) return "rate_limited";
  if ([401, 403].includes(Number(error?.status))) return "access_denied";
  if (Number(error?.status) >= 500) return "upstream_unavailable";
  if (error?.message === "Source returned invalid JSON") return "invalid_response";
  return "request_failed";
}

async function fetchContent(url, options = {}, read = (response) => response.text()) {
  const { requestTimeoutMs = UPSTREAM_TIMEOUT_MS, ...requestOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      ...requestOptions,
      signal: controller.signal,
      headers: { ...headers, ...(options.headers || {}) },
      cf: { cacheTtl: 300, cacheEverything: true, ...(options.cf || {}) },
    });
    if (!response.ok) {
      const error = new Error(`Source returned ${response.status}`);
      error.status = response.status;
      error.retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
      throw error;
    }
    return await read(response);
  } finally {
    clearTimeout(timeout);
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(24 * 60 * 60, Math.ceil(seconds));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1, Math.min(24 * 60 * 60, Math.ceil((date - Date.now()) / 1000))) : null;
}

async function fetchText(url, options = {}) {
  return await fetchContent(url, options);
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Source returned invalid JSON");
  }
}

async function providerA(requested = Object.keys(sourcePages)) {
  const pages = Object.entries(sourcePages).filter(([asset]) => requested.includes(asset));
  const results = await Promise.allSettled(
    pages.map(async ([asset, page]) => {
      const html = await fetchText(TGJU_BASE + page);
      const price = firstNumberAfter(html, 'data-col="info.last_trade.PDrCotVal"', 500);
      const changePct = firstNumberAfter(html, 'data-col="info.last_trade.last_change_percentage"', 300);
      const revision = html.match(/data-revision="([^"]+)"/);
      const serverTime = html.match(/id="server-time"[^>]+data-value="([^"]+)"/);
      const item = quote(asset, price === null ? null : price / 10, "TGJU", {
        changePct,
        sourceUrl: TGJU_BASE + page,
        sourceTime: serverTime ? serverTime[1] : null,
        sourceRevision: revision ? revision[1] : null,
      });
      return { asset, item, history: normalizeTgjuHistory(extractTgjuChartData(html)) };
    }),
  );
  const fulfilled = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
  if (!fulfilled.length) throw new Error("No TGJU quote pages responded");
  return {
    quotes: fulfilled.map((result) => result.item).filter(Boolean),
    history: Object.fromEntries(fulfilled.map((result) => [result.asset, result.history])),
  };
}

async function providerB() {
  const landing = await fetchContent(
    BONBAST_BASE + "/",
    { requestTimeoutMs: 800, cf: { cacheTtl: 60, cacheEverything: true } },
    async (response) => ({
      html: await response.text(),
      cookie: response.headers.get("set-cookie") || "",
    }),
  );
  const tokenMatch = landing.html.match(/\$\.post\('\/json',\s*\{param:\s*"([^"]+)"/);
  if (!tokenMatch) throw new Error("Request token not found");
  const data = await fetchJson(BONBAST_BASE + "/json", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      referer: BONBAST_BASE + "/",
      ...(landing.cookie ? { cookie: landing.cookie } : {}),
    },
    body: "param=" + encodeURIComponent(tokenMatch[1]),
    requestTimeoutMs: 800,
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (data.rest) throw new Error("Quote response was incomplete");
  const sourceTime = data.last_modified || data.created || null;
  return [
    quote("dollar", parseNumber(data.usd1), "Bonbast", { sourceUrl: BONBAST_BASE + "/", sourceTime }),
    quote("gold", parseNumber(data.gol18), "Bonbast", { sourceUrl: BONBAST_BASE + "/", sourceTime }),
  ].filter(Boolean);
}

async function providerC(requestTimeoutMs = 600, requested = ["dollar", "gold"]) {
  const [fiatResult, goldResult] = await Promise.allSettled([
    requested.includes("dollar")
      ? fetchJson(NAVASAN_RAW_BASE + "fiat.json", { requestTimeoutMs })
      : Promise.resolve(null),
    requested.includes("gold")
      ? fetchJson(NAVASAN_RAW_BASE + "gold.json", { requestTimeoutMs })
      : Promise.resolve(null),
  ]);
  const hasSuccessfulFeed =
    (requested.includes("dollar") && fiatResult.status === "fulfilled") ||
    (requested.includes("gold") && goldResult.status === "fulfilled");
  if (!hasSuccessfulFeed) throw new Error("No Navasan fallback feed responded");
  const fiat = fiatResult.status === "fulfilled" ? fiatResult.value : null;
  const gold = goldResult.status === "fulfilled" ? goldResult.value : null;
  const dollar = fiat && fiat.usd;
  const gold18 = gold && gold["18ayar"];
  const dollarTime =
    dollar && Number.isFinite(Number(dollar.date)) ? new Date(Number(dollar.date) * 1000).toISOString() : null;
  const goldTime =
    gold18 && Number.isFinite(Number(gold18.date)) ? new Date(Number(gold18.date) * 1000).toISOString() : null;
  return [
    requested.includes("dollar")
      ? quote("dollar", parseNumber(dollar && dollar.value), "Navasan", {
          changePct: parseNumber(dollar && dollar.change_pct),
          sourceUrl: "https://github.com/HosseinOdd/Navasan-API",
          sourceTime: dollarTime,
        })
      : null,
    requested.includes("gold")
      ? quote("gold", parseNumber(gold18 && gold18.value), "Navasan", {
          changePct: parseNumber(gold18 && gold18.change_pct),
          sourceUrl: "https://github.com/HosseinOdd/Navasan-API",
          sourceTime: goldTime,
        })
      : null,
  ].filter(Boolean);
}

const providers = [
  { id: "providerA", run: providerA },
  { id: "providerB", run: providerB },
  { id: "providerC", run: providerC },
];

async function providerCrypto(
  requested = ["bitcoin", "ethereum", "tether"],
  apiKey = "",
  userSuppliedKey = false,
  env = {},
) {
  const mapping = { bitcoin: "bitcoin", ethereum: "ethereum", tether: "tether" };
  const selected = Object.entries(mapping).filter(([, asset]) => requested.includes(asset));
  if (!selected.length) return [];
  if (!apiKey) throw new Error("coingecko-demo-key-missing");
  if (!userSuppliedKey && !hasDurableSessionSecurity(env)) throw new Error("platform-key-security-not-configured");
  const url =
    COINGECKO_SIMPLE_URL +
    `?ids=${selected.map(([id]) => id).join(",")}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`;
  const fetchQuotes = async () => {
    if (!apiKey) throw new Error("coingecko-demo-key-missing");
    const data = await fetchJson(url, {
      headers: { "x-cg-demo-api-key": apiKey },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    return selected
      .map(([id, asset]) => {
        const item = data && data[id];
        if (!item) return null;
        const usd = parseNumber(item.usd);
        return quote(asset, usd, "CoinGecko", {
          changePct: parseNumber(item.usd_24hr_change ?? item.usd_24h_change),
          sourceUrl: url,
          sourceTime: item.last_updated_at ? new Date(Number(item.last_updated_at) * 1000).toISOString() : null,
          unit: "coin",
          currency: "USD",
          quoteType: "direct",
        });
      })
      .filter(Boolean);
  };
  // User-owned keys are used only for this request; their quotes and key IDs
  // never enter the durable platform-provider cache or quota tables.
  if (userSuppliedKey) return { quotes: await fetchQuotes(), cacheStatus: "uncached" };
  return await loadPlatformProviderQuotes(env, "coingecko", {
    maxAgeMs: 6 * 60_000,
    maxStaleMs: 24 * 60 * 60_000,
    monthlyLimit: 8000,
    minimumIntervalSeconds: 6 * 60,
    fetchQuotes,
  });
}

async function providerCoinMarketCap(requested, env, userKey = "", userSuppliedKey = false) {
  const mapping = { bitcoin: "bitcoin", ethereum: "ethereum", tether: "tether" };
  const selected = Object.entries(mapping).filter(([, asset]) => requested.includes(asset));
  if (!selected.length) return { quotes: [], cacheStatus: "skipped" };
  const apiKey = userSuppliedKey
    ? userKey
    : hasDurableSessionSecurity(env) && typeof env?.COINMARKETCAP_API_KEY === "string"
      ? env.COINMARKETCAP_API_KEY.trim()
      : "";
  const slugs = selected.map(([slug]) => slug);
  const url = apiKey
    ? `${COINMARKETCAP_QUOTES_URL}?slug=${encodeURIComponent(slugs.join(","))}&convert=USD`
    : `${COINMARKETCAP_PUBLIC_URL}?slug=${encodeURIComponent(slugs.join(","))}&convert=USD`;
  const fetchQuotes = async () => {
    const data = await fetchJson(url, {
      ...(apiKey ? { headers: { "X-CMC_PRO_API_KEY": apiKey } } : {}),
      cf: apiKey ? { cacheTtl: 0, cacheEverything: false } : { cacheTtl: 60, cacheEverything: true },
    });
    const rows = Array.isArray(data?.data)
      ? data.data
      : Object.values(data?.data || {}).flatMap((row) => (Array.isArray(row) ? row : [row]));
    return rows
      .map((item) => {
        const asset = item?.slug;
        if (!selected.some(([, selectedAsset]) => selectedAsset === asset)) return null;
        const usd = parseNumber(
          item?.price ?? item?.quote?.USD?.price ?? item?.quotes?.find((row) => row.symbol === "USD")?.price,
        );
        return quote(asset, usd, "CoinMarketCap", {
          changePct: parseNumber(
            item?.quote?.USD?.percent_change_24h ??
              item?.quotes?.find((row) => row.symbol === "USD")?.percent_change_24h,
          ),
          sourceUrl: "https://coinmarketcap.com/api/documentation/pro-api-reference/cryptocurrency",
          sourceTime:
            item?.quote?.USD?.last_updated ||
            item?.quotes?.find((row) => row.symbol === "USD")?.last_updated ||
            item?.last_updated ||
            null,
          unit: "coin",
          currency: "USD",
          quoteType: "direct",
        });
      })
      .filter(Boolean);
  };
  // A personal key is used only for this request and never enters the shared
  // platform cache or durable quota coordinator.
  if (userSuppliedKey) return { quotes: await fetchQuotes(), cacheStatus: "uncached" };
  if (!apiKey) return { quotes: await fetchQuotes(), cacheStatus: "public" };
  if (!hasDurableSessionSecurity(env)) throw new Error("platform-key-security-not-configured");
  return await loadPlatformProviderQuotes(env, "coinmarketcap", {
    maxAgeMs: 15 * 60_000,
    maxStaleMs: 24 * 60 * 60_000,
    monthlyLimit: 15000,
    quotaUnits: selected.length,
    minimumIntervalSeconds: 15 * 60,
    fetchQuotes,
  });
}

const providerFlights = new Map();

async function loadPlatformProviderQuotes(env, provider, options) {
  const now = Date.now();
  const cached = await readPlatformProviderCache(env, provider);
  const cacheAge = cached ? now - cached.fetchedAt : Infinity;
  if (cached && cacheAge >= 0 && cacheAge < options.maxAgeMs) return { quotes: cached.quotes, cacheStatus: "cached" };
  const cachedStale = () =>
    cached && cacheAge >= 0 && cacheAge <= options.maxStaleMs
      ? cached.quotes.map((item) => ({ ...item, cacheStale: true }))
      : [];
  if (providerFlights.has(provider)) return providerFlights.get(provider);

  const operation = (async () => {
    const canFetch = await reservePlatformProviderRequest(env, provider, {
      monthlyLimit: options.monthlyLimit,
      minimumIntervalSeconds: options.minimumIntervalSeconds,
    });
    if (!canFetch) {
      const latest = await waitForPlatformProviderCache(env, provider, cached?.fetchedAt || 0);
      const latestAge = latest ? Date.now() - latest.fetchedAt : Infinity;
      if (latest && latestAge >= 0 && latestAge < options.maxAgeMs)
        return { quotes: latest.quotes, cacheStatus: "cached" };
      const quotes =
        latest && latestAge >= 0 && latestAge <= options.maxStaleMs
          ? latest.quotes.map((item) => ({ ...item, cacheStale: true }))
          : cachedStale();
      return { quotes, cacheStatus: quotes.length ? "stale" : "rate-limited" };
    }
    try {
      const quotes = await options.fetchQuotes();
      await writePlatformProviderCache(env, provider, quotes);
      return { quotes, cacheStatus: "refreshed" };
    } catch (error) {
      if (Number(error?.status) === 429 && error.retryAfterSeconds)
        await deferPlatformProviderRequest(env, provider, error.retryAfterSeconds);
      if (cached) return { quotes: cachedStale(), cacheStatus: "stale" };
      throw error;
    }
  })();
  providerFlights.set(provider, operation);
  try {
    return await operation;
  } finally {
    if (providerFlights.get(provider) === operation) providerFlights.delete(provider);
  }
}

async function providerCryptoBinance(requested = ["bitcoin", "ethereum"]) {
  const mapping = { BTCUSDT: "bitcoin", ETHUSDT: "ethereum" };
  const symbols = Object.entries(mapping)
    .filter(([, asset]) => requested.includes(asset))
    .map(([symbol]) => symbol);
  if (!symbols.length) return [];
  const url = BINANCE_TICKER_URL + "?symbols=" + encodeURIComponent(JSON.stringify(symbols));
  const data = await fetchJson(url);
  return (Array.isArray(data) ? data : [])
    .map((item) => {
      const asset = mapping[item && item.symbol];
      if (!asset) return null;
      const usdt = parseNumber(item.lastPrice);
      return quote(asset, usdt, "Binance", {
        changePct: parseNumber(item.priceChangePercent),
        sourceUrl: url,
        sourceTime: item.closeTime ? new Date(Number(item.closeTime)).toISOString() : null,
        unit: "coin",
        currency: "USDT",
        quoteType: "direct",
      });
    })
    .filter(Boolean);
}

async function providerNobitex(requested = ["bitcoin", "ethereum", "tether"]) {
  const mapping = { bitcoin: "btc", ethereum: "eth", tether: "usdt" };
  const requestedAssets = new Set(requested);
  if (requestedAssets.has("bitcoin") || requestedAssets.has("ethereum")) requestedAssets.add("tether");
  const selected = Object.entries(mapping).filter(([asset]) => requestedAssets.has(asset));
  if (!selected.length) return [];
  const url = new URL(NOBITEX_STATS_URL);
  // Request every Rial market in one call; Nobitex documents dstCurrency=rls
  // as the supported way to retrieve all Rial pairs.
  url.searchParams.set("dstCurrency", "rls");
  const data = await fetchJson(url.toString(), {
    requestTimeoutMs: 1400,
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (data?.status !== "ok" || !data.stats || typeof data.stats !== "object")
    throw new Error("Nobitex market response was unavailable");
  return selected
    .map(([asset, symbol]) => {
      const row = data.stats[`${symbol}-rls`];
      return quote(asset, parseNumber(row?.latest) / 10, "Nobitex", {
        changePct: parseNumber(row?.dayChange),
        sourceUrl: "https://apidocs.nobitex.ir/?shell=",
        unit: "coin",
        currency: "TOMAN",
        quoteType: "direct",
      });
    })
    .filter(Boolean);
}

function nestedNumber(value, keys, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value.slice().reverse()) {
      const found = nestedNumber(item, keys, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value)) {
    if (keys.includes(key)) {
      const found = parseNumber(item);
      if (Number.isFinite(found) && found > 0) return found;
    }
  }
  for (const item of Object.values(value)) {
    const found = nestedNumber(item, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

async function providerGlobalMetals() {
  const data = await fetchJson(METALS_LIVE_URL);
  const row = Array.isArray(data) ? data.at(-1) : data;
  const conversions = {
    gold: { factor: 0.75, unit: "gram", divisor: TROY_OUNCE_TO_GRAMS },
    silver: { factor: 1, unit: "gram", divisor: TROY_OUNCE_TO_GRAMS },
    platinum: { factor: 1, unit: "gram", divisor: TROY_OUNCE_TO_GRAMS },
    palladium: { factor: 1, unit: "gram", divisor: TROY_OUNCE_TO_GRAMS },
    copper: { factor: 1, unit: "gram", divisor: 453.59237 },
  };
  return Object.entries(conversions)
    .map(([asset, meta]) => {
      const ounceUsd = parseNumber(row && row[asset]);
      if (!Number.isFinite(ounceUsd) || ounceUsd <= 0) return null;
      return quote(asset, (ounceUsd * meta.factor) / meta.divisor, "Metals.live", {
        sourceUrl: METALS_LIVE_URL,
        sourceTime: null,
        unit: meta.unit,
        currency: "USD",
        quoteType: "direct",
      });
    })
    .filter(Boolean);
}

async function providerGoldApi(requested = []) {
  const metals = {
    gold: { symbol: "XAU", factor: 0.75 },
    silver: { symbol: "XAG", factor: 1 },
    platinum: { symbol: "XPT", factor: 1 },
    palladium: { symbol: "XPD", factor: 1 },
  };
  const selected = Object.entries(metals).filter(([asset]) => requested.includes(asset));
  if (!selected.length) return [];
  const results = await Promise.allSettled(
    selected.map(async ([asset, metal]) => {
      const url = GOLD_API_PRICE_BASE + metal.symbol;
      const data = await fetchJson(url, { requestTimeoutMs: 1500, cf: { cacheTtl: 30, cacheEverything: true } });
      const priceUsdPerTroyOunce = parseNumber(data?.price);
      if (data?.symbol !== metal.symbol || data?.currency !== "USD" || !isPositiveNumber(priceUsdPerTroyOunce))
        throw new Error("Gold API returned an unexpected quote unit");
      return quote(asset, (priceUsdPerTroyOunce * metal.factor) / TROY_OUNCE_TO_GRAMS, "Gold API", {
        sourceUrl: url,
        sourceTime: data.updatedAt || data.timestamp || null,
        unit: "gram",
        currency: "USD",
        quoteType: "direct",
      });
    }),
  );
  const quotes = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .filter(Boolean);
  if (!quotes.length && results.length)
    throw results.find((result) => result.status === "rejected")?.reason || new Error("Gold API returned no quotes");
  return quotes;
}

async function providerYahooMetals(requested = ["platinum", "palladium", "copper"]) {
  const symbols = {
    platinum: { symbol: "PL=F", divisor: TROY_OUNCE_TO_GRAMS },
    palladium: { symbol: "PA=F", divisor: TROY_OUNCE_TO_GRAMS },
    copper: { symbol: "HG=F", divisor: 453.59237 },
  };
  const results = await Promise.allSettled(
    Object.entries(symbols)
      .filter(([asset]) => requested.includes(asset))
      .map(async ([asset, meta]) => {
        const url = YAHOO_METAL_CHART_BASE + encodeURIComponent(meta.symbol) + "?range=1d&interval=1d";
        const data = await fetchJson(url);
        const quoteValue =
          data &&
          data.chart &&
          data.chart.result &&
          data.chart.result[0] &&
          data.chart.result[0].meta &&
          data.chart.result[0].meta.regularMarketPrice;
        const usd = parseNumber(quoteValue);
        if (!Number.isFinite(usd) || usd <= 0) throw new Error("Yahoo metal price not found");
        return quote(asset, usd / meta.divisor, "Yahoo Finance", {
          sourceUrl: url,
          sourceTime: data.chart.result[0].meta.regularMarketTime
            ? new Date(data.chart.result[0].meta.regularMarketTime * 1000).toISOString()
            : null,
          unit: "gram",
          currency: "USD",
          quoteType: "direct",
        });
      }),
  );
  return results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .filter(Boolean);
}

async function providerTsetmc() {
  const data = await fetchJson(TSETMC_INDEX_URL);
  const current = nestedNumber(data, ["xNivIn", "indexValue", "currentValue", "lastValue", "value"]);
  if (!Number.isFinite(current) || current <= 0) return [];
  const previous = nestedNumber(data, ["xNivInPre", "previousValue", "yesterdayValue", "prevValue"]);
  const changePct = Number.isFinite(previous) && previous > 0 ? (current / previous - 1) * 100 : null;
  return [
    quote("bourseIndex", current, "TSETMC", {
      changePct,
      sourceUrl: TSETMC_INDEX_URL,
      unit: "point",
      currency: "INDEX",
    }),
  ];
}

async function providerTgjuIndex() {
  const url = TGJU_BASE + "gc30";
  const html = await fetchText(url, { requestTimeoutMs: 500 });
  const current = firstNumberAfter(html, 'data-col="info.last_trade.PDrCotVal"', 500);
  const series = normalizeHistorySeries(extractTgjuChartData(html));
  const history = series.map((point) => ({ ...point, value: Math.round(point.value) }));
  if (!Number.isFinite(current) || current <= 0) return { quotes: [], history: { bourseIndex: history } };
  const serverTime = html.match(/id="server-time"[^>]+data-value="([^"]+)"/);
  const indexQuote = quote("bourseIndex", current, "TGJU", {
    sourceUrl: url,
    sourceTime: serverTime ? serverTime[1] : null,
    unit: "point",
    currency: "INDEX",
  });
  return {
    quotes: indexQuote ? [indexQuote] : [],
    history: { bourseIndex: history },
  };
}

export function normalizeHistorySeries(value) {
  if (Array.isArray(value)) {
    return value
      .map((point) => {
        if (Array.isArray(point)) return { date: point[0], value: Number(point[1]) };
        if (!point || typeof point !== "object") return null;
        return {
          date: point.date || point.time || point.timestamp || point.t,
          value: Number(point.close ?? point.value ?? point.price ?? point.c),
        };
      })
      .filter((point) => point && point.date && Number.isFinite(point.value) && point.value > 0);
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([date, point]) => ({
        date,
        value: Number(point && typeof point === "object" ? (point.close ?? point.value ?? point.price) : point),
      }))
      .filter((point) => point.date && Number.isFinite(point.value) && point.value > 0);
  }
  return [];
}

export function normalizeMetalHistory(value) {
  return normalizeHistorySeries(value).map((point) => ({ ...point, value: point.value / TROY_OUNCE_TO_GRAMS }));
}

function readBalancedArray(text, startIndex) {
  let depth = 0;
  let quoteChar = null;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];
    if (quoteChar) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quoteChar) quoteChar = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quoteChar = character;
      continue;
    }
    if (character === "[") depth += 1;
    if (character === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return null;
}

export function extractTgjuChartData(html, blockId = "ChartBlock-3") {
  const markerIndex = String(html || "").indexOf(`#${blockId}").msHighcharts({`);
  if (markerIndex < 0) return [];
  const dataIndex = String(html).indexOf("chartData:", markerIndex);
  if (dataIndex < 0) return [];
  const arrayStart = String(html).indexOf("[", dataIndex);
  if (arrayStart < 0) return [];
  const raw = readBalancedArray(String(html), arrayStart);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function normalizeTgjuHistory(value) {
  return normalizeHistorySeries(value)
    .map((point) => ({ ...point, value: point.value / 10 }))
    .filter((point) => Number.isFinite(point.value) && point.value > 0);
}

async function getAuxiliaryMetalData() {
  const data = await fetchJson(CHART_GOLD_URL, { requestTimeoutMs: 600 });
  const prices = data && data.prices ? data.prices : {};
  const history = data && data.history ? data.history : {};
  return {
    goldUsdPerGram: parseNumber(prices.gold && prices.gold.gram),
    silverUsdPerGram: parseNumber(prices.silver && prices.silver.gram),
    history: {
      gold: normalizeMetalHistory(history.gold || (history.series && history.series.gold)).slice(-180),
      silver: normalizeMetalHistory(history.silver || (history.series && history.series.silver)).slice(-180),
    },
    sourceTime: data && data.meta ? data.meta.updated_at || null : null,
  };
}

function median(values) {
  const sorted = values
    .filter(Number.isFinite)
    .slice()
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function aggregate(asset, quotes) {
  const valid = quotes.filter(
    (item) =>
      item &&
      item.asset === asset &&
      item.cacheStale !== true &&
      Number.isFinite(Number(item.price)) &&
      Number(item.price) > 0,
  );
  if (!valid.length) return null;
  const sleeveId = INSTRUMENT_REGISTRY[asset]?.sleeveId || "commodities";
  const configuredTolerance = CONSENSUS_POLICY.agreementTolerancePct[sleeveId];
  const hasAgreementTolerance = Number.isFinite(configuredTolerance);
  const agreementTolerancePct = hasAgreementTolerance ? configuredTolerance : 0;
  const spreadWarningPct = CONSENSUS_POLICY.spreadWarningPct[sleeveId] ?? 1;
  const timedQuotes = valid
    .map((item) => ({ item, time: new Date(item.observedAt || item.sourceTime || "").getTime() }))
    .filter((entry) => Number.isFinite(entry.time));
  const untimedQuotes = valid.filter(
    (item) => !Number.isFinite(new Date(item.observedAt || item.sourceTime || "").getTime()),
  );
  const timeWindow = sleeveId === "crypto" ? 5 * 60_000 : sleeveId === "fx" ? 60 * 60_000 : 30 * 60_000;
  const newestTime = timedQuotes.length ? Math.max(...timedQuotes.map((entry) => entry.time)) : null;
  const comparisonQuotes = timedQuotes.length
    ? [
        ...timedQuotes.filter((entry) => newestTime - entry.time <= timeWindow).map((entry) => entry.item),
        ...untimedQuotes,
      ]
    : valid;
  const unknownObservationCount = comparisonQuotes.filter(
    (item) => !Number.isFinite(new Date(item.observedAt || item.sourceTime || "").getTime()),
  ).length;
  const allPrices = comparisonQuotes.map((item) => Number(item.price));
  const center = median(allPrices);
  const mad = median(allPrices.map((price) => Math.abs(price - center)));
  const outlierLimit = 3 * 1.4826 * (mad || 0);
  const accepted =
    comparisonQuotes.length >= 3
      ? comparisonQuotes.filter(
          (item) =>
            Math.abs(Number(item.price) - center) <= Math.max(outlierLimit, (center * agreementTolerancePct) / 100),
        )
      : comparisonQuotes;
  const comparisonPrices = comparisonQuotes.map((item) => Number(item.price));
  const acceptedPrices = accepted.map((item) => Number(item.price));
  const spreadPct =
    comparisonPrices.length > 1
      ? ((Math.max(...comparisonPrices) - Math.min(...comparisonPrices)) / Math.max(median(comparisonPrices), 1)) * 100
      : 0;
  const acceptedSpreadPct =
    acceptedPrices.length > 1
      ? ((Math.max(...acceptedPrices) - Math.min(...acceptedPrices)) / Math.max(median(acceptedPrices), 1)) * 100
      : 0;
  const consensusDisagreement = accepted.length >= 2 && spreadPct > spreadWarningPct;
  const usable = accepted;
  const provisional =
    !CONSENSUS_POLICY.calibrated &&
    hasAgreementTolerance &&
    accepted.length >= 2 &&
    !consensusDisagreement &&
    unknownObservationCount === 0;
  const changes = accepted
    .map((item) => item.changePct)
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(Number)
    .filter(Number.isFinite);
  const sourceTimes = (usable.length ? usable : accepted)
    .map((item) => item.observedAt || item.sourceTime)
    .filter(Boolean)
    .sort((left, right) => {
      const leftTime = new Date(left).getTime();
      const rightTime = new Date(right).getTime();
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
      return String(left).localeCompare(String(right));
    });
  const defaultUnits = {
    dollar: "TOMAN",
    gold: "gram",
    silver: "gram",
    bitcoin: "coin",
    ethereum: "coin",
    tether: "coin",
    platinum: "gram",
    palladium: "gram",
    copper: "gram",
    bourseIndex: "point",
  };
  const quoteTypes = new Set(usable.map((item) => (item.quoteType === "derived" ? "derived" : "direct")));
  const conversionDependencies = [
    ...new Map(
      accepted
        .flatMap((item) => item.conversionDependencies || [])
        .map((dependency) => [JSON.stringify(dependency), dependency]),
    ).values(),
  ];
  const degradedDependency = conversionDependencies.some((dependency) => dependency.status !== "healthy");
  const status = provisional
    ? "provisional"
    : usable.length === 1 ||
        consensusDisagreement ||
        unknownObservationCount > 0 ||
        accepted.length < comparisonQuotes.length ||
        comparisonQuotes.length < valid.length ||
        degradedDependency
      ? "degraded"
      : "healthy";
  const confidenceRank = { none: 0, low: 1, medium: 2, high: 3 };
  let confidence = consensusDisagreement
    ? accepted.length >= 3
      ? "medium"
      : "low"
    : provisional
      ? "medium"
      : usable.length >= 3 && accepted.length === valid.length
        ? "high"
        : usable.length >= 2
          ? "medium"
          : "low";
  conversionDependencies.forEach((dependency) => {
    if ((confidenceRank[dependency.confidence] ?? 1) < confidenceRank[confidence])
      confidence = dependency.confidence || "low";
  });
  if (unknownObservationCount > 0) confidence = "low";
  return {
    price: usable.length ? Math.round(median(usable.map((item) => item.price))) : null,
    changePct: changes.length ? Number(median(changes).toFixed(3)) : null,
    unit: comparisonQuotes.find((item) => item.unit)?.unit || defaultUnits[asset] || "TOMAN",
    currency: comparisonQuotes.find((item) => item.currency)?.currency || "TOMAN",
    sleeveId,
    quoteType: quoteTypes.size > 1 ? "mixed" : quoteTypes.has("derived") ? "derived" : "direct",
    derivedFrom: [...new Set(usable.flatMap((item) => item.derivedFrom || []))],
    dependencies: conversionDependencies,
    status,
    confidence,
    sourceCount: usable.length,
    spreadPct: Number(spreadPct.toFixed(3)),
    acceptedSpreadPct: Number(acceptedSpreadPct.toFixed(3)),
    spreadWarningPct,
    consensusMethod: "median_mad",
    consensusDisagreement,
    unknownObservationCount,
    consensusPolicyVersion: CONSENSUS_POLICY.version,
    consensusCalibrated: CONSENSUS_POLICY.calibrated,
    agreementTolerancePct: hasAgreementTolerance ? agreementTolerancePct : null,
    consensusProvisional: provisional,
    sources: usable.map((item) => item.source),
    sourceValues: valid.map((item) => ({
      source: item.source,
      price: Math.round(item.price),
      quoteType: item.quoteType,
      observedAt: item.observedAt || item.sourceTime || null,
      accepted: accepted.includes(item),
      exclusionReason: accepted.includes(item)
        ? null
        : timedQuotes.length && !comparisonQuotes.includes(item)
          ? "older-observation"
          : "statistical-outlier",
    })),
    observedAt: sourceTimes.at(-1) || null,
    retrievedAt: new Date().toISOString(),
    asOf: sourceTimes.at(-1) || null,
  };
}

export function parseMarketSourceOptions(urlLike) {
  const url = urlLike instanceof URL ? urlLike : new URL(String(urlLike || "https://invest-consult.local/api/market"));
  return {
    sync: url.searchParams.get("sync") === "1",
    layer: url.searchParams.get("layer") || "crawler",
  };
}

export function marketResponseCacheKey(selected) {
  return SERVER_MARKET_CACHE_PREFIX + [...selected].sort().join(",");
}

export function isFreshServerMarketCache(cached, now = Date.now(), maxAgeMs = SERVER_MARKET_CACHE_MAX_AGE_MS) {
  if (!cached || !Number.isFinite(Number(cached.fetchedAt)) || !cached.quotes) return false;
  const age = now - Number(cached.fetchedAt);
  return age >= 0 && age <= maxAgeMs;
}

function serverQuotesFromSnapshot(snapshot, cacheAgeMs) {
  return Object.entries(snapshot?.assets || {}).flatMap(([asset, item]) => {
    const values =
      Array.isArray(item?.sourceValues) && item.sourceValues.length
        ? item.sourceValues.filter(
            (value) =>
              value.accepted !== false &&
              value.sourceLayer !== "server-cache" &&
              !String(value.source || "").startsWith("Server cache"),
          )
        : [
            {
              source: item?.sources?.[0] || "server-cache",
              price: item?.price,
              observedAt: item?.observedAt,
              quoteType: item?.quoteType,
            },
          ];
    return values
      .filter((value) => Number.isFinite(Number(value?.price)) && Number(value.price) > 0)
      .map((value) => ({
        asset,
        price: Number(value.price),
        source: "Server cache · " + (value.source || "market"),
        sourceTime: value.observedAt || null,
        observedAt: value.observedAt || null,
        retrievedAt: snapshot.updatedAt || null,
        quoteType: value.quoteType === "derived" ? "derived" : "direct",
        sourceLayer: "server-cache",
        cacheAgeMs,
      }));
  });
}

export function parseRequestedAssets(urlLike) {
  const url = urlLike instanceof URL ? urlLike : new URL(String(urlLike || "https://invest-consult.local/api/market"));
  if (!url.searchParams.has("assets")) return null;
  const allowed = new Set([...Object.keys(INSTRUMENT_REGISTRY), "fixedIncome"]);
  return new Set(
    url.searchParams
      .get("assets")
      .split(",")
      .map((asset) => asset.trim())
      .filter((asset) => allowed.has(asset)),
  );
}

function conversionDependency(dollarQuote, instrumentId = "dollar") {
  return {
    instrumentId,
    status: dollarQuote?.status || "unavailable",
    confidence: dollarQuote?.confidence || "none",
    sourceCount: Number(dollarQuote?.sourceCount) || 0,
    source: Array.isArray(dollarQuote?.sources) ? dollarQuote.sources.join(", ") : "",
    observedAt: dollarQuote?.observedAt || null,
    retrievedAt: dollarQuote?.retrievedAt || null,
  };
}

function convertGlobalQuote(item, dollarQuote, tetherQuote) {
  const conversion = item?.currency === "USD" ? dollarQuote : item?.currency === "USDT" ? tetherQuote : null;
  const dependencyId = item?.currency === "USDT" ? "tether" : "dollar";
  if (!Number.isFinite(Number(conversion?.price)) || Number(conversion.price) <= 0) return null;
  return {
    ...item,
    price: item.price * conversion.price,
    currency: "TOMAN",
    quoteType: "derived",
    derivedFrom: [`${item.asset}/${item.currency}`, `${item.currency}/TOMAN`],
    conversionDependencies: [conversionDependency(conversion, dependencyId)],
  };
}

function parseAnnualReturn(value) {
  const text = String(value || "");
  const patterns = [
    /(?:\u0628\u0627\u0632\u062f\u0647(?:\u06cc)?\s*\u0645\u0624\u062b\u0631\s*\u0633\u0627\u0644\u0627\u0646\u0647|\u0633\u0648\u062f\s*\u0645\u0624\u062b\u0631\s*\u0633\u0627\u0644\u0627\u0646\u0647)[^\u06f0-\u06f9\u0660-\u0669\d]{0,80}([\u06f0-\u06f9\u0660-\u0669\d]+(?:[.,\u066b][\u06f0-\u06f9\u0660-\u0669\d]+)?)\s*(?:\u062f\u0631\u0635\u062f|%|\u066a)/g,
    /([\u06f0-\u06f9\u0660-\u0669\d]+(?:[.,\u066b][\u06f0-\u06f9\u0660-\u0669\d]+)?)\s*(?:\u062f\u0631\u0635\u062f|%|\u066a)[^]{0,20}(?:\u0628\u0627\u0632\u062f\u0647(?:\u06cc)?\s*\u0645\u0624\u062b\u0631\s*\u0633\u0627\u0644\u0627\u0646\u0647|\u0633\u0648\u062f\s*\u0645\u0624\u062b\u0631\s*\u0633\u0627\u0644\u0627\u0646\u0647)/g,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return parseNumber(match[1]);
  }
  return null;
}

async function getFixedIncomeMetric() {
  const url = fundPages.fixedIncome;
  const html = await fetchText(url);
  const effectiveAnnualReturn = parseAnnualReturn(html);
  if (!Number.isFinite(effectiveAnnualReturn)) throw new Error("Annual return not found");
  return {
    effectiveAnnualReturn,
    sourceCount: 1,
    sources: ["Official provider page"],
    sourceUrl: url,
    observedAt: null,
    retrievedAt: new Date().toISOString(),
  };
}

export async function onRequestGet(context = {}) {
  const quota = await consumeRouteQuota(context, "market", { allowPublicWhenUnconfigured: true });
  if (quota.error) return quota.error;
  const startedAt = Date.now();
  const now = new Date().toISOString();
  const requestUrl = context.request?.url || "https://invest-consult.local/api/market";
  const sourceOptions = parseMarketSourceOptions(requestUrl);
  const selected = parseRequestedAssets(requestUrl) || new Set(DEFAULT_MARKET_ASSETS);
  const cacheKey = marketResponseCacheKey(selected);
  const cachedServerResponse =
    sourceOptions.sync && hasDurableSessionSecurity(context.env)
      ? await readPlatformProviderCache(context.env, cacheKey)
      : null;
  const serverCacheAgeMs = cachedServerResponse ? Date.now() - cachedServerResponse.fetchedAt : Infinity;
  const serverSnapshot = isFreshServerMarketCache(cachedServerResponse, Date.now())
    ? cachedServerResponse.quotes
    : null;
  const serverCacheQuotes = serverSnapshot ? serverQuotesFromSnapshot(serverSnapshot, serverCacheAgeMs) : [];
  const selectedKey = selectedProviderKey(context.request, context.env);
  const selectedCoinMarketCap = selectedCoinMarketCapKey(context.request, context.env);
  const providerKey =
    !hasDurableSessionSecurity(context.env) && !selectedKey.userSupplied ? { ...selectedKey, key: "" } : selectedKey;
  const derivedAssets = new Set(["gold", "silver", "bitcoin", "ethereum", "tether", "platinum", "palladium", "copper"]);
  const needsConversion = [...selected].some((asset) => derivedAssets.has(asset));
  const baseAssets = new Set([...selected].filter((asset) => sourcePages[asset]));
  if (needsConversion) baseAssets.add("dollar");

  const primaryDefinitions = [
    {
      id: "providerA",
      run: () => providerA([...baseAssets]),
      assetIds: [...baseAssets],
      providerKey: `providerA-${[...baseAssets].sort().join("-")}`,
      quotaProvider: "providerA",
      enabled: baseAssets.size > 0,
      localOnly: true,
    },
    {
      id: "providerB",
      run: providerB,
      assetIds: [...baseAssets].filter((asset) => ["dollar", "gold"].includes(asset)),
      providerKey: "providerB",
      quotaProvider: "providerB",
      enabled: baseAssets.has("dollar") || baseAssets.has("gold"),
      localOnly: true,
    },
  ].filter((provider) => provider.enabled);
  const wantsAny = (...assets) => assets.some((asset) => selected.has(asset));
  const extendedDefinitions = [
    {
      id: "coinGecko",
      run: () => providerCrypto([...selected], providerKey.key, providerKey.userSupplied, context.env),
      coordinated: false,
      assetIds: [...selected].filter((asset) => ["bitcoin", "ethereum", "tether"].includes(asset)),
      enabled:
        Boolean(providerKey.key) &&
        (providerKey.userSupplied || hasDurableSessionSecurity(context.env)) &&
        wantsAny("bitcoin", "ethereum", "tether"),
    },
    {
      id: "coinMarketCap",
      run: () =>
        providerCoinMarketCap(
          [...selected],
          context.env,
          selectedCoinMarketCap.key,
          selectedCoinMarketCap.userSupplied,
        ),
      coordinated: false,
      assetIds: [...selected].filter((asset) => ["bitcoin", "ethereum", "tether"].includes(asset)),
      enabled: wantsAny("bitcoin", "ethereum", "tether"),
    },
    {
      id: "nobitex",
      run: () => providerNobitex([...selected]),
      assetIds: [...selected].filter((asset) => ["bitcoin", "ethereum", "tether"].includes(asset)),
      enabled: wantsAny("bitcoin", "ethereum", "tether"),
      localOnly: true,
    },
    {
      id: "binance",
      run: () => providerCryptoBinance([...selected]),
      assetIds: [...selected].filter((asset) => ["bitcoin", "ethereum"].includes(asset)),
      enabled: wantsAny("bitcoin", "ethereum"),
      localOnly: true,
    },
    {
      id: "metalsLive",
      run: providerGlobalMetals,
      assetIds: [...selected].filter((asset) => ["silver", "platinum", "palladium", "copper"].includes(asset)),
      enabled: wantsAny("silver", "platinum", "palladium", "copper"),
      localOnly: true,
    },
    {
      id: "goldApi",
      run: () => providerGoldApi([...selected]),
      assetIds: [...selected].filter((asset) => ["gold", "silver", "platinum", "palladium"].includes(asset)),
      enabled: wantsAny("gold", "silver", "platinum", "palladium"),
      localOnly: true,
    },
    {
      id: "yahooMetals",
      run: () => providerYahooMetals([...selected]),
      assetIds: [...selected].filter((asset) => ["platinum", "palladium", "copper"].includes(asset)),
      enabled: context.env?.YAHOO_METALS_LICENSE_CONFIRMED === "true" && wantsAny("platinum", "palladium", "copper"),
      localOnly: true,
    },
    {
      id: "tsetmc",
      run: providerTsetmc,
      assetIds: selected.has("bourseIndex") ? ["bourseIndex"] : [],
      enabled: selected.has("bourseIndex"),
      localOnly: true,
    },
    {
      id: "tgjuIndex",
      run: providerTgjuIndex,
      assetIds: selected.has("bourseIndex") ? ["bourseIndex"] : [],
      enabled: selected.has("bourseIndex"),
      localOnly: true,
    },
  ].filter((provider) => provider.enabled);
  const activeDefinitions = [...primaryDefinitions, ...extendedDefinitions];
  const providerRuns = activeDefinitions.map(async (provider) => {
    const result = await provider.run();
    return {
      id: provider.id,
      quotes: Array.isArray(result) ? result : result.quotes || [],
      history: Array.isArray(result) ? {} : result.history || {},
      cacheStatus: Array.isArray(result) ? null : result.cacheStatus || null,
    };
  });
  const fixedIncomeRequest = selected.has("fixedIncome") ? getFixedIncomeMetric() : null;
  const [settledProviders, fixedIncomeSettled] = await Promise.all([
    Promise.allSettled(providerRuns),
    fixedIncomeRequest ? Promise.allSettled([fixedIncomeRequest]) : Promise.resolve([]),
  ]);
  const fixedIncomeOutcome = fixedIncomeSettled[0] || { status: "skipped" };
  const cachedFixedIncome = serverSnapshot?.funds?.fixedIncome || null;
  const fixedIncome =
    fixedIncomeOutcome.status === "fulfilled"
      ? { ...fixedIncomeOutcome.value, status: "available", cacheStatus: "refreshed" }
      : cachedFixedIncome
        ? { ...cachedFixedIncome, status: "cached", cacheStatus: "cached" }
        : null;
  const providerResults = new Map();
  settledProviders.forEach((result, index) => {
    providerResults.set(activeDefinitions[index].id, result);
  });
  const tgjuIndexOutcome = providerResults.get("tgjuIndex") || { status: "skipped" };
  const primaryQuotes = ["providerA", "providerB"].flatMap((id) => {
    const result = providerResults.get(id);
    return result?.status === "fulfilled" ? result.value.quotes : [];
  });
  const fallbackAssets = [...baseAssets].filter(
    (asset) => ["dollar", "gold"].includes(asset) && aggregate(asset, primaryQuotes)?.status !== "healthy",
  );
  let fallbackResult = { status: "skipped", quoteCount: 0 };
  if (fallbackAssets.length) {
    try {
      const fallback = await providerC(600, fallbackAssets);
      const fallbackQuotes = fallback.filter((item) => fallbackAssets.includes(item.asset));
      primaryQuotes.push(...fallbackQuotes);
      fallbackResult = { status: "fulfilled", quoteCount: fallbackQuotes.length };
    } catch {
      fallbackResult = { status: "rejected", quoteCount: 0 };
    }
  }

  const preliminaryDollar = aggregate("dollar", primaryQuotes);
  const rawGlobalQuotes = ["coinGecko", "coinMarketCap", "binance", "metalsLive", "goldApi", "yahooMetals"].flatMap(
    (id) => {
      const result = providerResults.get(id);
      return result?.status === "fulfilled" ? result.value.quotes : [];
    },
  );
  const directLocalQuotes = ["nobitex"].flatMap((id) => {
    const result = providerResults.get(id);
    return result?.status === "fulfilled" ? result.value.quotes : [];
  });
  const preliminaryTether = aggregate("tether", directLocalQuotes);
  const convertedGlobalQuotes = rawGlobalQuotes.map((item) =>
    convertGlobalQuote(item, preliminaryDollar, preliminaryTether),
  );
  const excludedCurrencyQuotes = rawGlobalQuotes.filter((item, index) => !convertedGlobalQuotes[index]);
  const currencyBlockedAssets = new Set(excludedCurrencyQuotes.map((item) => item.asset));
  const globalQuotes = convertedGlobalQuotes.filter(Boolean);
  const referenceQuotes = ["tsetmc", "tgjuIndex"].flatMap((id) => {
    const result = providerResults.get(id);
    return result?.status === "fulfilled" ? result.value.quotes : [];
  });
  const quotes = [...primaryQuotes, ...directLocalQuotes, ...globalQuotes, ...referenceQuotes, ...serverCacheQuotes];
  const auxiliaryAssets = ["gold", "silver"].filter((asset) => {
    if (!selected.has(asset)) return false;
    const status = aggregate(asset, quotes)?.status;
    return status !== "healthy" && status !== "provisional";
  });
  let auxiliaryResult = { status: "skipped", quoteCount: 0 };
  const auxiliary = auxiliaryAssets.length ? await getAuxiliaryMetalData().catch(() => null) : null;
  const auxiliaryRawQuotes = [];
  if (auxiliaryAssets.length) {
    if (auxiliary && auxiliaryAssets.includes("gold") && isPositiveNumber(auxiliary.goldUsdPerGram)) {
      auxiliaryRawQuotes.push({
        asset: "gold",
        price: auxiliary.goldUsdPerGram,
        source: "Auxiliary metal source",
        currency: "USD",
      });
    }
    if (auxiliary && auxiliaryAssets.includes("silver") && isPositiveNumber(auxiliary.silverUsdPerGram)) {
      auxiliaryRawQuotes.push({
        asset: "silver",
        price: auxiliary.silverUsdPerGram,
        source: "Auxiliary metal source",
        currency: "USD",
      });
    }
    auxiliaryResult = { status: auxiliary ? "fulfilled" : "rejected", quoteCount: auxiliaryRawQuotes.length };
  }
  if (auxiliary && !preliminaryDollar?.price) {
    auxiliaryRawQuotes.forEach((item) => currencyBlockedAssets.add(item.asset));
  }
  if (auxiliary && preliminaryDollar?.price) {
    if (selected.has("gold") && auxiliaryAssets.includes("gold") && isPositiveNumber(auxiliary.goldUsdPerGram)) {
      const item = quote("gold", auxiliary.goldUsdPerGram * preliminaryDollar.price * 0.75, "Auxiliary metal source", {
        sourceUrl: CHART_GOLD_URL,
        sourceTime: auxiliary.sourceTime,
        quoteType: "derived",
        derivedFrom: ["XAU/USD", "USD/TOMAN"],
        conversionDependencies: [conversionDependency(preliminaryDollar)],
      });
      if (item) quotes.push(item);
    }
    if (selected.has("silver") && auxiliaryAssets.includes("silver") && isPositiveNumber(auxiliary.silverUsdPerGram)) {
      const item = quote("silver", auxiliary.silverUsdPerGram * preliminaryDollar.price, "Auxiliary metal source", {
        sourceUrl: CHART_GOLD_URL,
        sourceTime: auxiliary.sourceTime,
        quoteType: "derived",
        derivedFrom: ["XAG/USD", "USD/TOMAN"],
        conversionDependencies: [conversionDependency(preliminaryDollar)],
      });
      if (item) quotes.push(item);
    }
  }

  const assets = {};
  selected.forEach((asset) => {
    const aggregated = aggregate(asset, quotes);
    if (aggregated) assets[asset] = aggregated;
  });
  const providerDiagnostics = {};
  [...providers, ...extendedDefinitions].forEach((provider) => {
    const settled = providerResults.get(provider.id);
    if (!settled) {
      providerDiagnostics[provider.id] = { status: "skipped", quoteCount: 0 };
      return;
    }
    providerDiagnostics[provider.id] = {
      status: settled.status,
      quoteCount: settled.status === "fulfilled" ? settled.value.quotes.length : 0,
    };
    if (settled.status === "rejected")
      providerDiagnostics[provider.id].failureCode = safeProviderFailureCode(settled.reason);
    if (settled.status === "fulfilled" && settled.value.cacheStatus)
      providerDiagnostics[provider.id].cacheStatus = settled.value.cacheStatus;
  });
  providerDiagnostics.providerC = fallbackResult;
  if (fallbackResult.status === "rejected") providerDiagnostics.providerC.failureCode = "request_failed";
  providerDiagnostics.tgjuIndex = {
    status: tgjuIndexOutcome.status,
    quoteCount: tgjuIndexOutcome.status === "fulfilled" ? tgjuIndexOutcome.value.quotes.length : 0,
    ...(tgjuIndexOutcome.status === "rejected" ? { failureCode: "request_failed" } : {}),
  };
  providerDiagnostics.auxiliary = auxiliaryResult;
  if (auxiliaryResult.status === "rejected") providerDiagnostics.auxiliary.failureCode = "request_failed";
  providerDiagnostics.fixedIncome = {
    status: fixedIncomeOutcome.status,
    quoteCount: fixedIncome ? 1 : 0,
    ...(fixedIncome?.cacheStatus ? { cacheStatus: fixedIncome.cacheStatus } : {}),
  };
  providerDiagnostics.serverSync = {
    status: serverSnapshot ? "fresh" : sourceOptions.sync ? "unavailable" : "not-requested",
    quoteCount: serverCacheQuotes.length,
    maxAgeMs: SERVER_MARKET_CACHE_MAX_AGE_MS,
    ageMs: Number.isFinite(serverCacheAgeMs) ? Math.max(0, serverCacheAgeMs) : null,
  };

  const attemptedProviders = new Map([...selected].map((asset) => [asset, new Set()]));
  activeDefinitions.forEach((provider) => {
    (provider.assetIds || []).forEach((asset) => attemptedProviders.get(asset)?.add(provider.id));
  });
  fallbackAssets.forEach((asset) => attemptedProviders.get(asset)?.add("providerC"));
  if (tgjuIndexOutcome.status !== "skipped") attemptedProviders.get("bourseIndex")?.add("tgjuIndex");
  auxiliaryAssets.forEach((asset) => attemptedProviders.get(asset)?.add("auxiliary"));
  selected.forEach((asset) => {
    if (assets[asset]) assets[asset].configuredSourceCount = attemptedProviders.get(asset)?.size || 0;
  });

  const history = {};
  const tgjuHistory =
    providerResults.get("providerA")?.status === "fulfilled" ? providerResults.get("providerA").value.history : {};
  ["dollar", "gold", "silver"].forEach((asset) => {
    const series = tgjuHistory[asset] || [];
    if (selected.has(asset) && series.length)
      history[asset] = series.map((point) => ({
        date: point.date,
        price: Math.round(point.value),
        source: "TGJU",
      }));
  });
  const tgjuIndexHistory =
    providerResults.get("tgjuIndex")?.status === "fulfilled"
      ? providerResults.get("tgjuIndex").value.history?.bourseIndex || []
      : [];
  if (selected.has("bourseIndex") && tgjuIndexHistory.length) {
    history.bourseIndex = tgjuIndexHistory.map((point) => ({
      date: point.date,
      price: Math.round(point.value),
      source: "TGJU",
    }));
  }
  const funds = fixedIncome ? { fixedIncome } : {};
  const diagnostics = {
    consensusPolicyVersion: CONSENSUS_POLICY.version,
    consensusCalibrated: CONSENSUS_POLICY.calibrated,
    interactiveBudgetMs: INTERACTIVE_BUDGET_MS,
    responseTimeMs: Date.now() - startedAt,
    providers: providerDiagnostics,
    assets: Object.fromEntries(
      [...selected]
        .filter((asset) => asset !== "fixedIncome")
        .map((asset) => [
          asset,
          {
            attempted: attemptedProviders.get(asset)?.size || 0,
            successful: assets[asset]?.sourceCount || 0,
            attemptedProviders: [...(attemptedProviders.get(asset) || [])],
            excludedForCurrency: [
              ...excludedCurrencyQuotes,
              ...(!preliminaryDollar?.price ? auxiliaryRawQuotes : []),
            ].filter((item) => item.asset === asset).length,
            status: assets[asset]?.status || "unavailable",
            reason:
              !assets[asset] && currencyBlockedAssets.has(asset)
                ? preliminaryDollar?.status === "conflicted"
                  ? "currency_conflicted"
                  : "currency_unavailable"
                : null,
          },
        ]),
    ),
    funds: selected.has("fixedIncome")
      ? {
          fixedIncome: {
            attempted: 1,
            successful: fixedIncome ? 1 : 0,
            status: fixedIncome ? "available" : "unavailable",
          },
        }
      : {},
  };

  const responseBody = {
    updatedAt: now,
    assets,
    funds,
    history,
    catalog: { sleeves: SLEEVE_REGISTRY, instruments: INSTRUMENT_REGISTRY },
    diagnostics,
    sources: {
      providers: [
        { id: "providerA", name: "TGJU", url: "https://www.tgju.org/" },
        { id: "providerB", name: "Bonbast", url: BONBAST_BASE + "/" },
        { id: "providerC", name: "Navasan public mirror", url: "https://github.com/HosseinOdd/Navasan-API" },
        { id: "auxiliary", name: "ChartGoldPrice", url: "https://www.chartgoldprice.com/gold-price-api" },
        { id: "coinGecko", name: "CoinGecko", url: COINGECKO_SIMPLE_URL },
        { id: "coinMarketCap", name: "CoinMarketCap", url: COINMARKETCAP_PUBLIC_URL },
        { id: "nobitex", name: "Nobitex public market stats", url: NOBITEX_STATS_URL },
        { id: "binance", name: "Binance public ticker", url: BINANCE_TICKER_URL },
        { id: "goldApi", name: "Gold API", url: GOLD_API_PRICE_BASE },
        { id: "metalsLive", name: "Metals.live", url: METALS_LIVE_URL },
        { id: "yahooMetals", name: "Yahoo Finance futures chart", url: YAHOO_METAL_CHART_BASE },
        { id: "tsetmc", name: "TSETMC", url: TSETMC_INDEX_URL },
        { id: "tgjuIndex", name: "TGJU Tehran general index", url: TGJU_BASE + "gc30" },
      ],
      fixedIncome: "https://charisma.ir/",
      history: "https://www.tgju.org/",
    },
    note: "قیمت‌های داخلی به تومان نرمال‌سازی می‌شوند. قیمت‌های مشتق‌شده با منبع تبدیل مشخص هستند؛ قیمت متعارض برای ارزش‌گذاری استفاده نمی‌شود. دارایی‌های شاخصی بورس به‌عنوان مرجع نمایش داده می‌شوند و قیمت آینده پیش‌بینی نمی‌شود.",
    serverDataFresh: Boolean(serverSnapshot),
    serverCacheAgeMs: Number.isFinite(serverCacheAgeMs) ? Math.max(0, serverCacheAgeMs) : null,
    dataLayers: {
      crawler: true,
      userApiKey: Boolean(selectedKey.userSupplied || selectedCoinMarketCap.userSupplied),
      serverSync: Boolean(serverSnapshot),
    },
  };
  if (
    sourceOptions.sync &&
    !selectedKey.userSupplied &&
    !selectedCoinMarketCap.userSupplied &&
    hasDurableSessionSecurity(context.env)
  )
    await writePlatformProviderCache(context.env, cacheKey, responseBody, Date.now());
  return new Response(JSON.stringify(responseBody), {
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "private, no-store",
    },
  });
}
