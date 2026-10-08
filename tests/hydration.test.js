import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runHydration } from "../src/ui/hydration.js";

function readCatalog(locale) {
  return JSON.parse(readFileSync(new URL("../content/" + locale + ".json", import.meta.url), "utf8"));
}

test("successful hydration removes the loading state", async () => {
  const documentRef = { documentElement: { dataset: { hydrating: "true" } } };
  const loadingElement = { hidden: false };
  let initialized = false;

  const result = await runHydration(
    async () => {
      initialized = true;
    },
    { documentRef, loadingElement },
  );

  assert.equal(initialized, true);
  assert.deepEqual(result, { ok: true });
  assert.equal(documentRef.documentElement.dataset.hydrating, "false");
  assert.equal(loadingElement.hidden, true);
});

test("failed hydration reports an error and still exposes the app after hiding the loader", async () => {
  const documentRef = { documentElement: { dataset: { hydrating: "true" } } };
  const loadingElement = { hidden: false };
  const storedData = new Map([["profile", '{"salary":80000000}']]);
  const message = { textContent: "", hidden: true };
  const failure = new Error("unsupported local record");

  const result = await runHydration(
    async () => {
      throw failure;
    },
    {
      documentRef,
      loadingElement,
      onError: () => {
        message.textContent = "Saved data was left in place.";
        message.hidden = false;
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, failure);
  assert.equal(message.hidden, false);
  assert.equal(documentRef.documentElement.dataset.hydrating, "false");
  assert.equal(loadingElement.hidden, true);
  assert.equal(storedData.get("profile"), '{"salary":80000000}');
});

test("storage and hydration recovery messages exist for all supported locales", () => {
  for (const locale of ["fa", "en", "ru", "zh"]) {
    const catalog = readCatalog(locale);
    assert.ok(catalog.app.hydrationFailed, locale + " needs an actionable startup recovery message");
    assert.ok(catalog.app.storageWarning, locale + " needs a local-storage recovery warning");
    assert.ok(catalog.navigation.urlUnavailable, locale + " needs a navigation fallback message");
  }
});

test("the loading shell selects one locale before app styles finish loading", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(html, /data-loading-locale="fa"(?![^>]*\bhidden)/u);
  for (const locale of ["en", "ru", "zh"])
    assert.match(html, new RegExp('data-loading-locale="' + locale + '" hidden', "u"));
  assert.match(html, /message\.hidden = !active/u);
  assert.match(html, /message\.setAttribute\("aria-hidden", "true"\)/u);
  assert.match(styles, /\.app-loading\[hidden\]/u);
  assert.match(styles, /data-loading-locale\]:not\(\[hidden\]\)/u);
});
