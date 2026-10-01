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
      const url = new URL(typeof input === "string" ? input : input.url);
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

test("Yahoo metal history remains inactive until its license is explicitly confirmed", async () => {
  const response = await historyRequest("https://app.test/api/history?assets=copper&range=all");
  const data = await response.json();
  assert.equal(data.assets.copper.coverage.status, "unavailable");
  assert.equal(data.assets.copper.coverage.reason, "yahoo-license-not-confirmed");
});
