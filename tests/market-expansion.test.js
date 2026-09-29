import test from "node:test";
import assert from "node:assert/strict";
import { aggregate } from "../functions/api/market.js";
import {
  PORTFOLIO_ASSETS,
  appendTransactions,
  calculatePortfolio,
  createPortfolioAsset,
  createEmptyPortfolio,
  createTransaction,
  marketPriceAt,
  portfolioContributionSeries,
  portfolioCostBasis,
} from "../src/portfolio.js";
import { lastKnownMarketQuote } from "../src/market/last-known.js";
import { createHistoryExport, parseHistoryExport } from "../src/history.js";

test("two-source disagreement still returns a median estimate with lower confidence", () => {
  const result = aggregate("bitcoin", [
    { asset: "bitcoin", price: 2000000000, source: "CoinGecko", unit: "coin" },
    { asset: "bitcoin", price: 2200000000, source: "Binance", unit: "coin" },
  ]);
  assert.equal(result.price, 2100000000);
  assert.equal(result.unit, "coin");
  assert.equal(result.sourceCount, 2);
  assert.equal(result.status, "degraded");
  assert.equal(result.confidence, "low");
  assert.equal(result.consensusDisagreement, true);
  assert.equal(result.consensusCalibrated, false);
});

test("fresh FX and gold quotes produce midpoint estimates and exclude older observations", () => {
  const dollar = aggregate("dollar", [
    { asset: "dollar", price: 234615, source: "TGJU", unit: "TOMAN", observedAt: "2026-09-25T11:18:00.000Z" },
    { asset: "dollar", price: 232700, source: "Bonbast", unit: "TOMAN", observedAt: "2026-09-25T11:26:00.000Z" },
    { asset: "dollar", price: 234000, source: "Navasan", unit: "TOMAN", observedAt: "2026-09-24T17:30:00.000Z" },
  ]);
  assert.equal(dollar.price, 233658);
  assert.equal(dollar.status, "degraded");
  assert.equal(dollar.sourceCount, 2);
  assert.equal(dollar.consensusDisagreement, true);
  assert.equal(dollar.sourceValues.find((source) => source.source === "Navasan").exclusionReason, "older-observation");

  const gold = aggregate("gold", [
    { asset: "gold", price: 24124600, source: "TGJU", unit: "gram", observedAt: "2026-09-25T11:18:00.000Z" },
    { asset: "gold", price: 23881527, source: "Bonbast", unit: "gram", observedAt: "2026-09-25T11:26:00.000Z" },
    { asset: "gold", price: 24054670, source: "Navasan", unit: "gram", observedAt: "2026-09-25T02:10:00.000Z" },
  ]);
  assert.equal(gold.price, 24003064);
  assert.equal(gold.status, "degraded");
  assert.equal(gold.sourceCount, 2);
  assert.equal(gold.consensusDisagreement, true);
});

test("two identical source values can be combined while thresholds await calibration", () => {
  const result = aggregate("bitcoin", [
    { asset: "bitcoin", price: 2000000000, source: "A", unit: "coin" },
    { asset: "bitcoin", price: 2000000000, source: "B", unit: "coin" },
  ]);
  assert.equal(result.price, 2000000000);
  assert.equal(result.status, "degraded");
  assert.equal(result.unknownObservationCount, 2);
  assert.equal(result.sourceCount, 2);
});

test("three-source aggregation rejects a strong outlier", () => {
  const result = aggregate("bitcoin", [
    { asset: "bitcoin", price: 2000000000, source: "A", unit: "coin" },
    { asset: "bitcoin", price: 2000000000, source: "B", unit: "coin" },
    { asset: "bitcoin", price: 2000000000, source: "C", unit: "coin" },
    { asset: "bitcoin", price: 9000000000, source: "Outlier", unit: "coin" },
  ]);
  assert.equal(result.price, 2000000000);
  assert.equal(result.sourceCount, 3);
  assert.equal(result.status, "degraded");
  assert.equal(result.sources.includes("Outlier"), false);
});

test("attached FX and gold readings use provisional bands after outlier filtering", () => {
  const dollar = aggregate("dollar", [
    { asset: "dollar", price: 231705, source: "TGJU", unit: "TOMAN" },
    { asset: "dollar", price: 231500, source: "Bonbast", unit: "TOMAN" },
    { asset: "dollar", price: 232000, source: "Navasan", unit: "TOMAN" },
  ]);
  assert.equal(dollar.price, 231705);
  assert.equal(dollar.status, "degraded");
  assert.equal(dollar.confidence, "low");
  assert.equal(dollar.sourceCount, 3);
  assert.equal(dollar.agreementTolerancePct, 0.25);
  assert.equal(dollar.consensusCalibrated, false);

  const gold = aggregate("gold", [
    { asset: "gold", price: 23765900, source: "TGJU", unit: "gram" },
    { asset: "gold", price: 23883835, source: "Bonbast", unit: "gram" },
    { asset: "gold", price: 23777640, source: "Navasan", unit: "gram" },
  ]);
  assert.equal(gold.price, 23771770);
  assert.equal(gold.status, "degraded");
  assert.equal(gold.confidence, "low");
  assert.equal(gold.sourceCount, 2);
  assert.equal(gold.agreementTolerancePct, 0.1);
  assert.equal(gold.sources.includes("Bonbast"), false);

  const beyondBand = aggregate("dollar", [
    { asset: "dollar", price: 231705, source: "A", unit: "TOMAN" },
    { asset: "dollar", price: 232300, source: "B", unit: "TOMAN" },
  ]);
  assert.equal(beyondBand.status, "degraded");
  assert.equal(beyondBand.price, 232003);
  assert.equal(beyondBand.consensusDisagreement, true);

  const now = new Date().toISOString();
  const provisionalMarket = { updatedAt: now, assets: { gold: { ...gold, retrievedAt: now } }, history: {} };
  assert.equal(marketPriceAt(provisionalMarket, "gold", now), 23771770);
});

test("last-known market quotes require a valid observation time and stay separate from current valuation", () => {
  const now = "2026-09-23T18:00:00.000Z";
  const market = {
    updatedAt: now,
    assets: { gold: { price: null, status: "conflicted", observedAt: now } },
    history: {
      gold: [
        { date: "2026-09-23T17:30:00.000Z", price: 23770000, source: "TGJU" },
        { price: 999, source: "Unknown time" },
      ],
    },
  };
  const cached = {
    assets: {
      gold: { price: 23765000, status: "provisional", observedAt: "2026-09-23T17:45:00.000Z", retrievedAt: now },
    },
  };
  const fallback = lastKnownMarketQuote("gold", market, cached, new Date(now).getTime());
  assert.equal(fallback.price, 23765000);
  assert.equal(fallback.observedAt, "2026-09-23T17:45:00.000Z");

  assert.equal(lastKnownMarketQuote("gold", market, null, new Date(now).getTime()).price, 23770000);
  assert.equal(
    lastKnownMarketQuote("bitcoin", { history: { bitcoin: [{ price: 10 }] } }, null, new Date(now).getTime()),
    null,
  );
  assert.equal(
    marketPriceAt({ updatedAt: now, assets: {}, history: { gold: market.history.gold } }, "gold", now),
    null,
  );
  assert.equal(
    marketPriceAt(
      { updatedAt: now, assets: {}, history: { gold: market.history.gold } },
      "gold",
      "2026-09-23T17:45:00.000Z",
    ),
    23770000,
  );

  const offlineMarket = {
    ...cached,
    updatedAt: now,
    assets: {},
    history: market.history,
    diagnostics: null,
    _currentQuotesUnavailableAt: now,
  };
  assert.equal(lastKnownMarketQuote("gold", offlineMarket, cached, new Date(now).getTime()).price, 23765000);
  assert.equal(marketPriceAt(offlineMarket, "gold", now), null);
});

test("history exports preserve provisional quote and currency dependency status", () => {
  const record = {
    createdAt: "2026-09-23T18:00:00.000Z",
    total: 1000,
    contributionRate: 20,
    weights: { fixed: 70, gold: 20, currency: 8, silver: 2 },
    marketSnapshot: {
      capturedAt: "2026-09-23T18:00:00.000Z",
      assets: {
        gold: {
          price: 23771770,
          status: "provisional",
          confidence: "medium",
          consensusPolicyVersion: "quote-consensus-v2-provisional",
          consensusCalibrated: false,
          agreementTolerancePct: 0.1,
          dependencies: [{ instrumentId: "dollar", status: "provisional", confidence: "medium" }],
        },
      },
    },
  };
  const exported = createHistoryExport([record]);
  const parsed = parseHistoryExport(JSON.parse(JSON.stringify(exported)));
  const quote = parsed.records[0].marketSnapshot.assets.gold;
  assert.equal(quote.status, "provisional");
  assert.equal(quote.dependencies[0].status, "provisional");
  assert.equal(quote.agreementTolerancePct, 0.1);
});

test("market-priced crypto can be added to the immutable portfolio ledger", () => {
  const now = "2026-09-20T00:00:00.000Z";
  const portfolio = createEmptyPortfolio(now);
  const market = {
    updatedAt: now,
    assets: { bitcoin: { price: 2000000000 } },
    history: {},
  };
  const transaction = createTransaction(
    {
      type: "OPENING",
      assetId: "bitcoin",
      quantity: 0.1,
      date: now,
      source: "test",
    },
    market,
    now,
    portfolio,
  );
  assert.ok(transaction);
  assert.equal(transaction.unitPrice, 2000000000);
  const appended = appendTransactions(portfolio, [transaction], { action: "test-opening" });
  assert.equal(appended.validation.valid, true);
  const result = calculatePortfolio(appended.portfolio, market, now);
  assert.equal(result.holdings.bitcoin, 0.1);
  assert.equal(result.currentValue, 200000000);
  assert.equal(result.missingPrices.length, 0);
});

test("portfolio separates net worth, investable capital, liquidity, and strategy sleeves", () => {
  const now = "2026-09-20T00:00:00.000Z";
  const portfolio = createEmptyPortfolio(now);
  const market = {
    updatedAt: now,
    assets: {
      gold: {
        price: 10,
        status: "healthy",
        observedAt: now,
        retrievedAt: now,
        quoteType: "direct",
        sleeveId: "gold",
        sourceCount: 2,
        configuredSourceCount: 3,
        spreadPct: 0,
        sourceValues: [{ source: "A", price: 10, quoteType: "direct", observedAt: now }],
        consensusPolicyVersion: "quote-consensus-v1",
        dependencies: [
          {
            instrumentId: "dollar",
            source: "A, B",
            sourceCount: 2,
            status: "healthy",
            confidence: "medium",
            observedAt: now,
            retrievedAt: now,
          },
        ],
      },
    },
    history: {},
  };
  const transactions = [
    createTransaction({ type: "OPENING", assetId: "cash", quantity: 1000, unitPrice: 1, date: now }, market, now),
    createTransaction({ type: "OPENING", assetId: "gold", quantity: 10, date: now }, market, now),
    createTransaction({ type: "OPENING", assetId: "other", quantity: 5000, unitPrice: 1, date: now }, market, now),
  ];
  const saved = appendTransactions(portfolio, transactions).portfolio;
  const result = calculatePortfolio(saved, market, now);
  assert.equal(result.netWorth, 6100);
  assert.equal(result.investableTotal, 1100);
  assert.equal(result.liquidTotal, 1100);
  assert.equal(result.sleeveValues.liquidity, 1000);
  assert.equal(result.sleeveValues.gold, 100);
  const goldQuote = result.transactions.find((transaction) => transaction.assetId === "gold").marketQuote;
  assert.equal(goldQuote.observedAt, now);
  assert.equal(goldQuote.quoteType, "direct");
  assert.equal(goldQuote.sourceCount, 2);
  assert.equal(goldQuote.consensusPolicyVersion, "quote-consensus-v1");
  assert.equal(goldQuote.dependencies[0].instrumentId, "dollar");
  assert.equal(goldQuote.sleeveId, "gold");
  assert.equal(goldQuote.configuredSourceCount, 3);
  assert.equal(goldQuote.sourceValues[0].source, "A");
});

test("invalid quote timestamps stay unknown when portfolio records are normalized", () => {
  const now = "2026-09-20T00:00:00.000Z";
  const portfolio = createEmptyPortfolio(now);
  const transaction = createTransaction(
    { type: "OPENING", assetId: "bitcoin", quantity: 1, date: now },
    {
      updatedAt: now,
      assets: { bitcoin: { price: 100, observedAt: "not-a-date", retrievedAt: now } },
      history: {},
    },
    now,
    portfolio,
  );
  transaction.marketQuote.retrievedAt = "also-not-a-date";
  const appended = appendTransactions(portfolio, [transaction]).portfolio;
  const quote = appended.versions[0].transactions.find((entry) => entry.assetId === "bitcoin").marketQuote;
  assert.equal(quote.observedAt, null);
  assert.equal(quote.retrievedAt, null);
});

test("portfolio refuses a market asset entry when no valid price exists", () => {
  const now = "2026-09-20T00:00:00.000Z";
  const portfolio = createEmptyPortfolio(now);
  const transaction = createTransaction(
    {
      type: "OPENING",
      assetId: "platinum",
      quantity: 10,
      date: now,
    },
    { updatedAt: now, assets: {}, history: {} },
    now,
    portfolio,
  );
  assert.equal(transaction, null);
});

test("conflicted live quotes are excluded from portfolio valuation", () => {
  const now = "2026-09-20T00:00:00.000Z";
  const portfolio = createEmptyPortfolio(now);
  const transaction = createTransaction(
    { type: "OPENING", assetId: "bitcoin", quantity: 0.1, unitPrice: 10, date: now },
    null,
    now,
  );
  const saved = appendTransactions(portfolio, [transaction]).portfolio;
  const valuation = calculatePortfolio(
    saved,
    {
      updatedAt: now,
      assets: { bitcoin: { price: null, status: "conflicted", retrievedAt: now } },
      history: {},
    },
    now,
  );
  assert.equal(valuation.values.bitcoin.value, null);
  assert.deepEqual(valuation.missingPrices, ["bitcoin"]);
});

test("cost basis follows buys, average-cost sales, and transfers without changing ledger values", () => {
  const transactions = [
    { type: "BUY", assetId: "gold", quantity: 2, unitPrice: 100, fee: 10, date: "2026-01-01" },
    { type: "BUY", assetId: "gold", quantity: 1, unitPrice: 130, fee: 0, date: "2026-01-02" },
    { type: "SELL", assetId: "gold", quantity: 1, unitPrice: 150, fee: 0, date: "2026-01-03" },
    { type: "TRANSFER", assetId: "gold", quantity: 1, targetAssetId: "silver", targetQuantity: 2, date: "2026-01-04" },
  ];
  const basis = portfolioCostBasis(transactions, "2026-01-05");
  assert.equal(basis.gold.quantity, 1);
  assert.ok(Math.abs(basis.gold.basis - 340 / 3) < 1e-10);
  assert.equal(basis.silver.quantity, 2);
  assert.ok(Math.abs(basis.silver.basis - 340 / 3) < 1e-10);
});

test("monthly contribution series uses only months with recorded ledger inflows", () => {
  const series = portfolioContributionSeries(
    [
      { type: "OPENING", assetId: "gold", quantity: 1, unitPrice: 100, fee: 5, date: "2026-01-12" },
      { type: "DEPOSIT", assetId: "cash", amount: 50, date: "2026-02-02" },
      { type: "SELL", assetId: "gold", quantity: 1, unitPrice: 125, date: "2026-03-02" },
    ],
    "2026-03-15",
    12,
  );
  assert.deepEqual(
    series.map((point) => point.value),
    [105, 50],
  );
  assert.equal(series.length, 2);
});

test("silver conflict values and a last-known reading stay outside current portfolio valuation", () => {
  const now = "2026-09-23T18:00:00.000Z";
  const staleDate = "2026-09-21T13:30:00.000Z";
  const market = {
    updatedAt: now,
    assets: {
      silver: {
        price: null,
        status: "conflicted",
        retrievedAt: now,
        sourceValues: [
          { source: "TGJU", price: 501240, observedAt: "2026-09-23T17:00:00.000Z" },
          { source: "Auxiliary metal source", price: 486249, observedAt: "2026-09-23T16:45:00.000Z" },
        ],
      },
    },
    history: { silver: [{ date: staleDate, price: 508750, source: "TGJU" }] },
  };
  const portfolio = createEmptyPortfolio(now);
  const opening = createTransaction(
    {
      type: "OPENING",
      assetId: "silver",
      quantity: 2,
      unitPrice: 500000,
      date: "2026-09-21",
    },
    market,
    now,
    portfolio,
  );
  const saved = appendTransactions(portfolio, [opening]).portfolio;
  const valuation = calculatePortfolio(saved, market, now);
  const lastKnown = lastKnownMarketQuote("silver", market, null, new Date(now).getTime());
  assert.deepEqual(
    market.assets.silver.sourceValues.map((item) => item.price),
    [501240, 486249],
  );
  assert.equal(lastKnown.price, 508750);
  assert.equal(valuation.values.silver.value, null);
  assert.equal(valuation.currentValue, 0);
  assert.deepEqual(valuation.missingPrices, ["silver"]);
});

test("all investable catalog assets and a named manual holding can be recorded in the ledger", () => {
  const now = "2026-09-23T18:00:00.000Z";
  let portfolio = createEmptyPortfolio(now);
  const catalogIds = Object.values(PORTFOLIO_ASSETS)
    .filter((asset) => asset.isInvestable)
    .map((asset) => asset.id);
  const manual = createPortfolioAsset(portfolio, { title: "فولاد", kind: "stock", unit: "TOMAN" }, now);
  portfolio = manual.portfolio;
  const transactions = catalogIds.map((assetId) =>
    createTransaction(
      {
        type: "OPENING",
        assetId,
        quantity: 1,
        unitPrice: 1,
        date: now,
      },
      { assets: {}, history: {} },
      now,
      portfolio,
    ),
  );
  transactions.push(
    createTransaction(
      {
        type: "OPENING",
        assetId: manual.asset.id,
        quantity: 5000000,
        unitPrice: 1,
        date: now,
      },
      { assets: {}, history: {} },
      now,
      portfolio,
    ),
  );
  const saved = appendTransactions(portfolio, transactions).portfolio;
  const valuation = calculatePortfolio(saved, { assets: {}, history: {} }, now);
  catalogIds.forEach((assetId) => assert.equal(valuation.holdings[assetId], 1));
  assert.equal(valuation.holdings[manual.asset.id], 5000000);
  assert.equal(valuation.assets[manual.asset.id].title, "فولاد");
});
