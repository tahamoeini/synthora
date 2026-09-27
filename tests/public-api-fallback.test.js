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
  assert.equal(data.assets.dollar.sourceValues[0].source, "Provider A");
  assert.ok(requestedUrls.some((url) => url.hostname === "www.tgju.org"));
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
  assert.equal(data.assets.bitcoin.coverage.reason, "provider-rate-limited");
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
