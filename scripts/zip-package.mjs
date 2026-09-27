import { execFileSync } from "node:child_process";
import { lstat, readFile, rm } from "node:fs/promises";
import assert from "node:assert/strict";
// Orca installs this zip as-is (it runs no build), so it holds the manifest and exactly the
// built files the manifest references, at the top level.
const dist = new URL("../dist/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("orca-plugin.json", dist), "utf8"));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(manifest.version, pkg.version, "package.json and PLUGIN_VERSION must match");
const files = [
  "orca-plugin.json",
  manifest.main,
  ...manifest.contributes.panels.map((panel) => panel.entry),
];
for (const file of files) {
  assert.ok((await lstat(new URL(file, dist))).isFile(), `${file} must be a regular file`);
}
const name = `${manifest.publisher}.${manifest.id}-${manifest.version}.zip`;
await rm(new URL(name, dist), { force: true });
execFileSync("zip", ["-X", "-q", name, ...files], { cwd: dist, stdio: "inherit" });
console.log(`Plugin zip: dist/${name}`);
