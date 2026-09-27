import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LOCALES } from "../src/ui/preferences.js";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

function declarations(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "gu");
  const match = [...css.matchAll(expression)].find((candidate) => candidate[1].includes("--bg")) || css.match(expression);
  assert.ok(match, `missing CSS selector ${selector}`);
  return Object.fromEntries([...match[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)].map((entry) => [entry[1], entry[2].trim()]));
}

function relativeLuminance(color) {
  const rgb = color.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu)?.slice(1);
  assert.ok(rgb, `expected a six-digit color, got ${color}`);
  const channels = rgb.map((channel) => Number.parseInt(channel, 16) / 255);
  const linear = channels.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test("light theme color tokens match the pre-RTL palette", () => {
  const light = declarations(":root");
  const original = {
    "--bg": "#f5f8f7",
    "--surface": "rgba(255, 255, 255, 0.94)",
    "--surface-muted": "#f9fbfc",
    "--ink": "#102331",
    "--muted": "#667785",
    "--line": "#e1e9e9",
    "--primary": "#126b62",
    "--primary-dark": "#0d514b",
    "--primary-soft": "#e3f2ee",
    "--gold": "#c18a2c",
    "--blue": "#4979a7",
    "--silver": "#8997a0",
    "--danger": "#a04a45",
    "--shadow": "0 18px 48px rgba(21, 48, 61, 0.07)",
  };
  for (const [token, value] of Object.entries(original)) assert.equal(light[token], value, token);
});

test("dark theme text and status colors meet AA contrast on dark surfaces", () => {
  const dark = declarations('[data-theme="dark"]');
  const backgrounds = [dark["--bg"], dark["--surface"]];
  const foregrounds = [
    dark["--ink"],
    dark["--muted"],
    dark["--primary"],
    dark["--primary-dark"],
    dark["--gold"],
    dark["--blue"],
    dark["--silver"],
    dark["--danger"],
  ];
  for (const foreground of foregrounds) {
    for (const background of backgrounds)
      assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background} is below WCAG AA`);
  }
});

test("directional layout uses logical edges and bidi-safe field handling", () => {
  assert.equal(LOCALES.fa.direction, "rtl");
  for (const locale of ["en", "ru", "zh"]) assert.equal(LOCALES[locale].direction, "ltr");
  assert.doesNotMatch(css, /\b(?:margin|padding|border|inset)-(?:left|right)\s*:/u);
  assert.doesNotMatch(css, /text-align\s*:\s*(?:left|right)\s*;/u);
  assert.match(css, /input\[type="number"\][\s\S]*?direction:\s*ltr;/u);
  assert.match(css, /input\[type="datetime-local"\][\s\S]*?direction:\s*ltr;/u);
  assert.match(css, /html\[dir="ltr"\] \.primary-button b/u);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*?html\[dir="ltr"\] \.app-sidebar/u);
  assert.match(css, /\.app-shell\.is-sidebar-collapsed \.sidebar-toggle/u);
  assert.match(css, /input\[type="number"\][\s\S]*?text-align:\s*end;/u);
  assert.match(css, /#provider-api-key\s*\{\s*direction:\s*ltr;/u);
  assert.match(css, /button,\s*input,\s*select\s*\{\s*font:\s*inherit;\s*font-size:\s*0\.875rem;/u);
  assert.match(app, /\[data-user-content\]/u);
  assert.doesNotMatch(css, /font-size\s*:\s*small\s*;/u);
});
