// @ts-check

import { NAVIGATION_ITEMS } from "./components.js";

const VIEW_IDS = new Set(NAVIGATION_ITEMS.map((item) => item.id));
const LEGACY_ROUTES = Object.freeze({
  home: "dashboard",
  overview: "dashboard",
  "my-portfolio": "portfolio",
  holdings: "portfolio",
  planning: "plan",
  "saved-plans": "history",
  "plan-history": "history",
  analysis: "simulation",
  markets: "assets",
  market: "assets",
});

export function viewFromRoute(value) {
  const raw = String(value || "").trim();
  if (raw.startsWith("?")) {
    const queryView = new URLSearchParams(raw.slice(1)).get("view");
    if (queryView) return viewFromRoute(queryView);
  }
  const fragment = raw.includes("#") ? raw.slice(raw.lastIndexOf("#") + 1) : raw;
  if (fragment.startsWith("?")) {
    const queryView = new URLSearchParams(fragment.slice(1)).get("view");
    if (queryView) return viewFromRoute(queryView);
  }
  const normalized = fragment.replace(/^\/+|\/+$/gu, "").replace(/^view=/u, "");
  let route = normalized.split(/[?&]/u)[0] || "";
  try {
    route = decodeURIComponent(route).toLowerCase();
  } catch {
    return "dashboard";
  }
  const view = LEGACY_ROUTES[route] || route;
  return VIEW_IDS.has(view) ? view : "dashboard";
}

function viewFromLocation(windowRef) {
  const hash = windowRef?.location?.hash;
  if (hash) return viewFromRoute(hash);
  const query = windowRef?.location?.search;
  if (query) {
    const legacy = new URLSearchParams(query).get("view");
    if (legacy) return viewFromRoute(legacy);
  }
  return "dashboard";
}

export function createNavigationController(shell, store, windowRef = globalThis.window) {
  const { root, sidebar, navigation, pageContainer } = shell;

  function apply(state) {
    if (!root) return;
    root.classList.toggle("is-sidebar-collapsed", state.sidebarCollapsed);
    root.classList.toggle("is-mobile-nav-open", state.mobileNavOpen);
    navigation.items.forEach((item) => {
      const active = item.dataset.navView === state.activeView;
      item.classList.toggle("is-active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    pageContainer.views.forEach((view) => {
      view.classList.toggle("is-active", view.dataset.appView === state.activeView);
      view.setAttribute("aria-hidden", view.dataset.appView === state.activeView ? "false" : "true");
    });
    const activeItem = NAVIGATION_ITEMS.find((item) => item.id === state.activeView);
    const activeButton = navigation.items.find((item) => item.dataset.navView === state.activeView);
    const localizedLabel = activeButton?.querySelector?.(".nav-copy strong")?.textContent || activeButton?.textContent?.trim();
    if (navigation.title && activeItem) navigation.title.textContent = localizedLabel || activeItem.label;
    if (sidebar.overlay) sidebar.overlay.setAttribute("aria-hidden", state.mobileNavOpen ? "false" : "true");
    if (sidebar.toggle) sidebar.toggle.setAttribute("aria-expanded", state.sidebarCollapsed ? "false" : "true");
    if (sidebar.mobileToggle)
      sidebar.mobileToggle.setAttribute("aria-expanded", state.mobileNavOpen ? "true" : "false");
  }

  function saveCurrentScroll() {
    if (!windowRef?.history?.replaceState || !windowRef.location) return;
    const previous = windowRef.history.state && typeof windowRef.history.state === "object" ? windowRef.history.state : {};
    windowRef.history.replaceState(
      { ...previous, synthoraView: store.getState().activeView, scrollX: windowRef.scrollX || 0, scrollY: windowRef.scrollY || 0 },
      "",
      windowRef.location.href,
    );
  }

  function goTo(viewId) {
    if (!VIEW_IDS.has(viewId)) return;
    const current = store.getState().activeView;
    if (viewId !== current && windowRef?.history?.pushState && windowRef.location) {
      saveCurrentScroll();
      windowRef.history.pushState({ synthoraView: viewId, scrollX: 0, scrollY: 0 }, "", `#${viewId}`);
      windowRef.scrollTo?.({ left: 0, top: 0, behavior: "instant" });
    }
    store.setState({ activeView: viewId, mobileNavOpen: false });
  }

  function restoreFromHistory(event) {
    const activeView = viewFromLocation(windowRef);
    store.setState({ activeView, mobileNavOpen: false });
    const state = event?.state;
    if (Number.isFinite(Number(state?.scrollY))) {
      const scrollX = Number(state.scrollX) || 0;
      const scrollY = Number(state.scrollY) || 0;
      windowRef.requestAnimationFrame?.(() => windowRef.scrollTo?.({ left: scrollX, top: scrollY, behavior: "instant" }));
    }
  }

  if (windowRef?.history && "scrollRestoration" in windowRef.history) windowRef.history.scrollRestoration = "manual";
  if (windowRef?.location && windowRef.history?.replaceState) {
    const initialView = viewFromLocation(windowRef);
    if (!windowRef.location.hash && initialView === "dashboard") {
      const query = windowRef.location.search;
      if (query && new URLSearchParams(query).has("view")) windowRef.history.replaceState({ synthoraView: initialView, scrollX: 0, scrollY: 0 }, "", `#${initialView}`);
    }
    store.setState({ activeView: initialView });
    if (!windowRef.history.state?.synthoraView)
      windowRef.history.replaceState({ ...(windowRef.history.state || {}), synthoraView: initialView, scrollX: 0, scrollY: windowRef.scrollY || 0 }, "", windowRef.location.href);
  }

  navigation.items.forEach((item) => item.addEventListener("click", () => goTo(item.dataset.navView)));
  sidebar.toggle?.addEventListener("click", () =>
    store.setState((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  );
  sidebar.mobileToggle?.addEventListener("click", () =>
    store.setState((state) => ({ mobileNavOpen: !state.mobileNavOpen })),
  );
  sidebar.overlay?.addEventListener("click", () => store.setState({ mobileNavOpen: false }));
  windowRef?.addEventListener?.("popstate", restoreFromHistory);
  windowRef?.addEventListener?.("hashchange", restoreFromHistory);

  store.subscribe(apply);
  return { goTo, apply, viewFromRoute };
}
