import { consumeRouteQuota, securityJson } from "./_security.js";

const WORLD_BANK_URL = "https://api.worldbank.org/v2/country/IR/indicator/FP.CPI.TOTL.ZG?format=json&per_page=20";

export async function onRequestGet(context) {
  const quota = await consumeRouteQuota(context, "inflation", { allowPublicWhenUnconfigured: true });
  if (quota.error) return quota.error;
  try {
    const response = await fetch(WORLD_BANK_URL, {
      headers: { accept: "application/json", "user-agent": "Synthora/1.0 (Cloudflare Pages)" },
      cf: { cacheTtl: 21600, cacheEverything: true },
    });
    if (!response.ok) throw new Error("world-bank-response-not-ok");
    const payload = await response.json();
    const rows = Array.isArray(payload?.[1]) ? payload[1] : [];
    const latest = rows.find(
      (row) =>
        row?.value !== null &&
        row?.value !== undefined &&
        Number.isFinite(Number(row.value)) &&
        Number(row.value) > -100,
    );
    if (!latest) return securityJson({ error: "inflation-data-unavailable" }, 502);
    return securityJson(
      {
        inflationRate: Number(latest.value),
        year: String(latest.date),
        source: "World Bank · CPI inflation (annual %)",
        sourceUrl: "https://data.worldbank.org/indicator/FP.CPI.TOTL.ZG?locations=IR",
        fetchedAt: new Date().toISOString(),
        frequency: "annual",
      },
      200,
      { "cache-control": "private, no-store" },
    );
  } catch {
    return securityJson({ error: "inflation-provider-unavailable" }, 502);
  }
}
