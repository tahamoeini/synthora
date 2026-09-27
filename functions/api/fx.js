import {
  consumeRouteQuota,
  deferPlatformProviderRequest,
  readPlatformProviderCache,
  reservePlatformProviderRequest,
  securityJson,
  writePlatformProviderCache,
  waitForPlatformProviderCache,
} from "./_security.js";

const FRANKFURTER_URL = "https://api.frankfurter.dev/v2/rates?base=USD&quotes=CNY&providers=cfets";
const CBR_CURRENCIES_URL = "https://www.cbr.ru/scripts/XML_daily_eng.asp";
const CBR_METALS_URL = "https://www.cbr.ru/scripts/xml_metall.asp";
const CACHE_AGE_MS = 24 * 60 * 60_000;
const MAX_STALE_MS = 10 * 24 * 60 * 60_000;
const providerFlights = new Map();

function numberFromXml(value) {
  const normalized = String(value || "")
    .replace(/[\s\u00a0]/g, "")
    .replace(/,(?=\d{1,4}$)/, ".")
    .replace(/,/g, "");
  const result = Number(normalized);
  return Number.isFinite(result) && result > 0 ? result : null;
}

function dateFromCbr(value) {
  const match = String(value || "").match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  return match ? `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}` : null;
}

function retryAfterSeconds(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(24 * 60 * 60, Math.ceil(seconds));
  const date = Date.parse(value || "");
  return Number.isFinite(date) ? Math.max(1, Math.min(24 * 60 * 60, Math.ceil((date - Date.now()) / 1000))) : null;
}

async function fetchText(url, cfCacheTtl = 60 * 60) {
  const response = await fetch(url, {
    headers: { Accept: "application/json, application/xml, text/xml;q=0.9" },
    cf: { cacheEverything: true, cacheTtl: cfCacheTtl },
  });
  if (!response.ok) {
    const error = new Error(`Reference source returned ${response.status}`);
    error.status = response.status;
    error.retryAfterSeconds = retryAfterSeconds(response.headers.get("retry-after"));
    throw error;
  }
  return await response.text();
}

function parseUsdRub(xml) {
  const blocks = xml.match(/<Valute\b[^>]*>[\s\S]*?<\/Valute>/gi) || [];
  const usd = blocks.find((block) => /<CharCode>\s*USD\s*<\/CharCode>/i.test(block));
  if (!usd) return null;
  const pick = (tag) => usd.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1]?.trim();
  const nominal = numberFromXml(pick("Nominal"));
  const value = numberFromXml(pick("Value"));
  const rootDate = xml.match(/<ValCurs\b[^>]*\bDate="([^"]+)"/i)?.[1];
  return nominal && value ? { rate: value / nominal, date: dateFromCbr(rootDate) } : null;
}

function parseCnyUsd(payload) {
  const rows = Array.isArray(payload) ? payload : [];
  const row = rows.find((item) => String(item?.quote || "").toUpperCase() === "CNY" && numberFromXml(item?.rate));
  return row ? { rate: Number(row.rate), date: row.date || null } : null;
}

function parseCbrMetals(xml) {
  const names = { 1: "gold", 2: "silver", 3: "platinum", 4: "palladium" };
  const records = [...xml.matchAll(/<Record\b([^>]*)>([\s\S]*?)<\/Record>/gi)];
  const values = {};
  records.forEach((match) => {
    const code = match[1].match(/\bCode="([^"]+)"/i)?.[1];
    const asset = names[code];
    if (!asset) return;
    const body = match[2];
    const date = dateFromCbr(match[1].match(/\bDate="([^"]+)"/i)?.[1]);
    const read = (tag) => numberFromXml(body.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1]);
    const reference = read("Sell") ?? read("Value") ?? read("Buy");
    if (!reference || !date) return;
    if (!values[asset] || date > values[asset].date)
      values[asset] = {
        asset,
        referenceRubPerGram: reference,
        buyRubPerGram: read("Buy"),
        sellRubPerGram: read("Sell"),
        date,
      };
  });
  return Object.values(values);
}

async function loadSharedReference(env, provider, fetchPayload) {
  if (typeof env?.API_USAGE_DB?.prepare !== "function")
    return { payload: await fetchPayload(), fetchedAt: Date.now(), status: "available" };
  const cached = await readPlatformProviderCache(env, provider);
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;
  if (cached && age >= 0 && age < CACHE_AGE_MS)
    return { payload: cached.quotes, fetchedAt: cached.fetchedAt, status: "available" };
  const stale = () =>
    cached && age >= 0 && age <= MAX_STALE_MS
      ? { payload: cached.quotes, fetchedAt: cached.fetchedAt, status: "stale" }
      : null;
  if (providerFlights.has(provider)) return providerFlights.get(provider);
  const operation = (async () => {
    const reserved = await reservePlatformProviderRequest(env, provider, {
      monthlyLimit: 8000,
      minimumIntervalSeconds: 60,
    });
    if (!reserved) {
      const latest = await waitForPlatformProviderCache(env, provider, cached?.fetchedAt || 0);
      const latestAge = latest ? Date.now() - latest.fetchedAt : Infinity;
      if (latest && latestAge >= 0 && latestAge < CACHE_AGE_MS)
        return { payload: latest.quotes, fetchedAt: latest.fetchedAt, status: "available" };
      if (latest && latestAge >= 0 && latestAge <= MAX_STALE_MS)
        return { payload: latest.quotes, fetchedAt: latest.fetchedAt, status: "stale" };
      return stale() || { payload: null, fetchedAt: null, status: "unavailable" };
    }
    try {
      const payload = await fetchPayload();
      await writePlatformProviderCache(env, provider, payload);
      return { payload, fetchedAt: Date.now(), status: "available" };
    } catch (error) {
      if (Number(error?.status) === 429 && error.retryAfterSeconds)
        await deferPlatformProviderRequest(env, provider, error.retryAfterSeconds);
      return stale() || { payload: null, fetchedAt: null, status: "unavailable" };
    }
  })();
  providerFlights.set(provider, operation);
  try {
    return await operation;
  } finally {
    if (providerFlights.get(provider) === operation) providerFlights.delete(provider);
  }
}

function validRequestedQuotes(requestUrl) {
  const url = new URL(requestUrl);
  const requested = (url.searchParams.get("quotes") || "USD,RUB,CNY")
    .split(",")
    .map((code) => code.trim().toUpperCase())
    .filter((code) => ["USD", "RUB", "CNY"].includes(code));
  return [...new Set(requested)];
}

function fxQuote({ rate, quotePerUsd, source, provider, observedAt, retrievedAt, derivedFrom, status, reason = null }) {
  return {
    provider: provider || null,
    rate: Number.isFinite(rate) && rate > 0 ? rate : null,
    quotePerUsd: Number.isFinite(quotePerUsd) && quotePerUsd > 0 ? quotePerUsd : null,
    source,
    observedAt: observedAt || null,
    retrievedAt: retrievedAt || null,
    derivedFrom,
    status,
    reason,
  };
}

export async function onRequestGet(context = {}) {
  const quota = await consumeRouteQuota(context, "fx", { allowPublicWhenUnconfigured: true });
  if (quota.error) return quota.error;
  const requestUrl = context.request?.url || "https://synthora.local/api/fx";
  const requested = validRequestedQuotes(requestUrl);
  const url = new URL(requestUrl);
  // The endpoint cannot authenticate a market price supplied in the query string.
  // The browser combines these public cross rates with its accepted market quote.
  const now = new Date().toISOString();
  const shouldLoadCbr = requested.includes("RUB") || url.searchParams.get("include") === "metals";
  const [frankfurter, cbr, metals] = await Promise.all([
    requested.includes("CNY")
      ? loadSharedReference(context.env, "frankfurter-cfets", async () => {
          const payload = JSON.parse(await fetchText(FRANKFURTER_URL));
          const rate = parseCnyUsd(payload);
          if (!rate) throw new Error("CNY reference not found");
          return rate;
        })
      : Promise.resolve({ payload: null, status: "unavailable" }),
    shouldLoadCbr
      ? loadSharedReference(context.env, "cbr-daily-rates", async () => {
          const rate = parseUsdRub(await fetchText(CBR_CURRENCIES_URL));
          if (!rate) throw new Error("USD reference not found");
          return rate;
        })
      : Promise.resolve({ payload: null, status: "unavailable" }),
    url.searchParams.get("include") === "metals"
      ? loadSharedReference(context.env, "cbr-daily-metals", async () => {
          const today = new Date();
          const start = new Date(today.getTime() - 14 * 24 * 60 * 60_000);
          const dateText = (date) =>
            `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
          const metalUrl = `${CBR_METALS_URL}?date_req1=${encodeURIComponent(dateText(start))}&date_req2=${encodeURIComponent(dateText(today))}`;
          const references = parseCbrMetals(await fetchText(metalUrl));
          if (!references.length) throw new Error("Precious metal references not found");
          return references;
        })
      : Promise.resolve({ payload: null, status: "unavailable" }),
  ]);
  const quotes = {};
  if (requested.includes("USD"))
    quotes.USD = fxQuote({
      rate: null,
      quotePerUsd: 1,
      source: "Iran market quote required for Toman conversion",
      provider: "synthora-iran-dollar",
      observedAt: null,
      retrievedAt: null,
      derivedFrom: [],
      status: "unavailable",
      reason: "usd-toman-reference-unavailable",
    });
  if (requested.includes("RUB")) {
    const rublesPerUsd = Number(cbr.payload?.rate);
    const sourceAge = cbr.payload?.date ? Date.now() - Date.parse(`${cbr.payload.date}T00:00:00Z`) : Infinity;
    const status =
      cbr.status === "unavailable" ? "unavailable" : sourceAge > 3 * 24 * 60 * 60_000 ? "stale" : cbr.status;
    quotes.RUB = fxQuote({
      rate: null,
      quotePerUsd: rublesPerUsd,
      source: "Bank of Russia daily reference rate",
      provider: "cbr-rates",
      observedAt: cbr.payload?.date,
      retrievedAt: cbr.fetchedAt ? new Date(cbr.fetchedAt).toISOString() : null,
      derivedFrom: ["CBR USD/RUB"],
      status: !rublesPerUsd ? "unavailable" : status,
      reason: !rublesPerUsd ? "provider-unavailable" : "usd-toman-reference-unavailable",
    });
  }
  if (requested.includes("CNY")) {
    const yuanPerUsd = Number(frankfurter.payload?.rate);
    const sourceAge = frankfurter.payload?.date
      ? Date.now() - Date.parse(`${frankfurter.payload.date}T00:00:00Z`)
      : Infinity;
    const status =
      frankfurter.status === "unavailable"
        ? "unavailable"
        : sourceAge > 3 * 24 * 60 * 60_000
          ? "stale"
          : frankfurter.status;
    quotes.CNY = fxQuote({
      rate: null,
      quotePerUsd: yuanPerUsd,
      source: "CFETS reference rate via Frankfurter",
      provider: "frankfurter-cfets",
      observedAt: frankfurter.payload?.date,
      retrievedAt: frankfurter.fetchedAt ? new Date(frankfurter.fetchedAt).toISOString() : null,
      derivedFrom: ["Frankfurter CFETS USD/CNY"],
      status: !yuanPerUsd ? "unavailable" : status,
      reason: !yuanPerUsd ? "provider-unavailable" : "usd-toman-reference-unavailable",
    });
  }
  const metalObservedAt = Array.isArray(metals.payload)
    ? metals.payload
        .map((item) => item.date)
        .sort()
        .at(-1) || null
    : null;
  const metalAge = metalObservedAt ? Date.now() - Date.parse(metalObservedAt + "T00:00:00Z") : Infinity;
  const metalStatus =
    metals.status === "unavailable" ? "unavailable" : metalAge > 3 * 24 * 60 * 60_000 ? "stale" : metals.status;
  const preciousMetals =
    url.searchParams.get("include") === "metals"
      ? {
          source: "Bank of Russia daily precious-metal reference prices",
          provider: "cbr-metals",
          sourceUrl: CBR_METALS_URL,
          currency: "RUB",
          unit: "gram",
          status: metalStatus,
          observedAt: metalObservedAt,
          retrievedAt: metals.fetchedAt ? new Date(metals.fetchedAt).toISOString() : null,
          references: Array.isArray(metals.payload) ? metals.payload : [],
          note: "Daily reference values in RUB per gram; not Iranian retail prices.",
        }
      : undefined;
  return securityJson({
    base: "TOMAN",
    quotes,
    ...(preciousMetals ? { preciousMetals } : {}),
    updatedAt: now,
  });
}
