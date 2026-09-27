import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const runtimeRoots = ["src", "functions/api"];
const runtimeFiles = ["app.js"];

function collectJavaScript(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectJavaScript(path);
    else if (/\.m?js$/.test(entry.name)) runtimeFiles.push(path);
  }
}

for (const root of runtimeRoots) collectJavaScript(root);
runtimeFiles.push("scripts/check-syntax.js");

for (const file of runtimeFiles) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
