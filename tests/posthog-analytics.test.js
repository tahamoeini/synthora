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

  return { options: window.posthog._i[0][1], analytics: window.__APP_ANALYTICS__, posthog: window.posthog };
}

test("analytics keeps anonymous events personless while scrubbing user properties", () => {
  const { options } = loadPosthogOptions();
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

test("workflow hooks reject arbitrary labels and never forward sensitive properties", () => {
  const { options, analytics, posthog } = loadPosthogOptions();
  const captured = [];
  posthog.capture = (name, props) => captured.push({ name, props });
  analytics.trackWorkflow("market-data", "started");
  analytics.trackWorkflow("market-data", "completed");
  analytics.trackIssue("network");
  analytics.trackTiming("forecast", 810);
  analytics.trackWorkflow("my-private-portfolio-balance", "started");
  analytics.trackIssue("api-key-exposed");
  analytics.trackTiming("portfolio", Number.POSITIVE_INFINITY);
  assert.equal(captured.length, 4);
  const clean = captured.map(({ name, props }) =>
    options.before_send({ event: name, properties: { ...props, distinct_id: "session", amount: 250000, prompt: "secret", email: "private@example.invalid", $current_url: "https://example.test/?token=secret" } })
  );
  assert.deepEqual(clean.map(event => event.event), ["workflow_step", "workflow_step", "client_issue", "workflow_timing"]);
  for (const event of clean) {
    assert.equal(event.properties.app_name, "Synthora");
    assert.equal(event.properties.$process_person_profile, false);
    for (const key of ["amount", "prompt", "email", "$current_url"]) {
      assert.equal(event.properties[key], undefined);
    }
  }
  assert.equal(clean[3].properties.duration_band, "500_1999ms");
});
test("SDK sanitizer rejects unknown events and invalid workflow values", () => {
  const { options } = loadPosthogOptions();
  assert.equal(options.before_send({ event: "private_document", properties: { name: "secret" } }), null);
  assert.equal(options.before_send({ event: "workflow_step", properties: { step_id: "market-data", outcome: "out_of_scope" } }), null);
  assert.equal(options.before_send({ event: "client_issue", properties: { issue_kind: "raw error message" } }), null);
  assert.equal(options.disable_session_recording, true);
  assert.equal(options.autocapture, false);
  assert.equal(options.capture_exceptions, false);
});
