import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSET_KEYS,
  DEFAULT_ALLOCATION,
  DEFAULT_ASSUMPTIONS,
  buildHistoricalReturns,
  backtestHistorical,
  covarianceMatrix,
  contributionRebalance,
  estimateReturnModel,
  evaluateGoal,
  recommendAllocation,
  runMonteCarlo,
  simulatePlan,
  walkForwardValidation,
} from "../src/engine.js";
import {
  createHistoryExport,
  createPersonalBackup,
  createPlanHistoryRecord,
  mergeHistory,
  parseHistoryExport,
  parsePersonalBackup,
  sanitizeHistoryEntry,
} from "../src/history.js";
import { SIMULATION_ASSET_KEYS } from "../src/market/catalog.js";
import {
  activePortfolioVersion,
  appendTransactions,
  calculatePortfolio,
  createPortfolioAsset,
  createEmptyPortfolio,
  createPortfolioVersion,
  createTransaction,
  portfolioSeries,
} from "../src/portfolio.js";

function series(start = 100, growth = 0.02, count = 36) {
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(Date.UTC(2020 + Math.floor(index / 12), index % 12, 1)).toISOString(),
    value: start * Math.pow(1 + growth, index),
  }));
}

const market = {
  assets: {
    dollar: { price: 500000 },
    gold: { price: 10000000 },
    silver: { price: 200000 },
  },
  funds: { fixedIncome: { effectiveAnnualReturn: 25 } },
  history: { dollar: series(400000, 0.02), gold: series(8000000, 0.025), silver: series(150000, 0.03) },
};

test("recommendation stays normalized and defensive for a conservative profile", () => {
  const profile = {
    age: 45,
    horizonYears: 5,
    goal: "preservation",
    riskTolerance: "conservative",
    incomeStability: "mixed",
    emergencyFund: "partial",
  };
  const result = recommendAllocation(profile);
  assert.equal(Math.round(Object.values(result.weights).reduce((sum, value) => sum + value, 0)), 100);
  assert.deepEqual(
    Object.fromEntries(["fixed", "gold", "currency", "silver"].map((assetId) => [assetId, result.weights[assetId]])),
    { fixed: 80, gold: 11, currency: 0, silver: 9 },
  );
  assert.ok(result.weights.fixed >= 60);
  assert.ok(result.weights.silver >= 3);
  assert.ok(Object.values(result.weights).every((weight) => weight === 0 || weight >= 3));
  const withFx = recommendAllocation(profile, { includeCurrency: true });
  assert.ok(withFx.weights.currency >= 3);
  ["bitcoin", "ethereum", "platinum", "palladium", "copper"].forEach((assetId) => {
    assert.equal(result.weights[assetId], 0);
  });
  assert.equal(Object.hasOwn(result.weights, "tether"), false);
});

test("optional recommendation assets use volatility-weighted sleeves and the profile crypto cap", () => {
  const assumptions = {
    ...DEFAULT_ASSUMPTIONS,
    silver: { annualReturn: 0.25, annualVolatility: 0.2 },
    copper: { annualReturn: 0.25, annualVolatility: 0.4 },
    bitcoin: { annualReturn: 0.25, annualVolatility: 0.4 },
    ethereum: { annualReturn: 0.25, annualVolatility: 0.8 },
  };
  const profile = { riskTolerance: "growth", horizonYears: 10, goal: "growth" };
  const base = recommendAllocation(profile, { assumptions });
  const result = recommendAllocation(profile, {
    enabledAssets: ["copper", "bitcoin", "ethereum", "tether", "bourseIndex"],
    assumptions,
  });
  const total = Object.values(result.weights).reduce((sum, value) => sum + value, 0);
  assert.equal(Math.round(total), 100);
  assert.equal(result.weights.bitcoin + result.weights.ethereum, 5);
  assert.ok([result.weights.bitcoin, result.weights.ethereum].every((weight) => weight === 0 || weight >= 3));
  assert.ok(result.weights.bitcoin > result.weights.ethereum);
  assert.ok(result.weights.silver > result.weights.copper);
  assert.ok(result.weights.silver + result.weights.copper < base.weights.silver);
  assert.ok(result.weights.silver + result.weights.copper > 0);
  assert.equal(Object.hasOwn(result.weights, "tether"), false);
  assert.equal(Object.hasOwn(result.weights, "bourseIndex"), false);
});

test("crypto recommendation targets follow the profile and never exceed five percent", () => {
  [
    ["conservative", 0],
    ["balanced", 3],
    ["growth", 5],
  ].forEach(([riskTolerance, expected]) => {
    const recommendation = recommendAllocation(
      { riskTolerance, horizonYears: 10 },
      { enabledAssets: ["bitcoin", "ethereum"] },
    );
    const cryptoWeight = recommendation.weights.bitcoin + recommendation.weights.ethereum;
    assert.equal(cryptoWeight, expected);
    assert.ok(cryptoWeight <= 5);
  });
});

test("deterministic simulation accounts for contribution growth and inflation", () => {
  const result = simulatePlan({
    initialInvestment: 1000,
    monthlyContribution: 100,
    contributionGrowth: 0.1,
    inflationRate: 0.2,
    horizonYears: 2,
    allocation: { fixed: 100 },
    annualReturns: { fixed: { annualReturn: 0 } },
    rebalance: true,
  });
  assert.ok(result.totalInvested > 1000 + 24 * 100);
  assert.equal(result.finalValue, result.totalInvested);
  assert.ok(result.finalRealValue < result.finalValue);
});

test("simulation supports registered assets including Tether without adding them to recommendations", () => {
  ["bitcoin", "ethereum", "copper", "platinum", "palladium", "tether"].forEach((assetId) => {
    assert.equal(DEFAULT_ALLOCATION[assetId], 0, `${assetId} should be opt-in for simulation`);
  });
  const result = simulatePlan({
    initialInvestment: 1000,
    monthlyContribution: 0,
    horizonYears: 1,
    allocation: { tether: 100 },
    annualReturns: { tether: { annualReturn: 0.12 } },
    rebalance: true,
  });
  assert.equal(result.holdings.tether, result.finalValue);
  assert.ok(result.finalValue > 1000);
  assert.equal(recommendAllocation({}).weights.tether, undefined);
});

test("each optional recommendation asset is available as a weighted simulation scenario", () => {
  ["bitcoin", "ethereum", "copper", "platinum", "palladium"].forEach((assetId) => {
    const result = simulatePlan({
      initialInvestment: 1000,
      horizonYears: 1,
      allocation: { [assetId]: 100 },
      annualReturns: { [assetId]: { annualReturn: 0.12 } },
    });
    assert.equal(result.holdings[assetId], result.finalValue, `${assetId} should retain the full scenario value`);
    assert.ok(result.finalValue > 1000, `${assetId} should use its configured scenario return`);
  });
});

test("new contributions close allocation gaps without selling", () => {
  const plan = contributionRebalance(
    { fixed: 900, gold: 100, currency: 0, silver: 0 },
    { fixed: 50, gold: 30, currency: 15, silver: 5 },
    100,
  );
  assert.equal(Math.round(Object.values(plan.amounts).reduce((sum, value) => sum + value, 0)), 100);
  assert.ok(plan.amounts.gold > plan.amounts.fixed);
  assert.ok(plan.amounts.currency > 0);
  assert.ok(plan.amounts.silver > 0);
});

test("contribution weights, target weights, and current portfolio deviation use separate denominators", () => {
  const plan = contributionRebalance({ fixed: 0, gold: 100, silver: 0 }, { fixed: 74, gold: 14, silver: 12 }, 100, [
    "fixed",
    "gold",
    "silver",
  ]);
  assert.equal(plan.currentWeights.gold, 100);
  assert.ok(Math.abs(plan.targetWeights.gold - 14) < 1e-10);
  assert.equal(plan.deviationPercentagePoints.gold, 86);
  assert.equal(plan.contributionWeights.gold, 0);
  assert.ok(Math.abs(plan.contributionWeights.fixed + plan.contributionWeights.silver - 100) < 1e-10);
  assert.equal(plan.contributionAmounts.gold, 0);
  assert.ok(Math.abs(plan.contributionAmounts.fixed - 86) < 0.02);
  assert.ok(Math.abs(plan.contributionAmounts.silver - 14) < 0.02);
  assert.ok(Math.abs(Object.values(plan.contributionAmounts).reduce((sum, amount) => sum + amount, 0) - 100) < 1e-10);
});

test("historical backtest returns requested risk metrics", () => {
  const result = backtestHistorical({
    market,
    allocation: { fixed: 0, gold: 40, currency: 40, silver: 20 },
    initialInvestment: 1000,
    monthlyContribution: 100,
    contributionGrowth: 0,
    inflationRate: 0.2,
    horizonYears: 2,
    rebalance: true,
  });
  assert.equal(result.available, true);
  assert.ok(result.best && result.worst);
  assert.ok(Number.isFinite(result.median.cagr));
  assert.ok(Number.isFinite(result.median.maxDrawdown));
  assert.equal(Object.keys(result.coverage).length, ASSET_KEYS.length);
});

test("backtest uses observed copper history and refuses assumption-filled crypto history", () => {
  const copperMarket = { history: { copper: series(100, 0.02, 36) } };
  const observed = backtestHistorical({
    market: copperMarket,
    allocation: { copper: 100 },
    initialInvestment: 1000,
    horizonYears: 1,
  });
  assert.equal(observed.available, true);
  assert.equal(observed.estimated, false);

  const missing = backtestHistorical({
    market,
    allocation: { bitcoin: 100 },
    initialInvestment: 1000,
    horizonYears: 1,
  });
  assert.equal(missing.available, false);
  assert.equal(missing.estimated, false);
  assert.deepEqual(missing.unobservedAssets, ["bitcoin"]);
});

test("backtest reports monthly observed ranges and the longest continuous selected-asset overlap", () => {
  const prices = series(100, 0.02, 36).filter((point) => {
    const date = new Date(point.date);
    const monthIndex = (date.getUTCFullYear() - 2020) * 12 + date.getUTCMonth();
    return ![10, 11, 12].includes(monthIndex);
  });
  const result = backtestHistorical({
    market: { history: { gold: prices } },
    allocation: { gold: 100 },
    initialInvestment: 1000,
    horizonYears: 2,
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "insufficient-continuous-overlap");
  assert.equal(result.frequency, "monthly");
  assert.deepEqual(result.requiredAssets, ["gold"]);
  assert.equal(result.longestContinuousMonths, 22);
  assert.equal(result.rangesByAsset.gold.length, 2);
  assert.equal(result.jointRanges.length, 2);
});

test("Monte Carlo returns ordered percentile outputs", () => {
  let state = 17;
  const random = () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
  const result = runMonteCarlo({
    market,
    allocation: { fixed: 60, gold: 20, currency: 15, silver: 5 },
    initialInvestment: 0,
    monthlyContribution: 100,
    horizonYears: 3,
    inflationRate: 0.2,
    paths: 1000,
    random,
  });
  assert.equal(result.paths, 1000);
  assert.ok(result.nominal.p10 <= result.nominal.p50);
  assert.ok(result.nominal.p50 <= result.nominal.p90);
  assert.ok(result.real.p10 <= result.real.p90);
});

test("planning and assumption-based simulation remain usable without market services", () => {
  const offlineMarket = { assets: {}, funds: {}, history: {} };
  const options = {
    market: offlineMarket,
    allocation: { fixed: 55, gold: 25, currency: 15, silver: 5 },
    initialInvestment: 1_000_000,
    monthlyContribution: 5_000_000,
    horizonYears: 5,
    assumptions: DEFAULT_ASSUMPTIONS,
    paths: 1000,
    seed: 42,
  };
  const plan = simulatePlan(options);
  const simulation = runMonteCarlo(options);
  const backtest = backtestHistorical({ ...options, horizonYears: 1 });
  assert.ok(Number.isFinite(plan.finalValue));
  assert.ok(Number.isFinite(simulation.nominal.p50));
  assert.equal(simulation.estimated, true);
  assert.equal(backtest.available, false);
  assert.equal(backtest.estimated, false);
});

test("Monte Carlo respects an explicitly supplied zero covariance matrix", () => {
  const model = Object.fromEntries(ASSET_KEYS.map((asset) => [asset, { annualReturn: 0, annualVolatility: 0.9 }]));
  const covariance = ASSET_KEYS.map(() => ASSET_KEYS.map(() => 0));
  const result = runMonteCarlo({
    allocation: { fixed: 25, gold: 25, currency: 25, silver: 25 },
    initialInvestment: 100,
    monthlyContribution: 0,
    horizonYears: 1,
    paths: 1000,
    returnModel: model,
    covariance,
    fixedIncomeMode: "user-expected",
    transactionCosts: Object.fromEntries(ASSET_KEYS.map((asset) => [asset, { buyFee: 0, sellFee: 0, spread: 0 }])),
    random: () => 0.1,
  });
  assert.equal(result.nominal.p10, 100);
  assert.equal(result.nominal.p50, 100);
  assert.equal(result.nominal.p90, 100);
});

test("covariance uses observed overlaps only and shrinks short samples", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    returns: { gold: index / 100, currency: index / 100 },
    observed: { gold: true, currency: true },
  }));
  const model = { gold: { annualVolatility: 0.2 }, currency: { annualVolatility: 0.2 } };
  const paired = covarianceMatrix(rows, ["gold", "currency"], model);
  assert.ok(Math.abs(paired[0][1] - (0.2 / Math.sqrt(12)) ** 2 * 0.825) < 1e-10);
  assert.ok(Math.abs(paired[0][0] - (0.2 / Math.sqrt(12)) ** 2) < 1e-10);
  const unobserved = rows.map((row) => ({ ...row, observed: { gold: true, currency: false } }));
  assert.ok(covarianceMatrix(unobserved, ["gold", "currency"], model)[0][1] > 0);
});

test("modeled fallback returns never become observed history or estimated covariance", () => {
  const historical = buildHistoricalReturns({ history: { gold: series(100, 0.01, 36) } });
  assert.equal(
    historical.rows.every((row) => row.observed.currency === false),
    true,
  );
  const result = estimateReturnModel({ history: { gold: series(100, 0.01, 36) } });
  assert.equal(result.model.currency.observed, false);
  assert.equal(result.model.currency.annualReturn, DEFAULT_ASSUMPTIONS.currency.annualReturn);
  assert.ok(result.covariance[1][2] > 0, "missing paired data uses the documented non-independent prior");
  const validation = walkForwardValidation({ history: { gold: series(100, 0.01, 36) } });
  assert.ok(validation.diagnostics.gold.observations >= 3);
});

test("advanced forecast methods require 24 walk-forward forecasts after their training window", () => {
  const tooShort = walkForwardValidation({ history: { gold: series(100, 0.01, 48) } });
  assert.equal(tooShort.diagnostics.gold.observations, 23);
  assert.equal(tooShort.diagnostics.gold.available, false);
  const sufficient = walkForwardValidation({ history: { gold: series(100, 0.01, 49) } });
  assert.equal(sufficient.diagnostics.gold.observations, 24);
  assert.equal(sufficient.diagnostics.gold.available, true);
});

test("block bootstrap falls back to versioned assumptions for assets with fewer than 24 observed returns", () => {
  const market = {
    history: {
      gold: [
        { date: "2025-01-01", value: 100 },
        { date: "2025-02-01", value: 500 },
        { date: "2025-03-01", value: 100 },
      ],
    },
  };
  const result = runMonteCarlo({
    market,
    allocation: { fixed: 0, gold: 100, currency: 0, silver: 0 },
    initialInvestment: 1000,
    monthlyContribution: 0,
    horizonYears: 1,
    paths: 1000,
    method: "block-bootstrap",
    random: () => 0.4,
  });
  assert.ok(Number.isFinite(result.nominal.p10));
  assert.equal(result.nominal.p10, result.nominal.p90);
  assert.equal(result.method, "gaussian");
  assert.equal(result.methodFallbackReason, "insufficient-joint-monthly-history");
});

test("goal planner calculates probability and required contribution deterministically", () => {
  const model = Object.fromEntries(ASSET_KEYS.map((asset) => [asset, { annualReturn: 0, annualVolatility: 0 }]));
  const covariance = ASSET_KEYS.map(() => ASSET_KEYS.map(() => 0));
  const result = evaluateGoal({
    targetToday: 2000,
    horizonYears: 1,
    initialInvestment: 1000,
    monthlyContribution: 100,
    inflationRate: 0,
    desiredProbability: 0.75,
    allocation: { fixed: 100 },
    returnModel: model,
    covariance,
  });
  assert.equal(result.available, true);
  assert.equal(result.successProbability, 1);
  assert.ok(result.requiredMonthlyContribution >= 83.3);
  assert.ok(result.requiredMonthlyContribution <= 83.4);
  assert.equal(result.targetNominal, 2000);
  assert.equal(result.modelAssumptionVersion, "ir-planning-v2");
});

test("history export preserves quote provenance while accepting legacy snapshots", () => {
  const record = {
    createdAt: "2026-01-01T00:00:00.000Z",
    total: 1000,
    contributionRate: 20,
    weights: { fixed: 70, gold: 20, currency: 8, silver: 2 },
    selectedAssets: ["bitcoin", "copper", "tether"],
    salary: 5000,
    marketSnapshot: {
      capturedAt: "2026-01-01T00:00:00.000Z",
      assets: {
        dollar: {
          price: 500000,
          sleeveId: "fx",
          quoteType: "derived",
          derivedFrom: ["USD/EUR", "EUR/TOMAN"],
          sourceValues: [{ source: "A", price: 499000, quoteType: "direct", observedAt: "2025-12-31T23:54:00.000Z" }],
          dependencies: [
            {
              instrumentId: "dollar",
              source: "A, B",
              sourceCount: 2,
              status: "degraded",
              confidence: "medium",
              observedAt: "2025-12-31T23:55:00.000Z",
              retrievedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          observedAt: "2025-12-31T23:55:00.000Z",
          retrievedAt: "2026-01-01T00:00:00.000Z",
          sourceCount: 2,
          sources: ["A", "B"],
          status: "degraded",
          confidence: "medium",
          consensusPolicyVersion: "quote-consensus-v1",
          consensusCalibrated: false,
        },
      },
      funds: { fixedIncome: { effectiveAnnualReturn: 25 } },
    },
  };
  const exported = createHistoryExport([record]);
  const parsed = parseHistoryExport(JSON.parse(JSON.stringify(exported)));
  assert.equal(exported.schema, "invest-consult-history");
  assert.equal(parsed.records.length, 1);
  assert.equal(
    parsed.records[0].weights.fixed +
      parsed.records[0].weights.gold +
      parsed.records[0].weights.currency +
      parsed.records[0].weights.silver,
    100,
  );
  assert.equal(parsed.records[0].marketSnapshot.assets.dollar.quoteType, "derived");
  assert.equal(parsed.records[0].marketSnapshot.assets.dollar.observedAt, "2025-12-31T23:55:00.000Z");
  assert.equal(parsed.records[0].marketSnapshot.assets.dollar.retrievedAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(parsed.records[0].marketSnapshot.assets.dollar.derivedFrom, ["USD/EUR", "EUR/TOMAN"]);
  assert.equal(parsed.records[0].marketSnapshot.assets.dollar.sleeveId, "fx");
  assert.equal(parsed.records[0].marketSnapshot.assets.dollar.sourceValues[0].price, 499000);
  assert.equal(parsed.records[0].marketSnapshot.assets.dollar.consensusCalibrated, false);
  assert.deepEqual(parsed.records[0].selectedAssets, ["bitcoin", "copper"]);
  assert.equal(parsed.records[0].weights.bitcoin, 0);
  assert.deepEqual(parsed.records[0].marketSnapshot.assets.dollar.dependencies, [
    {
      instrumentId: "dollar",
      price: null,
      sourceCount: 2,
      unit: "",
      source: "A, B",
      status: "degraded",
      confidence: "medium",
      observedAt: "2025-12-31T23:55:00.000Z",
      retrievedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  const oldSnapshot = parseHistoryExport([
    {
      createdAt: "2026-01-01T00:00:00.000Z",
      total: 1000,
      rate: 20,
      weights: { fixed: 70, gold: 20, currency: 8, silver: 2 },
      marketSnapshot: { assets: { dollar: { price: 500000 } } },
    },
  ]);
  assert.equal(oldSnapshot.records[0].marketSnapshot.assets.dollar.price, 500000);
  assert.equal(oldSnapshot.records[0].weights.ethereum, 0);
});

test("full personal backup round-trips plans and actual ledger separately and excludes unknown profile secrets", () => {
  const createdAt = "2026-10-07T12:00:00.000Z";
  const planRecord = createPlanHistoryRecord(
    {
      inputs: { monthlyContribution: 1000, contributionRate: 10, salary: 10000, profile: { goal: "growth" } },
      recommendation: { weights: { fixed: 100 } },
      contribution: {
        contributionAmounts: { fixed: 1000 },
        contributionWeights: { fixed: 100 },
        currentWeights: { fixed: 0 },
        deviationPercentagePoints: { fixed: -100 },
      },
    },
    [],
    createdAt,
  );
  let portfolio = createEmptyPortfolio(createdAt);
  const opening = createTransaction(
    { type: "OPENING", assetId: "gold", quantity: 2, unitPrice: 100, costBasisStatus: "confirmed", date: createdAt },
    null,
    createdAt,
    portfolio,
  );
  portfolio = appendTransactions(portfolio, [opening]).portfolio;
  const settings = {
    version: 3,
    inflationRate: 0.3,
    contributionGrowth: 0,
    paths: 2000,
    rebalance: true,
    targetDriftThresholdPercent: 3,
    assumptions: Object.fromEntries(SIMULATION_ASSET_KEYS.map((assetId) => [assetId, DEFAULT_ASSUMPTIONS[assetId]])),
    transactionCosts: Object.fromEntries(
      SIMULATION_ASSET_KEYS.map((assetId) => [assetId, { buyFee: null, sellFee: null, spread: null }]),
    ),
    inflationSource: null,
    inflationPeriod: null,
    inflationFetchedAt: null,
  };
  const backup = createPersonalBackup({
    profile: { salary: 10000, contributionRate: 10, apiKey: "must-not-export" },
    history: [planRecord],
    portfolio,
    modelSettings: settings,
    preferences: { locale: "en", currency: "USD", theme: "dark" },
  });
  const serialized = JSON.stringify(backup);
  assert.equal(serialized.includes("must-not-export"), false);
  assert.equal(serialized.includes("apiKey"), false);
  const restored = parsePersonalBackup(JSON.parse(serialized));
  assert.equal(restored.history[0].executionStatus, "not-linked");
  assert.equal(restored.history[0].plannedMonthlyAmount, 1000);
  assert.equal(activePortfolioVersion(restored.portfolio).transactions.length, 1);
  assert.equal(activePortfolioVersion(restored.portfolio).transactions[0].type, "OPENING");
  assert.equal(restored.profile.salary, 10000);
  assert.deepEqual(restored.preferences, { locale: "en", currency: "USD", theme: "dark" });
  assert.throws(
    () => parsePersonalBackup({ ...backup, modelSettings: { ...backup.modelSettings, inflationRate: 10 } }),
    /invalid-settings-format/,
  );
});

test("legacy rate records are accepted and invalid records are skipped", () => {
  const legacy = {
    createdAt: "2026-02-01",
    total: 2000,
    rate: 15,
    weights: { fixed: 80, gold: 15, currency: 5, silver: 0 },
  };
  assert.equal(sanitizeHistoryEntry(legacy).contributionRate, 15);
  const parsed = parseHistoryExport({ schema: "invest-consult-history", version: 1, history: [legacy, { total: -2 }] });
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.skipped, 1);
});

test("history merge keeps current duplicate timestamps and applies the limit", () => {
  const first = { createdAt: "2026-03-01", total: 1, contributionRate: 1, weights: { fixed: 100 } };
  const duplicate = { createdAt: "2026-03-01", total: 999, contributionRate: 99, weights: { gold: 100 } };
  const second = { createdAt: "2026-03-02", total: 2, contributionRate: 2, weights: { gold: 100 } };
  const merged = mergeHistory([first], [duplicate, second], 2);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].total, 1);
});

test("history import rejects inherited asset names and unbacked transfers without dropping ledger entries", () => {
  const base = createHistoryExport([], createEmptyPortfolio("2026-01-01T00:00:00.000Z"));
  const version = base.portfolio.versions[0];
  for (const assetId of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    version.transactions = [
      {
        id: `bad-${assetId}`,
        type: "BUY",
        assetId,
        quantity: 1,
        unitPrice: 10,
        date: "2026-01-01T00:00:00.000Z",
      },
    ];
    assert.throws(() => parseHistoryExport(base), /invalid-portfolio-ledger/);
  }

  version.transactions = [
    { id: "opening", type: "OPENING", assetId: "gold", quantity: 1, unitPrice: 10, date: "2026-01-01" },
    {
      id: "unbacked-transfer",
      type: "TRANSFER",
      assetId: "gold",
      targetAssetId: "fixed",
      quantity: 2,
      targetQuantity: 1,
      date: "2026-01-02",
    },
  ];
  assert.throws(() => parseHistoryExport(base), /invalid-portfolio-ledger/);
});

test("history import retains valid legacy-stock and custom-asset ledgers", () => {
  const exported = createHistoryExport([], createEmptyPortfolio("2026-01-01T00:00:00.000Z"));
  const portfolio = exported.portfolio;
  portfolio.versions[0].transactions = [
    { id: "legacy-stock", type: "OPENING", assetId: "stocks", quantity: 2, unitPrice: 10, date: "2026-01-01" },
    {
      id: "custom-asset",
      type: "OPENING",
      assetId: "custom:watch",
      quantity: 3,
      unitPrice: 10,
      date: "2026-01-02",
    },
  ];
  portfolio.assets["custom:watch"] = { title: "Watch", sleeveId: "iranEquity" };
  const parsed = parseHistoryExport(exported);
  assert.equal(parsed.portfolio.versions[0].transactions.length, 2);
  assert.ok(Object.hasOwn(parsed.portfolio.assets, "custom:watch"));
  assert.ok(Object.hasOwn(parsed.portfolio.assets, "custom:legacy-stocks"));
});

test("portfolio ledger replays cash flows and values holdings from market data", () => {
  const portfolioMarket = {
    updatedAt: "2026-01-01T00:00:00.000Z",
    assets: { gold: { price: 120 }, dollar: { price: 500 }, silver: { price: 10 } },
    history: { gold: [{ date: "2025-01-01", value: 100 }] },
  };
  let portfolio = createEmptyPortfolio("2025-01-01T00:00:00.000Z");
  const transactions = [
    createTransaction(
      { type: "OPENING", assetId: "fixed", quantity: 100, date: "2025-01-01" },
      portfolioMarket,
      "2025-01-01T00:00:00.000Z",
    ),
    createTransaction(
      { type: "BUY", assetId: "fixed", quantity: 50, unitPrice: 1, date: "2025-02-01" },
      portfolioMarket,
      "2025-02-01T00:00:00.000Z",
    ),
    createTransaction(
      { type: "SELL", assetId: "fixed", quantity: 20, unitPrice: 1, date: "2025-03-01" },
      portfolioMarket,
      "2025-03-01T00:00:00.000Z",
    ),
    createTransaction(
      {
        type: "TRANSFER",
        assetId: "fixed",
        quantity: 10,
        targetAssetId: "cash",
        targetQuantity: 10,
        date: "2025-04-01",
      },
      portfolioMarket,
      "2025-04-01T00:00:00.000Z",
    ),
    createTransaction(
      { type: "DEPOSIT", assetId: "cash", amount: 10, date: "2025-05-01" },
      portfolioMarket,
      "2025-05-01T00:00:00.000Z",
    ),
    createTransaction(
      { type: "DIVIDEND", assetId: "fixed", amount: 5, date: "2025-06-01" },
      portfolioMarket,
      "2025-06-01T00:00:00.000Z",
    ),
  ];
  portfolio = appendTransactions(portfolio, transactions, { action: "test-ledger", affectsHistory: true }).portfolio;
  const result = calculatePortfolio(portfolio, portfolioMarket, "2026-01-01T00:00:00.000Z");
  assert.equal(result.holdings.fixed, 120);
  assert.equal(result.holdings.cash, 25);
  assert.equal(result.currentValue, 145);
  assert.equal(result.netInvested, 140);
  assert.equal(result.profitLoss, 5);
});

test("portfolio versions preserve the prior ledger when tracking restarts", () => {
  const portfolioMarket = { assets: { gold: { price: 100 } }, history: { gold: [{ date: "2025-01-01", value: 100 }] } };
  let portfolio = createEmptyPortfolio("2025-01-01T00:00:00.000Z");
  const first = createTransaction(
    { type: "OPENING", assetId: "gold", quantity: 2, date: "2025-01-01" },
    portfolioMarket,
    "2025-01-01T00:00:00.000Z",
  );
  portfolio = appendTransactions(portfolio, [first], { action: "opening", affectsHistory: true }).portfolio;
  const second = createTransaction(
    { type: "OPENING", assetId: "fixed", quantity: 300, date: "2026-01-01" },
    portfolioMarket,
    "2026-01-01T00:00:00.000Z",
  );
  const versioned = createPortfolioVersion(portfolio, [second], "Restart", "2026-01-01T00:00:00.000Z");
  assert.equal(versioned.validation.valid, true);
  assert.equal(versioned.portfolio.versions.length, 2);
  assert.equal(versioned.portfolio.versions[0].transactions.length, 1);
  assert.equal(calculatePortfolio(versioned.portfolio, portfolioMarket, "2026-01-01T00:00:00.000Z").holdings.gold, 0);
  assert.equal(
    calculatePortfolio(versioned.portfolio, portfolioMarket, "2026-01-01T00:00:00.000Z").holdings.fixed,
    300,
  );
});

test("portfolio history leaves missing market periods blank", () => {
  const portfolioMarket = {
    updatedAt: "2025-08-01T00:00:00.000Z",
    assets: { gold: { price: 180 } },
    history: { gold: [{ date: "2025-07-01", value: 170 }] },
  };
  let portfolio = createEmptyPortfolio("2025-01-01T00:00:00.000Z");
  const opening = createTransaction(
    { type: "OPENING", assetId: "gold", quantity: 1, unitPrice: 100, date: "2025-01-01" },
    portfolioMarket,
    "2025-01-01T00:00:00.000Z",
  );
  portfolio = appendTransactions(portfolio, [opening]).portfolio;
  const series = portfolioSeries(portfolio, portfolioMarket, "2025-01-01", "2025-08-01");
  assert.equal(series[0].value, null);
  assert.ok(series.some((point) => point.value === 170));
});

test("history export round-trips the portfolio ledger", () => {
  const portfolioMarket = { assets: { gold: { price: 100 } }, history: { gold: [{ date: "2026-01-01", value: 100 }] } };
  let portfolio = createEmptyPortfolio("2026-01-01T00:00:00.000Z");
  const opening = createTransaction(
    { type: "OPENING", assetId: "gold", quantity: 1, date: "2026-01-01" },
    portfolioMarket,
    "2026-01-01T00:00:00.000Z",
  );
  portfolio = appendTransactions(portfolio, [opening]).portfolio;
  const exported = createHistoryExport([], portfolio);
  const parsed = parseHistoryExport(JSON.parse(JSON.stringify(exported)));
  assert.equal(parsed.portfolio.schema, "invest-consult-portfolio");
  assert.equal(parsed.portfolio.versions[0].transactions.length, 1);
});

test("named stock accounts stay separate from a global stock bucket", () => {
  const portfolioMarket = { assets: {}, history: {} };
  let portfolio = createEmptyPortfolio("2026-01-01T00:00:00.000Z");
  const steel = createPortfolioAsset(
    portfolio,
    { title: "فولاد", kind: "stock", unit: "TOMAN" },
    "2026-01-01T00:00:00.000Z",
  );
  portfolio = steel.portfolio;
  const refinery = createPortfolioAsset(
    portfolio,
    { title: "شپنا", kind: "stock", unit: "TOMAN" },
    "2026-01-01T00:00:00.000Z",
  );
  portfolio = refinery.portfolio;
  const transactions = [
    createTransaction(
      { type: "OPENING", assetId: steel.asset.id, quantity: 1000000, unitPrice: 1, date: "2026-01-01" },
      portfolioMarket,
      "2026-01-01T00:00:00.000Z",
      portfolio,
    ),
    createTransaction(
      { type: "OPENING", assetId: refinery.asset.id, quantity: 2000000, unitPrice: 1, date: "2026-01-01" },
      portfolioMarket,
      "2026-01-01T00:00:00.000Z",
      portfolio,
    ),
  ];
  portfolio = appendTransactions(portfolio, transactions).portfolio;
  const result = calculatePortfolio(portfolio, portfolioMarket, "2026-01-02T00:00:00.000Z");
  assert.equal(result.holdings[steel.asset.id], 1000000);
  assert.equal(result.holdings[refinery.asset.id], 2000000);
  assert.equal(result.currentValue, 3000000);
});

test("portfolio series never invents history before tracking starts", () => {
  const portfolioMarket = { assets: { gold: { price: 120 } }, history: {} };
  const empty = createEmptyPortfolio("2026-01-01T00:00:00.000Z");
  assert.deepEqual(portfolioSeries(empty, portfolioMarket, "2025-01-01", "2026-02-01"), []);

  let portfolio = createEmptyPortfolio("2026-01-01T00:00:00.000Z");
  const opening = createTransaction(
    { type: "OPENING", assetId: "gold", quantity: 1, unitPrice: 100, date: "2026-01-15" },
    portfolioMarket,
    "2026-01-15T00:00:00.000Z",
  );
  portfolio = appendTransactions(portfolio, [opening]).portfolio;
  const series = portfolioSeries(portfolio, portfolioMarket, "2025-01-01", "2026-02-01");
  assert.equal(series[0].date.slice(0, 10), "2026-01-15");
});

test("invalid transaction asset identifiers are rejected instead of becoming cash", () => {
  const market = { assets: {}, history: {} };
  assert.equal(createTransaction({ type: "BUY", assetId: "missing", quantity: 1, unitPrice: 1 }, market), null);
  const deposit = createTransaction({ type: "DEPOSIT", assetId: "missing", amount: 100 }, market);
  assert.equal(deposit.assetId, "cash");
});

test("a restarted portfolio baseline can preserve named holdings", () => {
  const portfolioMarket = { assets: { gold: { price: 100 } }, history: { gold: [{ date: "2026-01-01", value: 100 }] } };
  let portfolio = createEmptyPortfolio("2026-01-01T00:00:00.000Z");
  const created = createPortfolioAsset(
    portfolio,
    { title: "فولاد", kind: "stock", unit: "TOMAN" },
    "2026-01-01T00:00:00.000Z",
  );
  portfolio = created.portfolio;
  const transactions = [
    createTransaction(
      { type: "OPENING", assetId: "gold", quantity: 2, date: "2026-01-01" },
      portfolioMarket,
      "2026-01-01T00:00:00.000Z",
      portfolio,
    ),
    createTransaction(
      { type: "OPENING", assetId: created.asset.id, quantity: 500000, unitPrice: 1, date: "2026-01-01" },
      portfolioMarket,
      "2026-01-01T00:00:00.000Z",
      portfolio,
    ),
  ];
  portfolio = appendTransactions(portfolio, transactions).portfolio;
  const restart = createPortfolioVersion(
    portfolio,
    [
      createTransaction(
        { type: "OPENING", assetId: "gold", quantity: 2, date: "2026-02-01" },
        portfolioMarket,
        "2026-02-01T00:00:00.000Z",
        portfolio,
      ),
      createTransaction(
        { type: "OPENING", assetId: created.asset.id, quantity: 500000, unitPrice: 1, date: "2026-02-01" },
        portfolioMarket,
        "2026-02-01T00:00:00.000Z",
        portfolio,
      ),
    ],
    "Restart",
    "2026-02-01T00:00:00.000Z",
  );
  const result = calculatePortfolio(restart.portfolio, portfolioMarket, "2026-02-02T00:00:00.000Z");
  assert.equal(result.holdings.gold, 2);
  assert.equal(result.holdings[created.asset.id], 500000);
});
