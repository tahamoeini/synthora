import test from "node:test";
import assert from "node:assert/strict";
import { onRequestGet as marketGet } from "../functions/api/market.js";
import { onRequestGet as historyGet } from "../functions/api/history.js";
import { onRequestGet as fxGet } from "../functions/api/fx.js";
import { onRequestGet as inflationGet } from "../functions/api/inflation.js";
import { consumeRouteQuota } from "../functions/api/_security.js";

const appOrigin = "https://app.test";
let clientNumber = 0;

function context(path, { env = {}, headers = {}, method = "GET" } = {}) {
  clientNumber += 1;
  const requestHeaders = new Headers({
    origin: appOrigin,
    "cf-connecting-ip": `198.51.100.${clientNumber}`,
    ...headers,
  });
  return {
    request: new Request(appOrigin + path, { method, headers: requestHeaders }),
    env,
  };
}

function databaseWithoutSessionSecurity() {
  return {
    prepare(queryText) {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          return queryText.includes("SELECT quotes_json") ? null : { request_count: 1 };
        },
        async run() {
          return { success: true };
        },
      };
      return statement;
    },
  };
}

function tgjuHistory(points) {
  return '$("#ChartBlock-3").msHighcharts({ chartData: ' + JSON.stringify(points) + ', chartType: "line" });';
}

async function withFetch(handler, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("public market quotes continue without a D1 binding or provider key", async () => {
  const requestedUrls = [];
  const response = await withFetch(
    async (input) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      requestedUrls.push(url);
      if (url.hostname === "www.tgju.org")
        return new Response('<td data-col="info.last_trade.PDrCotVal">500000</td>', { status: 200 });
      if (url.hostname === "www.bonbast.com") return new Response("token unavailable", { status: 200 });
      throw new Error(`Unexpected provider request: ${url.href}`);
    },
    async () => marketGet(context("/api/market?assets=dollar")),
  );

  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.assets.dollar.price, 50_000);
  assert.equal(data.assets.dollar.sourceValues[0].source, "TGJU");
  assert.ok(requestedUrls.some((url) => url.hostname === "www.tgju.org"));
});

test("one failed Navasan fallback feed does not discard the successful domestic quote", async () => {
  const response = await withFetch(
    async (input) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.hostname === "www.tgju.org") return new Response("quote markup unavailable", { status: 200 });
      if (url.hostname === "www.bonbast.com") return new Response("request token unavailable", { status: 200 });
      if (url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith("/fiat.json"))
        return new Response(JSON.stringify({ usd: { value: "50000", date: 1790530315 } }), { status: 200 });
      if (url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith("/gold.json"))
        return new Response("unavailable", { status: 503 });
      if (url.hostname === "www.chartgoldprice.com")
        return new Response(JSON.stringify({ prices: { gold: { gram: 0 }, silver: { gram: 0 } }, history: {} }), {
          status: 200,
        });
      throw new Error(`Unexpected provider request: ${url.href}`);
    },
    async () => marketGet(context("/api/market?assets=dollar,gold")),
  );

  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.assets.dollar.price, 50_000);
  assert.equal(data.assets.dollar.sources.includes("Navasan"), true);
  assert.equal(data.assets.gold, undefined);
  assert.equal(data.diagnostics.providers.providerC.quoteCount, 1);
});

test("unmetered public mode never spends a server CoinGecko key but accepts the user's key", async () => {
  const requestedKeys = [];
  const env = { COINGECKO_DEMO_API_KEY: "platform-secret-must-not-be-used-without-d1" };
  const response = await withFetch(
    async (input, options = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.hostname === "www.tgju.org")
        return new Response('<td data-col="info.last_trade.PDrCotVal">500000</td>', { status: 200 });
      if (url.hostname === "www.bonbast.com") return new Response("token unavailable", { status: 200 });
      if (url.hostname === "api.coingecko.com") {
        requestedKeys.push(options.headers?.["x-cg-demo-api-key"]);
        return new Response(JSON.stringify({ bitcoin: { usd: 100, usd_24hr_change: 1 } }), { status: 200 });
      }
      if (url.hostname === "api.binance.com") return new Response("unavailable", { status: 503 });
      throw new Error(`Unexpected provider request: ${url.href}`);
    },
    async () => {
      const noUserKey = await marketGet(context("/api/market?assets=bitcoin", { env }));
      assert.equal(noUserKey.status, 200);
      assert.deepEqual(requestedKeys, []);
      const withUserKey = await marketGet(
        context("/api/market?assets=bitcoin", { env, headers: { "x-coingecko-api-key": "user-key" } }),
      );
      return withUserKey;
    },
  );

  const data = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(requestedKeys, ["user-key"]);
  assert.equal(data.assets.bitcoin.price, 5_000_000);
  assert.ok(data.assets.bitcoin.sources.includes("CoinGecko"));
});

test("user-key crypto history and Toman FX conversion work without D1", async () => {
  const now = Date.now();
  const timestamps = [now - 86_400_000, now];
  const response = await withFetch(
    async (input, options = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.hostname === "www.tgju.org")
        return new Response(
          tgjuHistory(timestamps.map((timestamp, index) => [timestamp, 2_300_000 + index * 10_000])),
          {
            status: 200,
          },
        );
      if (url.hostname === "api.coingecko.com") {
        assert.equal(options.headers?.["x-cg-demo-api-key"], "user-key");
        return new Response(
          JSON.stringify({ prices: timestamps.map((timestamp, index) => [timestamp, 100 + index * 10]) }),
          {
            status: 200,
          },
        );
      }
      throw new Error(`Unexpected provider request: ${url.href}`);
    },
    async () =>
      historyGet(
        context("/api/history?assets=bitcoin,dollar&range=all", {
          headers: { "x-coingecko-api-key": "user-key" },
        }),
      ),
  );
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.assets.bitcoin.coverage.status, "available");
  assert.equal(data.assets.bitcoin.points[0].value, 23_000_000);
  assert.equal(data.assets.bitcoin.points[0].currency, "TOMAN");
});

test("public history does not spend a platform CoinGecko key without D1", async () => {
  const now = Date.now();
  const timestamps = [now - 86_400_000, now];
  const platformKey = "platform-secret-must-not-be-used-without-d1";
  const response = await withFetch(
    async (input, options = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.hostname === "www.tgju.org")
        return new Response(tgjuHistory(timestamps.map((timestamp) => [timestamp, 2_300_000])), { status: 200 });
      if (url.hostname === "api.coingecko.com") {
        assert.notEqual(options.headers?.["x-cg-demo-api-key"], platformKey);
        throw new Error("A platform CoinGecko key must not be used without durable quota storage");
      }
      throw new Error(`Unexpected provider request: ${url.href}`);
    },
    async () =>
      historyGet(
        context("/api/history?assets=bitcoin&range=all", {
          env: { COINGECKO_DEMO_API_KEY: platformKey },
        }),
      ),
  );
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.assets.bitcoin.coverage.status, "unavailable");
  assert.equal(data.assets.bitcoin.coverage.reason, "nobitex-history-unavailable");
});

test("platform keys stay disabled without the session secret while keyless CoinMarketCap remains available", async () => {
  const now = Date.now();
  const timestamps = [now - 86_400_000, now];
  const platformKey = "platform-secret-requires-durable-session-security";
  const platformRequests = [];
  const keylessCoinMarketCapRequests = [];
  const env = {
    API_USAGE_DB: databaseWithoutSessionSecurity(),
    COINGECKO_DEMO_API_KEY: platformKey,
    COINMARKETCAP_API_KEY: "cmc-platform-secret-requires-durable-session-security",
  };
  const responses = await withFetch(
    async (input, options = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.hostname === "www.tgju.org")
        return new Response(
          '<td data-col="info.last_trade.PDrCotVal">2300000</td>' +
            tgjuHistory(timestamps.map((timestamp) => [timestamp, 2_300_000])),
          { status: 200 },
        );
      if (url.hostname === "www.bonbast.com") return new Response("token unavailable", { status: 200 });
      if (url.hostname === "api.binance.com" || url.hostname === "api.nobitex.ir")
        return new Response("unavailable", { status: 503 });
      if (url.hostname === "api.coingecko.com") {
        platformRequests.push({
          host: url.hostname,
          key: options.headers?.["x-cg-demo-api-key"],
        });
        return new Response("unexpected platform key call", { status: 500 });
      }
      if (url.hostname === "pro-api.coinmarketcap.com") {
        keylessCoinMarketCapRequests.push({
          path: url.pathname,
          key: options.headers?.["X-CMC_PRO_API_KEY"],
        });
        return new Response(JSON.stringify({ status: { error_code: "0" }, data: [] }), { status: 200 });
      }
      throw new Error(`Unexpected provider request: ${url.href}`);
    },
    async () => {
      const market = await marketGet(context("/api/market?assets=bitcoin", { env }));
      const history = await historyGet(context("/api/history?assets=bitcoin&range=all", { env }));
      return { market, history };
    },
  );
  const market = await responses.market.json();
  const history = await responses.history.json();
  assert.equal(responses.market.status, 200);
  assert.equal(responses.history.status, 200);
  assert.ok(market.diagnostics);
  assert.equal(history.assets.bitcoin.coverage.reason, "nobitex-history-unavailable");
  assert.deepEqual(platformRequests, []);
  assert.deepEqual(keylessCoinMarketCapRequests, [{ path: "/public-api/v2/simple/price", key: undefined }]);
  assert.equal(market.diagnostics.providers.coinMarketCap.status, "fulfilled");
});

test("FX and inflation references remain available without D1", async () => {
  const response = await withFetch(
    async (input) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.hostname === "api.frankfurter.dev")
        return new Response(JSON.stringify([{ quote: "CNY", rate: 7.2, date: "2026-09-25" }]), { status: 200 });
      if (url.hostname === "www.cbr.ru")
        return new Response(
          '<ValCurs Date="26.09.2026"><Valute><CharCode>USD</CharCode><Nominal>1</Nominal><Value>80,00</Value></Valute></ValCurs>',
          { status: 200 },
        );
      if (url.hostname === "api.worldbank.org")
        return new Response(JSON.stringify([{}, [{ value: 35, date: "2025" }]]), { status: 200 });
      throw new Error(`Unexpected reference request: ${url.href}`);
    },
    async () => {
      const fx = await fxGet(context("/api/fx?quotes=RUB,CNY"));
      const inflation = await inflationGet(context("/api/inflation"));
      return { fx, inflation };
    },
  );
  const fx = await response.fx.json();
  const inflation = await response.inflation.json();
  assert.equal(response.fx.status, 200);
  assert.equal(fx.quotes.RUB.quotePerUsd, 80);
  assert.equal(fx.quotes.CNY.quotePerUsd, 7.2);
  assert.equal(response.inflation.status, 200);
  assert.equal(inflation.inflationRate, 35);
});

test("no-D1 public quota remains same-origin, GET-only, and bounded per edge instance", async () => {
  const crossOrigin = await consumeRouteQuota(
    context("/api/market", { headers: { origin: "https://attacker.test" } }),
    "market",
    { allowPublicWhenUnconfigured: true },
  );
  assert.equal(crossOrigin.error.status, 403);

  const post = await consumeRouteQuota(context("/api/market", { method: "POST" }), "market", {
    allowPublicWhenUnconfigured: true,
  });
  assert.equal(post.error.status, 405);

  let last;
  for (let count = 0; count <= 60; count += 1)
    last = await consumeRouteQuota(
      context("/api/market", { headers: { "cf-connecting-ip": "203.0.113.77" } }),
      "market",
      { allowPublicWhenUnconfigured: true },
    );
  assert.equal(last.error.status, 429);
});
