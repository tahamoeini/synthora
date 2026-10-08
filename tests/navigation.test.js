import test from "node:test";
import assert from "node:assert/strict";
import { createNavigationController, viewFromRoute } from "../src/ui/navigation.js";

test("navigation resolves deep links and legacy section links", () => {
  assert.equal(viewFromRoute("#portfolio"), "portfolio");
  assert.equal(viewFromRoute("#/saved-plans"), "history");
  assert.equal(viewFromRoute("?view=markets"), "assets");
  assert.equal(viewFromRoute("#analysis"), "simulation");
  assert.equal(viewFromRoute("#unknown"), "dashboard");
  assert.equal(viewFromRoute("#%E0%A4%A"), "dashboard");
});

test("section changes add history entries and Back restores the prior section and scroll position", () => {
  const listeners = {};
  const classList = { toggle() {} };
  const button = {
    dataset: { navView: "dashboard" },
    classList,
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
  };
  const view = { dataset: { appView: "dashboard" }, classList, setAttribute() {} };
  const shell = {
    root: { classList },
    sidebar: {},
    navigation: { items: [button], title: { textContent: "" } },
    pageContainer: { views: [view] },
  };
  const state = { activeView: "dashboard", sidebarCollapsed: false, mobileNavOpen: false };
  const store = {
    getState: () => state,
    setState: (patch) => Object.assign(state, typeof patch === "function" ? patch(state) : patch),
    subscribe: (listener) => listener(state),
  };
  const historyEntries = [];
  const windowRef = {
    location: { hash: "", search: "", href: "https://example.test/" },
    history: {
      state: null,
      scrollRestoration: "auto",
      replaceState(nextState, _title, url) {
        this.state = nextState;
        if (url) windowRef.location.href = url;
      },
      pushState(nextState, _title, url) {
        historyEntries.push(nextState);
        this.state = nextState;
        windowRef.location.hash = url;
        windowRef.location.href = `https://example.test/${url}`;
      },
    },
    scrollY: 240,
    scrollX: 0,
    scrollTo(position) {
      this.restoredPosition = position;
    },
    requestAnimationFrame(callback) {
      callback();
    },
    addEventListener(name, callback) {
      listeners[name] = callback;
    },
  };

  const controller = createNavigationController(shell, store, windowRef);
  controller.goTo("portfolio");
  assert.equal(windowRef.location.hash, "#portfolio");
  assert.equal(state.activeView, "portfolio");
  assert.equal(historyEntries.length, 1);

  windowRef.location.hash = "#dashboard";
  listeners.popstate({ state: { synthoraView: "dashboard", scrollX: 0, scrollY: 240 } });
  assert.equal(state.activeView, "dashboard");
  assert.equal(windowRef.restoredPosition.top, 240);
});
