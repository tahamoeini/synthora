import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const analyticsSource = readFileSync(new URL("../posthog-analytics.js", import.meta.url), "utf8");

function loadPosthogOptions() {
  const location = {
    protocol: "https:",
    hostname: "synthora.test",
    origin: "https://synthora.test",
  };
  const window = { location, addEventListener() {} };
  const document = {
    createElement() {
      return {};
    },
    getElementsByTagName() {
      return [];
    },
    head: {
      appendChild() {},
    },
  };
  const context = vm.createContext({
    URL,
    document,
    location,
    window,
    __SYNTHORA_POSTHOG_CONFIG__: { projectToken: "__POSTHOG_PROJECT_TOKEN__" },
  });

  vm.runInContext(analyticsSource, context, { filename: "posthog-analytics.js" });

  return window.posthog._i[0][1];
}

test("analytics keeps anonymous events personless while scrubbing user properties", () => {
  const options = loadPosthogOptions();
  const event = {
    event: "product_opened",
    distinct_id: "test-session-id",
    properties: {
      token: "__POSTHOG_PROJECT_TOKEN__",
      distinct_id: "test-session-id",
      $process_person_profile: false,
      email: "sensitive@example.invalid",
      app_name: "untrusted-value",
    },
    $current_url: "https://synthora.test/?q=sensitive",
  };

  const cleanEvent = options.before_send(event);

  assert.equal(options.person_profiles, "never");
  assert.equal(cleanEvent.properties.$process_person_profile, false);
  assert.equal(cleanEvent.properties.app_name, "Synthora");
  assert.equal(cleanEvent.properties.email, undefined);
  assert.equal(cleanEvent.$current_url, undefined);
});
