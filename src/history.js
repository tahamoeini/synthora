// @ts-check

import { clamp, normalizeAllocation } from "./engine.js";
import { OPTIONAL_RECOMMENDATION_ASSETS, PLAN_ASSET_KEYS, SIMULATION_ASSET_KEYS } from "./market/catalog.js";
import { PORTFOLIO_SCHEMA, PORTFOLIO_VERSION, normalizePortfolio, validateImportedPortfolio } from "./portfolio.js";

export const HISTORY_SCHEMA = "invest-consult-history";
export const HISTORY_VERSION = 4;
export const PLAN_RECORD_VERSION = 1;
export const PERSONAL_BACKUP_SCHEMA = "synthora-personal-backup";
export const PERSONAL_BACKUP_VERSION = 1;

const PERSONAL_PROFILE_FIELDS = new Set([
  "age",
  "horizonYears",
  "goal",
  "riskTolerance",
  "incomeStability",
  "emergencyFund",
  "emergencyCoverageMonths",
  "essentialMonthlyExpenses",
  "salary",
  "contributionRate",
]);
const MODEL_SETTING_FIELDS = new Set([
  "version",
  "inflationRate",
  "contributionGrowth",
  "paths",
  "rebalance",
  "targetDriftThresholdPercent",
  "assumptions",
  "transactionCosts",
  "inflationSource",
  "inflationPeriod",
  "inflationFetchedAt",
]);

const MARKET_ASSETS = [
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
];

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function validDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sanitizeSnapshot(snapshot, fallbackDate) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const result = { capturedAt: validDate(snapshot.capturedAt) || fallbackDate, assets: {}, funds: {} };
  MARKET_ASSETS.forEach((key) => {
    const source = snapshot.assets && snapshot.assets[key];
    const price = finite(source && source.price);
    if (price !== null && price > 0) {
      const item = {
        price,
        changePct: finite(source.changePct),
        unit: typeof source.unit === "string" ? source.unit.slice(0, 20) : undefined,
      };
      const sourceCount = finite(source.sourceCount);
      const configuredSourceCount = finite(source.configuredSourceCount);
      const spreadPct = finite(source.spreadPct);
      if (sourceCount !== null && sourceCount >= 0) item.sourceCount = sourceCount;
      if (configuredSourceCount !== null && configuredSourceCount >= 0)
        item.configuredSourceCount = configuredSourceCount;
      if (spreadPct !== null && spreadPct >= 0) item.spreadPct = spreadPct;
      if (typeof source.sleeveId === "string" && source.sleeveId.length <= 60) item.sleeveId = source.sleeveId;
      if (Array.isArray(source.sources))
        item.sources = source.sources
          .filter((value) => typeof value === "string")
          .slice(0, 8)
          .map((value) => value.slice(0, 100));
      if (Array.isArray(source.derivedFrom))
        item.derivedFrom = source.derivedFrom
          .filter((value) => typeof value === "string")
          .slice(0, 5)
          .map((value) => value.slice(0, 100));
      if (Array.isArray(source.dependencies))
        item.dependencies = source.dependencies
          .slice(0, 5)
          .map((dependency) => {
            if (!dependency || typeof dependency !== "object") return null;
            const dependencyPrice = finite(dependency.price);
            const dependencySourceCount = finite(dependency.sourceCount);
            return {
              instrumentId: typeof dependency.instrumentId === "string" ? dependency.instrumentId.slice(0, 60) : "",
              price: dependencyPrice !== null && dependencyPrice > 0 ? dependencyPrice : null,
              sourceCount: dependencySourceCount !== null && dependencySourceCount >= 0 ? dependencySourceCount : 0,
              unit: typeof dependency.unit === "string" ? dependency.unit.slice(0, 20) : "",
              source: typeof dependency.source === "string" ? dependency.source.slice(0, 100) : "",
              status: ["healthy", "degraded", "provisional", "conflicted", "unavailable"].includes(dependency.status)
                ? dependency.status
                : "unavailable",
              confidence: ["high", "medium", "low", "none"].includes(dependency.confidence)
                ? dependency.confidence
                : "none",
              observedAt: validDate(dependency.observedAt),
              retrievedAt: validDate(dependency.retrievedAt),
            };
          })
          .filter(Boolean);
      if (Array.isArray(source.sourceValues))
        item.sourceValues = source.sourceValues
          .slice(0, 8)
          .map((value) => {
            if (!value || typeof value !== "object") return null;
            const sourcePrice = finite(value.price);
            if (sourcePrice === null || sourcePrice <= 0) return null;
            return {
              source: typeof value.source === "string" ? value.source.slice(0, 100) : "",
              price: sourcePrice,
              quoteType: ["direct", "derived"].includes(value.quoteType) ? value.quoteType : "direct",
              observedAt: validDate(value.observedAt),
              accepted: value.accepted === true,
              exclusionReason: typeof value.exclusionReason === "string" ? value.exclusionReason.slice(0, 60) : null,
            };
          })
          .filter(Boolean);
      if (["direct", "derived", "mixed"].includes(source.quoteType)) item.quoteType = source.quoteType;
      if (["healthy", "degraded", "provisional", "conflicted", "unavailable"].includes(source.status))
        item.status = source.status;
      if (["high", "medium", "low", "none"].includes(source.confidence)) item.confidence = source.confidence;
      if (typeof source.consensusPolicyVersion === "string")
        item.consensusPolicyVersion = source.consensusPolicyVersion.slice(0, 60);
      if (typeof source.consensusCalibrated === "boolean") item.consensusCalibrated = source.consensusCalibrated;
      if (typeof source.consensusDisagreement === "boolean") item.consensusDisagreement = source.consensusDisagreement;
      if (typeof source.consensusMethod === "string") item.consensusMethod = source.consensusMethod.slice(0, 60);
      const acceptedSpreadPct = finite(source.acceptedSpreadPct);
      if (acceptedSpreadPct !== null && acceptedSpreadPct >= 0) item.acceptedSpreadPct = acceptedSpreadPct;
      const agreementTolerancePct = finite(source.agreementTolerancePct);
      if (agreementTolerancePct !== null && agreementTolerancePct >= 0)
        item.agreementTolerancePct = agreementTolerancePct;
      const observedAt = validDate(source.observedAt);
      const retrievedAt = validDate(source.retrievedAt);
      if (observedAt) item.observedAt = observedAt;
      if (retrievedAt) item.retrievedAt = retrievedAt;
      result.assets[key] = item;
    }
  });
  const fixedReturn = finite(
    snapshot.funds && snapshot.funds.fixedIncome && snapshot.funds.fixedIncome.effectiveAnnualReturn,
  );
  if (fixedReturn !== null) {
    const fixedSource = snapshot.funds.fixedIncome;
    const fixed = { effectiveAnnualReturn: fixedReturn };
    const sourceCount = finite(fixedSource.sourceCount);
    if (sourceCount !== null && sourceCount >= 0) fixed.sourceCount = sourceCount;
    if (Array.isArray(fixedSource.sources))
      fixed.sources = fixedSource.sources
        .filter((value) => typeof value === "string")
        .slice(0, 8)
        .map((value) => value.slice(0, 100));
    const observedAt = validDate(fixedSource.observedAt || fixedSource.asOf);
    const retrievedAt = validDate(fixedSource.retrievedAt);
    if (observedAt) fixed.observedAt = observedAt;
    if (retrievedAt) fixed.retrievedAt = retrievedAt;
    result.funds.fixedIncome = fixed;
  }
  return Object.keys(result.assets).length || Object.keys(result.funds).length ? result : null;
}

function sanitizeProfile(profile) {
  if (!profile || typeof profile !== "object") return undefined;
  const result = {};
  const age = finite(profile.age);
  const horizonYears = finite(profile.horizonYears);
  if (age !== null) result.age = clamp(age, 18, 90);
  if (horizonYears !== null) result.horizonYears = clamp(horizonYears, 1, 50);
  ["goal", "riskTolerance", "incomeStability", "emergencyFund"].forEach((key) => {
    if (typeof profile[key] === "string" && profile[key].length <= 40) result[key] = profile[key];
  });
  return Object.keys(result).length ? result : undefined;
}

function sanitizeAmounts(amounts) {
  if (!amounts || typeof amounts !== "object") return undefined;
  const result = {};
  PLAN_ASSET_KEYS.forEach((key) => {
    const amount = finite(amounts[key]);
    if (amount !== null && amount >= 0) result[key] = amount;
  });
  return Object.keys(result).length ? result : undefined;
}

function sanitizePercentMap(values, { normalize = false } = {}) {
  if (!values || typeof values !== "object") return undefined;
  const result = {};
  PLAN_ASSET_KEYS.forEach((key) => {
    const value = finite(values[key]);
    if (value !== null && value >= 0) result[key] = Math.min(100, value);
  });
  const total = PLAN_ASSET_KEYS.reduce((sum, key) => sum + (result[key] || 0), 0);
  if (!total) return Object.keys(result).length ? result : undefined;
  if (normalize) return normalizeAllocation(result, undefined, PLAN_ASSET_KEYS);
  return result;
}

function weightsForAmounts(amounts) {
  if (!amounts) return undefined;
  const total = PLAN_ASSET_KEYS.reduce((sum, key) => sum + (Number(amounts[key]) || 0), 0);
  if (!(total > 0)) return Object.fromEntries(PLAN_ASSET_KEYS.map((key) => [key, 0]));
  return Object.fromEntries(PLAN_ASSET_KEYS.map((key) => [key, ((Number(amounts[key]) || 0) / total) * 100]));
}

function sanitizeSelectedAssets(assets) {
  if (!Array.isArray(assets)) return [];
  return [...new Set(assets.filter((assetId) => OPTIONAL_RECOMMENDATION_ASSETS.includes(assetId)))];
}

/**
 * Keep only the fields required to reconstruct the local portfolio history.
 * Legacy records using `rate` are accepted and converted to `contributionRate`.
 */
export function sanitizeHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const createdAt = validDate(entry.createdAt);
  const total = finite(entry.plannedMonthlyAmount ?? entry.total);
  const contributionRate = finite(entry.contributionRate ?? entry.rate);
  const rawWeights = entry.targetWeights || (entry.weights && typeof entry.weights === "object" ? entry.weights : null);
  if (!createdAt || total === null || total <= 0 || contributionRate === null || !rawWeights) return null;
  const rawWeightTotal = PLAN_ASSET_KEYS.reduce((sum, key) => sum + Math.max(0, finite(rawWeights[key]) || 0), 0);
  if (rawWeightTotal <= 0) return null;

  const result = {
    id: typeof entry.id === "string" && entry.id.length <= 120 ? entry.id : `plan-${createdAt}`,
    recordVersion: PLAN_RECORD_VERSION,
    planVersion:
      Number.isInteger(Number(entry.planVersion)) && Number(entry.planVersion) > 0 ? Number(entry.planVersion) : 1,
    createdAt,
    plannedMonthlyAmount: total,
    // Keep `total` and `weights` for older local consumers and exports.
    total,
    contributionRate: clamp(contributionRate, 0, 100),
    weights: normalizeAllocation(rawWeights, undefined, PLAN_ASSET_KEYS),
    executionStatus: "not-linked",
  };
  result.targetWeights = result.weights;
  const selectedAssets = sanitizeSelectedAssets(entry.selectedAssets);
  if (selectedAssets.length) result.selectedAssets = selectedAssets;
  const salary = finite(entry.salary);
  if (salary !== null && salary >= 0) result.salary = salary;
  const contributionPlan = sanitizeAmounts(entry.contributionAmounts ?? entry.contributionPlan);
  if (contributionPlan) {
    result.contributionAmounts = contributionPlan;
    result.contributionPlan = contributionPlan;
    result.contributionWeights =
      sanitizePercentMap(entry.contributionWeights) || weightsForAmounts(contributionPlan);
  }
  const currentWeights = sanitizePercentMap(entry.currentWeights);
  if (currentWeights) result.currentWeights = currentWeights;
  const deviations = {};
  PLAN_ASSET_KEYS.forEach((key) => {
    const value = finite(entry.deviationPercentagePoints?.[key]);
    if (value !== null && value >= -100 && value <= 100) deviations[key] = value;
  });
  if (Object.keys(deviations).length) result.deviationPercentagePoints = deviations;
  const profile = sanitizeProfile(entry.profile);
  if (profile) result.profile = profile;
  const marketSnapshot = sanitizeSnapshot(entry.marketSnapshot, createdAt);
  if (marketSnapshot) result.marketSnapshot = marketSnapshot;
  return result;
}

export function createPlanHistoryRecord(plan, existingHistory = [], createdAt = new Date().toISOString()) {
  const version = Math.max(0, ...(Array.isArray(existingHistory) ? existingHistory : []).map((entry) => Number(entry?.planVersion) || 0)) + 1;
  const cryptoApi = globalThis.crypto;
  const id =
    typeof cryptoApi?.randomUUID === "function"
      ? `plan-${cryptoApi.randomUUID()}`
      : `plan-${new Date(createdAt).getTime()}-${version}`;
  const { inputs, recommendation, contribution } = plan || {};
  if (!inputs || !recommendation || !contribution) return null;
  return sanitizeHistoryEntry({
    id,
    recordVersion: PLAN_RECORD_VERSION,
    planVersion: version,
    createdAt,
    plannedMonthlyAmount: inputs.monthlyContribution,
    contributionRate: inputs.contributionRate,
    targetWeights: recommendation.weights,
    contributionAmounts: contribution.contributionAmounts || contribution.amounts,
    contributionWeights: contribution.contributionWeights || contribution.weights,
    currentWeights: contribution.currentWeights,
    deviationPercentagePoints: contribution.deviationPercentagePoints || contribution.drift,
    executionStatus: "not-linked",
    profile: inputs.profile,
    selectedAssets: inputs.selectedAssets,
    salary: inputs.salary,
    marketSnapshot: plan.marketSnapshot,
  });
}

export function normalizeHistoryEntries(entries, limit = 60) {
  const seen = new Set();
  const result = [];
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const normalized = sanitizeHistoryEntry(entry);
    if (!normalized || seen.has(normalized.id)) return;
    seen.add(normalized.id);
    result.push(normalized);
  });
  return Number.isFinite(limit) ? result.slice(0, Math.max(0, limit)) : result;
}

export function mergeHistory(existing, incoming, limit = 60) {
  return normalizeHistoryEntries(
    [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])],
    limit,
  );
}

export function createHistoryExport(history, portfolio = null) {
  const records = normalizeHistoryEntries(history, Infinity);
  const result = {
    schema: HISTORY_SCHEMA,
    version: HISTORY_VERSION,
    currencyUnit: "TOMAN",
    exportedAt: new Date().toISOString(),
    recordCount: records.length,
    history: records,
  };
  if (portfolio) result.portfolio = normalizePortfolio(portfolio);
  return result;
}

export function parseHistoryExport(value) {
  let data = value;
  if (Array.isArray(data)) data = { schema: HISTORY_SCHEMA, version: HISTORY_VERSION, history: data };
  if (
    !data ||
    typeof data !== "object" ||
    data.schema !== HISTORY_SCHEMA ||
    Number(data.version) > HISTORY_VERSION ||
    !Array.isArray(data.history)
  ) {
    throw new Error("invalid-export-format");
  }
  const records = normalizeHistoryEntries(data.history, Infinity);
  let portfolio = null;
  if (data.portfolio !== undefined) {
    if (
      !data.portfolio ||
      data.portfolio.schema !== PORTFOLIO_SCHEMA ||
      Number(data.portfolio.version) > PORTFOLIO_VERSION ||
      !Array.isArray(data.portfolio.versions)
    )
      throw new Error("invalid-portfolio-format");
    const validated = validateImportedPortfolio(data.portfolio);
    if (!validated.valid) throw new Error("invalid-portfolio-ledger");
    portfolio = validated.portfolio;
  }
  return {
    records,
    skipped: data.history.length - records.length,
    version: Number(data.version) || HISTORY_VERSION,
    currencyUnit: data.currencyUnit === "TOMAN" ? "TOMAN" : "RIAL_LEGACY",
    portfolio,
  };
}

function sanitizePersonalProfile(profile, { strict = true } = {}) {
  if (profile === null) return null;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("invalid-profile-format");
  if (strict && Object.keys(profile).some((key) => !PERSONAL_PROFILE_FIELDS.has(key)))
    throw new Error("invalid-profile-format");
  const result = {};
  Object.entries(profile).forEach(([key, value]) => {
    if (!PERSONAL_PROFILE_FIELDS.has(key)) return;
    if (typeof value === "string") {
      if (value.length > 120) throw new Error("invalid-profile-format");
      result[key] = value;
      return;
    }
    if (value !== null && !Number.isFinite(Number(value))) throw new Error("invalid-profile-format");
    result[key] = value === null ? null : Number(value);
  });
  return result;
}

function validateModelSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("invalid-settings-format");
  if (Object.keys(settings).some((key) => !MODEL_SETTING_FIELDS.has(key))) throw new Error("invalid-settings-format");
  const rate = finite(settings.inflationRate);
  const growth = finite(settings.contributionGrowth);
  const drift = finite(settings.targetDriftThresholdPercent);
  if (
    Number(settings.version) !== 3 ||
    rate === null || rate < -0.2 || rate > 3 ||
    growth === null || growth < -0.5 || growth > 2 ||
    ![1000, 2000, 5000, 10000].includes(Number(settings.paths)) ||
    typeof settings.rebalance !== "boolean" ||
    drift === null || drift < 0 || drift > 25 ||
    !settings.assumptions || typeof settings.assumptions !== "object" || Array.isArray(settings.assumptions) ||
    !settings.transactionCosts || typeof settings.transactionCosts !== "object" || Array.isArray(settings.transactionCosts)
  ) throw new Error("invalid-settings-format");
  SIMULATION_ASSET_KEYS.forEach((assetId) => {
    const assumption = settings.assumptions[assetId];
    const costs = settings.transactionCosts[assetId];
    const annualReturn = finite(assumption?.annualReturn);
    const annualVolatility = finite(assumption?.annualVolatility);
    if (
      !assumption || typeof assumption !== "object" || Array.isArray(assumption) ||
      Object.keys(assumption).some((key) => !["annualReturn", "annualVolatility"].includes(key)) ||
      annualReturn === null || annualReturn < -0.99 || annualReturn > 3 || annualVolatility === null || annualVolatility < 0 || annualVolatility > 3
    )
      throw new Error("invalid-settings-format");
    if (
      !costs || typeof costs !== "object" || Array.isArray(costs) ||
      Object.keys(costs).some((key) => !["buyFee", "sellFee", "spread"].includes(key))
    ) throw new Error("invalid-settings-format");
    ["buyFee", "sellFee", "spread"].forEach((key) => {
      const fee = costs[key];
      if (fee !== null && (finite(fee) === null || Number(fee) < 0 || Number(fee) > 0.99))
        throw new Error("invalid-settings-format");
    });
  });
  if (
    Object.keys(settings.assumptions).some((assetId) => !SIMULATION_ASSET_KEYS.includes(assetId)) ||
    Object.keys(settings.transactionCosts).some((assetId) => !SIMULATION_ASSET_KEYS.includes(assetId)) ||
    SIMULATION_ASSET_KEYS.some((assetId) => !Object.hasOwn(settings.assumptions, assetId) || !Object.hasOwn(settings.transactionCosts, assetId))
  ) throw new Error("invalid-settings-format");
  if (
    (settings.inflationSource !== null && typeof settings.inflationSource !== "string") ||
    (settings.inflationPeriod !== null && typeof settings.inflationPeriod !== "string") ||
    (settings.inflationFetchedAt !== null && (typeof settings.inflationFetchedAt !== "string" || !validDate(settings.inflationFetchedAt)))
  ) throw new Error("invalid-settings-format");
  return settings;
}

function validatePersonalPreferences(preferences) {
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences))
    throw new Error("invalid-preferences-format");
  if (
    Object.keys(preferences).some((key) => !["locale", "currency", "theme"].includes(key)) ||
    !["fa", "en", "ru", "zh"].includes(preferences.locale) ||
    ![null, "TOMAN", "USD", "RUB", "CNY"].includes(preferences.currency) ||
    !["system", "light", "dark"].includes(preferences.theme)
  ) throw new Error("invalid-preferences-format");
  return { locale: preferences.locale, currency: preferences.currency, theme: preferences.theme };
}

export function createPersonalBackup({ profile, history, portfolio, modelSettings, preferences }) {
  const records = normalizeHistoryEntries(history, Infinity);
  const validatedPortfolio = validateImportedPortfolio(portfolio);
  if (!validatedPortfolio.valid) throw new Error("invalid-portfolio-ledger");
  const safeSettings = validateModelSettings(modelSettings);
  const safePreferences = validatePersonalPreferences(preferences);
  return {
    schema: PERSONAL_BACKUP_SCHEMA,
    version: PERSONAL_BACKUP_VERSION,
    currencyUnit: "TOMAN",
    exportedAt: new Date().toISOString(),
    profile: sanitizePersonalProfile(profile, { strict: false }),
    history: records,
    portfolio: validatedPortfolio.portfolio,
    modelSettings: safeSettings,
    preferences: safePreferences,
  };
}

export function parsePersonalBackup(value) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    value.schema !== PERSONAL_BACKUP_SCHEMA || Number(value.version) !== PERSONAL_BACKUP_VERSION ||
    value.currencyUnit !== "TOMAN" || !Array.isArray(value.history)
  ) throw new Error("invalid-personal-backup-format");
  const history = normalizeHistoryEntries(value.history, Infinity);
  if (history.length !== value.history.length) throw new Error("invalid-history-format");
  const portfolio = validateImportedPortfolio(value.portfolio);
  if (!portfolio.valid) throw new Error("invalid-portfolio-ledger");
  const exportedAt = validDate(value.exportedAt);
  if (!exportedAt) throw new Error("invalid-personal-backup-format");
  return {
    profile: sanitizePersonalProfile(value.profile),
    history,
    portfolio: portfolio.portfolio,
    modelSettings: validateModelSettings(value.modelSettings),
    preferences: validatePersonalPreferences(value.preferences),
    exportedAt,
    version: Number(value.version),
  };
}
