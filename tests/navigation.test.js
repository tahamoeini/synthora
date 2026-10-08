import test from "node:test";
import assert from "node:assert/strict";
import { createNavigationController, viewFromRoute } from "../src/ui/navigation.js";
import { NAVIGATION_ITEMS } from "../src/ui/components.js";

function createClassList() {
  const names = new Set();
  return {
    toggle(name, force) {
      if (force) names.add(name);
      else names.delete(name);
    },
    contains(name) {
      return names.has(name);
    },
  };
}

function createHarness(initialUrl = "https://example.test/", options = {}) {
  const entries = [{ url: new URL(initialUrl).href, state: null }];
  let index = 0;
  let currentUrl = new URL(entries[index].url);
  const listeners = new Map();
  const root = { classList: createClassList() };
  const items = NAVIGATION_ITEMS.map((entry) => ({
    dataset: { navView: entry.id },
    classList: createClassList(),
    attributes: {},
    handlers: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    addEventListener(name, handler) {
      this.handlers[name] = handler;
    },
    click() {
      this.handlers.click?.();
    },
  }));
  const views = NAVIGATION_ITEMS.map((entry) => ({
    dataset: { appView: entry.id },
    classList: createClassList(),
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  }));
  const title = { textContent: "" };

  const location = {
    get href() {
      return currentUrl.href;
    },
    get pathname() {
      return currentUrl.pathname;
    },
    get search() {
      return currentUrl.search;
    },
    get hash() {
      return currentUrl.hash;
    },
    set hash(value) {
      if (options.throwHash) throw new Error("hash assignment blocked");
      const nextUrl = new URL(currentUrl.href);
      nextUrl.hash = value;
      currentUrl = nextUrl;
      entries.splice(index + 1);
      entries.push({ url: currentUrl.href, state: history.state });
      index = entries.length - 1;
      listeners.get("hashchange")?.({ newURL: currentUrl.href });
    },
    replace(value) {
      currentUrl = new URL(value, currentUrl);
      entries[index] = { url: currentUrl.href, state: history.state };
    },
  };

  const history = {
    scrollRestoration: "auto",
    get state() {
      return entries[index].state;
    },
    replaceState(nextState, _title, url) {
      if (options.throwReplace) throw new Error("replaceState blocked");
      currentUrl = new URL(url, currentUrl);
      entries[index] = { url: currentUrl.href, state: nextState };
    },
    pushState(nextState, _title, url) {
      if (options.throwPush) throw new Error("pushState blocked");
      currentUrl = new URL(url, currentUrl);
      entries.splice(index + 1);
      entries.push({ url: currentUrl.href, state: nextState });
      index = entries.length - 1;
    },
    back() {
      if (index === 0) return;
      const oldUrl = currentUrl.href;
      index -= 1;
      currentUrl = new URL(entries[index].url);
      listeners.get("popstate")?.({ state: entries[index].state });
      if (oldUrl !== currentUrl.href) listeners.get("hashchange")?.({ oldURL: oldUrl, newURL: currentUrl.href });
    },
    forward() {
      if (index >= entries.length - 1) return;
      const oldUrl = currentUrl.href;
      index += 1;
      currentUrl = new URL(entries[index].url);
      listeners.get("popstate")?.({ state: entries[index].state });
      if (oldUrl !== currentUrl.href) listeners.get("hashchange")?.({ oldURL: oldUrl, newURL: currentUrl.href });
    },
  };

  const windowRef = {
    location,
    history,
    scrollX: 0,
    scrollY: 0,
    restoredPositions: [],
    scrollTo(positionOrX, y) {
      const position = typeof positionOrX === "object" ? positionOrX : { left: positionOrX, top: y };
      this.scrollX = Number(position.left) || 0;
      this.scrollY = Number(position.top) || 0;
      this.restoredPositions.push({ left: this.scrollX, top: this.scrollY });
    },
    requestAnimationFrame(callback) {
      callback();
    },
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
  };
  const state = { activeView: "dashboard", sidebarCollapsed: false, mobileNavOpen: false };
  const subscribers = new Set();
  const store = {
    getState() {
      return state;
    },
    setState(patch) {
      Object.assign(state, typeof patch === "function" ? patch(state) : patch);
      subscribers.forEach((listener) => listener(state));
      return state;
    },
    subscribe(listener) {
      subscribers.add(listener);
      listener(state);
      return () => subscribers.delete(listener);
    },
  };
  const shell = {
    root,
    sidebar: {},
    navigation: { items, title },
    pageContainer: { views },
  };
  const warnings = [];
  const controller = createNavigationController(shell, store, windowRef, {
    onUrlUpdateFailure: () => warnings.push("url-update-failed"),
  });

  return {
    controller,
    entries,
    history,
    items,
    location,
    state,
    title,
    views,
    warnings,
    windowRef,
  };
}

test("route parser accepts canonical, legacy, and unknown routes", () => {
  assert.equal(viewFromRoute("#portfolio"), "portfolio");
  assert.equal(viewFromRoute("#/saved-plans"), "history");
  assert.equal(viewFromRoute("?view=markets"), "assets");
  assert.equal(viewFromRoute("#analysis"), "simulation");
  assert.equal(viewFromRoute("#unknown"), "dashboard");
  assert.equal(viewFromRoute("#%E0%A4%A"), "dashboard");
});

test("startup restores every valid view from a hash and applies the matching navigation state", () => {
  for (const { id } of NAVIGATION_ITEMS) {
    const harness = createHarness("https://example.test/#" + id);
    assert.equal(harness.state.activeView, id, id + " is restored on startup");
    assert.equal(harness.title.textContent, NAVIGATION_ITEMS.find((item) => item.id === id).label);
    assert.equal(harness.items.find((item) => item.dataset.navView === id).attributes["aria-current"], "page");
    assert.equal(
      harness.views.find((view) => view.dataset.appView === id).attributes["aria-hidden"],
      "false",
      id + " view is exposed",
    );
  }
});

test("portfolio hash and legacy query routes restore and canonicalize to the portfolio hash", () => {
  const hashRoute = createHarness("https://example.test/#portfolio");
  assert.equal(hashRoute.state.activeView, "portfolio");
  assert.equal(hashRoute.location.hash, "#portfolio");

  for (const query of ["?view=portfolio", "?view=holdings", "?view=my-portfolio"]) {
    const queryRoute = createHarness("https://example.test/" + query);
    assert.equal(queryRoute.state.activeView, "portfolio");
    assert.equal(queryRoute.location.pathname, "/");
    assert.equal(queryRoute.location.search, "");
    assert.equal(queryRoute.location.hash, "#portfolio");
    assert.equal(queryRoute.entries.length, 1, "canonicalization replaces the legacy entry");
  }
});

test("unknown hashes fall back to Dashboard and replace the unknown route", () => {
  const harness = createHarness("https://example.test/#unknown");
  assert.equal(harness.state.activeView, "dashboard");
  assert.equal(harness.location.hash, "#dashboard");
});

test("navigation updates the URL, saves scroll, and Back and Forward restore matching views", () => {
  const harness = createHarness("https://example.test/#dashboard");
  harness.windowRef.scrollY = 240;
  assert.equal(harness.controller.goTo("portfolio"), true);
  assert.equal(harness.location.hash, "#portfolio");
  assert.equal(harness.state.activeView, "portfolio");
  assert.equal(harness.entries[0].state.scrollY, 240);
  assert.equal(harness.windowRef.scrollY, 0);

  harness.history.back();
  assert.equal(harness.location.hash, "#dashboard");
  assert.equal(harness.state.activeView, "dashboard");
  assert.equal(harness.windowRef.scrollY, 240);

  harness.history.forward();
  assert.equal(harness.location.hash, "#portfolio");
  assert.equal(harness.state.activeView, "portfolio");
  assert.equal(harness.windowRef.scrollY, 0);

  harness.items.find((item) => item.dataset.navView === "plan").click();
  assert.equal(harness.location.hash, "#plan");
  assert.equal(harness.state.activeView, "plan");
});

test("browser hash navigation keeps the visible section working when pushState throws", () => {
  const harness = createHarness("https://example.test/#dashboard", { throwPush: true });
  harness.items.find((item) => item.dataset.navView === "portfolio").click();
  assert.equal(harness.location.hash, "#portfolio");
  assert.equal(harness.state.activeView, "portfolio");
  assert.deepEqual(harness.warnings, []);
});

test("view changes still work and announce a warning when every URL update path fails", () => {
  const harness = createHarness("https://example.test/#dashboard", {
    throwPush: true,
    throwReplace: true,
    throwHash: true,
  });
  harness.items.find((item) => item.dataset.navView === "portfolio").click();
  assert.equal(harness.state.activeView, "portfolio");
  assert.equal(harness.views.find((view) => view.dataset.appView === "portfolio").attributes["aria-hidden"], "false");
  assert.deepEqual(harness.warnings, ["url-update-failed"]);
});
