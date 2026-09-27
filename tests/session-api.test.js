import test from "node:test";
import assert from "node:assert/strict";
import { issueSession } from "../functions/api/_security.js";

const env = (db) => ({
  API_SESSION_SIGNING_SECRET: "test-session-signing-secret-that-is-long-enough-for-hmac",
  API_USAGE_DB: db,
});

function createDb() {
  const issuance = new Map();
  const sessions = new Map();
  const cleanup = [];
  return {
    issuance,
    sessions,
    cleanup,
    prepare(sql) {
      let values = [];
      const query = {
        bind(...args) {
          values = args;
          return query;
        },
        async first() {
          if (sql.includes("INSERT INTO api_session_issuance")) {
            const [hash, window, limit] = values;
            const key = `${hash}:${window}`;
            const count = issuance.get(key) || 0;
            if (count >= limit) return null;
            issuance.set(key, count + 1);
            return { request_count: count + 1 };
          }
          if (sql.includes("SELECT expires_at FROM api_sessions")) return sessions.get(values[0]) || null;
          throw new Error(`Unexpected query: ${sql}`);
        },
        async run() {
          if (sql.includes("INSERT INTO api_sessions")) {
            sessions.set(values[0], { expires_at: values[2] });
            return { success: true };
          }
          if (sql.startsWith("DELETE FROM")) {
            cleanup.push({ sql, values });
            return { success: true };
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
      };
      return query;
    },
  };
}

function request(cookie = "", ip = "192.0.2.10") {
  const headers = { origin: "https://app.test", "cf-connecting-ip": ip };
  if (cookie) headers.cookie = cookie;
  return new Request("https://app.test/api/session", { method: "POST", headers });
}

test("session bootstrap atomically caps issuance at 60 per edge address and window", async () => {
  const db = createDb();
  const config = env(db);
  const responses = [];
  for (let index = 0; index < 61; index += 1) responses.push(await issueSession(request(), config));
  assert.equal(responses.filter((response) => response.status === 200).length, 60);
  assert.equal(responses[60].status, 429);
  assert.ok(responses[60].headers.has("retry-after"));
  assert.equal(db.sessions.size, 60);
});

test("valid sessions are reused without consuming bootstrap quota; cleanup is bounded", async () => {
  const db = createDb();
  const config = env(db);
  const issued = await issueSession(request(), config);
  const cookie = issued.headers.get("set-cookie").split(";", 1)[0];
  const issuanceCount = [...db.issuance.values()][0];
  const reused = await issueSession(request(cookie), config);
  assert.equal(reused.status, 200);
  assert.equal(reused.headers.has("set-cookie"), false);
  assert.equal([...db.issuance.values()][0], issuanceCount);
  assert.equal(db.cleanup.length, 3);
  assert.ok(db.cleanup.every(({ values }) => values.at(-1) === 100));
});

test("session issuance fails closed without a Cloudflare client address", async () => {
  const response = await issueSession(
    new Request("https://app.test/api/session", { method: "POST", headers: { origin: "https://app.test" } }),
    env(createDb()),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "session-limit-unavailable" });
});
