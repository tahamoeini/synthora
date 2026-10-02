import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregate,
  extractTgjuChartData,
  normalizeMetalHistory,
  normalizeTgjuHistory,
  onRequestGet,
  parseMarketSourceOptions,
  parseRequestedAssets,
  marketResponseCacheKey,
  isFreshServerMarketCache,
} from "../functions/api/market.js";
import { createSecureApiContext } from "./helpers/api-context.js";

async function marketRequest(url, env = {}, headers = {}) {
  return onRequestGet(await createSecureApiContext(url, env, headers));
}

test("server market cache is opt-in and limited to five minutes", () => {
  const selected = new Set(["gold", "dollar"]);
  assert.equal(parseMarketSourceOptions("https://app.test/api/market?assets=gold,dollar").sync, false);
  assert.equal(parseMarketSourceOptions("https://app.test/api/market?assets=gold,dollar&sync=1").sync, true);
  assert.equal(marketResponseCacheKey(selected), "market-response-v1:dollar,gold");

  const now = Date.now();
  assert.equal(isFreshServerMarketCache({ fetchedAt: now - (5 * 60 * 1000 - 1), quotes: {} }, now), true);
  assert.equal(isFreshServerMarketCache({ fetchedAt: now - (5 * 60 * 1000 + 1), quotes: {} }, now), false);
  assert.equal(isFreshServerMarketCache({ fetchedAt: now + 1, quotes: {} }, now), false);
});

test("metal history converts troy-ounce closes to grams", () => {
  const [gold] = normalizeMetalHistory([{ date: "2026-09-18", close: 4379.74 }]);
  assert.ok(Math.abs(gold.value - 140.81) < 0.01);
});

test("metal history accepts object-shaped source points", () => {
  const [silver] = normalizeMetalHistory({ "2026-09-18": 66.921 });
  assert.ok(Math.abs(silver.value - 2.1516) < 0.001);
});

test("TGJU chart history parses balanced arrays and converts rial to toman", () => {
  const html = `$("#ChartBlock-3").msHighcharts({ chartData: [[1700000000000, 233630000],[1700086400000, 234000000]], tooltipTitle: 'قیمت', chartType: "area" });`;
  assert.deepEqual(extractTgjuChartData(html), [
    [1700000000000, 233630000],
    [1700086400000, 234000000],
  ]);
  assert.deepEqual(normalizeTgjuHistory(extractTgjuChartData(html)), [
    { date: 1700000000000, value: 23363000 },
    { date: 1700086400000, value: 23400000 },
  ]);
});

test("TGJU history does not use a synthetic FX conversion", () => {
  const [gold] = normalizeTgjuHistory([[1700000000000, 233630000]]);
  assert.equal(gold.value, 23363000);
});

test("market aggregation returns a midpoint with a disagreement warning when two sources differ", () => {
  const result = aggregate("dollar", [
    { asset: "dollar", price: 100, source: "A", changePct: null, sourceTime: "2026-01-02T00:00:00.000Z" },
    { asset: "dollar", price: 110, source: "B", changePct: undefined, sourceTime: "2026-01-02T00:00:00.000Z" },
  ]);
  assert.equal(result.price, 105);
  assert.equal(result.status, "degraded");
  assert.equal(result.sourceCount, 2);
  assert.equal(result.consensusDisagreement, true);
  assert.equal(result.confidence, "low");
  assert.equal(result.changePct, null);
  assert.equal(result.asOf, "2026-01-02T00:00:00.000Z");
});

test("a single quote remains visible with degraded confidence", () => {
  const result = aggregate("dollar", [{ asset: "dollar", price: 100, source: "A" }]);
  assert.equal(result.price, 100);
  assert.equal(result.status, "degraded");
  assert.equal(result.confidence, "low");
});

test("selected market assets are allow-listed", () => {
  const selected = parseRequestedAssets("https://example.test/api/market?assets=bitcoin,unknown,gold");
  assert.deepEqual([...selected].sort(), ["bitcoin", "gold"]);
  assert.equal(parseRequestedAssets("https://example.test/api/market"), null);
});

test("selected crypto requests fetch only that instrument and preserve partial data when a provider fails", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    requestedUrls.push(url);
    if (url.hostname === "www.tgju.org") {
      return new Response('<td data-col="info.last_trade.PDrCotVal">500000</td>', { status: 200 });
    }
    if (url.hostname === "www.bonbast.com" && options.method !== "POST") {
      return new Response(`$.post('/json', {param: "token"});`, {
        status: 200,
        headers: { "set-cookie": "session=one" },
      });
    }
    if (url.hostname === "www.bonbast.com") {
      return new Response(JSON.stringify({ usd1: "50000", gol18: "40000000" }), { status: 200 });
    }
    if (url.hostname === "api.coingecko.com") {
      return new Response(JSON.stringify({ bitcoin: { usd: 60000, usd_24h_change: 1 } }), { status: 200 });
    }
    if (url.hostname === "api.binance.com") {
      return new Response("unavailable", { status: 503 });
    }
    if (url.hostname === "raw.githubusercontent.com") {
      return new Response(JSON.stringify({ usd: { value: "50000", date: 1780000000 } }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url.href}`);
  };
  try {
    const response = await marketRequest("https://app.test/api/market?assets=bitcoin", {
      COINGECKO_DEMO_API_KEY: "platform-test-key",
    });
    const data = await response.json();
    assert.deepEqual(Object.keys(data.assets), ["bitcoin"]);
    assert.equal(data.assets.bitcoin.price, 3000000000);
    assert.equal(data.assets.bitcoin.quoteType, "derived");
    assert.deepEqual(data.assets.bitcoin.derivedFrom, ["bitcoin/USD", "USD/TOMAN"]);
    assert.equal(data.assets.bitcoin.status, "degraded");
    assert.equal(data.assets.bitcoin.sourceCount, 1);
    assert.equal(data.assets.bitcoin.sleeveId, "crypto");
    assert.equal(data.assets.bitcoin.dependencies[0].instrumentId, "dollar");
    assert.equal(data.assets.bitcoin.dependencies[0].status, "degraded");
    assert.equal(data.assets.dollar, undefined);
    assert.equal(data.assets.bitcoin.observedAt, null);
    assert.ok(data.assets.bitcoin.retrievedAt);
    assert.ok(requestedUrls.some((url) => url.hostname === "www.tgju.org" && url.pathname.endsWith("price_dollar_rl")));
    const cryptoUrl = requestedUrls.find((url) => url.hostname === "api.coingecko.com");
    assert.equal(cryptoUrl.searchParams.get("ids"), "bitcoin");
    const exchangeUrl = requestedUrls.find((url) => url.hostname === "api.binance.com");
    assert.deepEqual(JSON.parse(exchangeUrl.searchParams.get("symbols")), ["BTCUSDT"]);
    assert.equal(data.diagnostics.providers.binance.status, "rejected");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public crypto quotes work without keys, a session database, or sync", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    requested.push(url);
    if (url.hostname === "www.tgju.org")
      return new Response('<td data-col="info.last_trade.PDrCotVal">500000</td>', { status: 200 });
    if (url.hostname === "www.bonbast.com") return new Response("token unavailable", { status: 200 });
    if (url.hostname === "raw.githubusercontent.com")
      return new Response(JSON.stringify({ usd: { value: "50000", date: Math.floor(Date.now() / 1000) } }), {
        status: 200,
      });
    if (url.hostname === "pro-api.coinmarketcap.com")
      return new Response(
        JSON.stringify({
          status: { error_code: "0" },
          data: [
            {
              id: 1,
              slug: "bitcoin",
              symbol: "BTC",
              quotes: [{ symbol: "USD", price: 60000, last_updated: new Date().toISOString() }],
            },
            {
              id: 825,
              slug: "tether",
              symbol: "USDT",
              quotes: [{ symbol: "USD", price: 1, last_updated: new Date().toISOString() }],
            },
          ],
        }),
        { status: 200 },
      );
    if (url.hostname === "api.nobitex.ir")
      return new Response(
        JSON.stringify({
          status: "ok",
          stats: {
            "btc-rls": { latest: "30000000000", dayChange: "1" },
            "usdt-rls": { latest: "500000", dayChange: "0.1" },
          },
        }),
        { status: 200 },
      );
    if (url.hostname === "api.binance.com")
      return new Response(
        JSON.stringify([{ symbol: "BTCUSDT", lastPrice: "60000", priceChangePercent: "1", closeTime: Date.now() }]),
        { status: 200 },
      );
    throw new Error(`Unexpected request: ${url.href}`);
  };
  try {
    const request = new Request("https://app.test/api/market?assets=bitcoin,tether", {
      headers: { origin: "https://app.test", "sec-fetch-site": "same-origin" },
    });
    const response = await onRequestGet({ request, env: {} });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.assets.bitcoin.price, 3000000000);
    assert.equal(data.assets.bitcoin.sourceCount, 3);
    assert.equal(data.assets.bitcoin.configuredSourceCount, 6);
    assert.deepEqual(new Set(data.assets.bitcoin.sources), new Set(["Binance", "CoinMarketCap", "Nobitex"]));
    assert.deepEqual(
      new Set(data.assets.bitcoin.derivedFrom),
      new Set(["bitcoin/USDT", "USDT/TOMAN", "bitcoin/USD", "USD/TOMAN"]),
    );
    assert.deepEqual(
      new Set(data.assets.bitcoin.dependencies.map((item) => item.instrumentId)),
      new Set(["dollar", "tether"]),
    );
    assert.equal(data.assets.tether.price, 50000);
    assert.ok(data.assets.tether.sourceCount >= 2);
    assert.equal(data.diagnostics.assets.bitcoin.attempted, 6);
    assert.deepEqual(
      new Set(data.diagnostics.assets.bitcoin.attemptedProviders),
      new Set(["coinMarketCap", "nobitex", "binance", "coinbase", "kraken", "goldApi"]),
    );
    assert.equal(data.diagnostics.providers.coinMarketCap.quoteCount, 2);
    assert.equal(data.diagnostics.providers.nobitex.quoteCount, 2);
    assert.equal(data.diagnostics.providers.binance.quoteCount, 1);
    assert.equal(
      requested.some(
        (url) => url.hostname === "pro-api.coinmarketcap.com" && url.searchParams.get("slug") === "bitcoin,tether",
      ),
      true,
    );
    assert.equal(
      requested.some((url) => url.hostname === "api.coingecko.com"),
      false,
    );
    assert.equal(
      requested.some((url) => url.hostname === "api.nobitex.ir" && url.searchParams.get("dstCurrency") === "rls"),
      true,
    );
    assert.equal(
      requested.some((url) => url.hostname === "api.nobitex.ir" && url.searchParams.has("srcCurrency")),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public Coinbase and Kraken quotes retain USD provenance and reconcile through observed local FX", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "www.tgju.org")
      return new Response('<td data-col="info.last_trade.PDrCotVal">500000</td>', { status: 200 });
    if (url.hostname === "www.bonbast.com") return new Response("token unavailable", { status: 200 });
    if (url.hostname === "raw.githubusercontent.com")
      return new Response(JSON.stringify({ usd: { value: "50000", date: Math.floor(Date.now() / 1000) } }), {
        status: 200,
      });
    if (url.hostname === "pro-api.coinmarketcap.com")
      return new Response(JSON.stringify({ data: [{ slug: "bitcoin", price: 60000 }] }), { status: 200 });
    if (url.hostname === "api.nobitex.ir")
      return new Response(
        JSON.stringify({
          status: "ok",
          stats: { "btc-rls": { latest: "30000000000" }, "usdt-rls": { latest: "500000" } },
        }),
        { status: 200 },
      );
    if (url.hostname === "api.binance.com")
      return new Response(JSON.stringify([{ symbol: "BTCUSDT", lastPrice: "60000", priceChangePercent: "0" }]), {
        status: 200,
      });
    if (url.hostname === "api.exchange.coinbase.com")
      return new Response(JSON.stringify({ price: "60000", time: new Date().toISOString() }), { status: 200 });
    if (url.hostname === "api.kraken.com")
      return new Response(
        JSON.stringify({
          error: [],
          result: {
            XXBTZUSD: { c: ["60000"], o: "59000" },
            USDTZUSD: { c: ["1"], o: "1" },
          },
        }),
        { status: 200 },
      );
    if (url.hostname === "api.gold-api.com")
      return new Response(
        JSON.stringify({ symbol: "BTC", currency: "USD", price: 60000, updatedAt: new Date().toISOString() }),
        { status: 200 },
      );
    throw new Error(`unexpected-provider:${url.href}:${options.method || "GET"}`);
  };
  try {
    const response = await marketRequest("https://app.test/api/market?assets=bitcoin,dollar,tether");
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.assets.bitcoin.price, 3_000_000_000);
    assert.ok(data.assets.bitcoin.sources.includes("Coinbase"));
    assert.ok(data.assets.bitcoin.sources.includes("Kraken"));
    assert.ok(data.assets.bitcoin.sources.includes("Gold API"));
    assert.ok(data.assets.bitcoin.derivedFrom.includes("USD/TOMAN"));
    assert.equal(data.assets.tether.price, 50_000);
    assert.ok(data.assets.tether.sources.includes("Kraken"));
    assert.equal(data.diagnostics.providers.coinbase.quoteCount, 1);
    assert.equal(data.diagnostics.providers.kraken.quoteCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a platform CoinMarketCap key is ignored without durable security and public quotes remain available", async () => {
  const originalFetch = globalThis.fetch;
  const cmcRequests = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "www.tgju.org")
      return new Response(
        `<td data-col="info.last_trade.PDrCotVal">500000</td><span id="server-time" data-value="${new Date().toISOString()}"></span>`,
        { status: 200 },
      );
    if (url.hostname === "www.bonbast.com") return new Response("token unavailable", { status: 200 });
    if (url.hostname === "raw.githubusercontent.com")
      return new Response(JSON.stringify({ usd: { value: "50000", date: Math.floor(Date.now() / 1000) } }), {
        status: 200,
      });
    if (url.hostname === "pro-api.coinmarketcap.com") {
      cmcRequests.push({ url, headers: options.headers || {} });
      return new Response(
        JSON.stringify({
          data: [
            {
              slug: "bitcoin",
              symbol: "BTC",
              quotes: [{ symbol: "USD", price: 60000, last_updated: new Date().toISOString() }],
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.hostname === "api.nobitex.ir" || url.hostname === "api.binance.com")
      return new Response("unavailable", { status: 503 });
    throw new Error(`Unexpected request: ${url.href}`);
  };
  try {
    const request = new Request("https://app.test/api/market?assets=bitcoin", {
      headers: { origin: "https://app.test", "sec-fetch-site": "same-origin" },
    });
    const response = await onRequestGet({ request, env: { COINMARKETCAP_API_KEY: "platform-secret" } });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.assets.bitcoin.price, 3_000_000_000);
    assert.equal(cmcRequests.length, 1);
    assert.equal(cmcRequests[0].url.pathname, "/public-api/v2/simple/price");
    assert.equal(cmcRequests[0].headers["X-CMC_PRO_API_KEY"], undefined);
    assert.equal(JSON.stringify(data).includes("platform-secret"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gold API adds timestamped platinum and palladium quotes while copper coverage stays honest", async () => {
  const originalFetch = globalThis.fetch;
  const apiRequests = [];
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "www.tgju.org")
      return new Response(
        `<td data-col="info.last_trade.PDrCotVal">500000</td><span id="server-time" data-value="${new Date().toISOString()}"></span>`,
        { status: 200 },
      );
    if (url.hostname === "www.bonbast.com") return new Response("token unavailable", { status: 200 });
    if (url.hostname === "raw.githubusercontent.com")
      return new Response(JSON.stringify({ usd: { value: "50000", date: Math.floor(Date.now() / 1000) } }), {
        status: 200,
      });
    if (url.hostname === "api.metals.live")
      return new Response(JSON.stringify([{ platinum: 3000, palladium: 1000, copper: 5 }]), { status: 200 });
    if (url.hostname === "api.gold-api.com") {
      const symbol = url.pathname.split("/").at(-1);
      apiRequests.push(symbol);
      const price = { XPT: 3000, XPD: 1000 }[symbol];
      return new Response(JSON.stringify({ symbol, currency: "USD", price, updatedAt: new Date().toISOString() }), {
        status: 200,
      });
    }
    throw new Error(`Unexpected request: ${url.href}`);
  };
  try {
    const response = await marketRequest("https://app.test/api/market?assets=platinum,palladium,copper");
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(new Set(apiRequests), new Set(["XPT", "XPD"]));
    assert.equal(data.assets.platinum.sourceCount, 2);
    assert.deepEqual(new Set(data.assets.platinum.sources), new Set(["Gold API", "Metals.live"]));
    assert.equal(data.assets.platinum.dependencies[0].instrumentId, "dollar");
    assert.equal(data.assets.palladium.sourceCount, 2);
    assert.equal(data.assets.copper.sourceCount, 1);
    assert.equal(data.assets.copper.configuredSourceCount, 1);
    assert.equal(data.diagnostics.providers.goldApi.quoteCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a user CoinGecko key bypasses durable platform-key cache and quota rows", async () => {
  const context = await createSecureApiContext("https://app.test/api/market?assets=bitcoin");
  const statements = [];
  const database = context.env.API_USAGE_DB;
  const prepare = database.prepare.bind(database);
  database.prepare = (statement) => {
    statements.push(statement);
    return prepare(statement);
  };
  const request = new Request(context.request.url, {
    headers: {
      cookie: context.request.headers.get("cookie"),
      origin: "https://app.test",
      "sec-fetch-site": "same-origin",
      "x-coingecko-api-key": "user-owned-key",
    },
  });
  const originalFetch = globalThis.fetch;
  const requestedKeys = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "www.tgju.org")
      return new Response('<td data-col="info.last_trade.PDrCotVal">500000</td>', { status: 200 });
    if (url.hostname === "www.bonbast.com") return new Response("token unavailable", { status: 200 });
    if (url.hostname === "raw.githubusercontent.com")
      return new Response(JSON.stringify({ usd: { value: "50000", date: Math.floor(Date.now() / 1000) } }), {
        status: 200,
      });
    if (url.hostname === "api.coingecko.com") {
      requestedKeys.push(options.headers?.["x-cg-demo-api-key"]);
      return new Response(JSON.stringify({ bitcoin: { usd: 100, usd_24hr_change: 1 } }), { status: 200 });
    }
    if (url.hostname === "api.binance.com") return new Response("unavailable", { status: 503 });
    throw new Error(`Unexpected provider request: ${url.href}`);
  };
  try {
    const response = await onRequestGet({ request, env: context.env });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.assets.bitcoin.price, 5_000_000);
    assert.deepEqual(requestedKeys, ["user-owned-key"]);
    assert.equal(data.diagnostics.providers.coinGecko.cacheStatus, "uncached");
    assert.equal(
      statements.some((statement) => /provider_monthly_usage|provider_quote_cache/.test(statement)),
      false,
      statements.filter((statement) => /provider_monthly_usage|provider_quote_cache/.test(statement)).join("\n"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a user CoinMarketCap key stays in the server header and bypasses shared provider storage", async () => {
  const context = await createSecureApiContext("https://app.test/api/market?assets=bitcoin&sync=1");
  const statements = [];
  const database = context.env.API_USAGE_DB;
  const prepare = database.prepare.bind(database);
  database.prepare = (statement) => {
    statements.push(statement);
    return prepare(statement);
  };
  const request = new Request(context.request.url, {
    headers: {
      cookie: context.request.headers.get("cookie"),
      origin: "https://app.test",
      "sec-fetch-site": "same-origin",
      "x-coinmarketcap-api-key": "user-cmc-key",
    },
  });
  const originalFetch = globalThis.fetch;
  let cmcRequest;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "pro-api.coinmarketcap.com") {
      cmcRequest = { url, options };
      return new Response(
        JSON.stringify({
          data: {
            1: {
              slug: "bitcoin",
              quote: { USD: { price: 60000, last_updated: new Date().toISOString() } },
            },
          },
        }),
        { status: 200 },
      );
    }
    if (url.hostname === "www.tgju.org")
      return new Response('<td data-col="info.last_trade.PDrCotVal">500000</td>', { status: 200 });
    if (url.hostname === "www.bonbast.com") return new Response("token unavailable", { status: 200 });
    if (url.hostname === "raw.githubusercontent.com")
      return new Response(JSON.stringify({ usd: { value: "50000", date: Math.floor(Date.now() / 1000) } }), {
        status: 200,
      });
    throw new Error(`Unexpected request: ${url.href}`);
  };
  try {
    const response = await onRequestGet({ request, env: context.env });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(cmcRequest.url.searchParams.has("api_key"), false);
    assert.equal(cmcRequest.options.headers["X-CMC_PRO_API_KEY"], "user-cmc-key");
    assert.deepEqual(cmcRequest.options.cf, { cacheTtl: 0, cacheEverything: false });
    assert.equal(data.diagnostics.providers.coinMarketCap.cacheStatus, "uncached");
    assert.equal(
      statements.some((statement) => /provider_monthly_usage/.test(statement)),
      false,
    );
    assert.equal(
      statements.some((statement) => statement.startsWith("INSERT INTO provider_quote_cache")),
      false,
      statements.join("\n"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fixture FX and gold quotes produce marked estimates and permit USD conversion", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "www.tgju.org") {
      const price = url.pathname.endsWith("price_dollar_rl") ? "2,317,050" : "237,659,000";
      return new Response(
        `<td data-col="info.last_trade.PDrCotVal">${price}</td><span id="server-time" data-value="2026-09-23T18:04:00.000Z"></span>`,
        { status: 200 },
      );
    }
    if (url.hostname === "www.bonbast.com" && options.method !== "POST")
      return new Response(`$.post('/json', {param: "token"});`, { status: 200 });
    if (url.hostname === "www.bonbast.com")
      return new Response(JSON.stringify({ usd1: "231500", gol18: "23883835" }), { status: 200 });
    if (url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith("fiat.json"))
      return new Response(JSON.stringify({ usd: { value: "232000", date: 1780000000 } }), { status: 200 });
    if (url.hostname === "raw.githubusercontent.com")
      return new Response(JSON.stringify({ "18ayar": { value: "23777640", date: 1780000000 } }), { status: 200 });
    if (url.hostname === "api.coingecko.com")
      return new Response(JSON.stringify({ bitcoin: { usd: 60000 } }), { status: 200 });
    if (url.hostname === "api.binance.com") throw new Error("Binance unavailable");
    if (url.hostname === "www.chartgoldprice.com")
      return new Response(JSON.stringify({ prices: { gold: { gram: 0 }, silver: { gram: 0 } }, history: {} }), {
        status: 200,
      });
    throw new Error(`Unexpected request: ${url.href}`);
  };
  try {
    const response = await marketRequest("https://app.test/api/market?assets=dollar,gold,bitcoin", {
      COINGECKO_DEMO_API_KEY: "platform-test-key",
    });
    const data = await response.json();
    assert.equal(data.assets.dollar.price, 231603);
    assert.equal(data.assets.dollar.status, "degraded");
    assert.equal(data.assets.dollar.confidence, "low");
    assert.equal(data.assets.dollar.consensusCalibrated, false);
    assert.equal(data.assets.gold.price, 23824868);
    assert.equal(data.assets.gold.status, "degraded");
    assert.equal(data.assets.gold.sourceCount, 2);
    assert.equal(data.assets.gold.sources.includes("Bonbast"), true);
    assert.equal(data.assets.bitcoin.price, 60000 * data.assets.dollar.price);
    assert.equal(data.assets.bitcoin.quoteType, "derived");
    assert.equal(data.assets.bitcoin.dependencies[0].status, "degraded");
    assert.equal(data.diagnostics.providers.auxiliary.quoteCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("USDT exchange pairs are not converted as if USDT were USD cash", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "www.tgju.org")
      return new Response('<td data-col="info.last_trade.PDrCotVal">500000</td>', { status: 200 });
    if (url.hostname === "www.bonbast.com" && options.method !== "POST")
      return new Response(`$.post('/json', {param: "token"});`, { status: 200 });
    if (url.hostname === "www.bonbast.com") return new Response(JSON.stringify({ usd1: "50000" }), { status: 200 });
    if (url.hostname === "api.coingecko.com")
      return new Response(JSON.stringify({ bitcoin: { usd: 60000 } }), { status: 200 });
    if (url.hostname === "api.binance.com")
      return new Response(JSON.stringify([{ symbol: "BTCUSDT", lastPrice: "65000", priceChangePercent: "2" }]), {
        status: 200,
      });
    if (url.hostname === "raw.githubusercontent.com")
      return new Response(JSON.stringify({ usd: { value: "50000", date: 1780000000 } }), { status: 200 });
    throw new Error(`Unexpected request: ${url.href}`);
  };
  try {
    const response = await marketRequest("https://app.test/api/market?assets=bitcoin", {
      COINGECKO_DEMO_API_KEY: "platform-test-key",
    });
    const data = await response.json();
    assert.equal(data.assets.bitcoin.price, 3000000000);
    assert.equal(data.assets.bitcoin.sourceCount, 1);
    assert.deepEqual(data.assets.bitcoin.sources, ["CoinGecko"]);
    assert.equal(data.diagnostics.providers.binance.status, "fulfilled");
    assert.equal(data.diagnostics.assets.bitcoin.attempted, 7);
    assert.equal(data.diagnostics.assets.bitcoin.attemptedProviders.length, 7);
    assert.equal(data.diagnostics.assets.bitcoin.excludedForCurrency, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TSETMC retrieval time is not misreported as the market observation time", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ indexValue: 2000000, previousValue: 1990000 }), { status: 200 });
  try {
    const response = await marketRequest("https://app.test/api/market?assets=bourseIndex");
    const data = await response.json();
    assert.equal(data.assets.bourseIndex.observedAt, null);
    assert.ok(data.assets.bourseIndex.retrievedAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TSETMC and TGJU index sources are queried together", async () => {
  const originalFetch = globalThis.fetch;
  const indexTime = "2026-09-23T17:45:00.000Z";
  const requestedHosts = new Set();
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    requestedHosts.add(url.hostname);
    if (url.hostname === "cdn.tsetmc.com")
      return new Response(JSON.stringify({ indexValue: 2000000, previousValue: 1990000 }), { status: 200 });
    if (url.hostname === "www.tgju.org" && url.pathname.endsWith("gc30"))
      return new Response(
        `<span data-col="info.last_trade.PDrCotVal">2,000,000</span><span id="server-time" data-value="${indexTime}"></span>`,
        { status: 200 },
      );
    throw new Error(`Unexpected request: ${url.href}`);
  };
  try {
    const response = await marketRequest("https://app.test/api/market?assets=bourseIndex");
    const data = await response.json();
    assert.deepEqual([...requestedHosts].sort(), ["cdn.tsetmc.com", "www.tgju.org"]);
    assert.equal(data.assets.bourseIndex.sourceCount, 2);
    assert.equal(data.diagnostics.assets.bourseIndex.attempted, 2);
    assert.equal(data.diagnostics.providers.tsetmc.status, "fulfilled");
    assert.equal(data.diagnostics.providers.tgjuIndex.status, "fulfilled");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TGJU gc30 supplies Tehran index points and history when TSETMC fails", async () => {
  const originalFetch = globalThis.fetch;
  const indexTime = "2026-09-23T17:45:00.000Z";
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "cdn.tsetmc.com") throw new Error("TSETMC unavailable");
    if (url.hostname === "www.tgju.org" && url.pathname.endsWith("gc30")) {
      return new Response(
        `<span data-col="info.last_trade.PDrCotVal">7,167,457</span><span id="server-time" data-value="${indexTime}"></span>$("#ChartBlock-3").msHighcharts({ chartData: [[1790181900000,7167000],[1790185500000,7167457]], chartType: "area" });`,
        { status: 200 },
      );
    }
    throw new Error(`Unexpected request: ${url.href}`);
  };
  try {
    const response = await marketRequest("https://app.test/api/market?assets=bourseIndex");
    const data = await response.json();
    assert.equal(data.assets.bourseIndex.price, 7167457);
    assert.equal(data.assets.bourseIndex.unit, "point");
    assert.equal(data.assets.bourseIndex.observedAt, indexTime);
    assert.equal(data.diagnostics.providers.tsetmc.status, "rejected");
    assert.deepEqual(data.diagnostics.providers.tgjuIndex, { status: "fulfilled", quoteCount: 1 });
    assert.deepEqual(
      data.history.bourseIndex.map((point) => point.price),
      [7167000, 7167457],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TGJU index history remains available as a prior reading when its current quote is empty", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "cdn.tsetmc.com") return new Response(JSON.stringify({}), { status: 200 });
    if (url.hostname === "www.tgju.org" && url.pathname.endsWith("gc30")) {
      return new Response(
        '$("#ChartBlock-3").msHighcharts({ chartData: [[1790181900000,7167000]], chartType: "area" });',
        { status: 200 },
      );
    }
    throw new Error(`Unexpected request: ${url.href}`);
  };
  try {
    const response = await marketRequest("https://app.test/api/market?assets=bourseIndex");
    const data = await response.json();
    assert.equal(data.assets.bourseIndex, undefined);
    assert.deepEqual(data.diagnostics.providers.tsetmc, {
      status: "fulfilled",
      quoteCount: 0,
    });
    assert.deepEqual(data.diagnostics.providers.tgjuIndex, {
      status: "fulfilled",
      quoteCount: 0,
    });
    assert.equal(data.history.bourseIndex[0].price, 7167000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a successful provider response with no parsed quote differs from a failed provider", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "api.coingecko.com") return new Response(JSON.stringify({}), { status: 200 });
    if (url.hostname === "api.binance.com") throw new Error("Binance unavailable");
    throw new Error(`Unexpected request: ${url.href}`);
  };
  try {
    const response = await marketRequest("https://app.test/api/market?assets=bitcoin", {
      COINGECKO_DEMO_API_KEY: "platform-test-key",
    });
    const data = await response.json();
    assert.deepEqual(data.diagnostics.providers.coinGecko, {
      status: "fulfilled",
      quoteCount: 0,
      cacheStatus: "refreshed",
    });
    assert.deepEqual(data.diagnostics.providers.binance, {
      status: "rejected",
      quoteCount: 0,
      failureCode: "request_failed",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gold auxiliary quotes are fetched only after primary and fallback sources conflict", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    requestedUrls.push(url);
    if (url.hostname === "www.tgju.org") {
      const value = url.pathname.endsWith("geram18") ? "400000000" : "500000";
      return new Response(`<td data-col="info.last_trade.PDrCotVal">${value}</td>`, { status: 200 });
    }
    if (url.hostname === "www.bonbast.com" && options.method !== "POST") {
      return new Response(`$.post('/json', {param: "token"});`, {
        status: 200,
        headers: { "set-cookie": "session=one" },
      });
    }
    if (url.hostname === "www.bonbast.com") {
      return new Response(JSON.stringify({ usd1: "50000", gol18: "41000000" }), { status: 200 });
    }
    if (url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith("fiat.json")) {
      return new Response(JSON.stringify({ usd: { value: "50000", date: 1770000000 } }), { status: 200 });
    }
    if (url.hostname === "raw.githubusercontent.com") {
      return new Response(JSON.stringify({ "18ayar": { value: "40500000", date: 1770000000 } }), { status: 200 });
    }
    if (url.hostname === "www.chartgoldprice.com") {
      return new Response(JSON.stringify({ prices: { gold: { gram: 1080 }, silver: { gram: 1 } }, history: {} }), {
        status: 200,
      });
    }
    throw new Error(`Unexpected request: ${url.href}`);
  };
  try {
    const response = await marketRequest("https://app.test/api/market?assets=gold");
    const data = await response.json();
    assert.ok(requestedUrls.some((url) => url.hostname === "www.chartgoldprice.com"));
    assert.equal(data.diagnostics.providers.auxiliary.status, "fulfilled");
    assert.equal(data.diagnostics.providers.auxiliary.quoteCount, 1);
    assert.equal(data.assets.gold.status, "degraded");
    assert.ok(data.assets.gold.price > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("primary, fallback, and auxiliary provider timeouts return within the interactive budget", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, { signal } = {}) =>
    await new Promise((_resolve, reject) => {
      const abort = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  try {
    const startedAt = Date.now();
    const response = await marketRequest("https://app.test/api/market?assets=gold");
    const data = await response.json();
    const elapsed = Date.now() - startedAt;
    assert.equal(data.assets.gold, undefined);
    assert.equal(data.diagnostics.providers.providerA.status, "rejected");
    assert.equal(data.diagnostics.providers.providerC.status, "rejected");
    assert.equal(data.diagnostics.providers.auxiliary.status, "rejected");
    assert.ok(elapsed < 3500);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fixed income diagnostics report the fund separately from instrument quotes", async () => {
  const originalFetch = globalThis.fetch;
  let html = "<p>بازده مؤثر سالانه 40%</p>";
  globalThis.fetch = async () => new Response(html, { status: 200 });
  try {
    const successResponse = await marketRequest("https://app.test/api/market?assets=fixedIncome");
    const success = await successResponse.json();
    assert.equal(success.funds.fixedIncome.effectiveAnnualReturn, 40);
    assert.equal(success.assets.fixedIncome, undefined);
    assert.equal(success.diagnostics.assets.fixedIncome, undefined);
    assert.deepEqual(success.diagnostics.funds.fixedIncome, { attempted: 1, successful: 1, status: "available" });
    assert.deepEqual(success.diagnostics.providers.fixedIncome, {
      status: "fulfilled",
      quoteCount: 1,
      cacheStatus: "refreshed",
    });

    html = "<p>اطلاعات بازده منتشر نشده است.</p>";
    const failedResponse = await marketRequest("https://app.test/api/market?assets=fixedIncome");
    const failed = await failedResponse.json();
    assert.deepEqual(failed.funds, {});
    assert.deepEqual(failed.diagnostics.funds.fixedIncome, { attempted: 1, successful: 0, status: "unavailable" });
    assert.deepEqual(failed.diagnostics.providers.fixedIncome, { status: "rejected", quoteCount: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("derived quotes use the FX median while unavailable rates remain unavailable", async () => {
  const originalFetch = globalThis.fetch;
  for (const dollarStatus of ["conflicted", "unavailable"]) {
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.hostname === "www.tgju.org") {
        if (dollarStatus === "unavailable") throw new Error("TGJU unavailable");
        return new Response('<td data-col="info.last_trade.PDrCotVal">5000000</td>', { status: 200 });
      }
      if (url.hostname === "www.bonbast.com" && options.method !== "POST") {
        if (dollarStatus === "unavailable") throw new Error("Bonbast unavailable");
        return new Response(`$.post('/json', {param: "token"});`, { status: 200 });
      }
      if (url.hostname === "www.bonbast.com") return new Response(JSON.stringify({ usd1: "600000" }), { status: 200 });
      if (url.hostname === "raw.githubusercontent.com") {
        if (dollarStatus === "unavailable") throw new Error("Navasan unavailable");
        return new Response(JSON.stringify({ usd: { value: "700000", date: 1770000000 } }), { status: 200 });
      }
      if (url.hostname === "api.coingecko.com")
        return new Response(JSON.stringify({ bitcoin: { usd: 60000 } }), { status: 200 });
      if (url.hostname === "api.binance.com") throw new Error("Binance unavailable");
      throw new Error(`Unexpected request: ${url.href}`);
    };
    try {
      const response = await marketRequest("https://app.test/api/market?assets=bitcoin", {
        COINGECKO_DEMO_API_KEY: "platform-test-key",
      });
      const data = await response.json();
      if (dollarStatus === "conflicted") {
        assert.ok(data.assets.bitcoin.price > 0);
        assert.equal(data.diagnostics.assets.bitcoin.status, "degraded");
        assert.equal(data.assets.dollar, undefined);
      } else {
        assert.equal(data.assets.bitcoin, undefined);
        assert.equal(data.diagnostics.assets.bitcoin.status, "unavailable");
        assert.equal(data.diagnostics.assets.bitcoin.reason, "currency_unavailable");
        assert.equal(data.diagnostics.assets.bitcoin.successful, 0);
        assert.equal(data.diagnostics.assets.bitcoin.excludedForCurrency, 1);
      }
      assert.equal(data.diagnostics.providers.coinGecko.quoteCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("auxiliary quotes are diagnosed and filtered as outliers when inconsistent", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "www.tgju.org") {
      const value = url.pathname.endsWith("price_dollar_rl") ? "5000000" : "400000000";
      return new Response(`<td data-col="info.last_trade.PDrCotVal">${value}</td>`, { status: 200 });
    }
    if (url.hostname === "www.bonbast.com" && options.method !== "POST")
      return new Response(`$.post('/json', {param: "token"});`, { status: 200 });
    if (url.hostname === "www.bonbast.com")
      return new Response(JSON.stringify({ usd1: "600000", gol18: "41000000" }), { status: 200 });
    if (url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith("fiat.json"))
      return new Response(JSON.stringify({ usd: { value: "700000", date: 1780000000 } }), { status: 200 });
    if (url.hostname === "raw.githubusercontent.com")
      return new Response(JSON.stringify({ "18ayar": { value: "40500000", date: 1780000000 } }), { status: 200 });
    if (url.hostname === "www.chartgoldprice.com")
      return new Response(JSON.stringify({ prices: { gold: { gram: 1080 }, silver: { gram: 1 } }, history: {} }), {
        status: 200,
      });
    throw new Error(`Unexpected request: ${url.href}`);
  };
  try {
    const response = await marketRequest("https://app.test/api/market?assets=gold");
    const data = await response.json();
    assert.equal(data.diagnostics.providers.auxiliary.status, "fulfilled");
    assert.equal(data.diagnostics.providers.auxiliary.quoteCount, 1);
    assert.equal(data.diagnostics.assets.gold.successful, 3);
    assert.equal(data.diagnostics.assets.gold.status, "degraded");
    assert.equal(data.assets.gold.price, 40500000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CoinMarketCap uses one batched request for only selected crypto assets", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    requests.push({ url, options });
    if (url.hostname === "pro-api.coinmarketcap.com") {
      return new Response(
        JSON.stringify({
          data: {
            1: {
              slug: "bitcoin",
              quote: { USD: { price: 60000, percent_change_24h: 1, last_updated: new Date().toISOString() } },
            },
            825: {
              slug: "tether",
              quote: { USD: { price: 1, percent_change_24h: 0, last_updated: new Date().toISOString() } },
            },
          },
        }),
        { status: 200 },
      );
    }
    if (url.hostname === "api.coingecko.com") return new Response("blocked", { status: 503 });
    if (url.hostname === "api.binance.com") return new Response("blocked", { status: 503 });
    if (url.hostname === "www.tgju.org")
      return new Response('<td data-col="info.last_trade.PDrCotVal">2317050</td>', { status: 200 });
    if (url.hostname === "www.bonbast.com" && options.method !== "POST")
      return new Response('$.post("/json", {param: "token"});', { status: 200 });
    if (url.hostname === "www.bonbast.com")
      return new Response(JSON.stringify({ usd1: "231500", gol18: "23883835" }), { status: 200 });
    if (url.hostname === "raw.githubusercontent.com")
      return new Response(JSON.stringify({ usd: { value: "232000", date: 1780000000 } }), { status: 200 });
    throw new Error("Unexpected request: " + url.href);
  };
  try {
    const response = await marketRequest("https://app.test/api/market?assets=bitcoin,tether", {
      COINMARKETCAP_API_KEY: "cmc-test-key",
      COINGECKO_DEMO_API_KEY: "cg-test-key",
    });
    const data = await response.json();
    const cmcRequests = requests.filter((request) => request.url.hostname === "pro-api.coinmarketcap.com");
    assert.equal(cmcRequests.length, 1);
    assert.equal(cmcRequests[0].url.searchParams.get("slug"), "bitcoin,tether");
    assert.equal(cmcRequests[0].options.headers["X-CMC_PRO_API_KEY"], "cmc-test-key");
    assert.equal(data.diagnostics.providers.coinMarketCap.status, "fulfilled");
    assert.equal(data.diagnostics.providers.coinMarketCap.quoteCount, 2);
    assert.ok(data.assets.bitcoin.sources.includes("CoinMarketCap"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
