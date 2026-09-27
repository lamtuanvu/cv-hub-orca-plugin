import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import assert from "node:assert/strict";
const root = new URL("../dist/", import.meta.url);
const html = await readFile(new URL("panel.html", root), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 1, "Package must contain one complete inline panel script");
new Script(scripts[0][1]);
const { default: activate } = await import(new URL("main.mjs", root));
const commands = new Map();
activate({
  commands: {
    register(id, handler) {
      commands.set(id, handler);
    },
  },
  host: { call: async () => ({ value: null }) },
});
const manifest = JSON.parse(await readFile(new URL("orca-plugin.json", root), "utf8"));
assert.deepEqual(
  [...commands.keys()].sort(),
  manifest.contributes.commands.map((c) => c.id).sort(),
);
assert.deepEqual(await commands.get("cvhub.authStatus")(), {
  connection: null,
  legacy: null,
  attempt: null,
});
// The hardened Orca host rejects panel dispatch of anything without a contract; make sure the
// review loaders stay private and the provider points at them.
const byId = new Map(manifest.contributes.commands.map((c) => [c.id, c]));
for (const provider of manifest.contributes.reviewProviders ?? []) {
  for (const id of [provider.snapshotCommand, provider.contentCommand]) {
    assert.ok(byId.has(id), `${id} is declared`);
    assert.equal(byId.get(id).panel, undefined, `${id} must not be panel-callable`);
  }
}
assert.ok(manifest.capabilities.some((c) => c.kind === "browser:open-external"), "PR links require browser:open-external");
assert.equal(manifest.contributes.panels[0].icon, "cv-hub");
// The committed marketplace index must list this exact build under its release tag.
const marketplace = JSON.parse(await readFile(new URL("../orca-marketplace.json", root), "utf8"));
assert.deepEqual(
  marketplace.plugins.map((p) => [p.id, p.source.kind, p.source.ref]),
  [[`${manifest.publisher}.${manifest.id}`, "git", `plugin-v${manifest.version}`]],
);
console.log("Packaged worker activation, manifest contracts and inline panel syntax passed");
