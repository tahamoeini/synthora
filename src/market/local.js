import { INSTRUMENT_REGISTRY } from "./catalog.js";
import { filterHistoryRange, normalizeObservedHistory } from "./history.js";

export const SERVER_MARKET_MAX_AGE_MS = 5 * 60 * 1000;
const LOCAL_SOURCE_TIMEOUT_MS = 3500;
const TGJU_BASE = "https://www.tgju.org/profile/";
const BONBAST_BASE = "https://www.bonbast.com";
const NAVASAN_RAW_BASE = "https://raw.githubusercontent.com/HosseinOdd/Navasan-API/main/data/";
const COINGECKO_SIMPLE_URL = "https://api.coingecko.com/api/v3/simple/price";
const BINANCE_TICKER_URL = "https://api.binance.com/api/v3/ticker/24hr";
const METALS_LIVE_URL = "https://api.metals.live/v1/spot";
const CHART_GOLD_URL = "https://www.chartgoldprice.com/api/data?history=both";
const TSETMC_INDEX_URL = "https://cdn.tsetmc.com/api/Index/GetIndexB1LastDay";
const TROY_OUNCE_TO_GRAMS = 31.1034768;
const COPPER_POUND_TO_GRAMS = 453.59237;
const TGJU_PAGES = {
  dollar: "price_dollar_rl",
  gold: "geram18",
  silver: "silver_999",
  bourseIndex: "gc30",
};
const DEFAULT_ASSETS = Object.freeze([
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

function normalizeDigits(value) {
  return String(value || "")
    .replace(/[\\u06f0-\\u06f9]/g, (digit) =>
      String("\\u06f0\\u06f1\\u06f2\\u06f3\\u06f4\\u06f5\\u06f6\\u06f7\\u06f8\\u06f9".indexOf(digit)),
    )
    .replace(/[\\u0660-\\u0669]/g, (digit) =>
      String("\\u0660\\u0661\\u0662\\u0663\\u0664\\u0665\\u0666\\u0667\\u0668\\u0669".indexOf(digit)),
    );
}

function parseNumber(value) {
  const normalized = normalizeDigits(value)
    .replace(/[\\u066c\\u060c,\\s]/g, "")
    .replace(/%/g, "")
    .replace(/\\u066a/g, "")
    .replace(/\\u066b/g, ".");
  const match = normalized.match(/[-+]?\\d+(?:\\.\\d+)?/);
  return match ? Number(match[0]) : null;
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" || (typeof value === "string" && /^\\d{10,13}$/.test(value.trim()));
  const date = numeric
    ? new Date(Math.abs(Number(value)) < 1e12 ? Number(value) * 1000 : Number(value))
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstNumberAfter(html, marker, windowSize = 800) {
  const start = String(html || "").indexOf(marker);
  if (start < 0) return null;
  const sample = String(html)
    .slice(start + marker.length, start + windowSize)
    .replace(/^>\\s*/, "")
    .replace(/<[^>]*>/g, " ")
    .trim();
  const token = sample.split(/\\s+/)[0] || "";
  const match = token.match(/[-+]?[0-9\\u06f0-\\u06f9\\u0660-\\u0669]+(?:[.,\\u066b][0-9\\u06f0-\\u06f9\\u0660-\\u0669]+)*/);
  return match ? parseNumber(match[0]) : null;
}

function quote(asset, price, source, metadata = {}) {
  if (!Number.isFinite(Number(price)) || Number(price) <= 0) return null;
  const observedAt = normalizeTimestamp(metadata.observedAt ?? metadata.sourceTime);
  return {
    ...metadata,
    asset,
    price: Number(price),
    source,
    observedAt,
    sourceTime: observedAt,
    retrievedAt: new Date().toISOString(),
    quoteType: metadata.quoteType === "derived" ? "derived" : "direct",
    derivedFrom: Array.isArray(metadata.derivedFrom) ? metadata.derivedFrom : [],
    sourceLayer: "local",
  };
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

function extractTgjuChartData(html) {
  const markerIndex = String(html || "").indexOf('ChartBlock-3").msHighcharts({');
  if (markerIndex < 0) return [];
  const dataIndex = String(html).indexOf("chartData:", markerIndex);
  if (dataIndex < 0) return [];
  const arrayStart = String(html).indexOf("[", dataIndex);
  const raw = arrayStart >= 0 ? readBalancedArray(String(html), arrayStart) : null;
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function normalizeTgjuHistory(value, asset) {
  const divisor = asset === "bourseIndex" ? 1 : 10;
  return normalizeObservedHistory(value, "TGJU").map((point) => ({
    ...point,
    value: point.value / divisor,
    source: "TGJU",
    currency: asset === "bourseIndex" ? "INDEX" : "TOMAN",
  }));
}

function isPositive(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

async function fetchContent(fetchImpl, url, options = {}, read = (response) => response.text()) {
  if (typeof fetchImpl !== "function") throw new Error("local-fetch-unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || LOCAL_SOURCE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      cache: "no-store",
      credentials: "omit",
      ...options,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("source-" + response.status);
    return await read(response);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(fetchImpl, url, options = {}) {
  return fetchContent(fetchImpl, url, options);
}

async function fetchJson(fetchImpl, url, options = {}) {
  return fetchContent(fetchImpl, url, options, (response) => response.json());
}

async function providerTgju(fetchImpl, requested) {
  const pages = Object.entries(TGJU_PAGES).filter(([asset]) => requested.has(asset));
  const settled = await Promise.allSettled(
    pages.map(async ([asset, page]) => {
      const url = TGJU_BASE + page;
      const html = await fetchText(fetchImpl, url);
      const rawPrice = firstNumberAfter(html, 'data-col="info.last_trade.PDrCotVal"', 500);
      const serverTime = html.match(/id="server-time"[^>]+data-value="([^"]+)"/);
      return {
        asset,
        item: quote(asset, asset === "bourseIndex" ? rawPrice : rawPrice === null ? null : rawPrice / 10, "TGJU", {
          sourceUrl: url,
          sourceTime: serverTime ? serverTime[1] : null,
          unit: asset === "bourseIndex" ? "point" : asset === "dollar" ? "TOMAN/USD" : "gram",
          currency: asset === "bourseIndex" ? "INDEX" : "TOMAN",
          changePct: firstNumberAfter(html, 'data-col="info.last_trade.last_change_percentage"', 300),
        }),
        history: normalizeTgjuHistory(extractTgjuChartData(html), asset),
      };
    }),
  );
  const fulfilled = settled.filter((result) => result.status === "fulfilled").map((result) => result.value);
  return {
    quotes: fulfilled.map((result) => result.item).filter(Boolean),
    history: Object.fromEntries(fulfilled.map((result) => [result.asset, result.history])),
  };
}

async function providerBonbast(fetchImpl, requested) {
  if (![...requested].some((asset) => ["dollar", "gold"].includes(asset))) return [];
  const landing = await fetchText(fetchImpl, BONBAST_BASE + "/", { timeoutMs: 2200 });
  const tokenMatch = landing.match(/\\$\\.post\\(['"]\\/json['"],\\s*\\{param:\\s*"([^"]+)"/);
  if (!tokenMatch) throw new Error("bonbast-token-unavailable");
  const data = await fetchJson(fetchImpl, BONBAST_BASE + "/json", {
    method: "POST",
    timeoutMs: 2200,
    headers: { "content-type": "application/x-www-form-urlencoded", "x-requested-with": "XMLHttpRequest" },
    body: "param=" + encodeURIComponent(tokenMatch[1]),
  });
  return [
    requested.has("dollar") ? quote("dollar", parseNumber(data?.usd1), "Bonbast", { sourceUrl: BONBAST_BASE + "/", currency: "TOMAN" }) : null,
    requested.has("gold") ? quote("gold", parseNumber(data?.gol18), "Bonbast", { sourceUrl: BONBAST_BASE + "/", currency: "TOMAN", unit: "gram" }) : null,
  ].filter(Boolean);
}

async function providerNavasan(fetchImpl, requested) {
  const [fiat, gold] = await Promise.all([
    requested.has("dollar") ? fetchJson(fetchImpl, NAVASAN_RAW_BASE + "fiat.json") : Promise.resolve(null),
    requested.has("gold") ? fetchJson(fetchImpl, NAVASAN_RAW_BASE + "gold.json") : Promise.resolve(null),
  ]);
  const dollar = fiat?.usd;
  const gold18 = gold?.["18ayar"];
  return [
    requested.has("dollar")
      ? quote("dollar", parseNumber(dollar?.value), "Navasan", {
          sourceUrl: NAVASAN_RAW_BASE + "fiat.json",
          sourceTime: Number.isFinite(Number(dollar?.date)) ? Number(dollar.date) : null,
          currency: "TOMAN",
          unit: "TOMAN/USD",
          changePct: parseNumber(dollar?.change_pct),
        })
      : null,
    requested.has("gold")
      ? quote("gold", parseNumber(gold18?.value), "Navasan", {
          sourceUrl: NAVASAN_RAW_BASE + "gold.json",
          sourceTime: Number.isFinite(Number(gold18?.date)) ? Number(gold18.date) : null,
          currency: "TOMAN",
          unit: "gram",
          changePct: parseNumber(gold18?.change_pct),
        })
      : null,
  ].filter(Boolean);
}

async function providerCoinGecko(fetchImpl, requested) {
  const ids = ["bitcoin", "ethereum", "tether"].filter((asset) => requested.has(asset));
  if (!ids.length) return [];
  const url =
    COINGECKO_SIMPLE_URL +
    "?ids=" +
    encodeURIComponent(ids.join(",")) +
    "&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true";
  const data = await fetchJson(fetchImpl, url);
  return ids
    .map((asset) => {
      const item = data?.[asset];
      return item
        ? quote(asset, parseNumber(item.usd), "CoinGecko", {
            sourceUrl: url,
            sourceTime: item.last_updated_at ? Number(item.last_updated_at) : null,
            currency: "USD",
            unit: "coin",
            changePct: parseNumber(item.usd_24h_change ?? item.usd_24hr_change),
          })
        : null;
    })
    .filter(Boolean);
}

async function providerBinance(fetchImpl, requested) {
  const symbols = [
    ["BTCUSDT", "bitcoin"],
    ["ETHUSDT", "ethereum"],
  ].filter(([, asset]) => requested.has(asset));
  if (!symbols.length) return [];
  const url = BINANCE_TICKER_URL + "?symbols=" + encodeURIComponent(JSON.stringify(symbols.map(([symbol]) => symbol)));
  const data = await fetchJson(fetchImpl, url);
  return (Array.isArray(data) ? data : [])
    .map((item) => {
      const asset = symbols.find(([symbol]) => symbol === item?.symbol)?.[1];
      return asset
        ? quote(asset, parseNumber(item.lastPrice), "Binance", {
            sourceUrl: url,
            sourceTime: Number(item.closeTime) || null,
            currency: "USDT",
            unit: "coin",
            changePct: parseNumber(item.priceChangePercent),
          })
        : null;
    })
    .filter(Boolean);
}

async function providerMetalsLive(fetchImpl, requested) {
  const selected = ["gold", "silver", "platinum", "palladium", "copper"].filter((asset) => requested.has(asset));
  if (!selected.length) return [];
  const data = await fetchJson(fetchImpl, METALS_LIVE_URL);
  const row = Array.isArray(data) ? data.at(-1) : data;
  const metadata = {
    gold: { factor: 0.75, divisor: TROY_OUNCE_TO_GRAMS },
    silver: { factor: 1, divisor: TROY_OUNCE_TO_GRAMS },
    platinum: { factor: 1, divisor: TROY_OUNCE_TO_GRAMS },
    palladium: { factor: 1, divisor: TROY_OUNCE_TO_GRAMS },
    copper: { factor: 1, divisor: COPPER_POUND_TO_GRAMS },
  };
  return selected
    .map((asset) => {
      const value = parseNumber(row?.[asset]);
      const meta = metadata[asset];
      return quote(asset, isPositive(value) ? (value * meta.factor) / meta.divisor : null, "Metals.live", {
        sourceUrl: METALS_LIVE_URL,
        currency: "USD",
        unit: "gram",
      });
    })
    .filter(Boolean);
}

async function providerChartGold(fetchImpl, requested) {
  if (![...requested].some((asset) => ["gold", "silver"].includes(asset))) return { quotes: [], history: {} };
  const data = await fetchJson(fetchImpl, CHART_GOLD_URL, { timeoutMs: 2200 });
  const prices = data?.prices || {};
  const history = data?.history || {};
  const values = [
    requested.has("gold")
      ? quote("gold", parseNumber(prices?.gold?.gram) * 0.75, "ChartGoldPrice", {
          sourceUrl: CHART_GOLD_URL,
          sourceTime: data?.meta?.updated_at || null,
          currency: "USD",
          unit: "gram",
        })
      : null,
    requested.has("silver")
      ? quote("silver", parseNumber(prices?.silver?.gram), "ChartGoldPrice", {
          sourceUrl: CHART_GOLD_URL,
          sourceTime: data?.meta?.updated_at || null,
          currency: "USD",
          unit: "gram",
        })
      : null,
  ].filter(Boolean);
  const points = {};
  for (const asset of ["gold", "silver"]) {
    const raw = history?.[asset] || history?.series?.[asset] || [];
    const normalized = normalizeObservedHistory(raw, "ChartGoldPrice").map((point) => ({
      ...point,
      value: point.value * (asset === "gold" ? 0.75 : 1),
      source: "ChartGoldPrice",
      currency: "USD",
    }));
    if (normalized.length) points[asset] = normalized;
  }
  return { quotes: values, history: points };
}

async function providerTsetmc(fetchImpl, requested) {
  if (!requested.has("bourseIndex")) return [];
  const data = await fetchJson(fetchImpl, TSETMC_INDEX_URL);
  const current = [data?.xNivIn, data?.indexValue, data?.currentValue, data?.lastValue, data?.value]
    .map(parseNumber)
    .find(isPositive);
  const previous = [data?.xNivInPre, data?.previousValue, data?.yesterdayValue, data?.prevValue]
    .map(parseNumber)
    .find(isPositive);
  return [
    quote("bourseIndex", current, "TSETMC", {
      sourceUrl: TSETMC_INDEX_URL,
      currency: "INDEX",
      unit: "point",
      changePct: isPositive(previous) ? ((current / previous) - 1) * 100 : null,
    }),
  ].filter(Boolean);
}

function parseAnnualReturn(value) {
  const text = String(value || "");
  const match =
    text.match(/(?:بازده(?:ی)?\\s*موثر\\s*سالانه|سود\\s*موثر\\s*سالانه)[^۰-۹\\d]{0,80}([۰-۹\\d]+(?:[.,٪]\\d+)?)\\s*(?:درصد|%|٪)/) ||
    text.match(/([۰-۹\\d]+(?:[.,٪]\\d+)?)\\s*(?:درصد|%|٪)[^]{0,20}(?:بازده(?:ی)?\\s*موثر\\s*سالانه|سود\\s*موثر\\s*سالانه)/);
  return match ? parseNumber(match[1]) : null;
}

async function providerFixedIncome(fetchImpl, requested) {
  if (!requested.has("fixedIncome")) return null;
  const url = "https://charisma.ir/funds/fixedincomefund";
  const html = await fetchText(fetchImpl, url);
  const effectiveAnnualReturn = parseAnnualReturn(html);
  if (!Number.isFinite(effectiveAnnualReturn)) throw new Error("fixed-income-rate-unavailable");
  return {
    effectiveAnnualReturn,
    sourceCount: 1,
    sources: ["Charisma"],
    sourceUrl: url,
    observedAt: null,
    retrievedAt: new Date().toISOString(),
    sourceLayer: "local",
  };
}

const THRESHOLDS = Object.freeze({
  dollar: 0.25,
  gold: 0.75,
  silver: 1,
  bitcoin: 2,
  ethereum: 2,
  tether: 1,
  platinum: 2,
  palladium: 2,
  copper: 2,
  bourseIndex: 0.5,
});

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function buildAggregate(asset, quotes) {
  const valid = quotes.filter((item) => item?.asset === asset && isPositive(item.price));
  if (!valid.length) return null;
  const prices = valid.map((item) => Number(item.price));
  const price = median(prices);
  const minimum = Math.min(...prices);
  const maximum = Math.max(...prices);
  const spreadPct = price > 0 ? ((maximum - minimum) / price) * 100 : 0;
  const disagreement = valid.length >= 2 && spreadPct > (THRESHOLDS[asset] ?? 1);
  const status = disagreement ? "conflicted" : valid.length >= 2 ? "healthy" : "degraded";
  const confidence = disagreement ? "low" : valid.length >= 3 ? "high" : valid.length >= 2 ? "medium" : "low";
  const times = valid
    .map((item) => item.observedAt || item.sourceTime)
    .filter(Boolean)
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime());
  return {
    price: Math.round(price),
    changePct: median(valid.map((item) => Number(item.changePct)).filter(Number.isFinite)),
    unit: valid.find((item) => item.unit)?.unit || (asset === "dollar" ? "TOMAN" : asset === "bourseIndex" ? "point" : "gram"),
    currency: asset === "bourseIndex" ? "INDEX" : "TOMAN",
    quoteType: valid.some((item) => item.quoteType === "derived") ? "derived" : "direct",
    derivedFrom: [...new Set(valid.flatMap((item) => item.derivedFrom || []))],
    status,
    confidence,
    sourceCount: valid.length,
    configuredSourceCount: Math.max(valid.length, asset === "dollar" || asset === "gold" ? 3 : 2),
    spreadPct: Number(spreadPct.toFixed(3)),
    consensusDisagreement: disagreement,
    consensusMethod: "local-median",
    consensusPolicyVersion: "local-crawler-v1",
    sources: valid.map((item) => item.source),
    sourceValues: valid.map((item) => ({
      source: item.source,
      price: Math.round(item.price),
      quoteType: item.quoteType,
      observedAt: item.observedAt || item.sourceTime || null,
      accepted: true,
      sourceLayer: item.sourceLayer || "local",
    })),
    observedAt: times.at(-1) || null,
    retrievedAt: valid
      .map((item) => item.retrievedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || new Date().toISOString(),
    asOf: times.at(-1) || null,
    sourceLayer: "local",
  };
}

function convertQuote(item, dollarPrice) {
  if (!item || !isPositive(item.price)) return null;
  if (item.currency === "USDT") return null;
  if (item.currency !== "USD") return item;
  if (!isPositive(dollarPrice)) return null;
  const factor = Number.isFinite(Number(item.conversionFactor)) ? Number(item.conversionFactor) : 1;
  return {
    ...item,
    price: item.price * dollarPrice * factor,
    currency: "TOMAN",
    quoteType: "derived",
    derivedFrom: [item.asset + "/USD", "USD/TOMAN"],
    conversionDependencies: [{ instrumentId: "dollar", sourceLayer: "local" }],
  };
}

function providerDefinitions(requested) {
  const wants = (...assets) => assets.some((asset) => requested.has(asset));
  return [
    { id: "tgju-local", run: (fetchImpl) => providerTgju(fetchImpl, requested), enabled: wants("dollar", "gold", "silver", "bourseIndex") },
    { id: "bonbast-local", run: (fetchImpl) => providerBonbast(fetchImpl, requested), enabled: wants("dollar", "gold") },
    { id: "navasan-local", run: (fetchImpl) => providerNavasan(fetchImpl, requested), enabled: wants("dollar", "gold") },
    { id: "coingecko-local", run: (fetchImpl) => providerCoinGecko(fetchImpl, requested), enabled: wants("bitcoin", "ethereum", "tether") },
    { id: "binance-local", run: (fetchImpl) => providerBinance(fetchImpl, requested), enabled: wants("bitcoin", "ethereum") },
    { id: "metals-live-local", run: (fetchImpl) => providerMetalsLive(fetchImpl, requested), enabled: wants("gold", "silver", "platinum", "palladium", "copper") },
    { id: "chart-gold-local", run: (fetchImpl) => providerChartGold(fetchImpl, requested), enabled: wants("gold", "silver") },
    { id: "tsetmc-local", run: (fetchImpl) => providerTsetmc(fetchImpl, requested), enabled: wants("bourseIndex") },
    { id: "fixed-income-local", run: (fetchImpl) => providerFixedIncome(fetchImpl, requested), enabled: wants("fixedIncome") },
  ].filter((provider) => provider.enabled);
}

export async function loadLocalMarketData({ assets = DEFAULT_ASSETS, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const allowed = new Set([...Object.keys(INSTRUMENT_REGISTRY), "fixedIncome"]);
  const requested = new Set((Array.isArray(assets) ? assets : DEFAULT_ASSETS).filter((asset) => allowed.has(asset)));
  const definitions = providerDefinitions(requested);
  const settled = await Promise.allSettled(definitions.map((provider) => provider.run(fetchImpl)));
  const rawQuotes = [];
  const history = {};
  const funds = {};
  const providers = {};
  settled.forEach((result, index) => {
    const definition = definitions[index];
    providers[definition.id] = {
      status: result.status,
      quoteCount: 0,
      sourceLayer: "local",
    };
    if (result.status !== "fulfilled") return;
    const value = result.value;
    const quotes = Array.isArray(value) ? value : value?.quotes || [];
    rawQuotes.push(...quotes);
    if (value?.history && typeof value.history === "object") Object.assign(history, value.history);
    if (value?.effectiveAnnualReturn !== undefined) funds.fixedIncome = value;
    providers[definition.id].quoteCount = quotes.length;
  });

  const rawDollar = buildAggregate("dollar", rawQuotes);
  const convertedQuotes = rawQuotes.map((item) => {
    if (item.currency === "USD") {
      const factor = item.asset === "gold" && item.source === "ChartGoldPrice" ? 0.75 : item.conversionFactor;
      return convertQuote({ ...item, conversionFactor: factor }, rawDollar?.price);
    }
    return item;
  }).filter(Boolean);
  const assetsOutput = {};
  requested.forEach((asset) => {
    if (asset === "fixedIncome") return;
    const aggregate = buildAggregate(asset, convertedQuotes);
    if (aggregate) assetsOutput[asset] = aggregate;
  });
  const filteredHistory = Object.fromEntries(
    Object.entries(history)
      .filter(([asset]) => requested.has(asset))
      .map(([asset, points]) => [asset, normalizeObservedHistory(points, "local-crawler")]),
  );
  return {
    layer: "local",
    dataOrigin: "browser-crawler",
    updatedAt: new Date(now).toISOString(),
    assets: assetsOutput,
    funds,
    history: filteredHistory,
    diagnostics: {
      layer: "local",
      sourceMode: "browser-crawler",
      providers,
      assets: Object.fromEntries(
        [...requested]
          .filter((asset) => asset !== "fixedIncome")
          .map((asset) => [asset, { status: assetsOutput[asset]?.status || "unavailable", successful: assetsOutput[asset]?.sourceCount || 0 }]),
      ),
    },
    sources: {
      providers: definitions.map((provider) => ({ id: provider.id, name: provider.id.replace(/-local$/, ""), layer: "local" })),
    },
  };
}

export async function loadLocalHistory({ assets, range = "all", start, end, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const requested = new Set(Array.isArray(assets) ? assets : DEFAULT_ASSETS);
  const result = await providerTgju(fetchImpl, requested).catch(() => ({ history: {} }));
  const output = {};
  Object.entries(result.history || {}).forEach(([asset, points]) => {
    const filtered = filterHistoryRange(normalizeObservedHistory(points, "TGJU"), range, now, { start, end });
    output[asset] = {
      unit: asset === "bourseIndex" ? "point" : asset === "dollar" ? "TOMAN/USD" : "TOMAN",
      priceUnit: asset === "bourseIndex" ? "index point" : asset === "dollar" ? "TOMAN/USD" : "TOMAN/" + (INSTRUMENT_REGISTRY[asset]?.unit || "unit"),
      currency: asset === "bourseIndex" ? "INDEX" : "TOMAN",
      sourceUrl: TGJU_BASE + (TGJU_PAGES[asset] || ""),
      points: filtered.map((point) => ({ date: point.date, price: point.value, source: "TGJU" })),
      coverage: {
        status: filtered.length >= 2 ? "available" : filtered.length ? "insufficient-history" : "unavailable",
        range,
        observationCount: filtered.length,
        firstObservedAt: filtered[0]?.date || null,
        lastObservedAt: filtered.at(-1)?.date || null,
        source: "TGJU",
        reason: filtered.length >= 2 ? null : "local-history-unavailable",
      },
    };
  });
  return {
    layer: "local",
    dataOrigin: "browser-crawler",
    updatedAt: new Date(now).toISOString(),
    assets: output,
    sources: { providers: [{ id: "tgju-local", name: "TGJU", layer: "local" }] },
  };
}

function snapshotQuotes(snapshot) {
  const entries = [];
  Object.entries(snapshot?.assets || {}).forEach(([asset, item]) => {
    const values = Array.isArray(item?.sourceValues) && item.sourceValues.length
      ? item.sourceValues.filter((value) => value.accepted !== false)
      : [{ source: item?.sources?.[0] || snapshot.layer || "market", price: item?.price, observedAt: item?.observedAt, quoteType: item?.quoteType }];
    values.forEach((value) => {
      if (!isPositive(value?.price)) return;
      entries.push({
        asset,
        price: Number(value.price),
        source: value.source || "market",
        sourceLayer: value.sourceLayer || snapshot.layer || "server",
        observedAt: value.observedAt || null,
        quoteType: value.quoteType === "derived" ? "derived" : "direct",
        retrievedAt: item?.retrievedAt || snapshot.updatedAt || null,
      });
    });
  });
  return entries;
}

function mergeAggregate(asset, quotes) {
  return buildAggregate(asset, quotes);
}

export function isFreshMarketSnapshot(snapshot, now = Date.now(), maxAgeMs = SERVER_MARKET_MAX_AGE_MS) {
  if (!snapshot || snapshot.serverDataFresh === false) return false;
  const cacheAge = Number(snapshot.serverCacheAgeMs);
  if (Number.isFinite(cacheAge)) return cacheAge >= 0 && cacheAge <= maxAgeMs;
  const updatedAt = Date.parse(snapshot.updatedAt || "");
  return Number.isFinite(updatedAt) && now - updatedAt >= 0 && now - updatedAt <= maxAgeMs;
}

export function mergeMarketSnapshots(primary, ...additional) {
  const snapshots = [primary, ...additional].filter((snapshot) => snapshot && typeof snapshot === "object");
  const quoteMap = new Map();
  snapshots.forEach((snapshot) => {
    snapshotQuotes(snapshot).forEach((item) => {
      const key = [item.asset, item.source, item.sourceLayer, item.observedAt || ""].join("|");
      if (!quoteMap.has(key)) quoteMap.set(key, item);
    });
  });
  const mergedQuotes = [...quoteMap.values()];
  const assets = {};
  const assetIds = new Set(snapshots.flatMap((snapshot) => Object.keys(snapshot.assets || {})));
  assetIds.forEach((asset) => {
    const aggregate = mergeAggregate(asset, mergedQuotes.filter((item) => item.asset === asset));
    if (aggregate) {
      aggregate.sourceLayer = snapshots.length > 1 ? "merged" : snapshots[0].layer || "local";
      assets[asset] = aggregate;
    }
  });
  const funds = {};
  snapshots.forEach((snapshot) => {
    if (snapshot.funds?.fixedIncome && !funds.fixedIncome) funds.fixedIncome = snapshot.funds.fixedIncome;
  });
  return {
    ...(primary || {}),
    layer: snapshots.length > 1 ? "merged" : primary?.layer || "local",
    dataOrigin: snapshots.length > 1 ? "local-plus-optional" : primary?.dataOrigin || "browser-crawler",
    updatedAt: new Date().toISOString(),
    assets,
    funds,
    diagnostics: {
      ...(primary?.diagnostics || {}),
      layers: snapshots.map((snapshot) => ({
        layer: snapshot.layer || "unknown",
        dataOrigin: snapshot.dataOrigin || null,
        updatedAt: snapshot.updatedAt || null,
        serverDataFresh: snapshot.serverDataFresh,
      })),
    },
    sources: {
      providers: snapshots.flatMap((snapshot) => snapshot.sources?.providers || []),
    },
  };
}

export function mergeHistorySnapshots(primary, ...additional) {
  const snapshots = [primary, ...additional].filter((snapshot) => snapshot && typeof snapshot === "object");
  const assets = {};
  const assetIds = new Set(snapshots.flatMap((snapshot) => Object.keys(snapshot.assets || {})));
  assetIds.forEach((asset) => {
    const byDay = new Map();
    snapshots.forEach((snapshot) => {
      const item = snapshot.assets?.[asset];
      (item?.points || []).forEach((point) => {
        const day = String(point.date || "").slice(0, 10);
        if (day && !byDay.has(day)) byDay.set(day, point);
      });
    });
    const points = [...byDay.values()].sort((left, right) => String(left.date).localeCompare(String(right.date)));
    const template = snapshots.map((snapshot) => snapshot.assets?.[asset]).find(Boolean) || {};
    assets[asset] = {
      ...template,
      points,
      coverage: {
        ...(template.coverage || {}),
        status: points.length >= 2 ? "available" : points.length ? "insufficient-history" : "unavailable",
        observationCount: points.length,
        firstObservedAt: points[0]?.date || null,
        lastObservedAt: points.at(-1)?.date || null,
        reason: points.length >= 2 ? null : template.coverage?.reason || "history-unavailable",
      },
    };
  });
  return {
    ...(primary || {}),
    layer: snapshots.length > 1 ? "merged" : primary?.layer || "local",
    updatedAt: new Date().toISOString(),
    assets,
    sources: { providers: snapshots.flatMap((snapshot) => snapshot.sources?.providers || []) },
  };
}
