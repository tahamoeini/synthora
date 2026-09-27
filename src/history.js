// @ts-check

import { clamp, normalizeAllocation } from "./engine.js";
import { OPTIONAL_RECOMMENDATION_ASSETS, PLAN_ASSET_KEYS } from "./market/catalog.js";
import { PORTFOLIO_SCHEMA, PORTFOLIO_VERSION, normalizePortfolio, validateImportedPortfolio } from "./portfolio.js";

export const HISTORY_SCHEMA = "invest-consult-history";
export const HISTORY_VERSION = 3;

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
  const total = finite(entry.total);
  const contributionRate = finite(entry.contributionRate ?? entry.rate);
  const rawWeights = entry.weights && typeof entry.weights === "object" ? entry.weights : null;
  if (!createdAt || total === null || total <= 0 || contributionRate === null || !rawWeights) return null;
  const rawWeightTotal = PLAN_ASSET_KEYS.reduce((sum, key) => sum + Math.max(0, finite(rawWeights[key]) || 0), 0);
  if (rawWeightTotal <= 0) return null;

  const result = {
    createdAt,
    total,
    contributionRate: clamp(contributionRate, 0, 100),
    weights: normalizeAllocation(rawWeights, undefined, PLAN_ASSET_KEYS),
  };
  const selectedAssets = sanitizeSelectedAssets(entry.selectedAssets);
  if (selectedAssets.length) result.selectedAssets = selectedAssets;
  const salary = finite(entry.salary);
  if (salary !== null && salary >= 0) result.salary = salary;
  const contributionPlan = sanitizeAmounts(entry.contributionPlan);
  if (contributionPlan) result.contributionPlan = contributionPlan;
  const profile = sanitizeProfile(entry.profile);
  if (profile) result.profile = profile;
  const marketSnapshot = sanitizeSnapshot(entry.marketSnapshot, createdAt);
  if (marketSnapshot) result.marketSnapshot = marketSnapshot;
  return result;
}

export function normalizeHistoryEntries(entries, limit = 60) {
  const seen = new Set();
  const result = [];
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const normalized = sanitizeHistoryEntry(entry);
    if (!normalized || seen.has(normalized.createdAt)) return;
    seen.add(normalized.createdAt);
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
