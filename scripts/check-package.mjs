import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { loadOrcaManifestSchema } from "./orca-schema.mjs";

const dist = new URL("../dist/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("orca-plugin.json", dist), "utf8"));

// 1. The generated manifest matches Orca's published format-2 schema, the same check
//    src/shared/manifest.test.ts runs against the in-memory manifest.
const schema = await loadOrcaManifestSchema();
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validate = ajv.compile(schema);
assert.ok(validate(manifest), `orca-plugin.json violates the schema: ${ajv.errorsText(validate.errors)}`);

// 2. Everything the manifest names exists, and dist/ holds nothing else (no stale panel.js;
//    the versioned zips this pipeline produces are packaging artifacts, not plugin files).
const present = new Set(await readdir(dist));
const expected = new Set(["orca-plugin.json", manifest.main, ...manifest.contributes.panels.map((panel) => panel.entry)]);
for (const file of expected) assert.ok(present.has(file), `dist/${file} is missing`);
for (const file of present)
  assert.ok(expected.has(file) || /^cv-hub-.*\.zip$/.test(file), `dist/${file} is not part of the plugin (stale file)`);
assert.equal(manifest.contributes.panels[0].ui, "html");
assert.equal(manifest.contributes.panels[0].icon, "code");

// 3. The worker activates against a stand-in host and registers exactly what the manifest
//    declares: the three commands, and the panel handlers the panel requests.
const DEFAULT_ORIGIN = "https://api.hub.controlvector.io";
const handlers = new Map();
const commands = new Map();
const posts = [];
const calls = [];
const orca = {
  api: { major: 1, minor: 10 },
  commands: { register: (id, handler) => (commands.set(id, handler), { dispose() {} }) },
  events: { on: () => ({ dispose() {} }) },
  host: {
    has: (method) => ["statusBar.update", "workspace.list", "notifications.show"].includes(method),
    call: async (method, params) => {
      calls.push({ method, params });
      return { ok: true };
    },
  },
  panels: {
    handle: (name, handler) => (handlers.set(name, handler), { dispose() {} }),
    post: (event, payload) => posts.push({ event, payload }),
  },
  storage: {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    keys: async () => [],
    onDidChange: () => ({ dispose() {} }),
  },
  secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
  settings: {
    get: async (key) => (key === "apiOrigin" ? DEFAULT_ORIGIN : undefined),
    set: async () => {},
    onDidChange: () => ({ dispose() {} }),
  },
  grantedCapabilities: [],
  log: () => {},
};
const { default: activate, deactivate } = await import(new URL("main.mjs", dist));
await activate(orca);
try {
  assert.deepEqual(
    [...commands.keys()].sort(),
    manifest.contributes.commands.map((c) => c.id).sort(),
    "the worker registers exactly the manifest's commands",
  );
  assert.deepEqual([...handlers.keys()].sort(), [
    "auth.cancel",
    "auth.signOut",
    "auth.start",
    "auth.status",
    "code.search",
    "context.current",
    "pull.checks",
    "pull.diff",
    "pull.get",
    "pull.reviews",
    "pulls.list",
    "repos.list",
    "review.submit",
  ]);
  assert.deepEqual(await handlers.get("auth.status")({}, {}), {
    connection: null,
    legacy: null,
    attempt: null,
    apiOrigin: DEFAULT_ORIGIN,
  });
  // The worker announced the signed-out state to any open panel and the status bar.
  assert.ok(posts.some((p) => p.event === "auth.changed" && p.payload.status.connection === null));
  assert.ok(calls.some((c) => c.method === "statusBar.update" && c.params.text === "CV Hub: sign in"));
  // A request the worker never declared must be refused by Orca, not answered here.
  assert.equal(handlers.get("cvhub.getReview"), undefined);
} finally {
  await deactivate(); // clears the status-bar timer so this script can exit
}
// 4. The built panel boots against a stand-in frame (a stub DOM and `window.orca`), and
//    the flows a person uses render: sign-in, the workspace repository, the pull request
//    detail, the in-panel Files diff and the external links.
const { smokePanel } = await import("./smoke-panel.mjs");
await smokePanel();
console.log("Packaged manifest schema, dist contents and worker activation passed");
