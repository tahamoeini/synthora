import test from "node:test";
import assert from "node:assert/strict";
import { onRequestGet, parseHistoryRequest } from "../functions/api/history.js";
import { createSecureApiContext } from "./helpers/api-context.js";

function tgjuPage(points) {
  return '$("#ChartBlock-3").msHighcharts({ chartData: ' + JSON.stringify(points) + ', chartType: "line" });';
}

function withFetch(handler, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

async function historyRequest(url, env = {}) {
  return onRequestGet(await createSecureApiContext(url, env));
}

test("history requests accept only known assets and ranges", () => {
  assert.deepEqual(parseHistoryRequest("https://app.test/api/history?assets=gold,unknown,silver&range=6m"), {
    assets: ["gold", "silver"],
    range: "6m",
    start: null,
    end: null,
  });
  assert.equal(
    parseHistoryRequest("https://app.test/api/history?assets=unknown&range=all").error,
    "no-supported-assets",
  );
  assert.equal(parseHistoryRequest("https://app.test/api/history?assets=gold&range=forever").error, "invalid-range");
  assert.deepEqual(parseHistoryRequest("https://app.test/api/history").assets, ["dollar", "gold", "silver"]);
});

test("history endpoint returns source-labelled Toman observations using dated FX", async () => {
  const now = Date.now();
  const dates = [now - 2 * 86400000, now - 86400000, now];
  const dollarRows = dates.map((date, index) => [date, 2300000 + index * 10000]);
  const cryptoRows = dates.map((date, index) => [date, 100 + index * 10]);
  const response = await withFetch(
    async (input, options = {}) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.hostname === "www.tgju.org") return new Response(tgjuPage(dollarRows), { status: 200 });
      if (url.hostname === "api.coingecko.com") {
        assert.equal(options.headers["x-cg-demo-api-key"], "demo-key");
        return new Response(JSON.stringify({ prices: cryptoRows }), { status: 200 });
      }
      throw new Error("unexpected-provider " + url.href);
    },
    async () =>
      historyRequest("https://app.test/api/history?assets=bitcoin,dollar&range=all", {
        COINGECKO_DEMO_API_KEY: "demo-key",
      }),
  );
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.assets.bitcoin.coverage.status, "available");
  assert.equal(data.assets.bitcoin.coverage.source, "CoinGecko");
  assert.equal(data.assets.bitcoin.points[0].source, "CoinGecko");
  assert.equal(data.assets.bitcoin.points[0].currency, "TOMAN");
  assert.equal(data.assets.bitcoin.points[0].value, 23000000);
  assert.equal(data.assets.bitcoin.points[0].conversion.dollarSource, "TGJU");
  assert.equal(data.assets.dollar.points[0].value, 230000);
});

test("public Nobitex crypto history converts Rial closes to Toman without dated FX", async () => {
  const now = Math.floor(Date.now() / 1000);
  const nobitexRequests = [];
  const response = await withFetch(
    async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.hostname === "www.tgju.org")
        return new Response(tgjuPage([[now * 1000 - 86400000, 2300000], [now * 1000, 2320000]]), { status: 200 });
      if (url.hostname === "api.nobitex.ir") {
        nobitexRequests.push(url);
        return new Response(JSON.stringify({ s: "ok", t: [now - 86400, now], c: [23000000, 24000000] }), {
          status: 200,
        });
      }
      throw new Error("unexpected-provider " + url.href);
    },
    async () => historyRequest("https://app.test/api/history?assets=bitcoin&range=1y"),
  );
  const data = await response.json();
  const bitcoin = data.assets.bitcoin;
  assert.equal(response.status, 200);
  assert.equal(nobitexRequests.length, 1);
  assert.equal(nobitexRequests[0].searchParams.get("symbol"), "BTCIRT");
  assert.equal(nobitexRequests[0].searchParams.get("resolution"), "D");
  assert.equal(bitcoin.coverage.status, "available");
  assert.equal(bitcoin.coverage.source, "Nobitex");
  assert.equal(bitcoin.points[0].value, 2_300_000);
  assert.equal(bitcoin.points[0].currency, "TOMAN");
  assert.equal(bitcoin.points[0].source, "Nobitex");
  assert.equal(bitcoin.points[0].conversion, null);
});

test("copper history converts USD per pound to Toman per gram with same-date FX once", async () => {
  const timestamps = [Date.UTC(2025, 0, 2), Date.UTC(2025, 0, 3)];
  const dollarRows = timestamps.map((date, index) => [date, 2_300_000 + index * 10_000]);
  const response = await withFetch(
    async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.hostname === "www.tgju.org") return new Response(tgjuPage(dollarRows), { status: 200 });
      if (url.hostname === "query1.finance.yahoo.com")
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  timestamp: timestamps.map((date) => date / 1000),
                  indicators: { quote: [{ close: [453.59237, 907.18474] }] },
                },
              ],
            },
          }),
          { status: 200 },
        );
      throw new Error(`unexpected-provider:${url.hostname}`);
    },
    async () =>
      historyRequest("https://app.test/api/history?assets=copper&range=all", {
        YAHOO_METALS_LICENSE_CONFIRMED: "true",
      }),
  );
  const data = await response.json();
  const copper = data.assets.copper;
  assert.equal(response.status, 200);
  assert.equal(copper.unit, "TOMAN");
  assert.equal(copper.priceUnit, "TOMAN/gram");
  assert.equal(copper.currency, "TOMAN");
  assert.equal(copper.coverage.source, "Yahoo Finance");
  assert.equal(copper.coverage.missingFxCount, 0);
  assert.equal(copper.points[0].value, 230_000);
  assert.equal(copper.points[1].value, 462_000);
  assert.equal(copper.points[0].conversion.formula, "USD × USD/TOMAN");
  assert.equal(copper.points[0].conversion.dollarObservedAt.slice(0, 10), "2025-01-02");
});

test("crypto history stays unavailable when the public source fails and no optional key is configured", async () => {
  const requestedUrls = [];
  const response = await withFetch(
    async (input) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      requestedUrls.push(url.href);
      if (url.hostname === "www.tgju.org") return new Response(tgjuPage([[Date.now(), 2300000]]), { status: 200 });
      if (url.hostname === "api.nobitex.ir") return new Response("unavailable", { status: 503 });
      throw new Error("unexpected-provider " + url.href);
    },
    async () => historyRequest("https://app.test/api/history?assets=bitcoin&range=1y"),
  );
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.assets.bitcoin.coverage.status, "unavailable");
  assert.equal(data.assets.bitcoin.coverage.reason, "nobitex-history-unavailable");
  assert.equal(
    requestedUrls.some((url) => url.includes("api.coingecko.com")),
    false,
  );
});

test("a failed local history provider returns partial results and labels the unavailable asset", async () => {
  const now = Date.now();
  const response = await withFetch(
    async (input) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.hostname === "www.tgju.org" && url.pathname.endsWith("/price_dollar_rl")) {
        return new Response(
          tgjuPage([
            [now - 86400000, 2300000],
            [now, 2320000],
          ]),
          { status: 200 },
        );
      }
      if (url.hostname === "www.tgju.org" && url.pathname.endsWith("/geram18"))
        return new Response("provider unavailable", { status: 503 });
      if (url.hostname === "www.chartgoldprice.com") {
        return new Response(
          JSON.stringify({
            history: {
              gold: [
                [now - 86400000, 80],
                [now, 82],
              ],
            },
          }),
          { status: 200 },
        );
      }
      throw new Error("unexpected-provider " + url.href);
    },
    async () => historyRequest("https://app.test/api/history?assets=gold,dollar&range=all"),
  );
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.assets.gold.coverage.status, "available");
  assert.equal(data.assets.gold.coverage.source, "ChartGoldPrice");
  assert.equal(data.assets.dollar.coverage.status, "available");
});

test("unsupported range and empty allowlist return a clear 400 response", async () => {
  const response = await historyRequest("https://app.test/api/history?assets=gold&range=bad");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid-range" });
});

test("copper history converts monthly FRED/IMF data with matching monthly-average dollar observations", async () => {
  const dates = ["2025-01-01", "2025-02-01"];
  const dollarDates = ["2025-01-02", "2025-01-03", "2025-02-02", "2025-02-03"];
  const dollarRows = dollarDates.map((date, index) => [Date.parse(`${date}T00:00:00.000Z`), 2_300_000 + index * 10_000]);
  const response = await withFetch(
    async (input) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.hostname === "www.tgju.org" && url.pathname.endsWith("/price_dollar_rl"))
        return new Response(tgjuPage(dollarRows), { status: 200 });
      if (url.hostname === "fred.stlouisfed.org")
        return new Response(
          ["observation_date,PCOPPUSDM", "2025-01-01,2000000", "2025-02-01,2100000"].join("\n"),
          { status: 200 },
        );
      throw new Error(`unexpected-provider:${url.hostname}`);
    },
    async () => historyRequest("https://app.test/api/history?assets=copper&range=all"),
  );
  const data = await response.json();
  const copper = data.assets.copper;
  assert.equal(response.status, 200);
  assert.equal(copper.coverage.status, "available");
  assert.equal(copper.coverage.source, "FRED / IMF copper");
  assert.equal(copper.coverage.frequency, "monthly");
  assert.deepEqual(copper.coverage.candidateSources, ["FRED / IMF copper"]);
  assert.equal(copper.points[0].source, "FRED / IMF copper");
  assert.equal(copper.points[0].observationType, "monthly-average");
  assert.equal(copper.points[0].conversion.formula, "monthly-average USD × monthly-average USD/TOMAN");
  assert.equal(copper.points[0].conversion.dollarObservedFrom.slice(0, 10), "2025-01-02");
  assert.equal(copper.points[0].conversion.dollarObservationCount, 2);
  assert.equal(copper.points[0].value, 461_000);
});

test("TSETMC TEDPIX history is used when the TGJU index chart is unavailable", async () => {
  const response = await withFetch(
    async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.hostname === "www.tgju.org") return new Response("unavailable", { status: 503 });
      if (url.hostname === "cdn.tsetmc.com")
        return new Response(
          JSON.stringify({ indexB2: [{ dEven: 14020102, xNivIn: 2_100_000 }, { dEven: 14020103, xNivIn: 2_120_000 }] }),
          { status: 200 },
        );
      throw new Error(`unexpected-provider:${url.hostname}`);
    },
    async () => historyRequest("https://app.test/api/history?assets=bourseIndex&range=all"),
  );
  const data = await response.json();
  const index = data.assets.bourseIndex;
  assert.equal(response.status, 200);
  assert.equal(index.coverage.source, "TSETMC");
  assert.equal(index.points[0].date.slice(0, 10), "2023-03-22");
  assert.deepEqual(index.coverage.candidateSources, ["TGJU", "TSETMC"]);
});

test("TSETMC TEDPIX history is used when the TGJU index chart has too few observations", async () => {
  const response = await withFetch(
    async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.hostname === "www.tgju.org") return new Response(tgjuPage([[Date.UTC(2023, 2, 22), 2_100_000]]), { status: 200 });
      if (url.hostname === "cdn.tsetmc.com")
        return new Response(
          JSON.stringify({ indexB2: [{ dEven: 14020102, xNivIn: 2_100_000 }, { dEven: 14020103, xNivIn: 2_120_000 }] }),
          { status: 200 },
        );
      throw new Error(`unexpected-provider:${url.hostname}`);
    },
    async () => historyRequest("https://app.test/api/history?assets=bourseIndex&range=all"),
  );
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.assets.bourseIndex.coverage.source, "TSETMC");
  assert.equal(data.assets.bourseIndex.coverage.status, "available");
});

test("Coinbase history is paged past the exchange's per-request candle limit", async () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const firstDay = Date.parse("2015-01-01T00:00:00.000Z");
  const lastDay = Math.floor(Date.now() / dayMs) * dayMs + dayMs - 1;
  const dollarRows = [];
  for (let chunkStart = firstDay; chunkStart <= lastDay; ) {
    dollarRows.push([chunkStart, 2_300_000]);
    dollarRows.push([chunkStart + dayMs, 2_300_000]);
    chunkStart += 290 * dayMs;
  }
  const coinbaseRequests = [];
  const response = await withFetch(
    async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.hostname === "www.tgju.org" && url.pathname.endsWith("/price_dollar_rl"))
        return new Response(tgjuPage(dollarRows), { status: 200 });
      if (url.hostname === "api.nobitex.ir") return new Response("unavailable", { status: 503 });
      if (url.hostname === "api.binance.com") return new Response("[]", { status: 200 });
      if (url.hostname === "api.kraken.com")
        return new Response(JSON.stringify({ error: [], result: {} }), { status: 200 });
      if (url.hostname === "api.exchange.coinbase.com") {
        coinbaseRequests.push(url);
        const timestamp = Math.floor(Date.parse(url.searchParams.get("start")) / 1000);
        return new Response(
          JSON.stringify([
            [timestamp, 99, 101, 100, 100],
            [timestamp + 86400, 100, 102, 101, 101],
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected-provider:${url.hostname}`);
    },
    async () => historyRequest("https://app.test/api/history?assets=bitcoin&range=all"),
  );
  const data = await response.json();
  const bitcoin = data.assets.bitcoin;
  assert.equal(response.status, 200);
  assert.ok(coinbaseRequests.length > 1);
  assert.equal(bitcoin.coverage.source, "Coinbase");
  assert.ok(bitcoin.points.length > 2);
  assert.equal(bitcoin.points[0].conversion.formula, "USD × USD/TOMAN");
  assert.deepEqual(bitcoin.coverage.candidateSources, ["Nobitex", "Coinbase", "Binance", "Kraken"]);
});

test("Binance history requires observed same-day Nobitex Tether prices for conversion", async () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const firstDay = Math.floor(Date.now() / dayMs) * dayMs - 3 * dayMs;
  const dates = [firstDay, firstDay + dayMs];
  const response = await withFetch(
    async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.hostname === "www.tgju.org") return new Response("unavailable", { status: 503 });
      if (url.hostname === "api.nobitex.ir" && url.pathname.endsWith("/udf/history")) {
        if (url.searchParams.get("symbol") !== "USDTIRT") return new Response("unavailable", { status: 503 });
        return new Response(JSON.stringify({ s: "ok", t: dates.map((date) => date / 1000), c: [5_000_000, 5_100_000] }), {
          status: 200,
        });
      }
      if (url.hostname === "api.exchange.coinbase.com") return new Response("[]", { status: 200 });
      if (url.hostname === "api.binance.com")
        return new Response(
          JSON.stringify(dates.map((date, index) => [date, "", "", "", String(60_000 + index * 1_000)])),
          { status: 200 },
        );
      throw new Error(`unexpected-provider:${url.hostname}`);
    },
    async () => historyRequest("https://app.test/api/history?assets=bitcoin&range=1y"),
  );
  const data = await response.json();
  const bitcoin = data.assets.bitcoin;
  assert.equal(response.status, 200);
  assert.equal(bitcoin.coverage.source, "Binance");
  assert.deepEqual(bitcoin.points.map((point) => point.value), [30_000_000_000, 31_110_000_000]);
  assert.equal(bitcoin.points[0].conversion.formula, "ASSET/USDT × USDT/TOMAN");
  assert.equal(bitcoin.points[0].conversion.tetherObservedAt.slice(0, 10), new Date(firstDay).toISOString().slice(0, 10));
});

test("Kraken history fills BTC/ETH gaps with dated local-dollar conversion", async () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const firstDay = Math.floor(Date.now() / dayMs) * dayMs - 3 * dayMs;
  const dates = [firstDay, firstDay + dayMs];
  const dollarRows = dates.map((date) => [date, 2_300_000]);
  const response = await withFetch(
    async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.hostname === "www.tgju.org" && url.pathname.endsWith("/price_dollar_rl"))
        return new Response(tgjuPage(dollarRows), { status: 200 });
      if (url.hostname === "www.tgju.org") return new Response("unavailable", { status: 503 });
      if (url.hostname === "api.nobitex.ir") return new Response("unavailable", { status: 503 });
      if (url.hostname === "api.exchange.coinbase.com") return new Response("[]", { status: 200 });
      if (url.hostname === "api.binance.com") return new Response("[]", { status: 200 });
      if (url.hostname === "api.kraken.com")
        return new Response(
          JSON.stringify({
            error: [],
            result: {
              XXBTZUSD: [
                [dates[0] / 1000, 0, 0, 0, 60_000],
                [dates[1] / 1000, 0, 0, 0, 61_000],
                [dates[1] / 1000 + 86400, 0, 0, 0, 62_000],
              ],
              last: dates[1] / 1000 + 86400,
            },
          }),
          { status: 200 },
        );
      throw new Error(`unexpected-provider:${url.hostname}`);
    },
    async () => historyRequest("https://app.test/api/history?assets=bitcoin&range=1y"),
  );
  const data = await response.json();
  const bitcoin = data.assets.bitcoin;
  assert.equal(response.status, 200);
  assert.equal(bitcoin.coverage.source, "Kraken");
  assert.deepEqual(bitcoin.points.map((point) => point.value), [13_800_000_000, 14_030_000_000]);
  assert.equal(bitcoin.points[0].conversion.formula, "USD × USD/TOMAN");
});

test("Gold API history stays server-side, rate limited, and converts metals by dated USD FX", async () => {
  const dates = ["2025-01-02", "2025-01-03"];
  const dollarRows = dates.map((date) => [Date.parse(`${date}T00:00:00.000Z`), 2_300_000]);
  const requestUrls = [];
  const response = await withFetch(
    async (input, options = {}) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      requestUrls.push(url);
      if (url.hostname === "www.tgju.org" && url.pathname.endsWith("/price_dollar_rl"))
        return new Response(tgjuPage(dollarRows), { status: 200 });
      if (url.hostname === "www.tgju.org" && url.pathname.endsWith("/geram18"))
        return new Response("unavailable", { status: 503 });
      if (url.hostname === "www.chartgoldprice.com") return new Response("unavailable", { status: 503 });
      if (url.hostname === "api.gold-api.com") {
        assert.equal(options.headers["x-api-key"], "history-secret");
        return new Response(
          JSON.stringify([
            { day: dates[0], avg_price: 31.1034768 * 100 },
            { day: dates[1], avg_price: 31.1034768 * 110 },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected-provider:${url.hostname}`);
    },
    async () =>
      historyRequest("https://app.test/api/history?assets=gold&range=all", { GOLD_API_KEY: "history-secret" }),
  );
  const data = await response.json();
  const gold = data.assets.gold;
  assert.equal(response.status, 200);
  assert.equal(gold.coverage.source, "Gold API");
  assert.ok(gold.coverage.candidateSources.includes("Gold API"));
  assert.equal(gold.points[0].value, 17_250_000);
  assert.equal(requestUrls.some((url) => url.searchParams.has("key") || url.searchParams.has("api_key")), false);
});
