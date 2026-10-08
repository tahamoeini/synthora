import test from "node:test";
import assert from "node:assert/strict";
import { readStoredJson } from "../src/ui/storage.js";
import { validateImportedPortfolio } from "../src/portfolio.js";

test("local JSON reads use the fallback when a storage provider throws", () => {
  const failure = new Error("storage unavailable");
  const failures = [];
  const result = readStoredJson(
    () => {
      throw failure;
    },
    "profile",
    { salary: 0 },
    (error) => failures.push(error),
  );

  assert.deepEqual(result, { salary: 0 });
  assert.deepEqual(failures, [failure]);
});

test("corrupt local JSON is reported without deleting or rewriting the original value", () => {
  const records = new Map([["profile", "{not valid json"]]);
  const failures = [];
  const storage = {
    getItem(key) {
      return records.get(key) ?? null;
    },
    setItem(key, value) {
      records.set(key, value);
    },
  };

  const result = readStoredJson(storage, "profile", null, (error) => failures.push(error));

  assert.equal(result, null);
  assert.equal(failures.length, 1);
  assert.equal(records.get("profile"), "{not valid json");
});

test("unsupported portfolio records remain untouched and fail validation", () => {
  const original = JSON.stringify({ schema: "future-portfolio-v99", versions: [] });
  const records = new Map([["portfolio", original]]);
  const portfolio = readStoredJson({ getItem: (key) => records.get(key) ?? null }, "portfolio", null);
  const validation = validateImportedPortfolio(portfolio);

  assert.equal(validation.valid, false);
  assert.equal(records.get("portfolio"), original);
});
