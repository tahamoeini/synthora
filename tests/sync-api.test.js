import test from "node:test";
import assert from "node:assert/strict";
import { onRequestDelete, onRequestGet, onRequestPut } from "../functions/api/sync.js";
import { createSecureApiContext } from "./helpers/api-context.js";

const SYNC_URL = "https://app.test/api/sync";
const tokenA = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
const tokenB = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
const payload = { version: 1, iv: btoa("123456789012"), ciphertext: btoa("1234567890123456").replace(/=+$/, "") };

function createDatabase() {
  const records = new Map();
  return {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) {
          args = values;
          return this;
        },
        async first() {
          const [accountId] = args;
          const current = records.get(accountId);
          if (sql.startsWith("SELECT revision, payload_json")) return current || null;
          if (sql.startsWith("SELECT revision FROM")) return current ? { revision: current.revision } : null;
          if (sql.startsWith("INSERT INTO sync_blobs")) {
            if (current) return null;
            records.set(accountId, { revision: 1, payload_json: args[1], updated_at: args[2], deleted_at: null });
            return { revision: 1 };
          }
          if (sql.includes("SET revision = revision + 1, payload_json = ?2")) {
            if (!current || current.revision !== args[3] || current.deleted_at !== null) return null;
            records.set(accountId, {
              revision: current.revision + 1,
              payload_json: args[1],
              updated_at: args[2],
              deleted_at: null,
            });
            return { revision: current.revision + 1 };
          }
          if (sql.includes("SET revision = revision + 1, payload_json = NULL")) {
            if (!current || current.revision !== args[1] || current.deleted_at !== null) return null;
            records.set(accountId, {
              revision: current.revision + 1,
              payload_json: null,
              updated_at: args[2],
              deleted_at: args[2],
            });
            return { revision: current.revision + 1 };
          }
          throw new Error(`Unexpected sync SQL: ${sql}`);
        },
      };
    },
  };
}

async function context(db, token = tokenA, method = "GET", body, headers = {}) {
  const secure = await createSecureApiContext(SYNC_URL, db ? { USER_DATA_DB: db } : {});
  const requestHeaders = new Headers(secure.request.headers);
  requestHeaders.set("x-synthora-sync-token", token);
  for (const [name, value] of Object.entries(headers)) requestHeaders.set(name, value);
  if (body !== undefined) requestHeaders.set("content-type", headers["content-type"] || "application/json");
  return {
    env: secure.env,
    request: new Request(SYNC_URL, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
  };
}

test("sync scopes reads and writes to the bearer token hash", async () => {
  const db = createDatabase();
  const created = await onRequestPut(await context(db, tokenA, "PUT", { revision: 0, payload }));
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { revision: 1 });
  assert.deepEqual(await (await onRequestGet(await context(db, tokenA))).json(), { revision: 1, payload });
  const other = await onRequestGet(await context(db, tokenB));
  assert.equal(other.status, 404);
  assert.deepEqual(await other.json(), { error: "sync-not-found", revision: 0 });
  assert.equal((await onRequestPut(await context(db, tokenB, "PUT", { revision: 0, payload }))).status, 201);
  assert.deepEqual(await (await onRequestGet(await context(db, tokenA))).json(), { revision: 1, payload });
});

test("sync create and update use atomic revision comparisons", async () => {
  const db = createDatabase();
  const [first, second] = await Promise.all([
    context(db, tokenA, "PUT", { revision: 0, payload }),
    context(db, tokenA, "PUT", { revision: 0, payload }),
  ]);
  const results = await Promise.all([onRequestPut(first), onRequestPut(second)]);
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  const changed = { ...payload, iv: btoa("abcdefghijkl") };
  assert.deepEqual(await (await onRequestPut(await context(db, tokenA, "PUT", { revision: 1, payload: changed }))).json(), {
    revision: 2,
  });
  const stale = await onRequestPut(await context(db, tokenA, "PUT", { revision: 1, payload }));
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "sync-conflict", revision: 2 });
  assert.deepEqual(await (await onRequestGet(await context(db))).json(), { revision: 2, payload: changed });
});

test("sync rejects malformed requests before storing data", async () => {
  const db = createDatabase();
  const invalid = [
    "{",
    { revision: 0, payload: { ...payload, ciphertext: "not base64!" } },
    { revision: 0, payload: { ...payload, iv: "short" } },
    { revision: 0, payload: { ...payload, extra: "plaintext" } },
    { revision: -1, payload },
    { revision: 0, payload: "plaintext" },
    { revision: 0, payload, accountId: "other" },
  ];
  for (const body of invalid) {
    const response = await onRequestPut(await context(db, tokenA, "PUT", body));
    assert.equal(response.status, 400);
  }
  assert.equal(
    (await onRequestPut(await context(db, tokenA, "PUT", { revision: 0, payload }, { "content-type": "text/plain" }))).status,
    415,
  );
  assert.equal(
    (await onRequestPut(await context(db, tokenA, "PUT", { revision: 0, payload }, { "content-length": "360001" }))).status,
    413,
  );
  assert.equal((await onRequestGet(await context(db))).status, 404);
});

test("sync enforces origin, token format, and dedicated binding", async () => {
  const db = createDatabase();
  assert.equal(
    (await onRequestGet(await context(db, tokenA, "GET", undefined, { origin: "https://other.test" }))).status,
    403,
  );
  assert.equal(
    (await onRequestGet(await context(db, tokenA, "GET", undefined, { "sec-fetch-site": "cross-site" }))).status,
    403,
  );
  assert.equal((await onRequestGet(await context(db, "short"))).status, 401);
  assert.equal((await onRequestGet(await context(null))).status, 503);
});

test("sync requires a signed API session and enforces its per-session quota", async () => {
  const db = createDatabase();
  const secure = await createSecureApiContext(SYNC_URL, { USER_DATA_DB: db });
  const unauthenticated = new Request(SYNC_URL, {
    headers: {
      origin: new URL(SYNC_URL).origin,
      "sec-fetch-site": "same-origin",
      "x-synthora-sync-token": tokenA,
    },
  });
  assert.equal((await onRequestGet({ ...secure, request: unauthenticated })).status, 401);
  const responses = [];
  for (let index = 0; index < 41; index += 1) {
    const request = new Request(SYNC_URL, { headers: { ...Object.fromEntries(secure.request.headers), "x-synthora-sync-token": tokenA } });
    responses.push(await onRequestGet({ ...secure, request }));
  }
  assert.equal(responses.filter((response) => response.status === 404).length, 40);
  assert.equal(responses[40].status, 429);
});

test("sync DELETE clears ciphertext and leaves a revision tombstone", async () => {
  const db = createDatabase();
  await onRequestPut(await context(db, tokenA, "PUT", { revision: 0, payload }));
  assert.equal((await onRequestDelete(await context(db, tokenB, "DELETE", { revision: 1 }))).status, 409);
  assert.deepEqual(await (await onRequestGet(await context(db, tokenA))).json(), { revision: 1, payload });
  const stale = await onRequestDelete(await context(db, tokenA, "DELETE", { revision: 2 }));
  assert.equal(stale.status, 409);
  const deleted = await onRequestDelete(await context(db, tokenA, "DELETE", { revision: 1 }));
  assert.deepEqual(await deleted.json(), { revision: 2 });
  assert.deepEqual(await (await onRequestGet(await context(db))).json(), { error: "sync-deleted", revision: 2 });
  assert.equal((await onRequestPut(await context(db, tokenA, "PUT", { revision: 0, payload }))).status, 409);
  assert.equal((await onRequestPut(await context(db, tokenA, "PUT", { revision: 2, payload }))).status, 409);
});
