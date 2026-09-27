import test from "node:test";
import assert from "node:assert/strict";
import { writeJsonBatch } from "../src/ui/atomic-storage.js";

test("a failed multi-record write restores prior local data", () => {
  const values = new Map([
    ["history", "old-history"],
    ["portfolio", "old-portfolio"],
  ]);
  let failPortfolioWrite = true;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (key === "portfolio" && failPortfolioWrite) {
        failPortfolioWrite = false;
        throw new Error("quota exceeded");
      }
      values.set(key, String(value));
    },
    removeItem: (key) => values.delete(key),
  };
  assert.equal(
    writeJsonBatch(storage, [
      ["history", [1]],
      ["portfolio", [2]],
    ]),
    false,
  );
  assert.equal(values.get("history"), "old-history");
  assert.equal(values.get("portfolio"), "old-portfolio");
});
