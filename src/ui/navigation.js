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

function routeHref(location, viewId) {
  const search = new URLSearchParams(location?.search || "");
  search.delete("view");
  const query = search.toString();
  const pathname = location?.pathname || "/";
  return pathname + (query ? "?" + query : "") + "#" + viewId;
}

function isCanonicalLocation(location, viewId) {
  if (!location || location.hash !== "#" + viewId) return false;
  return !new URLSearchParams(location.search || "").has("view");
}

function stateForRoute(windowRef, viewId, scrollX, scrollY) {
  const previous =
    windowRef?.history?.state && typeof windowRef.history.state === "object" ? windowRef.history.state : {};
  return {
    ...previous,
    synthoraView: viewId,
    scrollX: Number(scrollX) || 0,
    scrollY: Number(scrollY) || 0,
  };
}

function safeScrollTo(windowRef, scrollX, scrollY) {
  try {
    windowRef?.scrollTo?.({ left: Number(scrollX) || 0, top: Number(scrollY) || 0, behavior: "instant" });
  } catch {
    try {
      windowRef?.scrollTo?.(Number(scrollX) || 0, Number(scrollY) || 0);
    } catch {
      // The section change remains useful when this browser cannot scroll programmatically.
    }
  }
}

export function createNavigationController(
  shell,
  store,
  windowRef = globalThis.window,
  { onUrlUpdateFailure = () => {} } = {},
) {
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
      const active = view.dataset.appView === state.activeView;
      view.classList.toggle("is-active", active);
      view.setAttribute("aria-hidden", active ? "false" : "true");
    });
    const activeItem = NAVIGATION_ITEMS.find((item) => item.id === state.activeView);
    const activeButton = navigation.items.find((item) => item.dataset.navView === state.activeView);
    const localizedLabel =
      activeButton?.querySelector?.(".nav-copy strong")?.textContent || activeButton?.textContent?.trim();
    if (navigation.title && activeItem) navigation.title.textContent = localizedLabel || activeItem.label;
    if (sidebar.overlay) sidebar.overlay.setAttribute("aria-hidden", state.mobileNavOpen ? "false" : "true");
    if (sidebar.toggle) sidebar.toggle.setAttribute("aria-expanded", state.sidebarCollapsed ? "false" : "true");
    if (sidebar.mobileToggle)
      sidebar.mobileToggle.setAttribute("aria-expanded", state.mobileNavOpen ? "true" : "false");
  }

  function reportUrlUpdateFailure() {
    try {
      onUrlUpdateFailure();
    } catch {
      // Reporting a browser limitation must not prevent the requested view from opening.
    }
  }

  function updateRouteUrl(viewId, { replace = false, scrollX, scrollY } = {}) {
    const location = windowRef?.location;
    if (!location) return false;
    const url = routeHref(location, viewId);
    const state = stateForRoute(windowRef, viewId, scrollX ?? windowRef.scrollX, scrollY ?? windowRef.scrollY);
    const method = replace ? "replaceState" : "pushState";

    try {
      const history = windowRef.history;
      if (typeof history?.[method] === "function") {
        history[method](state, "", url);
        if (isCanonicalLocation(location, viewId)) return true;
      }
    } catch {
      // Try the browser's built-in fragment navigation below.
    }

    if (replace && typeof location.replace === "function") {
      try {
        location.replace(url);
        return true;
      } catch {
        // Fall through to a same-page hash update.
      }
    }

    try {
      location.hash = "#" + viewId;
      return location.hash === "#" + viewId;
    } catch {
      return false;
    }
  }

  function saveCurrentScroll() {
    const history = windowRef?.history;
    const location = windowRef?.location;
    if (typeof history?.replaceState !== "function" || !location) return;
    try {
      history.replaceState(
        stateForRoute(windowRef, store.getState().activeView, windowRef.scrollX, windowRef.scrollY),
        "",
        location.href,
      );
    } catch {
      // Browser history is optional; navigation still changes the visible section.
    }
  }

  function goTo(viewId) {
    if (!VIEW_IDS.has(viewId)) return false;
    const current = store.getState().activeView;
    const changed = viewId !== current;
    const canonical = isCanonicalLocation(windowRef?.location, viewId);
    const routeAlreadyMatches = canonical && viewFromLocation(windowRef) === viewId;

    if (changed && !routeAlreadyMatches) saveCurrentScroll();
    if (!routeAlreadyMatches) {
      const updated = updateRouteUrl(viewId, {
        replace: !changed || canonical,
        scrollX: changed ? 0 : windowRef?.scrollX,
        scrollY: changed ? 0 : windowRef?.scrollY,
      });
      if (!updated) reportUrlUpdateFailure();
    }
    store.setState({ activeView: viewId, mobileNavOpen: false });
    if (changed) safeScrollTo(windowRef, 0, 0);
    return true;
  }

  function restoreFromHistory(event) {
    const activeView = viewFromLocation(windowRef);
    store.setState({ activeView, mobileNavOpen: false });
    const state = event?.state ?? windowRef?.history?.state;
    if (Number.isFinite(Number(state?.scrollY)))
      windowRef.requestAnimationFrame?.(() => safeScrollTo(windowRef, state.scrollX, state.scrollY));
  }

  try {
    const history = windowRef?.history;
    if (history && "scrollRestoration" in history) history.scrollRestoration = "manual";
  } catch {
    // Browser-managed restoration remains available when this setting is blocked.
  }

  const initialView = viewFromLocation(windowRef);
  store.setState({ activeView: initialView });
  const location = windowRef?.location;
  if (location) {
    const hasLegacyQuery = new URLSearchParams(location.search || "").has("view");
    const hasNoncanonicalHash = Boolean(location.hash) && location.hash !== "#" + initialView;
    if (hasLegacyQuery || hasNoncanonicalHash) {
      const updated = updateRouteUrl(initialView, {
        replace: true,
        scrollX: windowRef.scrollX,
        scrollY: windowRef.scrollY,
      });
      if (!updated) reportUrlUpdateFailure();
    } else if (
      typeof windowRef.history?.replaceState === "function" &&
      windowRef.history.state?.synthoraView !== initialView
    ) {
      try {
        windowRef.history.replaceState(
          stateForRoute(windowRef, initialView, windowRef.scrollX, windowRef.scrollY),
          "",
          location.href,
        );
      } catch {
        // The current route is already canonical, so no fallback navigation is needed.
      }
    }
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
