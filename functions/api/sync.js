import { consumeRouteQuota } from "./_security.js";

const encoder = new TextEncoder();
const MAX_BODY_BYTES = 360_000;
const MAX_CIPHERTEXT_BYTES = 256 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function isSameOrigin(request) {
  const origin = new URL(request.url).origin;
  const sentOrigin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return (
    Boolean(sentOrigin || fetchSite) &&
    (!sentOrigin || sentOrigin === origin) &&
    (!fetchSite || fetchSite === "same-origin" || fetchSite === "none")
  );
}

function isCanonicalBase64Url(value, minBytes, maxBytes) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return false;
  try {
    const bytes = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4));
    if (bytes.length < minBytes || bytes.length > maxBytes) return false;
    return btoa(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === value;
  } catch {
    return false;
  }
}

async function authorize(context) {
  const { request, env } = context;
  const quota = await consumeRouteQuota(context, "sync");
  if (quota.error) return { error: quota.error };
  if (!isSameOrigin(request)) return { error: json({ error: "same-origin-required" }, 403) };
  if (!env?.USER_DATA_DB || typeof env.USER_DATA_DB.prepare !== "function")
    return { error: json({ error: "sync-storage-not-configured" }, 503) };
  const token = request.headers.get("x-synthora-sync-token");
  if (!token || !TOKEN_PATTERN.test(token)) return { error: json({ error: "sync-token-required" }, 401) };
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`synthora-sync-account-v1:${token}`));
  const accountId = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { db: env.USER_DATA_DB, accountId };
}

async function readBody(request, deleting = false) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json")
    return { error: json({ error: "invalid-content-type" }, 415) };
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES))
    return { error: json({ error: "body-too-large" }, 413) };
  if (!request.body) return { error: json({ error: "invalid-body" }, 400) };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return { error: json({ error: "body-too-large" }, 413) };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      !body ||
      Array.isArray(body) ||
      typeof body !== "object" ||
      Object.keys(body).sort().join(",") !== (deleting ? "revision" : "payload,revision") ||
      !Number.isSafeInteger(body.revision) ||
      body.revision < (deleting ? 1 : 0) ||
      body.revision >= Number.MAX_SAFE_INTEGER
    )
      return { error: json({ error: "invalid-body" }, 400) };
    if (
      !deleting &&
      (!body.payload ||
        Array.isArray(body.payload) ||
        typeof body.payload !== "object" ||
        Object.keys(body.payload).sort().join(",") !== "ciphertext,iv,version" ||
        body.payload.version !== 1 ||
        !isCanonicalBase64Url(body.payload.iv, 12, 12) ||
        !isCanonicalBase64Url(body.payload.ciphertext, 16, MAX_CIPHERTEXT_BYTES))
    )
      return { error: json({ error: "invalid-body" }, 400) };
    return { body };
  } catch {
    return { error: json({ error: "invalid-body" }, 400) };
  }
}

export async function onRequestGet(context) {
  const auth = await authorize(context);
  if (auth.error) return auth.error;
  try {
    const row = await auth.db
      .prepare("SELECT revision, payload_json, deleted_at FROM sync_blobs WHERE account_id = ?1")
      .bind(auth.accountId)
      .first();
    if (!row) return json({ error: "sync-not-found", revision: 0 }, 404);
    if (row.deleted_at !== null) return json({ error: "sync-deleted", revision: row.revision }, 404);
    return json({ revision: row.revision, payload: JSON.parse(row.payload_json) });
  } catch {
    return json({ error: "sync-storage-unavailable" }, 503);
  }
}

export async function onRequestPut(context) {
  const auth = await authorize(context);
  if (auth.error) return auth.error;
  const parsed = await readBody(context.request);
  if (parsed.error) return parsed.error;
  const { revision, payload } = parsed.body;
  const payloadJson = JSON.stringify(payload);
  const now = Math.floor(Date.now() / 1000);
  try {
    const statement =
      revision === 0
        ? auth.db
            .prepare(
              "INSERT INTO sync_blobs (account_id, revision, payload_json, updated_at) VALUES (?1, 1, ?2, ?3) ON CONFLICT(account_id) DO NOTHING RETURNING revision",
            )
            .bind(auth.accountId, payloadJson, now)
        : auth.db
            .prepare(
              "UPDATE sync_blobs SET revision = revision + 1, payload_json = ?2, updated_at = ?3 WHERE account_id = ?1 AND revision = ?4 AND deleted_at IS NULL RETURNING revision",
            )
            .bind(auth.accountId, payloadJson, now, revision);
    const written = await statement.first();
    if (written) return json({ revision: written.revision }, revision === 0 ? 201 : 200);
    const current = await auth.db
      .prepare("SELECT revision FROM sync_blobs WHERE account_id = ?1")
      .bind(auth.accountId)
      .first();
    return json({ error: "sync-conflict", revision: current?.revision ?? null }, 409);
  } catch {
    return json({ error: "sync-storage-unavailable" }, 503);
  }
}

export async function onRequestDelete(context) {
  const auth = await authorize(context);
  if (auth.error) return auth.error;
  const parsed = await readBody(context.request, true);
  if (parsed.error) return parsed.error;
  const now = Math.floor(Date.now() / 1000);
  try {
    const deleted = await auth.db
      .prepare(
        "UPDATE sync_blobs SET revision = revision + 1, payload_json = NULL, deleted_at = ?3, updated_at = ?3 WHERE account_id = ?1 AND revision = ?2 AND deleted_at IS NULL RETURNING revision",
      )
      .bind(auth.accountId, parsed.body.revision, now)
      .first();
    if (deleted) return json({ revision: deleted.revision });
    const current = await auth.db
      .prepare("SELECT revision FROM sync_blobs WHERE account_id = ?1")
      .bind(auth.accountId)
      .first();
    return json({ error: "sync-conflict", revision: current?.revision ?? null }, 409);
  } catch {
    return json({ error: "sync-storage-unavailable" }, 503);
  }
}
