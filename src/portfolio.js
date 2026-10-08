// @ts-check

import { realValue } from "./engine.js";
import { INSTRUMENT_REGISTRY, SLEEVE_REGISTRY } from "./market/catalog.js";

export const PORTFOLIO_SCHEMA = "invest-consult-portfolio";
export const PORTFOLIO_VERSION = 3;
export const REPORTING_CALENDAR = "gregory";
export const REPORTING_TIME_ZONE = "UTC";
export const TRANSACTION_TYPES = [
  "OPENING",
  "BUY",
  "SELL",
  "DIVIDEND",
  "TRANSFER",
  "ADJUSTMENT",
  "BASIS_CORRECTION",
  "DEPOSIT",
  "WITHDRAWAL",
];

export const PORTFOLIO_ASSETS = Object.freeze({
  gold: { ...INSTRUMENT_REGISTRY.gold, id: "gold", titleKey: "gold", priced: true, isInvestable: true, isLiquid: true },
  fixed: {
    id: "fixed",
    titleKey: "fixed",
    unit: "TOMAN",
    marketKey: null,
    sleeveId: "fixedIncome",
    priced: true,
    isInvestable: true,
    isLiquid: true,
  },
  currency: {
    ...INSTRUMENT_REGISTRY.dollar,
    id: "currency",
    titleKey: "currency",
    unit: "USD",
    marketKey: "dollar",
    priced: true,
    isInvestable: true,
    isLiquid: true,
  },
  silver: {
    ...INSTRUMENT_REGISTRY.silver,
    id: "silver",
    titleKey: "silver",
    priced: true,
    isInvestable: true,
    isLiquid: true,
  },
  bitcoin: {
    ...INSTRUMENT_REGISTRY.bitcoin,
    id: "bitcoin",
    titleKey: "bitcoin",
    priced: true,
    isInvestable: true,
    isLiquid: true,
  },
  ethereum: {
    ...INSTRUMENT_REGISTRY.ethereum,
    id: "ethereum",
    titleKey: "ethereum",
    priced: true,
    isInvestable: true,
    isLiquid: true,
  },
  tether: {
    ...INSTRUMENT_REGISTRY.tether,
    id: "tether",
    titleKey: "tether",
    priced: true,
    isInvestable: true,
    isLiquid: true,
  },
  platinum: {
    ...INSTRUMENT_REGISTRY.platinum,
    id: "platinum",
    titleKey: "platinum",
    priced: true,
    isInvestable: true,
    isLiquid: true,
  },
  palladium: {
    ...INSTRUMENT_REGISTRY.palladium,
    id: "palladium",
    titleKey: "palladium",
    priced: true,
    isInvestable: true,
    isLiquid: true,
  },
  copper: {
    ...INSTRUMENT_REGISTRY.copper,
    id: "copper",
    titleKey: "copper",
    priced: true,
    isInvestable: true,
    isLiquid: true,
  },
  cash: {
    id: "cash",
    titleKey: "cash",
    unit: "TOMAN",
    marketKey: null,
    sleeveId: "liquidity",
    priced: true,
    isInvestable: true,
    isLiquid: true,
  },
  other: {
    id: "other",
    titleKey: "other",
    unit: "TOMAN",
    marketKey: null,
    sleeveId: null,
    priced: true,
    isInvestable: false,
    isLiquid: false,
  },
});

export const SIMPLE_ASSET_IDS = ["gold", "fixed", "cash", "other"];

const LEGACY_STOCK_ASSET_ID = "custom:legacy-stocks";

const EPSILON = 1e-7;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function isoDate(value, fallback = new Date().toISOString()) {
  const date = new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function optionalIsoDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

let fallbackIdSequence = 0;

function makeId(prefix = "id") {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return `${prefix}-${cryptoApi.randomUUID()}`;
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  fallbackIdSequence += 1;
  return `${prefix}-${Date.now()}-${fallbackIdSequence}`;
}

function assetDefinition(assetId, assets = PORTFOLIO_ASSETS) {
  return assets && Object.hasOwn(assets, assetId) ? assets[assetId] : null;
}

function assetRegistry(portfolio) {
  return { ...PORTFOLIO_ASSETS, ...(portfolio && portfolio.assets ? portfolio.assets : {}) };
}

function emptyHoldings(assets = PORTFOLIO_ASSETS) {
  return Object.fromEntries(Object.keys(assets).map((assetId) => [assetId, 0]));
}

function snapshotQuote(market, assetId, date) {
  const definition = assetDefinition(assetId);
  if (!definition || !definition.marketKey) return null;
  const price = marketPriceAt(market, assetId, date);
  if (price === null || price <= 0) return null;
  const observed = market?.assets?.[definition.marketKey] || {};
  return {
    assetId,
    price,
    source: observed.sources?.join(", ") || observed.source || "market-snapshot",
    capturedAt: isoDate(date),
    observedAt: observed.observedAt || observed.asOf || null,
    retrievedAt: observed.retrievedAt || market.updatedAt || isoDate(date),
    quoteType: observed.quoteType || definition.quoteType || "direct",
    sleeveId: observed.sleeveId || definition.sleeveId || null,
    derivedFrom: Array.isArray(observed.derivedFrom) ? observed.derivedFrom.slice() : [],
    sourceValues: Array.isArray(observed.sourceValues) ? observed.sourceValues.slice(0, 8) : [],
    dependencies: Array.isArray(observed.dependencies) ? observed.dependencies.slice(0, 5) : [],
    status: observed.status || "healthy",
    confidence: observed.confidence || null,
    sourceCount: Math.max(0, finite(observed.sourceCount) || 0),
    configuredSourceCount: Math.max(0, finite(observed.configuredSourceCount) || 0),
    spreadPct: Math.max(0, finite(observed.spreadPct) || 0),
    consensusPolicyVersion: observed.consensusPolicyVersion || null,
    consensusCalibrated: observed.consensusCalibrated === true,
  };
}

function normalizeTransaction(raw, assets = PORTFOLIO_ASSETS) {
  if (!raw || typeof raw !== "object" || !TRANSACTION_TYPES.includes(raw.type)) return null;
  const assetId = assetDefinition(raw.assetId, assets) ? raw.assetId : null;
  const targetAssetId = assetDefinition(raw.targetAssetId, assets) ? raw.targetAssetId : null;
  const quantity = finite(raw.quantity);
  const unitPrice = finite(raw.unitPrice);
  const amount = finite(raw.amount);
  const costBasisStatus =
    raw.type === "BASIS_CORRECTION"
      ? "confirmed"
      : ["confirmed", "estimated", "unknown"].includes(raw.costBasisStatus)
        ? raw.costBasisStatus
        : "unknown";
  if (!assetId && raw.type !== "DEPOSIT" && raw.type !== "WITHDRAWAL") return null;
  if (["OPENING", "BUY", "SELL", "TRANSFER", "BASIS_CORRECTION"].includes(raw.type) && (quantity === null || quantity <= EPSILON))
    return null;
  if (raw.type === "ADJUSTMENT" && (quantity === null || Math.abs(quantity) <= EPSILON)) return null;
  if (
    (raw.type === "SELL" && (unitPrice === null || unitPrice <= 0)) ||
    (raw.type === "ADJUSTMENT" && (unitPrice === null || unitPrice <= 0) && costBasisStatus !== "unknown") ||
    (["OPENING", "BUY"].includes(raw.type) && unitPrice === null && costBasisStatus !== "unknown")
  )
    return null;
  if (raw.type === "BASIS_CORRECTION" && (amount === null || amount <= 0)) return null;
  if (["DEPOSIT", "WITHDRAWAL", "DIVIDEND"].includes(raw.type) && (amount === null || amount <= 0)) return null;
  if (
    raw.type === "TRANSFER" &&
    (!targetAssetId ||
      targetAssetId === assetId ||
      finite(raw.targetQuantity) === null ||
      Number(raw.targetQuantity) <= EPSILON)
  )
    return null;
  return {
    id: typeof raw.id === "string" && raw.id.length <= 120 ? raw.id : makeId("tx"),
    type: raw.type,
    assetId: assetId || "cash",
    targetAssetId,
    targetQuantity: raw.type === "TRANSFER" ? finite(raw.targetQuantity) : undefined,
    quantity: quantity === null ? undefined : quantity,
    unitPrice: unitPrice === null ? undefined : unitPrice,
    trackingValue: finite(raw.trackingValue),
    costBasisStatus,
    targetUnitPrice: raw.type === "TRANSFER" ? finite(raw.targetUnitPrice) : undefined,
    amount: amount === null ? undefined : amount,
    fee: Math.max(0, finite(raw.fee) || 0),
    date: isoDate(raw.date),
    createdAt: isoDate(raw.createdAt),
    note: typeof raw.note === "string" ? raw.note.slice(0, 300) : "",
    source: typeof raw.source === "string" ? raw.source.slice(0, 50) : "advanced",
    marketQuote:
      raw.marketQuote && typeof raw.marketQuote === "object"
        ? {
            assetId: raw.marketQuote.assetId,
            price: finite(raw.marketQuote.price),
            source: typeof raw.marketQuote.source === "string" ? raw.marketQuote.source : "market-snapshot",
            capturedAt: optionalIsoDate(raw.marketQuote.capturedAt),
            observedAt: optionalIsoDate(raw.marketQuote.observedAt),
            retrievedAt: optionalIsoDate(raw.marketQuote.retrievedAt),
            quoteType: ["direct", "derived", "mixed"].includes(raw.marketQuote.quoteType)
              ? raw.marketQuote.quoteType
              : "direct",
            sleeveId: typeof raw.marketQuote.sleeveId === "string" ? raw.marketQuote.sleeveId.slice(0, 60) : null,
            derivedFrom: Array.isArray(raw.marketQuote.derivedFrom)
              ? raw.marketQuote.derivedFrom.filter((value) => typeof value === "string").slice(0, 5)
              : [],
            sourceValues: Array.isArray(raw.marketQuote.sourceValues)
              ? raw.marketQuote.sourceValues
                  .slice(0, 8)
                  .map((value) => {
                    if (!value || typeof value !== "object") return null;
                    const quotePrice = finite(value.price);
                    if (quotePrice === null || quotePrice <= 0) return null;
                    return {
                      source: typeof value.source === "string" ? value.source.slice(0, 100) : "",
                      price: quotePrice,
                      quoteType: ["direct", "derived"].includes(value.quoteType) ? value.quoteType : "direct",
                      observedAt: optionalIsoDate(value.observedAt),
                    };
                  })
                  .filter(Boolean)
              : [],
            dependencies: Array.isArray(raw.marketQuote.dependencies)
              ? raw.marketQuote.dependencies
                  .slice(0, 5)
                  .map((dependency) => {
                    if (!dependency || typeof dependency !== "object") return null;
                    return {
                      instrumentId:
                        typeof dependency.instrumentId === "string" ? dependency.instrumentId.slice(0, 60) : "",
                      price: finite(dependency.price),
                      sourceCount: Math.max(0, finite(dependency.sourceCount) || 0),
                      unit: typeof dependency.unit === "string" ? dependency.unit.slice(0, 20) : "",
                      source: typeof dependency.source === "string" ? dependency.source.slice(0, 100) : "",
                      status: typeof dependency.status === "string" ? dependency.status.slice(0, 30) : "unavailable",
                      confidence:
                        typeof dependency.confidence === "string" ? dependency.confidence.slice(0, 20) : "none",
                      observedAt: optionalIsoDate(dependency.observedAt),
                      retrievedAt: optionalIsoDate(dependency.retrievedAt),
                    };
                  })
                  .filter(Boolean)
              : [],
            status: typeof raw.marketQuote.status === "string" ? raw.marketQuote.status.slice(0, 30) : "healthy",
            confidence: typeof raw.marketQuote.confidence === "string" ? raw.marketQuote.confidence.slice(0, 20) : null,
            sourceCount: Math.max(0, finite(raw.marketQuote.sourceCount) || 0),
            configuredSourceCount: Math.max(0, finite(raw.marketQuote.configuredSourceCount) || 0),
            spreadPct: Math.max(0, finite(raw.marketQuote.spreadPct) || 0),
            consensusPolicyVersion:
              typeof raw.marketQuote.consensusPolicyVersion === "string"
                ? raw.marketQuote.consensusPolicyVersion.slice(0, 60)
                : null,
            consensusCalibrated: raw.marketQuote.consensusCalibrated === true,
          }
        : undefined,
  };
}

function normalizeAudit(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: typeof raw.id === "string" ? raw.id : makeId("audit"),
    action: typeof raw.action === "string" ? raw.action.slice(0, 80) : "portfolio-change",
    timestamp: isoDate(raw.timestamp),
    versionId: typeof raw.versionId === "string" ? raw.versionId : "",
    transactionIds: Array.isArray(raw.transactionIds)
      ? raw.transactionIds.filter((id) => typeof id === "string").slice(0, 100)
      : [],
    affectsHistory: Boolean(raw.affectsHistory),
    detail: typeof raw.detail === "string" ? raw.detail.slice(0, 300) : "",
  };
}

function normalizeAsset(raw, id) {
  if (!raw || typeof raw !== "object" || !id.startsWith("custom:")) return null;
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 80) : "Personal asset";
  if (!title) return null;
  return {
    id,
    title,
    titleKey: "stocks",
    kind: typeof raw.kind === "string" ? raw.kind.slice(0, 30) : "custom",
    unit: typeof raw.unit === "string" ? raw.unit.slice(0, 20) : "TOMAN",
    marketKey: null,
    priced: true,
    sleeveId: Object.hasOwn(SLEEVE_REGISTRY, raw.sleeveId) ? raw.sleeveId : null,
    isInvestable: raw.isInvestable === true,
    isLiquid: raw.isLiquid === true,
    createdAt: isoDate(raw.createdAt),
  };
}

function normalizeVersion(raw, assets = PORTFOLIO_ASSETS) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && raw.id.length <= 120 ? raw.id : makeId("version");
  return {
    id,
    label: typeof raw.label === "string" ? raw.label.slice(0, 100) : "Portfolio version",
    createdAt: isoDate(raw.createdAt),
    startedAt: isoDate(raw.startedAt || raw.createdAt),
    closedAt: raw.closedAt ? isoDate(raw.closedAt) : null,
    transactions: Array.isArray(raw.transactions)
      ? raw.transactions.map((transaction) => normalizeTransaction(transaction, assets)).filter(Boolean)
      : [],
    audit: Array.isArray(raw.audit) ? raw.audit.map(normalizeAudit).filter(Boolean) : [],
  };
}

function normalizeManualQuote(raw) {
  if (!raw || typeof raw !== "object") return null;
  const assetId = typeof raw.assetId === "string" ? raw.assetId.slice(0, 120) : "";
  const knownMarketAsset = Object.hasOwn(INSTRUMENT_REGISTRY, assetId);
  const knownPortfolioAsset = Object.hasOwn(PORTFOLIO_ASSETS, assetId) || assetId.startsWith("custom:");
  const price = finite(raw.price);
  const observedAt = optionalIsoDate(raw.observedAt || raw.date);
  if ((!knownMarketAsset && !knownPortfolioAsset) || price === null || price <= 0 || !observedAt) return null;
  return {
    id: typeof raw.id === "string" && raw.id.length <= 120 ? raw.id : makeId("quote"),
    assetId,
    price,
    observedAt,
    createdAt: isoDate(raw.createdAt || observedAt),
    source: "manual",
    note: typeof raw.note === "string" ? raw.note.slice(0, 160) : "",
  };
}

export function createEmptyPortfolio(now = new Date().toISOString()) {
  const versionId = makeId("version");
  return {
    schema: PORTFOLIO_SCHEMA,
    version: PORTFOLIO_VERSION,
    assets: {},
    manualQuotes: [],
    activeVersionId: versionId,
    versions: [
      {
        id: versionId,
        label: "Initial portfolio",
        createdAt: now,
        startedAt: now,
        closedAt: null,
        transactions: [],
        audit: [],
      },
    ],
  };
}

export function normalizePortfolio(raw) {
  if (
    !raw ||
    typeof raw !== "object" ||
    raw.schema !== PORTFOLIO_SCHEMA ||
    Number(raw.version) > PORTFOLIO_VERSION ||
    !Array.isArray(raw.versions)
  )
    return createEmptyPortfolio();
  const customAssets = Object.fromEntries(
    Object.entries(raw.assets && typeof raw.assets === "object" ? raw.assets : {})
      .map(([id, asset]) => [id, normalizeAsset(asset, id)])
      .filter(([, asset]) => asset),
  );
  const hasLegacyStocks = raw.versions.some(
    (version) =>
      Array.isArray(version.transactions) &&
      version.transactions.some(
        (transaction) => transaction && (transaction.assetId === "stocks" || transaction.targetAssetId === "stocks"),
      ),
  );
  if (hasLegacyStocks && !customAssets[LEGACY_STOCK_ASSET_ID])
    customAssets[LEGACY_STOCK_ASSET_ID] = {
      id: LEGACY_STOCK_ASSET_ID,
      title: "Legacy stock holding",
      titleKey: "stocks",
      kind: "legacy-stock",
      unit: "TOMAN",
      marketKey: null,
      priced: true,
      sleeveId: "iranEquity",
      isInvestable: true,
      isLiquid: false,
      createdAt: new Date().toISOString(),
    };
  const assets = { ...PORTFOLIO_ASSETS, ...customAssets };
  const versions = raw.versions
    .map((version) =>
      normalizeVersion(
        {
          ...version,
          transactions: (version.transactions || []).map((transaction) => ({
            ...transaction,
            assetId: transaction.assetId === "stocks" ? LEGACY_STOCK_ASSET_ID : transaction.assetId,
            targetAssetId: transaction.targetAssetId === "stocks" ? LEGACY_STOCK_ASSET_ID : transaction.targetAssetId,
          })),
        },
        assets,
      ),
    )
    .filter(Boolean);
  if (!versions.length) return createEmptyPortfolio();
  const activeVersionId = versions.some((version) => version.id === raw.activeVersionId)
    ? raw.activeVersionId
    : versions[versions.length - 1].id;
  const manualQuotes = (Array.isArray(raw.manualQuotes) ? raw.manualQuotes : [])
    .map(normalizeManualQuote)
    .filter(Boolean);
  return {
    schema: PORTFOLIO_SCHEMA,
    version: PORTFOLIO_VERSION,
    assets: customAssets,
    manualQuotes,
    activeVersionId,
    versions,
  };
}

export function validateImportedPortfolio(raw) {
  const portfolio = normalizePortfolio(raw);
  const sourceVersions = Array.isArray(raw?.versions) ? raw.versions : [];
  const versionsPreserved =
    portfolio.versions.length === sourceVersions.length &&
    sourceVersions.every((version) => version && typeof version === "object" && Array.isArray(version.transactions));
  const transactionsPreserved =
    versionsPreserved &&
    sourceVersions.every((sourceVersion, index) => {
      const sourceTransactions = Array.isArray(sourceVersion?.transactions) ? sourceVersion.transactions : [];
      return portfolio.versions[index].transactions.length === sourceTransactions.length;
    });
  const assets = assetRegistry(portfolio);
  const validLedgers = portfolio.versions.every((version) => validateLedger(version.transactions, assets).valid);
  return { portfolio, valid: versionsPreserved && transactionsPreserved && validLedgers };
}

export function activePortfolioVersion(portfolio) {
  const normalized = normalizePortfolio(portfolio);
  return (
    normalized.versions.find((version) => version.id === normalized.activeVersionId) ||
    normalized.versions[normalized.versions.length - 1]
  );
}

export function activeTransactions(portfolio) {
  return activePortfolioVersion(portfolio).transactions.slice();
}

function marketHistoryKey(assetId) {
  return assetId === "currency" ? "dollar" : assetId;
}

function seriesPointValue(point) {
  if (Array.isArray(point)) return { date: point[0], value: finite(point[1]) };
  if (!point || typeof point !== "object") return null;
  return {
    date: point.date || point.time || point.timestamp,
    value: finite(point.price ?? point.value ?? point.close ?? point.c),
  };
}

function quoteQualityDetails({ assetId, definition, market, current, price, source, observedAt, retrievedAt, isManual, sourceKind, asOf }) {
  const rejectedConflict = current?.status === "conflicted";
  const shared = {
    eligible: Number.isFinite(Number(price)) && Number(price) > 0,
    rejectedConflict,
    source,
    observedAt,
    retrievedAt,
    status: current?.status || (sourceKind === "history" ? "healthy" : "unavailable"),
    confidence: current?.confidence || (sourceKind === "history" ? "high" : "none"),
    quoteType: current?.quoteType || definition?.quoteType || null,
    sourceCount: Number(current?.sourceCount) || 0,
    configuredSourceCount: Number(current?.configuredSourceCount) || 0,
    spreadPct: finite(current?.spreadPct),
    acceptedSpreadPct: finite(current?.acceptedSpreadPct),
    dependencies: Array.isArray(current?.dependencies) ? current.dependencies : [],
  };
  if (!shared.eligible) return { ...shared, qualityState: rejectedConflict ? "rejected-conflict" : "unavailable" };
  if (sourceKind === "tracking-value") return { ...shared, qualityState: "accepted" };
  const observedTime = observedAt ? Date.parse(observedAt) : NaN;
  const asOfTime = Date.parse(asOf);
  const freshnessWindowMs = ["bitcoin", "ethereum", "tether"].includes(assetId) ? 15 * 60_000 : 3 * 60 * 60_000;
  const stale =
    current?.status === "stale" ||
    current?.cacheStale === true ||
    market?._clientStale === true ||
    (Number.isFinite(observedTime) && Number.isFinite(asOfTime) && asOfTime - observedTime > freshnessWindowMs);
  const partialCoverage =
    Number(current?.configuredSourceCount) > 0 &&
    Number(current?.sourceCount) < Number(current.configuredSourceCount);
  const estimated =
    sourceKind !== "history" &&
    (current?.status !== "healthy" ||
      current?.confidence !== "high" ||
      ["derived", "mixed"].includes(current?.quoteType) ||
      current?.consensusDisagreement === true ||
      Number(current?.unknownObservationCount) > 0 ||
      !Number.isFinite(observedTime) ||
      partialCoverage);
  return {
    ...shared,
    qualityState: stale ? "stale" : isManual ? "manual" : estimated ? "accepted-estimate" : "accepted",
  };
}

export function marketPriceDetailsAt(market, assetId, asOf = new Date().toISOString()) {
  const definition =
    assetDefinition(assetId) ||
    market?.assetDefinitions?.[assetId] ||
    (String(assetId).startsWith("custom:") ? { id: assetId, marketKey: null, unit: "TOMAN" } : null);
  if (!definition) return null;
  const timestamp = new Date(asOf).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const quoteAssetIds = new Set([assetId, definition.marketKey].filter(Boolean));
  const manualQuotes = (Array.isArray(market?.manualQuotes) ? market.manualQuotes : [])
    .map(normalizeManualQuote)
    .filter((quote) => quote && quoteAssetIds.has(quote.assetId) && new Date(quote.observedAt).getTime() <= timestamp)
    .sort((left, right) => new Date(left.observedAt).getTime() - new Date(right.observedAt).getTime());
  const latestManual = manualQuotes.at(-1) || null;
  const current = definition.marketKey ? market?.assets?.[definition.marketKey] : null;
  const withQuality = (quote, sourceKind) =>
    quote
      ? {
          ...quote,
          ...quoteQualityDetails({
            assetId,
            definition,
            market,
            current,
            sourceKind,
            asOf,
            ...quote,
          }),
        }
      : null;
  if (!definition.marketKey)
    return latestManual
      ? withQuality({
          price: latestManual.price,
          source: "قیمت دستی",
          observedAt: latestManual.observedAt,
          retrievedAt: latestManual.createdAt,
          isManual: true,
        }, "manual")
      : String(assetId).startsWith("custom:") && definition.unit !== "TOMAN"
        ? null
        : withQuality(
            { price: 1, source: "ارزش تومانی ثبت‌شده", observedAt: null, retrievedAt: null, isManual: false },
            "tracking-value",
          );
  const currentUnavailableAt = market?._currentQuotesUnavailableAt
    ? new Date(market._currentQuotesUnavailableAt).getTime()
    : NaN;
  const currentPrice = finite(current && current.price);
  const observedAtValue = current?.observedAt || current?.asOf || null;
  const observedAt = observedAtValue ? new Date(observedAtValue).getTime() : NaN;
  const retrievedAt = current?.retrievedAt || market?.updatedAt || null;
  const retrievedTime = retrievedAt ? new Date(retrievedAt).getTime() : NaN;
  const currentQuoteUsable =
    currentPrice !== null && current?.status !== "conflicted" && current?.status !== "unavailable";
  const marketUpdatedTime = market?.updatedAt ? new Date(market.updatedAt).getTime() : NaN;
  const historicalAsOf = !Number.isFinite(marketUpdatedTime) || timestamp < marketUpdatedTime;
  const rawSeries = market && market.history && market.history[marketHistoryKey(assetId)];
  const points = (Array.isArray(rawSeries) ? rawSeries : [])
    .map(seriesPointValue)
    .filter(
      (point) =>
        historicalAsOf &&
        point &&
        point.value !== null &&
        point.value > 0 &&
        Number.isFinite(new Date(point.date).getTime()) &&
        new Date(point.date).getTime() <= timestamp,
    )
    .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime());
  const lastHistory = points.at(-1) || null;
  const manualTime = latestManual ? new Date(latestManual.observedAt).getTime() : -Infinity;
  const historyTime = lastHistory ? new Date(lastHistory.date).getTime() : -Infinity;
  if (
    currentQuoteUsable &&
    Number.isFinite(observedAt) &&
    observedAt <= timestamp &&
    observedAt >= manualTime &&
    observedAt >= historyTime
  ) {
    return withQuality({
      price: currentPrice,
      source: current.sources?.join(", ") || current.source || "قیمت خودکار",
      observedAt: observedAtValue,
      retrievedAt,
      isManual: false,
    }, "current");
  }
  if (latestManual && manualTime >= historyTime) {
    return withQuality({
      price: latestManual.price,
      source: "قیمت دستی",
      observedAt: latestManual.observedAt,
      retrievedAt: latestManual.createdAt,
      isManual: true,
    }, "manual");
  }
  if (lastHistory)
    return withQuality({
      price: lastHistory.value,
      source: lastHistory.source || "تاریخچه‌ی بازار",
      observedAt: lastHistory.date,
      retrievedAt: null,
      isManual: false,
    }, "history");
  if (
    currentQuoteUsable &&
    !latestManual &&
    Number.isFinite(retrievedTime) &&
    retrievedTime >= historyTime &&
    timestamp >= retrievedTime &&
    (!Number.isFinite(currentUnavailableAt) || timestamp < currentUnavailableAt)
  ) {
    return withQuality({
      price: currentPrice,
      source: current.sources?.join(", ") || current.source || "قیمت خودکار",
      observedAt: null,
      retrievedAt,
      isManual: false,
    }, "current");
  }
  return null;
}

export function marketPriceAt(market, assetId, asOf = new Date().toISOString()) {
  return marketPriceDetailsAt(market, assetId, asOf)?.price ?? null;
}

function transactionAmount(transaction) {
  if (transaction.amount !== undefined) return Math.abs(Number(transaction.amount) || 0);
  return Math.abs((Number(transaction.quantity) || 0) * (Number(transaction.unitPrice) || 0));
}

function sortedTransactions(transactions, asOf) {
  const timestamp = new Date(asOf).getTime();
  return transactions
    .filter((transaction) => new Date(transaction.date).getTime() <= timestamp)
    .slice()
    .sort(
      (left, right) =>
        new Date(left.date).getTime() - new Date(right.date).getTime() ||
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
    );
}

export function ledgerState(transactions, asOf = new Date().toISOString(), assets = PORTFOLIO_ASSETS) {
  const holdings = emptyHoldings(assets);
  let contributed = 0;
  let returned = 0;
  let dividends = 0;
  const applied = [];
  sortedTransactions(transactions, asOf).forEach((transaction) => {
    const amount = transactionAmount(transaction);
    switch (transaction.type) {
      case "OPENING":
      case "BUY":
        holdings[transaction.assetId] += Number(transaction.quantity) || 0;
        contributed += amount + (Number(transaction.fee) || 0);
        break;
      case "SELL":
        holdings[transaction.assetId] -= Number(transaction.quantity) || 0;
        returned += Math.max(0, amount - (Number(transaction.fee) || 0));
        break;
      case "ADJUSTMENT":
        holdings[transaction.assetId] += Number(transaction.quantity) || 0;
        if (amount > 0) {
          if ((Number(transaction.quantity) || 0) >= 0) contributed += amount;
          else returned += amount;
        }
        break;
      case "DIVIDEND":
        holdings.cash += Number(transaction.amount) || 0;
        dividends += Number(transaction.amount) || 0;
        break;
      case "DEPOSIT":
        holdings.cash += Number(transaction.amount) || 0;
        contributed += Number(transaction.amount) || 0;
        break;
      case "WITHDRAWAL":
        holdings.cash -= Number(transaction.amount) || 0;
        returned += Number(transaction.amount) || 0;
        break;
      case "TRANSFER":
        holdings[transaction.assetId] -= Number(transaction.quantity) || 0;
        holdings[transaction.targetAssetId] += Number(transaction.targetQuantity) || 0;
        break;
      case "BASIS_CORRECTION": {
        const previousBasis = portfolioCostBasis(applied, transaction.date)[transaction.assetId]?.basis || 0;
        contributed += (Number(transaction.amount) || 0) - previousBasis;
        break;
      }
      default:
        break;
    }
    applied.push(transaction);
  });
  return { holdings, contributed, returned, dividends, netInvested: Math.max(0, contributed - returned), applied };
}

export function portfolioCostBasis(transactions, asOf = new Date().toISOString()) {
  const positions = new Map();
  const positionFor = (assetId) =>
    positions.get(assetId) || { quantity: 0, confirmedBasis: 0, estimatedBasis: 0, unknownQuantity: 0 };
  const add = (assetId, quantity, basis, status = "unknown") => {
    if (!assetId || quantity <= EPSILON || basis < 0) return;
    const position = positionFor(assetId);
    const next = { ...position, quantity: position.quantity + quantity };
    if (status === "confirmed") next.confirmedBasis += basis;
    else if (status === "estimated") next.estimatedBasis += basis;
    else next.unknownQuantity += quantity;
    positions.set(assetId, next);
  };
  const remove = (assetId, quantity) => {
    const position = positionFor(assetId);
    if (position.quantity <= EPSILON || quantity <= EPSILON)
      return { quantity: 0, confirmedBasis: 0, estimatedBasis: 0, unknownQuantity: 0 };
    const removedQuantity = Math.min(position.quantity, quantity);
    const retainedRatio = Math.max(0, (position.quantity - removedQuantity) / position.quantity);
    const removed = {
      quantity: removedQuantity,
      confirmedBasis: position.confirmedBasis * (1 - retainedRatio),
      estimatedBasis: position.estimatedBasis * (1 - retainedRatio),
      unknownQuantity: position.unknownQuantity * (1 - retainedRatio),
    };
    positions.set(assetId, {
      quantity: Math.max(0, position.quantity - removedQuantity),
      confirmedBasis: Math.max(0, position.confirmedBasis * retainedRatio),
      estimatedBasis: Math.max(0, position.estimatedBasis * retainedRatio),
      unknownQuantity: Math.max(0, position.unknownQuantity * retainedRatio),
    });
    return removed;
  };

  sortedTransactions(transactions, asOf).forEach((transaction) => {
    const quantity = Math.abs(Number(transaction.quantity) || 0);
    const amount = transactionAmount(transaction);
    const fee = Number(transaction.fee) || 0;
    if (["OPENING", "BUY"].includes(transaction.type))
      add(transaction.assetId, quantity, amount + fee, transaction.costBasisStatus || "unknown");
    if (transaction.type === "SELL") remove(transaction.assetId, quantity);
    if (transaction.type === "ADJUSTMENT") {
      if (Number(transaction.quantity) > 0)
        add(transaction.assetId, quantity, amount + fee, transaction.costBasisStatus || "unknown");
      else remove(transaction.assetId, quantity);
    }
    if (["DEPOSIT", "DIVIDEND"].includes(transaction.type)) add("cash", amount, amount, "confirmed");
    if (transaction.type === "WITHDRAWAL") remove("cash", amount);
    if (transaction.type === "TRANSFER") {
      const moved = remove(transaction.assetId, quantity);
      if (moved.quantity > EPSILON) {
        const targetQuantity = Number(transaction.targetQuantity) || 0;
        const retainedSourceRatio = targetQuantity / moved.quantity;
        const target = positionFor(transaction.targetAssetId);
        positions.set(transaction.targetAssetId, {
          quantity: target.quantity + targetQuantity,
          confirmedBasis: target.confirmedBasis + moved.confirmedBasis,
          estimatedBasis: target.estimatedBasis + moved.estimatedBasis,
          unknownQuantity: target.unknownQuantity + moved.unknownQuantity * retainedSourceRatio,
        });
      }
    }
    if (transaction.type === "BASIS_CORRECTION") {
      const position = positionFor(transaction.assetId);
      if (Math.abs(position.quantity - quantity) <= EPSILON) {
        positions.set(transaction.assetId, {
          quantity: position.quantity,
          confirmedBasis: amount,
          estimatedBasis: 0,
          unknownQuantity: 0,
        });
      }
    }
  });

  return Object.fromEntries(
    [...positions].map(([assetId, position]) => {
      const knownBasis = position.confirmedBasis + position.estimatedBasis;
      const hasConfirmed = position.confirmedBasis > EPSILON;
      const hasEstimated = position.estimatedBasis > EPSILON;
      const hasUnknown = position.unknownQuantity > EPSILON;
      const status = hasUnknown
        ? hasConfirmed || hasEstimated
          ? "partial"
          : "unknown"
        : hasEstimated
          ? hasConfirmed
            ? "mixed"
            : "estimated"
          : "confirmed";
      return [
        assetId,
        {
          quantity: position.quantity,
          basis: knownBasis > EPSILON ? knownBasis : null,
          confirmedBasis: position.confirmedBasis,
          estimatedBasis: position.estimatedBasis,
          unknownQuantity: position.unknownQuantity,
          status,
          averageCost: position.quantity > EPSILON && !hasUnknown ? knownBasis / position.quantity : null,
        },
      ];
    }),
  );
}

export function portfolioContributionSeries(transactions, asOf = new Date().toISOString(), monthCount = 12) {
  const asOfDate = new Date(asOf);
  if (Number.isNaN(asOfDate.getTime())) return [];
  const contributions = new Map();
  const contributionTransactions = sortedTransactions(transactions, asOf).filter((transaction) =>
    ["OPENING", "BUY", "DEPOSIT"].includes(transaction.type),
  );
  if (!contributionTransactions.length) return [];

  const endMonth = Date.UTC(asOfDate.getUTCFullYear(), asOfDate.getUTCMonth(), 1);
  const requestedStart = new Date(endMonth);
  requestedStart.setUTCMonth(requestedStart.getUTCMonth() - Math.max(1, Math.floor(monthCount)) + 1);
  const startMonth = requestedStart.getTime();

  contributionTransactions.forEach((transaction) => {
    const date = new Date(transaction.date);
    const month = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    if (month < startMonth || month > endMonth) return;
    const amount =
      transaction.type === "DEPOSIT"
        ? transactionAmount(transaction)
        : transactionAmount(transaction) + (Number(transaction.fee) || 0);
    contributions.set(month, (contributions.get(month) || 0) + amount);
  });

  return [...contributions.entries()]
    .filter(([month]) => month >= startMonth && month <= endMonth)
    .sort(([left], [right]) => left - right)
    .map(([month, value]) => ({ date: new Date(month).toISOString(), value, calendar: REPORTING_CALENDAR }));
}

function valueState(holdings, market, asOf, assets = PORTFOLIO_ASSETS) {
  const values = {};
  const missingPrices = [];
  let totalValue = 0;
  let investableTotal = 0;
  let liquidTotal = 0;
  const sleeveValues = {};
  const quoteQualityCounts = {
    accepted: 0,
    "accepted-estimate": 0,
    stale: 0,
    manual: 0,
    unavailable: 0,
    "rejected-conflict": 0,
  };
  Object.keys(assets).forEach((assetId) => {
    const quantity = Number(holdings[assetId]) || 0;
    const priceDetails = marketPriceDetailsAt(market, assetId, asOf);
    const definition = assets[assetId];
    const currentQuote = definition.marketKey ? market?.assets?.[definition.marketKey] : null;
    const price = priceDetails?.price ?? null;
    const value = price === null ? null : quantity * price;
    const quoteQuality =
      priceDetails?.qualityState ||
      (currentQuote?.status === "conflicted" ? "rejected-conflict" : "unavailable");
    values[assetId] = {
      quantity,
      price,
      value,
      unit: assets[assetId].unit,
      priceSource: priceDetails?.source || null,
      priceObservedAt: priceDetails?.observedAt || null,
      priceRetrievedAt: priceDetails?.retrievedAt || null,
      quoteQuality,
      quoteEligible: priceDetails?.eligible === true,
      rejectedConflict: priceDetails?.rejectedConflict === true || currentQuote?.status === "conflicted",
      quoteStatus: priceDetails?.status || currentQuote?.status || "unavailable",
      quoteConfidence: priceDetails?.confidence || currentQuote?.confidence || "none",
      quoteType: priceDetails?.quoteType || currentQuote?.quoteType || definition.quoteType || null,
      sourceCount: priceDetails?.sourceCount ?? (Number(currentQuote?.sourceCount) || 0),
      configuredSourceCount: priceDetails?.configuredSourceCount ?? (Number(currentQuote?.configuredSourceCount) || 0),
      spreadPct: priceDetails?.spreadPct ?? finite(currentQuote?.spreadPct),
      acceptedSpreadPct: priceDetails?.acceptedSpreadPct ?? finite(currentQuote?.acceptedSpreadPct),
      conversionDependencies: priceDetails?.dependencies || currentQuote?.dependencies || [],
      manualPrice: Boolean(priceDetails?.isManual),
    };
    if (quantity > EPSILON) quoteQualityCounts[quoteQuality] = (quoteQualityCounts[quoteQuality] || 0) + 1;
    if (quantity > EPSILON && value === null) missingPrices.push(assetId);
    if (value !== null) {
      totalValue += value;
      if (assets[assetId].isInvestable) investableTotal += value;
      if (assets[assetId].isLiquid) liquidTotal += value;
      const sleeveId = assets[assetId].sleeveId;
      if (sleeveId && assets[assetId].isInvestable) sleeveValues[sleeveId] = (sleeveValues[sleeveId] || 0) + value;
    }
  });
  const allocation = {};
  Object.entries(values).forEach(([assetId, item]) => {
    allocation[assetId] = missingPrices.length
      ? null
      : totalValue > EPSILON && item.value !== null
        ? (item.value / totalValue) * 100
        : 0;
  });
  const hasConflict = missingPrices.some((assetId) => values[assetId]?.rejectedConflict);
  const hasStale = quoteQualityCounts.stale > 0;
  const hasEstimate = quoteQualityCounts["accepted-estimate"] > 0;
  const hasManual = quoteQualityCounts.manual > 0;
  const quoteQualityStatus = missingPrices.length
    ? hasConflict
      ? "rejected-conflict"
      : "unavailable"
    : hasStale
      ? "stale"
      : hasEstimate
        ? "accepted-estimate"
        : hasManual
          ? "manual"
          : "accepted";
  const valuationComplete = missingPrices.length === 0;
  return {
    values,
    totalValue: valuationComplete ? totalValue : null,
    partialTotalValue: totalValue,
    netWorth: valuationComplete ? totalValue : null,
    investableTotal: valuationComplete ? investableTotal : null,
    liquidTotal: valuationComplete ? liquidTotal : null,
    sleeveValues: missingPrices.length ? null : sleeveValues,
    partialSleeveValues: sleeveValues,
    allocation,
    missingPrices,
    quoteQualityCounts,
    quoteQualityStatus,
    valuationComplete,
  };
}

function xirr(cashFlows, guess = 0.1) {
  if (cashFlows.length < 2) return null;
  const origin = new Date(cashFlows[0].date).getTime();
  const years = (date) => (new Date(date).getTime() - origin) / (365.25 * 24 * 60 * 60 * 1000);
  let rate = guess;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    let value = 0;
    let derivative = 0;
    cashFlows.forEach((flow) => {
      const year = years(flow.date);
      const denominator = Math.pow(1 + rate, year);
      value += flow.amount / denominator;
      if (year !== 0) derivative -= (year * flow.amount) / Math.pow(1 + rate, year + 1);
    });
    if (Math.abs(derivative) < EPSILON) return null;
    const next = rate - value / derivative;
    if (!Number.isFinite(next) || next <= -0.99 || next > 20) return null;
    if (Math.abs(next - rate) < 1e-8) return next;
    rate = next;
  }
  return null;
}

function performanceMetrics(
  transactions,
  state,
  totalValue,
  asOf,
  inflationRate = 0,
  costBasisStatus = "confirmed",
  valuationStatus = "accepted",
  partialValue = null,
) {
  const first = transactions
    .slice()
    .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime())[0];
  const start = first ? new Date(first.date) : new Date(asOf);
  const years = Math.max(0, (new Date(asOf).getTime() - start.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  const flows = [];
  transactions.forEach((transaction) => {
    const amount = transactionAmount(transaction);
    if (["OPENING", "BUY", "DEPOSIT"].includes(transaction.type))
      flows.push({ date: transaction.date, amount: -(amount + (Number(transaction.fee) || 0)) });
    if (["SELL", "WITHDRAWAL"].includes(transaction.type))
      flows.push({ date: transaction.date, amount: Math.max(0, amount - (Number(transaction.fee) || 0)) });
  });
  const valuationAvailable = totalValue !== null && totalValue !== undefined && Number.isFinite(Number(totalValue));
  const basisCorrectionApplied = transactions.some((transaction) => transaction.type === "BASIS_CORRECTION");
  if (valuationAvailable && totalValue > 0) flows.push({ date: asOf, amount: totalValue });
  const hasUnknownBasis = ["unknown", "partial"].includes(costBasisStatus);
  const hasEstimatedBasis = ["estimated", "mixed"].includes(costBasisStatus);
  const hasEstimatedValuation = ["accepted-estimate", "stale", "manual"].includes(valuationStatus);
  const hasEstimatedPerformance = hasEstimatedBasis || hasEstimatedValuation;
  const annualizedReturn = hasUnknownBasis || basisCorrectionApplied || !valuationAvailable ? null : xirr(flows);
  const realTotalValue = valuationAvailable ? realValue(totalValue, inflationRate, years) : null;
  const profitLoss = hasUnknownBasis || hasEstimatedPerformance || !valuationAvailable ? null : totalValue - state.netInvested;
  const estimatedProfitLoss =
    !hasUnknownBasis && hasEstimatedPerformance && valuationAvailable ? totalValue - state.netInvested : null;
  return {
    trackingStart: first ? first.date : null,
    years,
    netInvested: hasUnknownBasis ? null : state.netInvested,
    estimatedNetInvested: hasEstimatedBasis ? state.netInvested : null,
    netInvestedStatus: hasUnknownBasis ? "unavailable" : hasEstimatedBasis ? "estimated" : "confirmed",
    currentValue: valuationAvailable ? totalValue : null,
    partialValue,
    profitLoss,
    estimatedProfitLoss,
    performanceStatus:
      hasUnknownBasis || !valuationAvailable
        ? "unavailable"
        : hasEstimatedPerformance
          ? "estimated"
          : "confirmed",
    returnRateAvailable: !basisCorrectionApplied && !hasUnknownBasis && !hasEstimatedPerformance && valuationAvailable,
    cagr:
      !basisCorrectionApplied && !hasUnknownBasis && !hasEstimatedPerformance && valuationAvailable && annualizedReturn === null && state.netInvested > 0 && years > 0
        ? Math.pow(totalValue / state.netInvested, 1 / years) - 1
        : basisCorrectionApplied || hasEstimatedPerformance || hasUnknownBasis || !valuationAvailable
          ? null
          : annualizedReturn,
    estimatedCagr:
      hasEstimatedPerformance && valuationAvailable
        ? annualizedReturn === null && state.netInvested > 0 && years > 0
          ? Math.pow(totalValue / state.netInvested, 1 / years) - 1
          : annualizedReturn
        : null,
    realValue: realTotalValue,
    inflationAdjustedReturn:
      !basisCorrectionApplied && !hasUnknownBasis && !hasEstimatedPerformance && valuationAvailable && state.netInvested > 0
        ? realTotalValue / state.netInvested - 1
        : null,
    estimatedInflationAdjustedReturn:
      hasEstimatedPerformance && valuationAvailable && state.netInvested > 0
        ? realTotalValue / state.netInvested - 1
        : null,
    dividends: state.dividends,
  };
}

export function calculatePortfolio(portfolio, market, asOf = new Date().toISOString(), inflationRate = 0) {
  const normalized = normalizePortfolio(portfolio);
  const assets = assetRegistry(normalized);
  const version = activePortfolioVersion(normalized);
  const transactions = version.transactions;
  const marketWithManualQuotes = { ...(market || {}), manualQuotes: normalized.manualQuotes, assetDefinitions: assets };
  const state = ledgerState(transactions, asOf, assets);
  const valuation = valueState(state.holdings, marketWithManualQuotes, asOf, assets);
  const costBasisByAsset = portfolioCostBasis(state.applied, asOf);
  const openPositions = Object.entries(state.holdings)
    .filter(([, quantity]) => Math.abs(Number(quantity) || 0) > EPSILON)
    .map(([assetId]) => costBasisByAsset[assetId])
    .filter(Boolean);
  const hasUnknownBasis = openPositions.some((position) => position.unknownQuantity > EPSILON);
  const hasEstimatedBasis = openPositions.some((position) => position.estimatedBasis > EPSILON);
  const hasConfirmedBasis = openPositions.some((position) => position.confirmedBasis > EPSILON);
  const costBasisStatus = !openPositions.length
    ? "none"
    : hasUnknownBasis
      ? hasEstimatedBasis || hasConfirmedBasis
        ? "partial"
        : "unknown"
      : hasEstimatedBasis
        ? hasConfirmedBasis
          ? "mixed"
          : "estimated"
        : "confirmed";
  const valuationStatus = valuation.valuationComplete ? valuation.quoteQualityStatus : "unavailable";
  return {
    versionId: version.id,
    versionLabel: version.label,
    transactions,
    holdings: state.holdings,
    values: valuation.values,
    allocation: valuation.allocation,
    netWorth: valuation.netWorth,
    investableTotal: valuation.investableTotal,
    liquidTotal: valuation.liquidTotal,
    sleeveValues: valuation.sleeveValues,
    partialSleeveValues: valuation.partialSleeveValues,
    missingPrices: valuation.missingPrices,
    valuationComplete: valuation.valuationComplete,
    quoteQualityStatus: valuation.quoteQualityStatus,
    quoteQualityCounts: valuation.quoteQualityCounts,
    partialValue: valuation.partialTotalValue,
    costBasisByAsset,
    costBasisStatus,
    assets,
    audit: version.audit,
    ...performanceMetrics(
      state.applied,
      state,
      valuation.totalValue,
      asOf,
      inflationRate,
      costBasisStatus,
      valuationStatus,
      valuation.partialTotalValue,
    ),
  };
}

export function validateLedger(transactions, assets = PORTFOLIO_ASSETS) {
  const holdings = emptyHoldings(assets);
  const errors = [];
  sortedTransactions(transactions, new Date(8640000000000000).toISOString()).forEach((transaction) => {
    const requiresAssetBalance =
      transaction.type === "SELL" ||
      (transaction.type === "ADJUSTMENT" && Number(transaction.quantity) < 0) ||
      transaction.type === "BASIS_CORRECTION";
    const required =
      requiresAssetBalance || transaction.type === "WITHDRAWAL"
        ? transaction.type === "WITHDRAWAL"
          ? "cash"
          : transaction.assetId
        : transaction.type === "TRANSFER"
          ? transaction.assetId
          : null;
    const requested =
      transaction.type === "WITHDRAWAL"
        ? transaction.amount
        : transaction.type === "TRANSFER"
          ? transaction.quantity
          : transaction.type === "ADJUSTMENT"
            ? Math.abs(Number(transaction.quantity) || 0)
          : transaction.quantity;
    if (required && (Number(holdings[required]) || 0) + EPSILON < (Number(requested) || 0))
      errors.push({ code: "negative-holding", transactionId: transaction.id, assetId: required });
    if (
      transaction.type === "BASIS_CORRECTION" &&
      Math.abs((Number(holdings[transaction.assetId]) || 0) - (Number(transaction.quantity) || 0)) > EPSILON
    )
      errors.push({ code: "basis-quantity-mismatch", transactionId: transaction.id, assetId: transaction.assetId });
    if (transaction.type === "TRANSFER") {
      holdings[transaction.assetId] -= Number(transaction.quantity) || 0;
      holdings[transaction.targetAssetId] += Number(transaction.targetQuantity) || 0;
    } else if (transaction.type === "WITHDRAWAL") holdings.cash -= Number(transaction.amount) || 0;
    else if (transaction.type === "DIVIDEND" || transaction.type === "DEPOSIT")
      holdings.cash += Number(transaction.amount) || 0;
    else if (transaction.type === "SELL") holdings[transaction.assetId] -= Number(transaction.quantity) || 0;
    else if (["OPENING", "BUY", "ADJUSTMENT"].includes(transaction.type))
      holdings[transaction.assetId] += Number(transaction.quantity) || 0;
    if (Object.values(holdings).some((value) => value < -EPSILON))
      errors.push({ code: "negative-holding", transactionId: transaction.id });
  });
  return { valid: errors.length === 0, errors };
}

export function appendTransactions(portfolio, transactions, audit = {}) {
  const current = normalizePortfolio(portfolio);
  const assets = assetRegistry(current);
  const normalized = transactions.map((transaction) => normalizeTransaction(transaction, assets)).filter(Boolean);
  const version = activePortfolioVersion(current);
  const candidate = [...version.transactions, ...normalized];
  const validation = validateLedger(candidate, assets);
  if (!validation.valid) return { portfolio: current, transactions: [], validation };
  const next = clone(current);
  const nextVersion = next.versions.find((item) => item.id === version.id);
  nextVersion.transactions = candidate;
  nextVersion.audit.push({
    id: makeId("audit"),
    action: audit.action || "append-transactions",
    timestamp: isoDate(audit.timestamp),
    versionId: version.id,
    transactionIds: normalized.map((transaction) => transaction.id),
    affectsHistory: Boolean(audit.affectsHistory),
    detail: audit.detail || "",
  });
  return { portfolio: next, transactions: normalized, validation: { valid: true, errors: [] } };
}

export function createPortfolioVersion(
  portfolio,
  openingTransactions,
  label = "New tracking baseline",
  now = new Date().toISOString(),
) {
  const current = normalizePortfolio(portfolio);
  const assets = assetRegistry(current);
  const next = clone(current);
  const oldVersion =
    next.versions.find((version) => version.id === next.activeVersionId) || next.versions[next.versions.length - 1];
  const versionId = makeId("version");
  const normalized = openingTransactions
    .map((transaction) => normalizeTransaction(transaction, assets))
    .filter(Boolean);
  const validation = validateLedger(normalized, assets);
  if (!validation.valid) return { portfolio: current, transactions: [], validation };
  oldVersion.closedAt = now;
  oldVersion.audit.push({
    id: makeId("audit"),
    action: "close-version",
    timestamp: now,
    versionId: oldVersion.id,
    transactionIds: [],
    affectsHistory: true,
    detail: label,
  });
  next.versions.push({
    id: versionId,
    label,
    createdAt: now,
    startedAt: now,
    closedAt: null,
    transactions: normalized,
    audit: [
      {
        id: makeId("audit"),
        action: "create-version",
        timestamp: now,
        versionId,
        transactionIds: normalized.map((transaction) => transaction.id),
        affectsHistory: true,
        detail: label,
      },
    ],
  });
  next.activeVersionId = versionId;
  return { portfolio: next, transactions: normalized, validation: { valid: true, errors: [] } };
}

export function createTransaction(input, market, now = new Date().toISOString(), portfolio = null) {
  if (!input || typeof input !== "object" || !TRANSACTION_TYPES.includes(input.type)) return null;
  const type = input.type;
  const assets = assetRegistry(portfolio);
  const suppliedAssetId = input.assetId;
  const assetId = assetDefinition(suppliedAssetId, assets) ? suppliedAssetId : null;
  if (!assetId && type !== "DEPOSIT" && type !== "WITHDRAWAL") return null;
  const effectiveAssetId = assetId || "cash";
  const date = isoDate(input.date || now, now);
  const definition = assetDefinition(effectiveAssetId, assets);
  const normalizedPortfolio = normalizePortfolio(portfolio);
  const transactionMarket = {
    ...(market || {}),
    manualQuotes: normalizedPortfolio.manualQuotes,
    assetDefinitions: assetRegistry(normalizedPortfolio),
  };
  const enteredUnitPrice = finite(input.unitPrice);
  const marketUnitPrice = marketPriceAt(transactionMarket, effectiveAssetId, date);
  const basisUnknown =
    ["OPENING", "BUY", "ADJUSTMENT"].includes(type) && input.costBasisStatus === "unknown" && definition.unit !== "TOMAN";
  const unitPrice =
    type === "BASIS_CORRECTION"
      ? null
      : enteredUnitPrice ?? (basisUnknown ? null : definition.unit === "TOMAN" ? 1 : marketUnitPrice);
  const quantity = finite(input.quantity);
  const amount = finite(input.amount);
  const costBasisStatus =
    type === "BASIS_CORRECTION"
      ? "confirmed"
      : ["OPENING", "BUY", "ADJUSTMENT"].includes(type)
        ? ["confirmed", "estimated", "unknown"].includes(input.costBasisStatus)
          ? input.costBasisStatus
          : enteredUnitPrice !== null
            ? "confirmed"
            : unitPrice !== null && unitPrice > 0
              ? definition.unit === "TOMAN"
                ? "confirmed"
                : "estimated"
              : "unknown"
        : "unknown";
  const referencePrice = marketUnitPrice ?? (definition.unit === "TOMAN" ? 1 : null);
  const transaction = {
    id: makeId("tx"),
    type,
    assetId: effectiveAssetId,
    targetAssetId: input.targetAssetId,
    targetQuantity: finite(input.targetQuantity),
    quantity,
    unitPrice,
    trackingValue:
      type === "OPENING" && quantity !== null && referencePrice !== null ? quantity * referencePrice : finite(input.trackingValue),
    costBasisStatus,
    targetUnitPrice: finite(input.targetUnitPrice),
    amount,
    fee: Math.max(0, finite(input.fee) || 0),
    date,
    createdAt: now,
    note: input.note || "",
    source: input.source || "advanced",
    marketQuote: snapshotQuote(transactionMarket, assetId, date),
  };
  return normalizeTransaction(transaction, assets);
}

export function createPortfolioAsset(portfolio, input, now = new Date().toISOString()) {
  const current = normalizePortfolio(portfolio);
  const title = String((input && input.title) || "")
    .trim()
    .slice(0, 80);
  if (!title) return { portfolio: current, asset: null };
  const existing = Object.values(current.assets).find(
    (asset) => asset.title.toLocaleLowerCase() === title.toLocaleLowerCase(),
  );
  if (existing) return { portfolio: current, asset: existing };
  const id = makeId("asset").replace(/^/, "custom:");
  const kind = input.kind || "custom";
  const isStock = kind === "stock" || kind === "legacy-stock";
  const asset = normalizeAsset(
    {
      id,
      title,
      kind,
      unit: input.unit || "TOMAN",
      sleeveId: input.sleeveId || (isStock ? "iranEquity" : null),
      isInvestable: typeof input.isInvestable === "boolean" ? input.isInvestable : isStock,
      isLiquid: typeof input.isLiquid === "boolean" ? input.isLiquid : false,
      createdAt: now,
    },
    id,
  );
  const next = clone(current);
  next.assets = { ...(next.assets || {}), [id]: asset };
  return { portfolio: next, asset };
}

export function simpleBalancesFromPortfolio(portfolio, market, asOf = new Date().toISOString()) {
  const result = calculatePortfolio(portfolio, market, asOf);
  return Object.fromEntries(SIMPLE_ASSET_IDS.map((assetId) => [assetId, result.holdings[assetId] || 0]));
}

export function simpleChangeTransactions(
  currentHoldings,
  desiredHoldings,
  reason,
  market,
  now = new Date().toISOString(),
  trackingStart = null,
) {
  const transactions = [];
  let hasMissingPrice = false;
  SIMPLE_ASSET_IDS.forEach((assetId) => {
    const current = Number(currentHoldings[assetId]) || 0;
    const desired = Math.max(0, Number(desiredHoldings[assetId]) || 0);
    const delta = desired - current;
    if (Math.abs(delta) <= EPSILON) return;
    const effectiveDate = reason === "new-purchase" ? now : trackingStart || now;
    const definition = assetDefinition(assetId);
    const marketPrice = marketPriceAt(market, assetId, effectiveDate);
    const price = marketPrice ?? (definition?.unit === "TOMAN" ? 1 : null);
    if (!Number.isFinite(price) || price <= 0) {
      hasMissingPrice = true;
      return;
    }
    if (reason === "new-purchase") {
      transactions.push(
        createTransaction(
          {
            type: delta > 0 ? "BUY" : "SELL",
            assetId,
            quantity: Math.abs(delta),
            unitPrice: price,
            source: "simple",
            note: "Simple holdings update",
            date: effectiveDate,
          },
          market,
          now,
        ),
      );
    } else {
      transactions.push(
        createTransaction(
          {
            type: "ADJUSTMENT",
            assetId,
            quantity: delta,
            unitPrice: price,
            source: "simple-correction",
            note: "Simple holdings correction",
            date: effectiveDate,
          },
          market,
          now,
        ),
      );
    }
  });
  return hasMissingPrice ? [] : transactions.filter(Boolean);
}

export function portfolioSeries(portfolio, market, startDate, endDate, inflationRate = 0) {
  const normalized = normalizePortfolio(portfolio);
  const marketWithManualQuotes = {
    ...(market || {}),
    manualQuotes: normalized.manualQuotes,
    assetDefinitions: assetRegistry(normalized),
  };
  const version = activePortfolioVersion(normalized);
  const transactionDates = version.transactions
    .map((transaction) => new Date(transaction.date).getTime())
    .filter(Number.isFinite);
  if (!transactionDates.length) return [];
  const requestedStart = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  if (!Number.isFinite(requestedStart) || !Number.isFinite(end)) return [];
  const start = Math.max(requestedStart, Math.min(...transactionDates));
  if (end < start) return [];
  const points = [];
  for (let time = start; time <= end; time += 30 * 24 * 60 * 60 * 1000) {
    const date = new Date(time).toISOString();
    const state = calculatePortfolio(normalized, marketWithManualQuotes, date, inflationRate);
    points.push({
      date,
      value: state.missingPrices.length ? null : state.currentValue,
      realValue: state.missingPrices.length ? null : state.realValue,
      complete: state.missingPrices.length === 0,
    });
  }
  const finalDate = new Date(end).toISOString();
  if (!points.length || points[points.length - 1].date.slice(0, 10) !== finalDate.slice(0, 10)) {
    const state = calculatePortfolio(normalized, market, finalDate, inflationRate);
    points.push({
      date: finalDate,
      value: state.missingPrices.length ? null : state.currentValue,
      realValue: state.missingPrices.length ? null : state.realValue,
      complete: state.missingPrices.length === 0,
    });
  }
  return points;
}

export function assetIds(portfolio = null) {
  return Object.keys(assetRegistry(portfolio));
}
