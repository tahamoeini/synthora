// @ts-check

/**
 * Pure, dependency-free planning and analysis functions.
 *
 * The browser and the test suite use this module. It deliberately contains no
 * DOM, network, storage, or provider-specific code.
 */

import {
  OPTIONAL_RECOMMENDATION_ASSETS,
  INSTRUMENT_REGISTRY,
  PLAN_ASSET_KEYS,
  SIMULATION_ASSET_KEYS,
} from "./market/catalog.js";

export const ASSET_KEYS = SIMULATION_ASSET_KEYS;
export const MODEL_ASSUMPTION_VERSION = "ir-planning-v2";
export const MONTE_CARLO_MODEL_VERSION = "mc-lognormal-gaussian-v2";
export const BOOTSTRAP_MODEL_VERSION = "mc-block-bootstrap-v1";
export const MIN_PAIRED_MONTHS = 24;
export const MIN_WALK_FORWARD_FORECASTS = 24;
export const BOOTSTRAP_BLOCK_MONTHS = 3;
export const EWMA_HALF_LIFE_MONTHS = 12;
export const MIN_MEANINGFUL_ALLOCATION = 3;
export const DEFAULT_REBALANCE_CADENCE = "quarterly";
export const DEFAULT_REBALANCE_THRESHOLD_PERCENT = 3;
export const MIN_SORTINO_OBSERVATIONS = 24;
export const MIN_SORTINO_DOWNSIDE_OBSERVATIONS = 5;
export const MIN_CORRELATION_OBSERVATIONS = 24;
export const NEAR_PURCHASING_POWER_CHANGE = 0.01;

// Judgmental priors avoid treating related Iranian market assets as independent
// when paired history is unavailable. They are disclosed in each simulation.
export const FALLBACK_CORRELATIONS = Object.freeze({
  "bitcoin|ethereum": 0.65,
  "currency|gold": 0.65,
  "gold|silver": 0.65,
  "currency|silver": 0.35,
  "copper|currency": 0.6,
  "copper|gold": 0.35,
  "copper|silver": 0.3,
  "gold|platinum": 0.45,
  "gold|palladium": 0.4,
  "platinum|silver": 0.45,
  "palladium|silver": 0.4,
  "currency|bitcoin": 0.3,
  "currency|ethereum": 0.3,
  "currency|tether": 0.85,
  "copper|bitcoin": 0.2,
  "copper|ethereum": 0.2,
  "gold|bitcoin": 0.2,
  "gold|ethereum": 0.2,
  "silver|bitcoin": 0.2,
  "silver|ethereum": 0.2,
});

export const ASSET_RETURN_BASIS = Object.freeze({
  fixed: Object.freeze({ classification: "D. fixed-rate instrument", currencyBasis: "TOMAN", proxy: false }),
  gold: Object.freeze({ classification: "A. local-currency Toman price return", currencyBasis: "TOMAN", proxy: false }),
  currency: Object.freeze({
    classification: "F. local USD/TOMAN exchange-rate return",
    currencyBasis: "TOMAN per USD",
    proxy: false,
  }),
  silver: Object.freeze({
    classification: "A. local-currency Toman price return",
    currencyBasis: "TOMAN",
    proxy: false,
  }),
  copper: Object.freeze({
    classification: "C. global commodity price converted with dated FX",
    currencyBasis: "TOMAN per gram",
    proxy: true,
  }),
  platinum: Object.freeze({
    classification: "C. global commodity price converted with dated FX",
    currencyBasis: "TOMAN per gram",
    proxy: true,
  }),
  palladium: Object.freeze({
    classification: "C. global commodity price converted with dated FX",
    currencyBasis: "TOMAN per gram",
    proxy: true,
  }),
  bitcoin: Object.freeze({
    classification: "E. USD-quoted crypto converted with dated FX",
    currencyBasis: "TOMAN per coin",
    proxy: true,
  }),
  ethereum: Object.freeze({
    classification: "E. USD-quoted crypto converted with dated FX",
    currencyBasis: "TOMAN per coin",
    proxy: true,
  }),
  tether: Object.freeze({
    classification: "E. USD-quoted crypto converted with dated FX",
    currencyBasis: "TOMAN per token",
    proxy: true,
  }),
});

export const DEFAULT_ALLOCATION = Object.freeze({
  fixed: 72,
  gold: 18,
  currency: 8,
  silver: 2,
  bitcoin: 0,
  ethereum: 0,
  platinum: 0,
  palladium: 0,
  copper: 0,
  tether: 0,
});

export const DEFAULT_ASSUMPTIONS = Object.freeze({
  fixed: { annualReturn: 0.25, annualVolatility: 0.04 },
  gold: { annualReturn: 0.25, annualVolatility: 0.24 },
  currency: { annualReturn: 0.25, annualVolatility: 0.22 },
  silver: { annualReturn: 0.28, annualVolatility: 0.34 },
  bitcoin: { annualReturn: 0.25, annualVolatility: 0.8 },
  ethereum: { annualReturn: 0.25, annualVolatility: 0.95 },
  tether: { annualReturn: 0.25, annualVolatility: 0.25 },
  platinum: { annualReturn: 0.25, annualVolatility: 0.3 },
  palladium: { annualReturn: 0.25, annualVolatility: 0.42 },
  copper: { annualReturn: 0.25, annualVolatility: 0.35 },
});

export const DEFAULT_TRANSACTION_COSTS = Object.freeze({
  fixed: Object.freeze({ buyFee: null, sellFee: null, spread: null }),
  gold: Object.freeze({ buyFee: 0.005, sellFee: 0.005, spread: null }),
  currency: Object.freeze({ buyFee: null, sellFee: null, spread: null }),
  silver: Object.freeze({ buyFee: 0.005, sellFee: 0.005, spread: null }),
  bitcoin: Object.freeze({ buyFee: null, sellFee: null, spread: null }),
  ethereum: Object.freeze({ buyFee: null, sellFee: null, spread: null }),
  tether: Object.freeze({ buyFee: null, sellFee: null, spread: null }),
  platinum: Object.freeze({ buyFee: null, sellFee: null, spread: null }),
  palladium: Object.freeze({ buyFee: null, sellFee: null, spread: null }),
  copper: Object.freeze({ buyFee: 0.005, sellFee: 0.005, spread: null }),
});

export const GOALS = Object.freeze({
  liquidity: { fixedBias: 5 },
  preservation: { fixedBias: 3 },
  retirement: { fixedBias: 0 },
  growth: { fixedBias: -4 },
});

const EPSILON = 1e-9;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

export function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? sum(valid) / valid.length : null;
}

export function median(values) {
  const valid = values
    .filter(Number.isFinite)
    .slice()
    .sort((left, right) => left - right);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
}

export function standardDeviation(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return null;
  const average = mean(valid);
  return Math.sqrt(sum(valid.map((value) => (value - average) ** 2)) / (valid.length - 1));
}

export function annualizedVolatility(returns) {
  const deviation = standardDeviation(returns);
  return deviation === null ? null : deviation * Math.sqrt(12);
}

export function sharpeRatio(returns, benchmarkMonthlyReturn = 0) {
  if (!Number.isFinite(benchmarkMonthlyReturn)) return null;
  const valid = returns.filter(Number.isFinite);
  const volatility = annualizedVolatility(valid);
  if (valid.length < 2 || volatility === null || volatility <= EPSILON) return null;
  return (mean(valid.map((value) => value - benchmarkMonthlyReturn)) * 12) / volatility;
}

export function downsideDeviation(returns, targetMonthlyReturn = 0) {
  if (!Number.isFinite(targetMonthlyReturn)) return null;
  const valid = returns.filter(Number.isFinite);
  if (valid.length < MIN_SORTINO_OBSERVATIONS) return null;
  const downsideObservations = valid.filter((value) => value < targetMonthlyReturn).length;
  if (downsideObservations < MIN_SORTINO_DOWNSIDE_OBSERVATIONS) return null;
  const monthly = Math.sqrt(mean(valid.map((value) => Math.min(0, value - targetMonthlyReturn) ** 2)));
  return monthly > EPSILON ? monthly * Math.sqrt(12) : null;
}

export function sortinoRatio(returns, targetMonthlyReturn = 0) {
  if (!Number.isFinite(targetMonthlyReturn)) return null;
  const valid = returns.filter(Number.isFinite);
  const downside = downsideDeviation(valid, targetMonthlyReturn);
  if (downside === null) return null;
  return (mean(valid.map((value) => value - targetMonthlyReturn)) * 12) / downside;
}

export function percentile(values, probability) {
  const valid = values
    .filter(Number.isFinite)
    .slice()
    .sort((left, right) => left - right);
  if (!valid.length) return null;
  const position = clamp(probability, 0, 1) * (valid.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return valid[lower];
  return valid[lower] + (valid[upper] - valid[lower]) * (position - lower);
}

export function normalizeAllocation(input, fallback = DEFAULT_ALLOCATION, assetKeys = ASSET_KEYS) {
  const raw = {};
  assetKeys.forEach((key) => {
    raw[key] = Math.max(0, Number(input && input[key]) || 0);
  });
  const total = sum(Object.values(raw));
  if (total <= EPSILON) {
    const fallbackAllocation = Object.fromEntries(
      assetKeys.map((key) => [key, Math.max(0, Number(fallback && fallback[key]) || 0)]),
    );
    const fallbackTotal = sum(Object.values(fallbackAllocation));
    if (fallbackTotal <= EPSILON) return fallbackAllocation;
    return Object.fromEntries(assetKeys.map((key) => [key, (fallbackAllocation[key] / fallbackTotal) * 100]));
  }
  const normalized = {};
  assetKeys.forEach((key) => {
    normalized[key] = (raw[key] / total) * 100;
  });
  return normalized;
}

function requirePositiveAllocation(input, assetKeys = ASSET_KEYS) {
  const rawWeights = assetKeys.map((asset) => Number(input?.[asset] ?? 0));
  if (rawWeights.some((weight) => !Number.isFinite(weight) || weight < 0) || sum(rawWeights) <= EPSILON)
    throw new RangeError("invalid-allocation");
}

export function roundAllocation(input, assetKeys = ASSET_KEYS) {
  const normalized = normalizeAllocation(input, DEFAULT_ALLOCATION, assetKeys);
  const rounded = Object.fromEntries(assetKeys.map((key) => [key, Math.floor(normalized[key])]));
  let remaining = 100 - sum(Object.values(rounded));
  const order = assetKeys
    .slice()
    .sort((left, right) => normalized[right] - rounded[right] - (normalized[left] - rounded[left]));
  for (let index = 0; index < remaining; index += 1) rounded[order[index % order.length]] += 1;
  return rounded;
}

export function annualToMonthlyRate(annualRate) {
  if (annualRate === null || annualRate === undefined || annualRate === "") return null;
  const annual = Number(annualRate);
  if (!Number.isFinite(annual) || annual <= -1) return null;
  const monthly = Math.pow(1 + annual, 1 / 12) - 1;
  return Number.isFinite(monthly) ? monthly : null;
}

export function monthlyToAnnualRate(monthlyRate) {
  if (monthlyRate === null || monthlyRate === undefined || monthlyRate === "") return null;
  const monthly = Number(monthlyRate);
  if (!Number.isFinite(monthly) || monthly <= -1) return null;
  const annual = Math.pow(1 + monthly, 12) - 1;
  return Number.isFinite(annual) ? annual : null;
}

export function realValue(nominalValue, inflationRate, years) {
  if (nominalValue === null || nominalValue === undefined || nominalValue === "") return null;
  const nominal = Number(nominalValue);
  const inflation = Number(inflationRate);
  const elapsedYears = Number(years);
  if (
    nominal < 0 ||
    !Number.isFinite(nominal) ||
    !Number.isFinite(inflation) ||
    inflation <= -1 ||
    !Number.isFinite(elapsedYears) ||
    elapsedYears < 0
  )
    return null;
  const factor = Math.pow(1 + inflation, elapsedYears);
  return factor > 0 && Number.isFinite(factor) ? nominal / factor : null;
}

export function realReturn(nominalReturn, inflationRate) {
  if (nominalReturn === null || nominalReturn === undefined || nominalReturn === "") return null;
  const nominal = Number(nominalReturn);
  const inflation = Number(inflationRate);
  if (!Number.isFinite(nominal) || !Number.isFinite(inflation) || nominal <= -1 || inflation <= -1) return null;
  const result = (1 + nominal) / (1 + inflation) - 1;
  return Number.isFinite(result) ? result : null;
}

function scenarioInflationRate(value) {
  if (value === undefined) return 0;
  if (value === null || value === "") throw new RangeError("missing-inflation-rate");
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= -1) throw new RangeError("invalid-inflation-rate");
  return rate;
}

export function maxDrawdown(values) {
  const valid = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (valid.length < 2 || !valid.some((value) => value > EPSILON)) return null;
  let peak = -Infinity;
  let drawdown = 0;
  values.forEach((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    const numeric = value;
    peak = Math.max(peak, numeric);
    if (peak > EPSILON) drawdown = Math.max(drawdown, 1 - numeric / peak);
  });
  return drawdown;
}

function unitizedValuePath(monthlyReturns, initialValue = 100) {
  const firstObservedMonth = monthlyReturns.findIndex(Number.isFinite);
  if (firstObservedMonth < 0) return [];
  const values = Array(monthlyReturns.length + 1).fill(null);
  values[firstObservedMonth] = initialValue;
  for (let index = firstObservedMonth; index < monthlyReturns.length; index += 1) {
    const monthlyReturn = monthlyReturns[index];
    if (Number.isFinite(monthlyReturn) && monthlyReturn <= -1) throw new RangeError("invalid-portfolio-return");
    values[index + 1] = Number.isFinite(monthlyReturn) ? values[index] * (1 + monthlyReturn) : values[index];
  }
  return values;
}

function realUnitizedValuePath(monthlyReturns, inflationRate, initialValue = 100) {
  return unitizedValuePath(monthlyReturns, initialValue).map((value, month) =>
    value === null ? null : realValue(value, inflationRate, month / 12),
  );
}

function riskValue(value) {
  return { conservative: 0, balanced: 1, growth: 2 }[value] ?? 0;
}

function stabilityValue(value) {
  return { unstable: 2, mixed: 1, stable: 0 }[value] ?? 1;
}

function emergencyValue(value) {
  return { none: 3, partial: 1, complete: 0 }[value] ?? 1;
}

/**
 * Build a conservative allocation from the user's situation.
 * This is a rule system, not a market forecast.
 */
function inverseVolatilityWeights(assetKeys, budget, model) {
  const inverseVolatility = Object.fromEntries(
    assetKeys.map((assetId) => {
      const configuredVolatility = Number(model?.[assetId]?.annualVolatility);
      const fallbackVolatility = DEFAULT_ASSUMPTIONS[assetId]?.annualVolatility;
      const volatility =
        Number.isFinite(configuredVolatility) && configuredVolatility >= 0 ? configuredVolatility : fallbackVolatility;
      return [assetId, 1 / Math.max(volatility, 0.01)];
    }),
  );
  const total = sum(Object.values(inverseVolatility));
  return Object.fromEntries(
    assetKeys.map((assetId) => [assetId, total > EPSILON ? (budget * inverseVolatility[assetId]) / total : 0]),
  );
}

function applyMinimumAllocation(weights, minimumPercent = MIN_MEANINGFUL_ALLOCATION, allowMicroAllocation = false) {
  const result = { ...weights };
  const minimum = Math.max(0, Number(minimumPercent) || 0);
  if (allowMicroAllocation || minimum <= 0) return result;
  const removed = Object.keys(result).filter((assetId) => result[assetId] > EPSILON && result[assetId] < minimum);
  const removedWeight = sum(removed.map((assetId) => result[assetId]));
  removed.forEach((assetId) => {
    result[assetId] = 0;
  });
  const eligible = Object.keys(result).filter((assetId) => result[assetId] >= minimum);
  if (!eligible.length) {
    const largest = Object.keys(result).sort((left, right) => weights[right] - weights[left])[0];
    if (largest) result[largest] = 100;
    return result;
  }
  const eligibleTotal = sum(eligible.map((assetId) => result[assetId]));
  eligible.forEach((assetId) => {
    result[assetId] +=
      removedWeight * (eligibleTotal > EPSILON ? result[assetId] / eligibleTotal : 1 / eligible.length);
  });
  return result;
}

export function recommendAllocation(profile = {}, options = {}) {
  const age = Number.isFinite(Number(profile.age)) && Number(profile.age) > 0 ? clamp(profile.age, 18, 90) : null;
  const horizon = clamp(profile.horizonYears || 5, 1, 50);
  const goal = GOALS[profile.goal] || GOALS.preservation;
  const risk = riskValue(profile.riskTolerance);
  const stability = stabilityValue(profile.incomeStability);
  const emergency = emergencyValue(profile.emergencyFund);

  let fixed = 71 + goal.fixedBias + stability + emergency;
  if (age !== null) fixed += age >= 55 ? 4 : age >= 40 ? 2 : age < 30 ? -2 : 0;
  fixed += horizon <= 3 ? 6 : horizon <= 7 ? 2 : horizon >= 15 ? -4 : 0;
  fixed -= risk * 6;
  fixed = clamp(fixed, 52, 86);
  const assumptions = options.assumptions || DEFAULT_ASSUMPTIONS;
  const minimumRaw = options.minimumMeaningfulAllocation;
  const minimumAllocation = Math.max(
    0,
    minimumRaw === null || minimumRaw === undefined || minimumRaw === ""
      ? MIN_MEANINGFUL_ALLOCATION
      : Number(minimumRaw),
  );
  const expectedFixedRate = Number(assumptions.fixed?.annualReturn ?? DEFAULT_ASSUMPTIONS.fixed.annualReturn);
  const inflationRate = Number(options.inflationRate);
  const inflationGap = Number.isFinite(inflationRate) ? Math.max(0, inflationRate - expectedFixedRate) : 0;
  const inflationHedgeAdjustment = clamp(inflationGap * 20, 0, 5);
  fixed = Math.max(45, fixed - inflationHedgeAdjustment);

  const nonFixed = 100 - fixed;
  const goldShare = clamp(0.54 - risk * 0.06 + (horizon <= 3 ? 0.05 : 0), 0.38, 0.62);
  const currentHoldings = options.currentHoldings || {};
  const hasExistingFx = Number(currentHoldings.currency) > EPSILON;
  const includeCurrency = risk > 0 || hasExistingFx || options.includeCurrency === true;
  const currencyShare = includeCurrency ? clamp(0.31 + risk * 0.02, 0.22, 0.36) : 0;
  const remainingHedgeShare = 1 - goldShare - currencyShare;
  const hedgeShareTotal = goldShare + remainingHedgeShare;
  const weights = {
    ...Object.fromEntries(PLAN_ASSET_KEYS.map((assetId) => [assetId, 0])),
    fixed,
    gold: nonFixed * (includeCurrency ? goldShare : goldShare / hedgeShareTotal),
    currency: nonFixed * currencyShare,
    silver: Math.max(0, nonFixed * (includeCurrency ? remainingHedgeShare : remainingHedgeShare / hedgeShareTotal)),
  };
  const enabledAssets = new Set(
    (Array.isArray(options.enabledAssets) ? options.enabledAssets : []).filter((assetId) =>
      OPTIONAL_RECOMMENDATION_ASSETS.includes(assetId),
    ),
  );
  const returnModel =
    options.returnModel ||
    (enabledAssets.size ? estimateReturnModel(options.market || {}, assumptions).model : assumptions);
  const enabledCommodities = [
    "silver",
    ...["copper", "platinum", "palladium"].filter((assetId) => enabledAssets.has(assetId)),
  ];
  const commodityWeights = inverseVolatilityWeights(enabledCommodities, weights.silver, returnModel);
  enabledCommodities.forEach((assetId) => {
    weights[assetId] = commodityWeights[assetId];
  });

  const enabledCrypto = ["bitcoin", "ethereum"].filter((assetId) => enabledAssets.has(assetId));
  const cryptoTargets = { conservative: 1, balanced: 3, growth: 5 };
  const targetCryptoBudget = enabledCrypto.length ? Math.min(cryptoTargets[profile.riskTolerance] || 1, 5) : 0;
  let cryptoBudget = targetCryptoBudget;
  if (!options.allowMicroAllocation && cryptoBudget < minimumAllocation) cryptoBudget = 0;
  if (cryptoBudget > 0) {
    let candidates = enabledCrypto.slice();
    let cryptoWeights = inverseVolatilityWeights(candidates, cryptoBudget, returnModel);
    if (!options.allowMicroAllocation && candidates.length > 1) {
      const eligibleCandidates = candidates.filter((assetId) => cryptoWeights[assetId] >= minimumAllocation);
      if (eligibleCandidates.length) candidates = eligibleCandidates;
      else candidates = [candidates.sort((left, right) => cryptoWeights[right] - cryptoWeights[left])[0]];
      cryptoWeights = inverseVolatilityWeights(candidates, cryptoBudget, returnModel);
    }
    const nonFixedAssets = PLAN_ASSET_KEYS.filter((assetId) => assetId !== "fixed" && !enabledCrypto.includes(assetId));
    const nonFixedBudget = sum(nonFixedAssets.map((assetId) => weights[assetId]));
    const remainingBudget = Math.max(0, nonFixedBudget - cryptoBudget);
    const reduction = nonFixedBudget > EPSILON ? remainingBudget / nonFixedBudget : 0;
    nonFixedAssets.forEach((assetId) => {
      weights[assetId] *= reduction;
    });
    Object.assign(weights, cryptoWeights);
  }

  const eligibleWeights = applyMinimumAllocation(weights, minimumAllocation, Boolean(options.allowMicroAllocation));
  const roundedWeights = roundAllocation(eligibleWeights, PLAN_ASSET_KEYS);
  const finalWeights = roundAllocation(
    applyMinimumAllocation(roundedWeights, minimumAllocation, Boolean(options.allowMicroAllocation)),
    PLAN_ASSET_KEYS,
  );

  return {
    weights: finalWeights,
    enabledAssets: [...enabledAssets],
    facts: {
      age,
      horizon,
      goal: profile.goal || "preservation",
      riskTolerance: profile.riskTolerance || "conservative",
      incomeStability: profile.incomeStability || "mixed",
      emergencyFund: profile.emergencyFund || "partial",
    },
    guardrails: {
      monthlyRateMin: profile.emergencyFund === "complete" ? 15 : 10,
      monthlyRateMax: profile.emergencyFund === "none" ? 20 : 25,
      cryptoWeightCap: 5,
      cryptoWeight: sum(["bitcoin", "ethereum"].map((assetId) => finalWeights[assetId] || 0)),
      minimumMeaningfulAllocation: minimumAllocation,
      allowMicroAllocation: Boolean(options.allowMicroAllocation),
      fxIncluded: finalWeights.currency > 0,
      inflationHedgeAdjustment,
      targetUsesCurrentHoldings: Boolean(Object.keys(currentHoldings).length),
    },
  };
}

function extractSeries(market, key) {
  const raw = market && market.history && market.history[key];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((point) => {
      if (Array.isArray(point)) return { date: point[0], value: Number(point[1]), source: null, currency: null };
      if (!point || typeof point !== "object") return null;
      return {
        date: point.date || point.time || point.timestamp,
        value: Number(point.value ?? point.price ?? point.close ?? point.c),
        source: point.source || null,
        currency: point.currency || null,
        conversion: point.conversion || null,
      };
    })
    .filter(
      (point) =>
        point &&
        point.date &&
        Number.isFinite(new Date(point.date).getTime()) &&
        Number.isFinite(point.value) &&
        point.value > 0,
    )
    .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime());
}

function monthlySeries(series) {
  const buckets = new Map();
  series.forEach((point) => {
    const date = new Date(point.date);
    if (Number.isNaN(date.getTime())) return;
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    buckets.set(key, point);
  });
  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, point]) => ({ month, value: point.value, date: point.date }));
}

function partialAsOfMonth(asOfDate) {
  const asOf = asOfDate ? new Date(asOfDate) : null;
  if (!asOf || !Number.isFinite(asOf.getTime())) return null;
  const lastDay = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() + 1, 0)).getUTCDate();
  if (asOf.getUTCDate() >= lastDay) return null;
  return `${asOf.getUTCFullYear()}-${String(asOf.getUTCMonth() + 1).padStart(2, "0")}`;
}

function seriesReturns(series, asOfDate = null) {
  const incompleteMonth = partialAsOfMonth(asOfDate);
  const monthly = monthlySeries(series).filter((point) => point.month !== incompleteMonth);
  return monthly
    .slice(1)
    .map((point, index) => ({
      month: point.month,
      date: point.date,
      value: point.value / monthly[index].value - 1,
      consecutive: monthOrdinal(point.month) === monthOrdinal(monthly[index].month) + 1,
    }))
    .filter((point) => point.consecutive && Number.isFinite(point.value) && point.value > -1);
}

function monthOrdinal(month) {
  const [year, monthNumber] = String(month).split("-").map(Number);
  return year * 12 + monthNumber;
}

function monthKey(ordinal) {
  const year = Math.floor((ordinal - 1) / 12);
  const month = ((ordinal - 1) % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Align observed returns with modeled fallbacks while retaining observation flags. */
export function buildHistoricalReturns(market, assumptions = DEFAULT_ASSUMPTIONS) {
  const asOfDate = market?.historyAsOfDate || market?.updatedAt || null;
  const incompleteMonth = partialAsOfMonth(asOfDate);
  const marketKeys = Object.fromEntries(
    ASSET_KEYS.map((assetId) => [
      assetId,
      assetId === "fixed" ? null : assetId === "currency" ? "dollar" : INSTRUMENT_REGISTRY[assetId]?.marketKey || null,
    ]),
  );
  const actual = {};
  const assetMetadata = {};
  const months = [];
  ASSET_KEYS.forEach((asset) => {
    const prices = marketKeys[asset] ? extractSeries(market, marketKeys[asset]) : [];
    const returns = seriesReturns(prices, asOfDate);
    const assetMonthExcluded = Boolean(
      incompleteMonth && prices.some((point) => new Date(point.date).toISOString().slice(0, 7) === incompleteMonth),
    );
    actual[asset] = new Map(returns.map((point) => [point.month, point]));
    const firstPrice = prices[0] || null;
    const lastPrice = prices.at(-1) || null;
    assetMetadata[asset] = {
      ...ASSET_RETURN_BASIS[asset],
      proxy: Boolean(
        ASSET_RETURN_BASIS[asset].proxy || (firstPrice?.conversion && (asset === "gold" || asset === "silver")),
      ),
      historyKey: marketKeys[asset],
      priceObservations: prices.length,
      returnObservations: returns.length,
      firstObservedAt: firstPrice?.date || null,
      lastObservedAt: lastPrice?.date || null,
      source: firstPrice?.source || market?.historyCoverage?.[marketKeys[asset]]?.source || null,
      sourceUrl: market?.historyCoverage?.[marketKeys[asset]]?.sourceUrl || null,
      sourceCoverage: market?.historyCoverage?.[marketKeys[asset]] || null,
      observedCurrency: firstPrice?.currency || null,
      conversion: firstPrice?.conversion || null,
      classification:
        asset === "fixed"
          ? "D. fixed-rate instrument"
          : firstPrice?.conversion
            ? asset === "bitcoin" || asset === "ethereum" || asset === "tether"
              ? "E. USD-quoted crypto converted with same-date USD/TOMAN"
              : "C. global asset price converted with same-date USD/TOMAN"
            : firstPrice?.currency === "TOMAN"
              ? asset === "currency"
                ? "F. local USD/TOMAN exchange-rate return"
                : "A. local-currency Toman price return"
              : asset === "currency"
                ? "F. local USD/TOMAN exchange-rate return"
                : ASSET_RETURN_BASIS[asset].classification,
      transformation:
        asset === "fixed"
          ? "effective annual yield is converted to effective monthly compounding; no historical NAV series is available"
          : asset === "currency"
            ? "observed Toman per USD exchange-rate returns; the series is already the FX exposure"
            : firstPrice?.conversion
              ? "USD quote multiplied by same-date USD/TOMAN, then Toman price returns; do not add FX again"
              : firstPrice?.currency === "TOMAN"
                ? "use observed local Toman price returns; do not add FX or historical inflation again"
                : "quote basis is inferred from instrument type because source currency metadata is missing; prices are treated as Toman inputs",
      basisConfidence:
        asset === "fixed" || asset === "currency" || firstPrice?.conversion || firstPrice?.currency
          ? "identified"
          : "inferred",
      sourceNames: [...new Set(prices.map((point) => point.source).filter(Boolean))],
      frequency:
        "monthly returns from the latest dated close in consecutive calendar months; current partial month excluded when an as-of date is available",
      partialMonthExcluded: assetMonthExcluded,
      available: returns.length > 0,
    };
    returns.forEach((point) => months.push(monthOrdinal(point.month)));
  });
  if (months.length === 0)
    return {
      rows: [],
      coverage: Object.fromEntries(ASSET_KEYS.map((asset) => [asset, 0])),
      assetMetadata,
      observations: 0,
      estimated: true,
      historyFetchError: market?.historyFetchError || null,
      oldestDate: null,
      latestDate: null,
      asOfDate: asOfDate && Number.isFinite(Date.parse(asOfDate)) ? new Date(asOfDate).toISOString() : null,
      excludedPartialMonth: incompleteMonth,
    };
  const firstMonth = Math.min(...months);
  const lastMonth = Math.max(...months);
  const orderedMonths = Array.from({ length: lastMonth - firstMonth + 1 }, (_, index) => monthKey(firstMonth + index));

  const rows = orderedMonths.map((month, index) => {
    const row = { month, returns: {}, observed: {} };
    ASSET_KEYS.forEach((asset) => {
      const point = actual[asset].get(month);
      row.returns[asset] = point ? point.value : null;
      row.observed[asset] = Boolean(point);
    });
    row.index = index;
    return row;
  });

  const coverage = {};
  ASSET_KEYS.forEach((asset) => {
    coverage[asset] = rows.length ? rows.filter((row) => row.observed[asset]).length / rows.length : 0;
  });
  return {
    rows,
    coverage,
    assetMetadata,
    observations: rows.length,
    estimated: Object.values(coverage).some((value) => value < 0.75),
    historyFetchError: market?.historyFetchError || null,
    oldestDate: orderedMonths[0],
    latestDate: orderedMonths.at(-1),
    asOfDate: asOfDate && Number.isFinite(Date.parse(asOfDate)) ? new Date(asOfDate).toISOString() : null,
    excludedPartialMonth: incompleteMonth,
  };
}

function currentFixedReturn(market) {
  const value = market && market.funds && market.funds.fixedIncome && market.funds.fixedIncome.effectiveAnnualReturn;
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
    ? Number(value) / 100
    : null;
}

export function estimateReturnModel(market, assumptions = DEFAULT_ASSUMPTIONS) {
  const historical = buildHistoricalReturns(market, assumptions);
  const model = {};
  const ewmaModel = {};
  ASSET_KEYS.forEach((asset) => {
    const values = historical.rows
      .filter((row) => row.observed[asset])
      .map((row) => row.returns[asset])
      .filter(Number.isFinite);
    const configured = assumptions[asset] || DEFAULT_ASSUMPTIONS[asset];
    const observedAnnual = values.length ? Math.pow(1 + mean(values), 12) - 1 : null;
    const geometricAnnual =
      values.length && values.every((value) => value > -1)
        ? Math.expm1((sum(values.map((value) => Math.log1p(value))) * 12) / values.length)
        : null;
    const observedVolatility = annualizedVolatility(values);
    const ewmaVolatility =
      values.length >= MIN_PAIRED_MONTHS ? exponentiallyWeightedVolatility(values, EWMA_HALF_LIFE_MONTHS) : null;
    const officialFixed = asset === "fixed" ? currentFixedReturn(market) : null;
    const annualReturn =
      asset === "fixed"
        ? configured.annualReturn
        : values.length >= MIN_PAIRED_MONTHS
          ? observedAnnual
          : configured.annualReturn;
    const annualVolatility =
      asset === "fixed"
        ? configured.annualVolatility
        : values.length >= MIN_PAIRED_MONTHS
          ? observedVolatility
          : configured.annualVolatility;
    const base = {
      annualReturn,
      annualVolatility,
      geometricAnnualReturn: values.length >= MIN_PAIRED_MONTHS ? geometricAnnual : null,
      observations: values.length,
      observed: values.length >= MIN_PAIRED_MONTHS,
      source:
        asset === "fixed"
          ? officialFixed === null
            ? "configured-assumption"
            : "market-yield-reference"
          : values.length >= MIN_PAIRED_MONTHS
            ? "historical-monthly-returns"
            : "configured-assumption",
      assumptionVersion: MODEL_ASSUMPTION_VERSION,
    };
    model[asset] = base;
    ewmaModel[asset] = { ...base, annualVolatility: ewmaVolatility ?? annualVolatility };
  });
  return {
    model,
    ewmaModel,
    historical,
    referenceAnnualReturn: currentFixedReturn(market),
    covariance: covarianceMatrix(historical.rows, ASSET_KEYS, model),
  };
}

export function walkForwardValidation(market, assumptions = DEFAULT_ASSUMPTIONS) {
  const historical = buildHistoricalReturns(market, assumptions);
  const diagnostics = {};
  ASSET_KEYS.forEach((asset) => {
    const observedRows = historical.rows.filter((row) => row.observed[asset]);
    const losses = { sample: [], ewma: [] };
    const coverage = { gaussian: 0, ewma: 0, bootstrap: 0 };
    let forecasts = 0;
    for (let index = MIN_PAIRED_MONTHS; index < observedRows.length; index += 1) {
      const window = observedRows.slice(index - MIN_PAIRED_MONTHS, index + 1);
      const contiguous = window
        .slice(1)
        .every((row, offset) => monthOrdinal(row.month) === monthOrdinal(window[offset].month) + 1);
      if (!contiguous) continue;
      const training = window.slice(0, -1).map((row) => row.returns[asset]);
      const actual = window.at(-1).returns[asset];
      const expected = mean(training);
      const sampleVolatility = standardDeviation(training);
      const weightedVolatility = exponentiallyWeightedVolatility(training, EWMA_HALF_LIFE_MONTHS) / Math.sqrt(12);
      const realizedVariance = (actual - expected) ** 2;
      losses.sample.push(Math.abs(realizedVariance - sampleVolatility ** 2));
      losses.ewma.push(Math.abs(realizedVariance - weightedVolatility ** 2));
      if (Math.abs(actual - expected) <= 1.2816 * sampleVolatility) coverage.gaussian += 1;
      if (Math.abs(actual - expected) <= 1.2816 * weightedVolatility) coverage.ewma += 1;
      if (actual >= percentile(training, 0.1) && actual <= percentile(training, 0.9)) coverage.bootstrap += 1;
      forecasts += 1;
    }
    const baselineLoss = mean(losses.sample);
    const ewmaLoss = mean(losses.ewma);
    const gaussianCoverage = forecasts ? coverage.gaussian / forecasts : null;
    const ewmaCoverage = forecasts ? coverage.ewma / forecasts : null;
    const bootstrapCoverage = forecasts ? coverage.bootstrap / forecasts : null;
    diagnostics[asset] = {
      observations: forecasts,
      available: forecasts >= MIN_WALK_FORWARD_FORECASTS,
      sampleVolatilityLoss: forecasts ? baselineLoss : null,
      ewmaVolatilityLoss: forecasts ? ewmaLoss : null,
      gaussianCoverage,
      ewmaCoverage,
      bootstrapCoverage,
      ewmaEligible:
        forecasts >= MIN_WALK_FORWARD_FORECASTS &&
        ewmaLoss <= baselineLoss &&
        Math.abs(ewmaCoverage - 0.8) <= Math.abs(gaussianCoverage - 0.8),
      bootstrapEligible:
        forecasts >= MIN_WALK_FORWARD_FORECASTS &&
        Math.abs(bootstrapCoverage - 0.8) <= Math.abs(gaussianCoverage - 0.8),
    };
  });
  const eligibleAssets = ASSET_KEYS.filter((asset) => diagnostics[asset].available);
  return {
    available: eligibleAssets.length > 0,
    diagnostics,
    ewmaEligible: eligibleAssets.length > 0 && eligibleAssets.every((asset) => diagnostics[asset].ewmaEligible),
    bootstrapEligible:
      eligibleAssets.length > 0 && eligibleAssets.every((asset) => diagnostics[asset].bootstrapEligible),
  };
}

function exponentiallyWeightedVolatility(values, halfLifeMonths = EWMA_HALF_LIFE_MONTHS) {
  if (values.length < 2) return null;
  const weights = values.map((_, index) => Math.pow(0.5, (values.length - index - 1) / halfLifeMonths));
  const weightTotal = sum(weights);
  const average = sum(values.map((value, index) => value * weights[index])) / weightTotal;
  const variance = sum(values.map((value, index) => weights[index] * (value - average) ** 2)) / weightTotal;
  return Math.sqrt(Math.max(variance, 0) * 12);
}

export function covarianceMatrix(rows, assets = ASSET_KEYS, model = null) {
  return assets.map((rowAsset, rowIndex) =>
    assets.map((columnAsset, columnIndex) => {
      const paired = rows
        .filter((row) => row.observed?.[rowAsset] && row.observed?.[columnAsset])
        .map((row) => [Number(row.returns[rowAsset]), Number(row.returns[columnAsset])])
        .filter(([left, right]) => Number.isFinite(left) && Number.isFinite(right));
      const rowVolatility = Math.max(0, Number(model?.[rowAsset]?.annualVolatility) || 0) / Math.sqrt(12);
      const columnVolatility = Math.max(0, Number(model?.[columnAsset]?.annualVolatility) || 0) / Math.sqrt(12);
      if (rowIndex === columnIndex) {
        if (paired.length < MIN_PAIRED_MONTHS) return rowVolatility ** 2;
        const values = paired.map(([value]) => value);
        return standardDeviation(values) ** 2;
      }
      const pairName = [rowAsset, columnAsset].sort().join("|");
      const fallbackCorrelation = Number(
        FALLBACK_CORRELATIONS[pairName] ?? (rowAsset === "fixed" || columnAsset === "fixed" ? 0 : 0.25),
      );
      if (paired.length < 2) return fallbackCorrelation * rowVolatility * columnVolatility;
      const leftValues = paired.map(([left]) => left);
      const rightValues = paired.map(([, right]) => right);
      const leftDeviation = standardDeviation(leftValues);
      const rightDeviation = standardDeviation(rightValues);
      if (leftDeviation <= EPSILON || rightDeviation <= EPSILON)
        return fallbackCorrelation * rowVolatility * columnVolatility;
      const leftMean = mean(leftValues);
      const rightMean = mean(rightValues);
      const covariance =
        sum(paired.map(([left, right]) => (left - leftMean) * (right - rightMean))) / (paired.length - 1);
      const correlation = covariance / (leftDeviation * rightDeviation);
      const historicalWeight = Math.min(1, paired.length / MIN_CORRELATION_OBSERVATIONS);
      const blendedCorrelation =
        clamp(correlation, -1, 1) * historicalWeight + fallbackCorrelation * (1 - historicalWeight);
      return blendedCorrelation * rowVolatility * columnVolatility;
    }),
  );
}

function cholesky(matrix) {
  const size = matrix.length;
  const lower = Array.from({ length: size }, () => Array(size).fill(0));
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let value = matrix[row][column];
      for (let index = 0; index < column; index += 1) value -= lower[row][index] * lower[column][index];
      if (row === column) {
        if (value < -EPSILON) return null;
        lower[row][column] = Math.sqrt(Math.max(value, 0));
      } else if (lower[column][column] > EPSILON) lower[row][column] = value / lower[column][column];
      else if (Math.abs(value) > EPSILON) return null;
    }
  }
  return lower;
}

function stableCholesky(matrix) {
  for (let attempt = 0; attempt <= 100; attempt += 1) {
    const shrinkage = attempt === 0 ? 1 : Math.pow(0.95, attempt);
    const candidate = matrix.map((row, rowIndex) =>
      row.map((value, columnIndex) => (rowIndex === columnIndex ? value : value * shrinkage)),
    );
    const lower = cholesky(candidate);
    if (lower) return { lower, shrinkage };
  }
  return {
    lower: cholesky(
      matrix.map((row, rowIndex) => row.map((value, columnIndex) => (rowIndex === columnIndex ? value : 0))),
    ),
    shrinkage: 0,
  };
}

function gaussian(random = Math.random) {
  const u = clamp(random(), Number.EPSILON, 1 - Number.EPSILON);
  const v = clamp(random(), Number.EPSILON, 1 - Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function monthlyContributionAt(base, growth, month) {
  return Math.max(0, Number(base) || 0) * Math.pow(1 + (Number(growth) || 0), Math.floor(month / 12));
}

function configuredFeeRate(transactionCosts, asset, side) {
  const configured = transactionCosts?.[asset] || DEFAULT_TRANSACTION_COSTS[asset] || {};
  const rawFee = configured[side];
  const rawSpread = configured.spread;
  const hasFee = rawFee !== null && rawFee !== undefined && rawFee !== "";
  const hasSpread = rawSpread !== null && rawSpread !== undefined && rawSpread !== "";
  const fee = hasFee ? Number(rawFee) : 0;
  const spread = hasSpread ? Number(rawSpread) : 0;
  if (!Number.isFinite(fee) || fee < 0 || !Number.isFinite(spread) || spread < 0)
    throw new RangeError(`invalid-transaction-cost:${asset}`);
  const rate = fee + spread / 2;
  if (rate >= 1) throw new RangeError(`transaction-cost-exceeds-purchase:${asset}`);
  return rate;
}

function applyReturns(holdings, returns) {
  ASSET_KEYS.forEach((asset) => {
    const monthlyReturn = Number(returns[asset]);
    if (!Number.isFinite(monthlyReturn) || monthlyReturn <= -1) throw new RangeError(`invalid-monthly-return:${asset}`);
    holdings[asset] *= 1 + monthlyReturn;
  });
}

function addContribution(holdings, amount, allocation, transactionCosts) {
  let fees = 0;
  ASSET_KEYS.forEach((asset) => {
    const grossPurchase = (amount * (Number(allocation[asset]) || 0)) / 100;
    const fee = grossPurchase * configuredFeeRate(transactionCosts, asset, "buyFee");
    holdings[asset] += grossPurchase - fee;
    fees += fee;
  });
  return fees;
}

function rebalance(holdings, allocation, transactionCosts) {
  const total = portfolioTotal(holdings);
  if (total <= EPSILON) return { fees: 0, turnover: 0 };
  const target = normalizeAllocation(allocation, DEFAULT_ALLOCATION, ASSET_KEYS);
  const feesAt = (targetTotal) =>
    sum(
      ASSET_KEYS.map((asset) => {
        const targetValue = (targetTotal * target[asset]) / 100;
        const change = targetValue - holdings[asset];
        if (change > 0) {
          const buyRate = configuredFeeRate(transactionCosts, asset, "buyFee");
          return (change * buyRate) / Math.max(EPSILON, 1 - buyRate);
        }
        return -change * configuredFeeRate(transactionCosts, asset, "sellFee");
      }),
    );
  let low = 0;
  let high = total;
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const candidate = (low + high) / 2;
    const afterFees = total - feesAt(candidate);
    if (candidate > afterFees) high = candidate;
    else low = candidate;
  }
  const finalValue = (low + high) / 2;
  const fees = Math.max(0, total - finalValue);
  let turnover = 0;
  ASSET_KEYS.forEach((asset) => {
    const targetValue = (finalValue * target[asset]) / 100;
    turnover += Math.abs(targetValue - holdings[asset]);
    holdings[asset] = targetValue;
  });
  return { fees, turnover: turnover / 2 };
}

function portfolioTotal(holdings) {
  return sum(Object.values(holdings));
}

function shouldRebalance(holdings, allocation, options, monthIndex) {
  if (options.rebalance === false) return false;
  const cadence = options.rebalanceCadence || DEFAULT_REBALANCE_CADENCE;
  if (cadence === "monthly") return true;
  if (cadence === "annually") return (monthIndex + 1) % 12 === 0;
  if (cadence === "threshold") {
    const total = portfolioTotal(holdings);
    if (total <= EPSILON) return false;
    const target = normalizeAllocation(allocation, DEFAULT_ALLOCATION, ASSET_KEYS);
    const rawThreshold = options.rebalanceThresholdPercent;
    const threshold = Math.max(
      0,
      rawThreshold === null || rawThreshold === undefined || rawThreshold === ""
        ? DEFAULT_REBALANCE_THRESHOLD_PERCENT
        : Number(rawThreshold),
    );
    return ASSET_KEYS.some((asset) => Math.abs((holdings[asset] / total) * 100 - target[asset]) >= threshold);
  }
  return (monthIndex + 1) % 3 === 0;
}

function fixedIncomeMonthlyReturn(options, model, state, random = null) {
  const configuredExpected = Number(model?.fixed?.annualReturn ?? DEFAULT_ASSUMPTIONS.fixed.annualReturn);
  const currentMarketRate = Number(options.currentFixedAnnualReturn);
  const hasCurrentMarketRate =
    options.currentFixedAnnualReturn !== null &&
    options.currentFixedAnnualReturn !== undefined &&
    options.currentFixedAnnualReturn !== "" &&
    Number.isFinite(currentMarketRate);
  const currentRate = hasCurrentMarketRate ? currentMarketRate : configuredExpected;
  const mode = options.fixedIncomeMode || "mean-reverting";
  if (mode === "constant-market") return annualToMonthlyRate(currentRate);
  if (mode === "user-expected") return annualToMonthlyRate(configuredExpected);

  const speed = clamp(options.fixedIncomeMeanReversionSpeed ?? 0.15, 0, 1);
  const yieldVolatility = Math.max(
    0,
    Number(options.fixedIncomeYieldVolatility ?? model?.fixed?.annualVolatility) || 0,
  );
  const shock = typeof random === "function" ? (yieldVolatility / Math.sqrt(12)) * gaussian(random) : 0;
  state.annualRate += speed * (configuredExpected - state.annualRate) + shock;
  state.annualRate = clamp(state.annualRate, -0.5, 3);
  return annualToMonthlyRate(state.annualRate);
}

function contributionAmounts(options, months) {
  const contributions = [Math.max(0, Number(options.initialInvestment) || 0)];
  for (let month = 0; month < months; month += 1)
    contributions.push(monthlyContributionAt(options.monthlyContribution, options.contributionGrowth, month));
  return contributions;
}

function realInvestedToday(contributions, inflationRate) {
  const realContributions = contributions.map((amount, index) => realValue(amount, inflationRate, index / 12));
  return realContributions.every((amount) => amount !== null) ? sum(realContributions) : null;
}

function inflationProtectedValue(contributions, inflationRate, horizonMonths) {
  const realDeposits = realInvestedToday(contributions, inflationRate);
  if (realDeposits === null || inflationRate <= -1 || !Number.isFinite(horizonMonths) || horizonMonths < 0) return null;
  const value = realDeposits * Math.pow(1 + inflationRate, horizonMonths / 12);
  return Number.isFinite(value) ? value : null;
}

function currentPurchasingPowerDrawdown(values, contributions, inflationRate) {
  if (values.length < 2 || !contributions.length) return null;
  if (!contributions.some((amount) => Number.isFinite(amount) && amount > EPSILON)) return null;
  let drawdown = 0;
  for (let month = 1; month < values.length; month += 1) {
    const realBalance = realValue(values[month], inflationRate, month / 12);
    const realContributions = realInvestedToday(contributions.slice(0, month + 1), inflationRate);
    if (realBalance === null || realContributions === null) return null;
    if (realContributions <= EPSILON) continue;
    drawdown = Math.max(drawdown, Math.max(0, 1 - realBalance / realContributions));
  }
  return drawdown;
}

function percentileStatus(returns, monthlyMar) {
  const valid = returns.filter(Number.isFinite);
  const downsideCount = valid.filter((value) => value < monthlyMar).length;
  if (valid.length < MIN_SORTINO_OBSERVATIONS) return "insufficient-observations";
  if (downsideCount < MIN_SORTINO_DOWNSIDE_OBSERVATIONS) return "insufficient-downside-observations";
  const deviation = downsideDeviation(valid, monthlyMar);
  return deviation === null ? "zero-downside-deviation" : "available";
}

export function simulatePlan(options = {}) {
  const horizonYears = clamp(options.horizonYears || 5, 1, 50);
  const months = Math.max(1, Math.round(horizonYears * 12));
  requirePositiveAllocation(options.allocation);
  const allocation = normalizeAllocation(options.allocation);
  const annualReturns = options.annualReturns || DEFAULT_ASSUMPTIONS;
  const inflationRate = scenarioInflationRate(options.inflationRate);
  const transactionCosts = options.transactionCosts || DEFAULT_TRANSACTION_COSTS;
  const holdings = Object.fromEntries(ASSET_KEYS.map((asset) => [asset, 0]));
  let totalInvested = Math.max(0, Number(options.initialInvestment) || 0);
  let totalTransactionCosts = addContribution(holdings, totalInvested, allocation, transactionCosts);
  let rebalancingTurnover = 0;
  const contributions = [totalInvested];
  const points = [{ month: 0, nominal: portfolioTotal(holdings), real: portfolioTotal(holdings) }];
  const fixedMarketRate = Number(options.currentFixedAnnualReturn);
  const hasFixedMarketRate =
    options.currentFixedAnnualReturn !== null &&
    options.currentFixedAnnualReturn !== undefined &&
    options.currentFixedAnnualReturn !== "" &&
    Number.isFinite(fixedMarketRate);
  const fixedRateState = {
    annualRate: hasFixedMarketRate
      ? fixedMarketRate
      : Number(annualReturns.fixed?.annualReturn ?? annualReturns.fixed ?? DEFAULT_ASSUMPTIONS.fixed.annualReturn),
  };
  const portfolioMonthlyReturns = [];

  for (let month = 0; month < months; month += 1) {
    const contribution = monthlyContributionAt(options.monthlyContribution, options.contributionGrowth, month);
    totalInvested += contribution;
    contributions.push(contribution);
    const previousValue = portfolioTotal(holdings);
    const monthlyAssetReturns = {};
    ASSET_KEYS.forEach((asset) => {
      monthlyAssetReturns[asset] =
        asset === "fixed"
          ? fixedIncomeMonthlyReturn(options, annualReturns, fixedRateState)
          : annualToMonthlyRate(
              annualReturns[asset]?.annualReturn ?? annualReturns[asset] ?? DEFAULT_ASSUMPTIONS[asset].annualReturn,
            );
    });
    applyReturns(holdings, monthlyAssetReturns);
    let netContribution = 0;
    if (contribution > 0) {
      const contributionFees = addContribution(holdings, contribution, allocation, transactionCosts);
      totalTransactionCosts += contributionFees;
      netContribution = contribution - contributionFees;
    }
    if (shouldRebalance(holdings, allocation, options, month)) {
      const trade = rebalance(holdings, allocation, transactionCosts);
      totalTransactionCosts += trade.fees;
      rebalancingTurnover += trade.turnover;
    }
    const nominal = portfolioTotal(holdings);
    portfolioMonthlyReturns.push(previousValue > EPSILON ? (nominal - netContribution) / previousValue - 1 : null);
    points.push({
      month: month + 1,
      nominal,
      real: realValue(nominal, inflationRate, (month + 1) / 12),
    });
  }

  const final = points[points.length - 1];
  const investedInTomanToday = realInvestedToday(contributions, inflationRate);
  const monthlyIrr = irr(
    contributions.map((amount, index) => (index === contributions.length - 1 ? final.nominal - amount : -amount)),
  );
  const cagr = monthlyIrr === null ? null : Math.pow(1 + monthlyIrr, 12) - 1;
  return {
    points,
    holdings,
    months,
    horizonYears,
    totalInvested,
    finalValue: final.nominal,
    finalRealValue: final.real,
    inflationFactor: Math.pow(1 + inflationRate, horizonYears),
    nominalGain: final.nominal - totalInvested,
    realInvested: investedInTomanToday,
    realGain: final.real - investedInTomanToday,
    purchasingPowerChange: investedInTomanToday > EPSILON ? final.real / investedInTomanToday - 1 : null,
    cagr,
    realCagr: realMoneyWeightedCagr(contributions, final.nominal, inflationRate),
    maxDrawdown: maxDrawdown(unitizedValuePath(portfolioMonthlyReturns)),
    realMaxDrawdown: maxDrawdown(realUnitizedValuePath(portfolioMonthlyReturns, inflationRate)),
    purchasingPowerDrawdown: currentPurchasingPowerDrawdown(
      points.map((point) => point.nominal),
      contributions,
      inflationRate,
    ),
    transactionCosts: totalTransactionCosts,
    rebalancingTurnover,
    monthlyReturns: portfolioMonthlyReturns,
  };
}

function irr(cashFlows) {
  if (cashFlows.length < 2 || !cashFlows.some((flow) => flow < 0) || !cashFlows.some((flow) => flow > 0)) return null;
  const netPresentValue = (rate) =>
    cashFlows.reduce((value, cashFlow, month) => value + cashFlow / Math.pow(1 + rate, month), 0);
  const atZero = netPresentValue(0);
  let low = atZero >= 0 ? 0 : -0.99;
  let high = atZero >= 0 ? 0.1 : 0;
  let highValue = netPresentValue(high);
  let attempts = 0;
  while (atZero >= 0 && highValue > 0 && attempts < 16) {
    high = (high + 1) * 2 - 1;
    highValue = netPresentValue(high);
    attempts += 1;
  }
  const lowValue = netPresentValue(low);
  if (Number.isNaN(lowValue) || Number.isNaN(highValue) || lowValue * highValue > 0) return null;
  for (let iteration = 0; iteration < 120; iteration += 1) {
    const midpoint = (low + high) / 2;
    const value = netPresentValue(midpoint);
    if (!Number.isFinite(value)) {
      if (value < 0) low = midpoint;
      else high = midpoint;
      continue;
    }
    if (Math.abs(value) < 1e-8 || Math.abs(high - low) < 1e-10) return midpoint;
    if (value > 0) low = midpoint;
    else high = midpoint;
  }
  return (low + high) / 2;
}

function realMoneyWeightedCagr(contributions, nominalFinalValue, inflationRate) {
  if (!Number.isFinite(inflationRate) || inflationRate <= -1 || !Number.isFinite(nominalFinalValue)) return null;
  const months = contributions.length - 1;
  if (months < 1) return null;
  const finalRealValue = realValue(nominalFinalValue, inflationRate, months / 12);
  if (finalRealValue === null) return null;
  const realCashFlows = contributions.map((amount, month) => -amount / Math.pow(1 + inflationRate, month / 12));
  realCashFlows[realCashFlows.length - 1] += finalRealValue;
  const monthlyIrr = irr(realCashFlows);
  if (monthlyIrr === null || monthlyIrr <= -1) return null;
  const annualized = Math.pow(1 + monthlyIrr, 12) - 1;
  return Number.isFinite(annualized) ? annualized : null;
}

function pathMetrics(
  values,
  contributions,
  inflationRate,
  monthlyReturns = [],
  sharpeBenchmarkAnnualReturn = null,
  transactionCosts = 0,
  monthlyMar = 0,
) {
  const months = Math.max(1, values.length - 1);
  const cashFlows = contributions.map((amount) => -amount);
  cashFlows[cashFlows.length - 1] += values[values.length - 1];
  const monthlyIrr = irr(cashFlows);
  const cagr = monthlyIrr === null ? null : Math.pow(1 + monthlyIrr, 12) - 1;
  const finalRealValue = realValue(values[values.length - 1], inflationRate, months / 12);
  const realDeposits = realInvestedToday(contributions, inflationRate);
  const unitizedValues = unitizedValuePath(monthlyReturns);
  const realValues = realUnitizedValuePath(monthlyReturns, inflationRate);
  const annualizedRisk = annualizedVolatility(monthlyReturns);
  return {
    totalInvested: sum(contributions),
    finalValue: values[values.length - 1],
    finalRealValue,
    cagr,
    realCagr: realMoneyWeightedCagr(contributions, values[values.length - 1], inflationRate),
    inflationAdjustedReturn: realDeposits > EPSILON ? finalRealValue / realDeposits - 1 : null,
    maxDrawdown: maxDrawdown(unitizedValues),
    realMaxDrawdown: maxDrawdown(realValues),
    purchasingPowerDrawdown: currentPurchasingPowerDrawdown(values, contributions, inflationRate),
    volatility: annualizedRisk,
    downsideDeviation: monthlyMar === null ? null : downsideDeviation(monthlyReturns, monthlyMar),
    sortino: monthlyMar === null ? null : sortinoRatio(monthlyReturns, monthlyMar),
    sortinoStatus: monthlyMar === null ? "benchmark-unavailable" : percentileStatus(monthlyReturns, monthlyMar),
    sharpe: Number.isFinite(sharpeBenchmarkAnnualReturn)
      ? sharpeRatio(monthlyReturns, annualToMonthlyRate(sharpeBenchmarkAnnualReturn))
      : null,
    transactionCosts,
    months,
  };
}

function monthlyCoverageRanges(rows, assets) {
  const ranges = [];
  let run = null;
  rows.forEach((row) => {
    const previous = run?.months.at(-1);
    const [year, month] = row.month.split("-").map(Number);
    const [previousYear, previousMonth] = (previous || "").split("-").map(Number);
    const adjacent = previous && year * 12 + month === previousYear * 12 + previousMonth + 1;
    if (!assets.every((asset) => row.observed[asset])) {
      if (run) ranges.push(run);
      run = null;
      return;
    }
    if (!run || !adjacent) {
      if (run) ranges.push(run);
      run = { start: row.month, end: row.month, months: [row.month] };
      return;
    }
    run.end = row.month;
    run.months.push(row.month);
  });
  if (run) ranges.push(run);
  return ranges.map(({ start, end, months: coveredMonths }) => ({ start, end, months: coveredMonths.length }));
}

function backtestCoverage(historical, requiredAssets) {
  const byAsset = Object.fromEntries(
    requiredAssets.map((asset) => [asset, monthlyCoverageRanges(historical.rows, [asset])]),
  );
  const joint = monthlyCoverageRanges(historical.rows, requiredAssets);
  return {
    frequency: "monthly",
    requiredAssets,
    rangesByAsset: byAsset,
    jointRanges: joint,
    longestContinuousMonths: Math.max(0, ...joint.map((range) => range.months)),
  };
}

export function backtestHistorical(options = {}) {
  const assumptions = options.assumptions || DEFAULT_ASSUMPTIONS;
  const historical = buildHistoricalReturns(options.market, assumptions);
  const requestedMonths = Math.max(6, Math.round(clamp(options.horizonYears || 5, 1, 50) * 12));
  const allocation = normalizeAllocation(options.allocation);
  requirePositiveAllocation(options.allocation);
  const inflationRate = scenarioInflationRate(options.inflationRate);
  const fixedReference = currentFixedReturn(options.market);
  const annualMar =
    options.marType === "inflation" ? inflationRate : options.marType === "fixed-income" ? fixedReference : 0;
  const monthlyMar = annualMar === null ? null : annualToMonthlyRate(annualMar);
  const requiredAssets = ASSET_KEYS.filter((asset) => allocation[asset] > EPSILON);
  const horizon = requestedMonths;
  const coverageDetail = backtestCoverage(historical, requiredAssets);
  const unobservedAssets = requiredAssets.filter((asset) => !historical.assetMetadata[asset]?.returnObservations);
  if (historical.rows.length < horizon)
    return {
      available: false,
      reason: "insufficient-observed-history",
      observations: historical.rows.length,
      requiredMonths: horizon,
      coverage: historical.coverage,
      ...coverageDetail,
      unobservedAssets,
      historyFetchError: historical.historyFetchError,
      estimated: false,
    };
  const periods = [];

  for (let start = 0; start + horizon <= historical.rows.length; start += 1) {
    const observedWindow = historical.rows.slice(start, start + horizon);
    const fullyObserved =
      observedWindow.every((row) => requiredAssets.every((asset) => row.observed[asset])) &&
      observedWindow.slice(1).every((row, index) => {
        const previousMonth = observedWindow[index].month;
        const [previousYear, previousMonthNumber] = previousMonth.split("-").map(Number);
        const [currentYear, currentMonthNumber] = row.month.split("-").map(Number);
        return currentYear * 12 + currentMonthNumber === previousYear * 12 + previousMonthNumber + 1;
      });
    if (!fullyObserved) continue;
    const holdings = Object.fromEntries(ASSET_KEYS.map((asset) => [asset, 0]));
    const initialInvestment = Math.max(0, Number(options.initialInvestment) || 0);
    const contributions = [initialInvestment];
    const monthlyReturns = [];
    let transactionCosts = addContribution(holdings, contributions[0], allocation, options.transactionCosts);
    const values = [portfolioTotal(holdings)];
    for (let offset = 0; offset < horizon; offset += 1) {
      const contribution = monthlyContributionAt(options.monthlyContribution, options.contributionGrowth, offset);
      const previousValue = portfolioTotal(holdings);
      contributions.push(contribution);
      applyReturns(holdings, observedWindow[offset].returns);
      let netContribution = 0;
      if (contribution > 0) {
        const contributionFees = addContribution(holdings, contribution, allocation, options.transactionCosts);
        transactionCosts += contributionFees;
        netContribution = contribution - contributionFees;
      }
      if (shouldRebalance(holdings, allocation, options, offset)) {
        transactionCosts += rebalance(holdings, allocation, options.transactionCosts).fees;
      }
      const valueAfter = portfolioTotal(holdings);
      monthlyReturns.push(previousValue > EPSILON ? (valueAfter - netContribution) / previousValue - 1 : null);
      values.push(portfolioTotal(holdings));
    }
    periods.push({
      start: observedWindow[0].month,
      end: observedWindow.at(-1).month,
      ...pathMetrics(
        values,
        contributions,
        inflationRate,
        monthlyReturns,
        options.sharpeBenchmarkAnnualReturn ?? null,
        transactionCosts,
        monthlyMar,
      ),
    });
  }

  if (!periods.length)
    return {
      available: false,
      reason: "insufficient-observed-history",
      observations: historical.rows.length,
      requiredMonths: horizon,
      coverage: historical.coverage,
      ...coverageDetail,
      unobservedAssets,
      reason: coverageDetail.longestContinuousMonths < horizon ? "insufficient-continuous-overlap" : "no-valid-window",
      historyFetchError: historical.historyFetchError,
      estimated: false,
    };
  const best = periods.slice().sort((left, right) => (right.cagr ?? -Infinity) - (left.cagr ?? -Infinity))[0];
  const worst = periods.slice().sort((left, right) => (left.cagr ?? -Infinity) - (right.cagr ?? -Infinity))[0];
  return {
    available: periods.length > 0,
    observations: historical.rows.length,
    coverage: historical.coverage,
    ...coverageDetail,
    historyFetchError: historical.historyFetchError,
    estimated: false,
    referenceAnnualReturn: currentFixedReturn(options.market),
    horizonMonths: horizon,
    periods,
    best,
    worst,
    median: {
      finalValue: median(periods.map((period) => period.finalValue)),
      cagr: median(periods.map((period) => period.cagr)),
      inflationAdjustedReturn: median(periods.map((period) => period.inflationAdjustedReturn)),
      maxDrawdown: median(periods.map((period) => period.maxDrawdown)),
      realMaxDrawdown: median(periods.map((period) => period.realMaxDrawdown)),
      purchasingPowerDrawdown: median(periods.map((period) => period.purchasingPowerDrawdown)),
      volatility: median(periods.map((period) => period.volatility)),
      downsideDeviation: median(periods.map((period) => period.downsideDeviation)),
      sortino: median(periods.map((period) => period.sortino)),
      sharpe: median(periods.map((period) => period.sharpe)),
    },
  };
}

export function contributionRebalance(
  currentHoldings,
  targetAllocation,
  monthlyContribution,
  assetKeys = PLAN_ASSET_KEYS,
  options = {},
) {
  requirePositiveAllocation(targetAllocation, assetKeys);
  const contribution = Math.max(0, Number(monthlyContribution) || 0);
  const current = Object.fromEntries(
    assetKeys.map((asset) => [asset, Math.max(0, Number(currentHoldings && currentHoldings[asset]) || 0)]),
  );
  const target = normalizeAllocation(targetAllocation, DEFAULT_ALLOCATION, assetKeys);
  const currentTotal = portfolioTotal(current);
  const currentWeights = Object.fromEntries(
    assetKeys.map((asset) => [asset, currentTotal > EPSILON ? (current[asset] / currentTotal) * 100 : 0]),
  );
  const drift = Object.fromEntries(assetKeys.map((asset) => [asset, currentWeights[asset] - target[asset]]));
  const configuredThreshold = options.driftThresholdPercent;
  const driftThreshold = Math.max(
    0,
    configuredThreshold === null || configuredThreshold === undefined || configuredThreshold === ""
      ? DEFAULT_REBALANCE_THRESHOLD_PERCENT
      : Number(configuredThreshold),
  );
  const resultFor = (amounts, usesTargetDrift) => {
    const amountTotal = sum(assetKeys.map((asset) => Number(amounts[asset]) || 0));
    const residual = contribution - amountTotal;
    const recipient = [...assetKeys].reverse().find((asset) => Number(amounts[asset]) > EPSILON) || assetKeys.at(-1);
    if (recipient && Number.isFinite(residual)) amounts[recipient] = (Number(amounts[recipient]) || 0) + residual;
    const finalTotal = sum(assetKeys.map((asset) => Number(amounts[asset]) || 0));
    const contributionWeights = Object.fromEntries(
      assetKeys.map((asset) => [asset, finalTotal > EPSILON ? ((Number(amounts[asset]) || 0) / finalTotal) * 100 : 0]),
    );
    return {
      amounts,
      contributionAmounts: amounts,
      weights: contributionWeights,
      contributionWeights,
      targetWeights: target,
      contributionBudget: contribution,
      amountRoundingRule: "Amounts reconcile to the full-precision budget before display rounding.",
      current,
      currentTotal,
      currentWeights,
      drift,
      deviationPercentagePoints: drift,
      driftThreshold,
      usesTargetDrift,
    };
  };
  if (currentTotal <= EPSILON)
    return resultFor(
      assetKeys.reduce((result, asset) => ({ ...result, [asset]: (contribution * target[asset]) / 100 }), {}),
      false,
    );

  const targetWeightedBuyRate = sum(
    assetKeys.map((asset) => (target[asset] / 100) * configuredFeeRate(options.transactionCosts, asset, "buyFee")),
  );
  const targetNetContribution = contribution * Math.max(0, 1 - targetWeightedBuyRate);
  const projectedHoldings = Object.fromEntries(
    assetKeys.map((asset) => [
      asset,
      current[asset] +
        (contribution * target[asset] * (1 - configuredFeeRate(options.transactionCosts, asset, "buyFee"))) / 100,
    ]),
  );
  const projectedTotal = portfolioTotal(projectedHoldings);
  const projectedDriftRemains = assetKeys.some((asset) => {
    const deviation = Math.abs((projectedHoldings[asset] / Math.max(EPSILON, projectedTotal)) * 100 - target[asset]);
    return deviation > EPSILON && deviation >= driftThreshold;
  });
  const desiredAfterContribution = currentTotal + targetNetContribution;
  const grossDeficits = Object.fromEntries(
    assetKeys.map((asset) => [
      asset,
      Math.max(0, (desiredAfterContribution * target[asset]) / 100 - current[asset]) /
        Math.max(EPSILON, 1 - configuredFeeRate(options.transactionCosts, asset, "buyFee")),
    ]),
  );
  const grossDeficitTotal = sum(Object.values(grossDeficits));
  const usesTargetDrift = projectedDriftRemains && grossDeficitTotal > EPSILON;
  const amounts = Object.fromEntries(assetKeys.map((asset) => [asset, 0]));
  if (!usesTargetDrift) {
    assetKeys.forEach((asset) => {
      amounts[asset] = (contribution * target[asset]) / 100;
    });
  } else if (contribution <= grossDeficitTotal) {
    assetKeys.forEach((asset) => {
      amounts[asset] = (contribution * grossDeficits[asset]) / grossDeficitTotal;
    });
  } else {
    const remainingContribution = contribution - grossDeficitTotal;
    assetKeys.forEach((asset) => {
      amounts[asset] = grossDeficits[asset] + (remainingContribution * target[asset]) / 100;
    });
  }
  return resultFor(amounts, usesTargetDrift);
}

function correlatedDraws(model, covariance, random, assets = ASSET_KEYS) {
  if (!assets.length)
    return {
      returns: Object.fromEntries(ASSET_KEYS.map((asset) => [asset, 0])),
      correlationOffDiagonalRetention: null,
    };
  const assetIndices = assets.map((asset) => ASSET_KEYS.indexOf(asset));
  const monthlyMeans = assets.map((asset) =>
    annualToMonthlyRate(model[asset]?.annualReturn ?? DEFAULT_ASSUMPTIONS[asset].annualReturn),
  );
  const hasCovariance = Array.isArray(covariance) && covariance.length >= ASSET_KEYS.length;
  const monthlyCovariance = assets.map((rowAsset, rowIndex) =>
    assets.map((asset, columnIndex) => {
      const supplied = Number(covariance?.[assetIndices[rowIndex]]?.[assetIndices[columnIndex]]);
      if (hasCovariance && Number.isFinite(supplied)) return supplied;
      const first = Number(model[rowAsset]?.annualVolatility || 0) / Math.sqrt(12);
      const second = Number(model[assets[columnIndex]]?.annualVolatility || 0) / Math.sqrt(12);
      return rowIndex === columnIndex ? first * second : 0;
    }),
  );
  const relativeVariances = monthlyMeans.map((monthlyMean, index) =>
    monthlyMeans[index] > -1 ? monthlyCovariance[index][index] / (1 + monthlyMean) ** 2 : 0,
  );
  const logStandardDeviations = relativeVariances.map((variance) => Math.sqrt(Math.log1p(Math.max(0, variance))));
  const logCorrelation = assets.map((_, rowIndex) =>
    assets.map((__, columnIndex) => {
      if (rowIndex === columnIndex) return 1;
      const denominator = logStandardDeviations[rowIndex] * logStandardDeviations[columnIndex];
      if (denominator <= EPSILON) return 0;
      const covarianceValue = monthlyCovariance[rowIndex][columnIndex];
      const covarianceInLognormalUnits =
        covarianceValue / ((1 + monthlyMeans[rowIndex]) * (1 + monthlyMeans[columnIndex]));
      return clamp(Math.log1p(clamp(covarianceInLognormalUnits, -0.999999, 1000)) / denominator, -1, 1);
    }),
  );
  const { lower, shrinkage } = stableCholesky(logCorrelation);
  const standard = assets.map(() => gaussian(random));
  const correlated = assets.map((_, row) => sum(lower[row].map((value, index) => value * standard[index])));
  const returns = Object.fromEntries(ASSET_KEYS.map((asset) => [asset, 0]));
  Object.assign(
    returns,
    Object.fromEntries(
      assets.map((asset, index) => {
        const monthlyMean = monthlyMeans[index];
        if (monthlyMean <= -1) throw new RangeError(`invalid-expected-monthly-return:${asset}`);
        const logVariance = logStandardDeviations[index] ** 2;
        const logMean = Math.log1p(monthlyMean) - logVariance / 2;
        return [asset, Math.expm1(logMean + logStandardDeviations[index] * correlated[index])];
      }),
    ),
  );
  return { returns, correlationOffDiagonalRetention: shrinkage };
}

function bootstrapDraws(rows, model, random, cursor) {
  if (!rows.length) return null;
  if (cursor.remaining <= 0) {
    const blockLength = Math.min(BOOTSTRAP_BLOCK_MONTHS, rows.length);
    cursor.index = Math.floor(random() * (rows.length - blockLength + 1));
    cursor.remaining = blockLength;
  }
  const row = rows[cursor.index];
  cursor.index += 1;
  cursor.remaining -= 1;
  return Object.fromEntries(
    ASSET_KEYS.map((asset) => [
      asset,
      row.observed?.[asset] ? row.returns[asset] : annualToMonthlyRate(model[asset].annualReturn),
    ]),
  );
}

function createSeededRandom(seed = 1) {
  let state = Number(seed) >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function completeHistoricalRows(historical, requiredAssets) {
  if (!historical?.rows?.length || !requiredAssets.length) return [];
  const complete = historical.rows.filter((row) =>
    requiredAssets.every((asset) => row.observed?.[asset] && Number.isFinite(row.returns?.[asset])),
  );
  let longest = [];
  let run = [];
  complete.forEach((row) => {
    const previous = run.at(-1);
    if (previous && monthOrdinal(row.month) !== monthOrdinal(previous.month) + 1) {
      if (run.length > longest.length) longest = run;
      run = [];
    }
    run.push(row);
  });
  if (run.length > longest.length) longest = run;
  return longest;
}

function simulationDataQuality(historical, model, activeAssets) {
  const assets = activeAssets.map((assetId) => {
    const history = historical?.assetMetadata?.[assetId] || {
      ...ASSET_RETURN_BASIS[assetId],
      priceObservations: 0,
      returnObservations: 0,
      firstObservedAt: null,
      lastObservedAt: null,
      source: null,
      frequency: "monthly returns from dated price history",
    };
    const observations = Number(history.returnObservations) || 0;
    const coverage = Number(historical?.coverage?.[assetId]) || 0;
    const complete = assetId !== "fixed" && observations >= MIN_PAIRED_MONTHS && coverage >= 0.75;
    const status =
      assetId === "fixed"
        ? "fixed-rate-scenario"
        : complete
          ? "historical"
          : observations
            ? "insufficient-history"
            : "fallback-assumption";
    return {
      assetId,
      ...history,
      observations,
      coverage,
      status,
      expectedReturnSource: model?.[assetId]?.source || "configured-assumption",
      arithmeticExpectedAnnualReturn: model?.[assetId]?.annualReturn ?? null,
      geometricHistoricalAnnualReturn: model?.[assetId]?.geometricAnnualReturn ?? null,
      annualVolatility: model?.[assetId]?.annualVolatility ?? null,
      complete,
    };
  });
  const historicalAssets = assets.filter((asset) => asset.assetId !== "fixed");
  const historicalAssetIds = historicalAssets.map((asset) => asset.assetId);
  const completeHistoryAssets = historicalAssets.filter((asset) => asset.complete).map((asset) => asset.assetId);
  const fallbackAssumptionAssets = assets.filter((asset) => !asset.complete).map((asset) => asset.assetId);
  const proxyDataAssets = assets.filter((asset) => asset.proxy && asset.observations > 0).map((asset) => asset.assetId);
  const insufficientHistoryAssets = historicalAssets
    .filter((asset) => asset.observations < MIN_PAIRED_MONTHS)
    .map((asset) => asset.assetId);
  const jointRows = completeHistoricalRows(historical, historicalAssetIds);
  const jointObservations = jointRows.length;
  const correlationPairs = [];
  for (let leftIndex = 0; leftIndex < historicalAssetIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < historicalAssetIds.length; rightIndex += 1) {
      const left = historicalAssetIds[leftIndex];
      const right = historicalAssetIds[rightIndex];
      const observations = historical?.rows?.filter((row) => row.observed?.[left] && row.observed?.[right]).length || 0;
      correlationPairs.push({
        assets: [left, right],
        observations,
        source:
          observations >= MIN_CORRELATION_OBSERVATIONS
            ? "paired-historical"
            : observations
              ? "historical-and-judgmental-prior"
              : "judgmental-prior",
        priorCorrelation: FALLBACK_CORRELATIONS[[left, right].sort().join("|")] ?? 0.25,
      });
    }
  }
  const oldestDate =
    assets
      .map((asset) => asset.firstObservedAt)
      .filter(Boolean)
      .sort()[0] || null;
  const latestDate =
    assets
      .map((asset) => asset.lastObservedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
  const allMarketAssetsComplete = historicalAssets.length > 0 && historicalAssets.every((asset) => asset.complete);
  const quality =
    allMarketAssetsComplete &&
    jointObservations >= 60 &&
    insufficientHistoryAssets.length === 0 &&
    proxyDataAssets.length === 0 &&
    !activeAssets.includes("fixed")
      ? "high"
      : allMarketAssetsComplete && jointObservations >= MIN_PAIRED_MONTHS
        ? "medium"
        : "low";
  return {
    quality,
    monthlyObservations: historical?.observations || 0,
    historyFetchError: historical?.historyFetchError || null,
    oldestDate,
    latestDate,
    jointOldestMonth: jointRows[0]?.month || null,
    jointLatestMonth: jointRows.at(-1)?.month || null,
    frequency: "monthly",
    assets,
    completeHistoryAssets,
    fallbackAssumptionAssets,
    proxyDataAssets,
    insufficientHistoryAssets,
    jointObservations,
    correlationPairs,
  };
}

function transactionCostCoverage(transactionCosts, activeAssets) {
  return activeAssets.map((assetId) => {
    const configured = transactionCosts?.[assetId] || DEFAULT_TRANSACTION_COSTS[assetId] || {};
    const hasBuy =
      configured.buyFee !== null &&
      configured.buyFee !== undefined &&
      Number.isFinite(Number(configured.buyFee)) &&
      Number(configured.buyFee) >= 0;
    const hasSell =
      configured.sellFee !== null &&
      configured.sellFee !== undefined &&
      Number.isFinite(Number(configured.sellFee)) &&
      Number(configured.sellFee) >= 0;
    const hasSpread =
      configured.spread !== null &&
      configured.spread !== undefined &&
      Number.isFinite(Number(configured.spread)) &&
      Number(configured.spread) >= 0;
    return {
      assetId,
      buyFee: hasBuy ? Number(configured.buyFee) : null,
      sellFee: hasSell ? Number(configured.sellFee) : null,
      spread: hasSpread ? Number(configured.spread) : null,
      complete: hasBuy && hasSell,
    };
  });
}

function calculateTailRisk(returns) {
  const valid = returns.filter(Number.isFinite);
  if (valid.length < 200)
    return { available: false, reason: "insufficient-observations", observations: valid.length, frequency: "monthly" };
  const quantile = percentile(valid, 0.05);
  const tail = valid.filter((value) => value <= quantile);
  if (!Number.isFinite(quantile) || !tail.length)
    return { available: false, reason: "unreliable-tail-sample", observations: valid.length, frequency: "monthly" };
  return {
    available: true,
    basis: "simulated-monthly-portfolio-returns",
    confidenceLevel: 0.95,
    valueAtRisk: Math.max(0, -quantile),
    expectedShortfall: Math.max(0, -mean(tail)),
    observations: valid.length,
    frequency: "monthly",
  };
}

export function runMonteCarlo(options = {}) {
  const paths = Math.round(clamp(options.paths || 2000, 1000, 10000));
  const horizonYears = clamp(options.horizonYears || 5, 1, 50);
  const months = Math.max(1, Math.round(horizonYears * 12));
  const includeMetrics = options.includeMetrics !== false;
  requirePositiveAllocation(options.allocation);
  const allocation = normalizeAllocation(options.allocation);
  const modelResult = options.returnModel
    ? {
        model: options.returnModel,
        ewmaModel: options.ewmaModel || options.returnModel,
        historical: options.historical || null,
        covariance:
          options.covariance ||
          (options.historical ? covarianceMatrix(options.historical.rows, ASSET_KEYS, options.returnModel) : null),
        referenceAnnualReturn: options.referenceAnnualReturn ?? null,
      }
    : estimateReturnModel(options.market, options.assumptions || DEFAULT_ASSUMPTIONS);
  const requestedMethod = ["ewma", "block-bootstrap"].includes(options.method) ? options.method : "gaussian";
  const activeAssets = ASSET_KEYS.filter((asset) => allocation[asset] > EPSILON);
  const historicalAssets = activeAssets.filter((asset) => asset !== "fixed");
  const bootstrapRows = completeHistoricalRows(modelResult.historical, historicalAssets);
  const hasBootstrapHistory =
    historicalAssets.length > 0 &&
    historicalAssets.every(
      (asset) => (modelResult.historical?.assetMetadata?.[asset]?.returnObservations || 0) >= MIN_PAIRED_MONTHS,
    ) &&
    bootstrapRows.length >= MIN_PAIRED_MONTHS;
  const method = requestedMethod === "block-bootstrap" && !hasBootstrapHistory ? "gaussian" : requestedMethod;
  const methodFallbackReason =
    requestedMethod === "block-bootstrap" && !hasBootstrapHistory ? "insufficient-joint-monthly-history" : null;
  const selectedModel = method === "ewma" ? modelResult.ewmaModel || modelResult.model : modelResult.model;
  const covariance =
    method === "ewma" && modelResult.historical
      ? covarianceMatrix(modelResult.historical.rows, ASSET_KEYS, selectedModel)
      : modelResult.covariance;
  const seed = Number.isFinite(Number(options.seed)) ? Number(options.seed) : 42;
  const random = typeof options.random === "function" ? options.random : createSeededRandom(seed);
  const inflationRate = scenarioInflationRate(options.inflationRate);
  const transactionCosts = options.transactionCosts || DEFAULT_TRANSACTION_COSTS;
  const explicitBenchmark =
    options.compareFixedIncomeBenchmark === true && Number.isFinite(modelResult.referenceAnnualReturn)
      ? modelResult.referenceAnnualReturn
      : null;
  const marAnnualReturn =
    options.marType === "inflation"
      ? inflationRate
      : options.marType === "fixed-income"
        ? Number.isFinite(modelResult.referenceAnnualReturn)
          ? modelResult.referenceAnnualReturn
          : null
        : 0;
  const monthlyMar = marAnnualReturn === null ? null : annualToMonthlyRate(marAnnualReturn);
  const finals = [];
  const realFinals = [];
  const drawdowns = [];
  const realDrawdowns = [];
  const purchasingPowerDrawdowns = [];
  const volatilities = [];
  const downsideDeviations = [];
  const sortinos = [];
  const sharpes = [];
  const nominalCagrs = [];
  const realCagrs = [];
  const purchasingPowerChanges = [];
  const monthlyPortfolioReturns = [];
  const pathTransactionCosts = [];
  const pathRebalancingTurnover = [];
  const goalTarget = Number(options.goalTarget);
  const targetNominal =
    Number.isFinite(goalTarget) && goalTarget > 0 ? goalTarget * Math.pow(1 + inflationRate, horizonYears) : null;
  let successfulGoals = 0;
  let nominalLosses = 0;
  let purchasingPowerLosses = 0;
  let inflationBeaters = 0;
  let fixedIncomeBeaters = 0;
  const futureContributions = contributionAmounts(options, months);
  const hasContributions = sum(futureContributions) > EPSILON;
  const inflationHurdle = inflationProtectedValue(futureContributions, inflationRate, months);
  const fixedIncomeHurdle =
    explicitBenchmark === null ? null : inflationProtectedValue(futureContributions, explicitBenchmark, months);
  let totalCorrelationShrinkage = 0;
  let correlationDraws = 0;
  const sortinoStatuses = [];

  for (let path = 0; path < paths; path += 1) {
    const holdings = Object.fromEntries(ASSET_KEYS.map((asset) => [asset, 0]));
    const monthlyReturns = [];
    const bootstrapCursor = { index: 0, remaining: 0 };
    const contributions = futureContributions;
    let totalInvested = sum(contributions.slice(0, 1));
    let transactionCostsPaid = addContribution(holdings, totalInvested, allocation, transactionCosts);
    let rebalancingTurnover = 0;
    const rawCurrentFixedRate = options.currentFixedAnnualReturn ?? modelResult.referenceAnnualReturn;
    const currentFixedAnnualReturn =
      rawCurrentFixedRate !== null && rawCurrentFixedRate !== undefined && rawCurrentFixedRate !== ""
        ? Number(rawCurrentFixedRate)
        : null;
    const fixedRateState = {
      annualRate: Number.isFinite(currentFixedAnnualReturn)
        ? currentFixedAnnualReturn
        : Number(selectedModel.fixed?.annualReturn ?? DEFAULT_ASSUMPTIONS.fixed.annualReturn),
    };
    const values = [portfolioTotal(holdings)];
    for (let month = 0; month < months; month += 1) {
      const contribution = contributions[month + 1];
      totalInvested += contribution;
      const previousValue = portfolioTotal(holdings);
      const generated =
        method === "block-bootstrap"
          ? {
              returns: bootstrapDraws(bootstrapRows, selectedModel, random, bootstrapCursor),
              correlationOffDiagonalRetention: null,
            }
          : correlatedDraws(selectedModel, covariance, random, historicalAssets);
      const returns = generated.returns || {};
      if (Number.isFinite(generated.correlationOffDiagonalRetention)) {
        totalCorrelationShrinkage += generated.correlationOffDiagonalRetention;
        correlationDraws += 1;
      }
      returns.fixed = fixedIncomeMonthlyReturn(
        {
          ...options,
          currentFixedAnnualReturn: Number.isFinite(currentFixedAnnualReturn) ? currentFixedAnnualReturn : undefined,
        },
        selectedModel,
        fixedRateState,
        random,
      );
      applyReturns(holdings, returns);
      let netContribution = 0;
      if (contribution > 0) {
        const contributionFees = addContribution(holdings, contribution, allocation, transactionCosts);
        transactionCostsPaid += contributionFees;
        netContribution = contribution - contributionFees;
      }
      if (shouldRebalance(holdings, allocation, options, month)) {
        const trade = rebalance(holdings, allocation, transactionCosts);
        transactionCostsPaid += trade.fees;
        rebalancingTurnover += trade.turnover;
      }
      const portfolioValue = portfolioTotal(holdings);
      if (!Number.isFinite(portfolioValue) || portfolioValue < -EPSILON)
        throw new RangeError("invalid-portfolio-balance");
      if (previousValue > EPSILON) {
        const portfolioReturn = (portfolioValue - netContribution) / previousValue - 1;
        monthlyReturns.push(portfolioReturn);
        monthlyPortfolioReturns.push(portfolioReturn);
      } else monthlyReturns.push(null);
      values.push(portfolioValue);
    }
    const finalValue = values.at(-1);
    const finalRealValue = realValue(finalValue, inflationRate, horizonYears);
    finals.push(finalValue);
    const finalNominalIrr = includeMetrics
      ? irr(contributions.map((amount, index) => (index === contributions.length - 1 ? finalValue - amount : -amount)))
      : null;
    const nominalCagr = finalNominalIrr === null ? null : Math.pow(1 + finalNominalIrr, 12) - 1;
    const realCagr = realMoneyWeightedCagr(contributions, finalValue, inflationRate);
    if (includeMetrics && nominalCagr !== null) nominalCagrs.push(nominalCagr);
    if (includeMetrics && realCagr !== null) realCagrs.push(realCagr);
    if (targetNominal !== null && finalValue >= targetNominal) successfulGoals += 1;
    if (finalValue < totalInvested) nominalLosses += 1;
    if (finalValue < inflationHurdle) purchasingPowerLosses += 1;
    if (finalValue > inflationHurdle) inflationBeaters += 1;
    if (inflationHurdle > EPSILON) purchasingPowerChanges.push(finalValue / inflationHurdle - 1);
    if (fixedIncomeHurdle !== null && finalValue > fixedIncomeHurdle) fixedIncomeBeaters += 1;
    realFinals.push(finalRealValue);
    if (includeMetrics) {
      drawdowns.push(maxDrawdown(unitizedValuePath(monthlyReturns)));
      realDrawdowns.push(maxDrawdown(realUnitizedValuePath(monthlyReturns, inflationRate)));
      purchasingPowerDrawdowns.push(currentPurchasingPowerDrawdown(values, contributions, inflationRate));
      const volatility = annualizedVolatility(monthlyReturns);
      volatilities.push(volatility);
      downsideDeviations.push(monthlyMar === null ? null : downsideDeviation(monthlyReturns, monthlyMar));
      sortinos.push(monthlyMar === null ? null : sortinoRatio(monthlyReturns, monthlyMar));
      sortinoStatuses.push(
        monthlyMar === null ? "benchmark-unavailable" : percentileStatus(monthlyReturns, monthlyMar),
      );
      if (explicitBenchmark !== null) {
        const ratio = sharpeRatio(monthlyReturns, annualToMonthlyRate(explicitBenchmark));
        if (ratio !== null) sharpes.push(ratio);
      }
    }
    pathTransactionCosts.push(transactionCostsPaid);
    pathRebalancingTurnover.push(rebalancingTurnover);
  }

  const selectedData = simulationDataQuality(modelResult.historical, selectedModel, activeAssets);
  const rawCurrentFixedReference = options.currentFixedAnnualReturn ?? modelResult.referenceAnnualReturn;
  const currentFixedReference =
    rawCurrentFixedReference !== null && rawCurrentFixedReference !== undefined && rawCurrentFixedReference !== ""
      ? Number(rawCurrentFixedReference)
      : null;
  const tailRisk = includeMetrics
    ? calculateTailRisk(monthlyPortfolioReturns)
    : { available: false, reason: "not-requested", observations: 0, frequency: "monthly" };
  return {
    paths,
    horizonYears,
    method,
    modelVersion:
      method === "block-bootstrap"
        ? BOOTSTRAP_MODEL_VERSION
        : method === "ewma"
          ? "mc-ewma-v1"
          : MONTE_CARLO_MODEL_VERSION,
    methodFallbackReason,
    seed: typeof options.random === "function" ? null : seed,
    inflationRate,
    inflationFactor: Math.pow(1 + inflationRate, horizonYears),
    fixedIncomeAssumption: {
      mode: options.fixedIncomeMode || "mean-reverting",
      modeFallbackReason:
        (options.fixedIncomeMode || "mean-reverting") === "constant-market" && !Number.isFinite(currentFixedReference)
          ? "current-market-rate-unavailable"
          : null,
      configuredEffectiveAnnualReturn: Number.isFinite(Number(selectedModel.fixed?.annualReturn))
        ? Number(selectedModel.fixed.annualReturn)
        : null,
      currentMarketEffectiveAnnualReturn: Number.isFinite(currentFixedReference) ? currentFixedReference : null,
      yieldVolatility: Number.isFinite(Number(options.fixedIncomeYieldVolatility))
        ? Number(options.fixedIncomeYieldVolatility)
        : Number(selectedModel.fixed?.annualVolatility) || 0,
    },
    nominal: { p10: percentile(finals, 0.1), p50: percentile(finals, 0.5), p90: percentile(finals, 0.9) },
    real: { p10: percentile(realFinals, 0.1), p50: percentile(realFinals, 0.5), p90: percentile(realFinals, 0.9) },
    purchasingPowerChange: {
      p10: percentile(purchasingPowerChanges, 0.1),
      p50: percentile(purchasingPowerChanges, 0.5),
      p90: percentile(purchasingPowerChanges, 0.9),
      status:
        percentile(purchasingPowerChanges, 0.5) === null
          ? "unavailable"
          : Math.abs(percentile(purchasingPowerChanges, 0.5)) <= NEAR_PURCHASING_POWER_CHANGE
            ? "near-preservation"
            : percentile(purchasingPowerChanges, 0.5) > 0
              ? "above-inflation"
              : "below-inflation",
    },
    maxDrawdown: { p10: percentile(drawdowns, 0.1), p50: percentile(drawdowns, 0.5), p90: percentile(drawdowns, 0.9) },
    realMaxDrawdown: {
      p10: percentile(realDrawdowns, 0.1),
      p50: percentile(realDrawdowns, 0.5),
      p90: percentile(realDrawdowns, 0.9),
    },
    purchasingPowerDrawdown: {
      p10: percentile(purchasingPowerDrawdowns, 0.1),
      p50: percentile(purchasingPowerDrawdowns, 0.5),
      p90: percentile(purchasingPowerDrawdowns, 0.9),
    },
    volatility: percentile(volatilities, 0.5),
    sortino: percentile(sortinos, 0.5),
    minimumAcceptableReturn: { annual: marAnnualReturn, monthly: monthlyMar, type: options.marType || "zero" },
    downsideDeviation: percentile(downsideDeviations, 0.5),
    sharpe: percentile(sharpes, 0.5),
    cagr: percentile(nominalCagrs, 0.5),
    realCagr: percentile(realCagrs, 0.5),
    nominalLossProbability: hasContributions ? nominalLosses / paths : null,
    purchasingPowerLossProbability: inflationHurdle > EPSILON ? purchasingPowerLosses / paths : null,
    probabilityBeatingInflation: inflationHurdle > EPSILON ? inflationBeaters / paths : null,
    probabilityBeatingFixedIncome:
      fixedIncomeHurdle === null || fixedIncomeHurdle <= EPSILON ? null : fixedIncomeBeaters / paths,
    fixedIncomeBenchmark: explicitBenchmark,
    tailRisk,
    transactionCosts: {
      p50: percentile(pathTransactionCosts, 0.5),
      p90: percentile(pathTransactionCosts, 0.9),
      rebalancingTurnoverP50: percentile(pathRebalancingTurnover, 0.5),
      assumptions: transactionCostCoverage(transactionCosts, activeAssets),
    },
    correlationOffDiagonalRetention: correlationDraws ? totalCorrelationShrinkage / correlationDraws : null,
    sortinoStatus: !includeMetrics
      ? "not-requested"
      : sortinoStatuses.filter((status) => status === "available").length >= paths / 2
        ? "available"
        : sortinoStatuses.find((status) => status !== "available") || "insufficient-observations",
    goalProbability: targetNominal === null ? null : successfulGoals / paths,
    goalTargetNominal: targetNominal,
    historicalObservations: selectedData.jointObservations,
    estimated: selectedData.quality !== "high",
    dataQuality: selectedData,
    model: selectedModel,
  };
}

export function evaluateGoal(options = {}) {
  const targetToday = Math.max(0, Number(options.targetToday) || 0);
  const horizonYears = clamp(options.horizonYears || 0, 0.25, 50);
  const desiredProbability = clamp(options.desiredProbability ?? 0.75, 0.5, 0.99);
  if (targetToday <= 0 || !horizonYears) return { available: false, reason: "invalid-goal" };

  const seed = Number(options.seed) || 42;
  const paths = Math.round(clamp(options.paths || 1000, 1000, 5000));
  const common = { ...options, paths, horizonYears, goalTarget: targetToday };
  const runAtContribution = (monthlyContribution) =>
    runMonteCarlo({
      ...common,
      monthlyContribution,
      includeMetrics: false,
      random: createSeededRandom(seed),
    });
  const current = runAtContribution(Math.max(0, Number(options.monthlyContribution) || 0));
  let low = 0;
  let high = Math.max(Number(options.monthlyContribution) || 0, targetToday / (horizonYears * 12), 1);
  let upper = runAtContribution(high);
  let attempts = 0;
  while ((upper.goalProbability || 0) < desiredProbability && attempts < 12) {
    high *= 2;
    upper = runAtContribution(high);
    attempts += 1;
  }
  const feasible = (upper.goalProbability || 0) >= desiredProbability;
  if (feasible) {
    for (let iteration = 0; iteration < 18; iteration += 1) {
      const midpoint = (low + high) / 2;
      const candidate = runAtContribution(midpoint);
      if ((candidate.goalProbability || 0) >= desiredProbability) high = midpoint;
      else low = midpoint;
    }
  }
  return {
    available: true,
    targetToday,
    targetNominal: current.goalTargetNominal,
    horizonYears,
    desiredProbability,
    successProbability: current.goalProbability,
    outcomes: current.nominal,
    requiredMonthlyContribution: feasible ? high : null,
    feasible,
    modelVersion: current.modelVersion,
    modelAssumptionVersion: current.model?.fixed?.assumptionVersion || MODEL_ASSUMPTION_VERSION,
    estimated: current.estimated,
    historicalObservations: current.historicalObservations,
  };
}

export function portfolioFromHistory(history, currentMarket, now = Date.now()) {
  const categories = Object.fromEntries(
    PLAN_ASSET_KEYS.map((asset) => [asset, { invested: 0, value: 0, priced: 0, entries: 0 }]),
  );
  const current = currentMarket && currentMarket.assets ? currentMarket.assets : {};
  let totalInvested = 0;
  (Array.isArray(history) ? history : []).forEach((entry) => {
    const total = Math.max(0, Number(entry.total) || 0);
    totalInvested += total;
    PLAN_ASSET_KEYS.forEach((asset) => {
      const invested = (total * (Number(entry.weights && entry.weights[asset]) || 0)) / 100;
      categories[asset].invested += invested;
      categories[asset].entries += invested > 0 ? 1 : 0;
      if (asset === "fixed") {
        const annual = Number(
          currentMarket?.funds?.fixedIncome?.effectiveAnnualReturn ??
            entry.marketSnapshot?.funds?.fixedIncome?.effectiveAnnualReturn,
        );
        const days = Math.max(0, (now - new Date(entry.createdAt).getTime()) / (24 * 60 * 60 * 1000));
        categories[asset].value += Number.isFinite(annual)
          ? invested * Math.pow(1 + Math.max(-0.9, annual / 100), days / 365)
          : invested;
        categories[asset].priced += Number.isFinite(annual) ? 1 : 0;
        return;
      }
      const marketKey = asset === "currency" ? "dollar" : asset;
      const entryPrice = Number(entry.marketSnapshot?.assets?.[marketKey]?.price);
      const currentPrice = Number(current?.[marketKey]?.price);
      if (entryPrice > 0 && currentPrice > 0) {
        categories[asset].value += (invested * currentPrice) / entryPrice;
        categories[asset].priced += 1;
      } else categories[asset].value += invested;
    });
  });
  const currentValue = sum(Object.values(categories).map((category) => category.value));
  return { totalInvested, currentValue, gain: currentValue - totalInvested, categories };
}
