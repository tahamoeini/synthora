// Client configuration contains only a proxy placeholder; the project token is a Cloudflare Pages Secret.
globalThis.__SYNTHORA_POSTHOG_CONFIG__ = Object.freeze({
  projectToken: "__POSTHOG_PROJECT_TOKEN__",
  apiHost: new URL("/api/posthog", location.origin).toString()
});
