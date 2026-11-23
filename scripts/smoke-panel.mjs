/** Boots the built `dist/panel.html` against a stand-in DOM and a stand-in `window.orca`
 *  frame, then drives the flows a person actually uses: sign-in, the workspace repository,
 *  the pull-request list and detail, the in-panel Files diff and the external links. It
 *  catches what type-checking cannot: a render that throws, a state field read at the
 *  wrong time, a worker view the panel cannot draw. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ORIGIN = "https://api.hub.example.com";

/** Just enough DOM for the panel's builders: elements with attributes, listeners and
 *  children; no layout, so measurements and focus are no-ops. */
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.value = "";
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.parentElement = null;
    const classes = new Set();
    this.classList = {
      contains: (name) => classes.has(name),
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
    };
  }
  setAttribute(key, value) {
    this.attrs[key] = String(value);
    if (key === "id") this[key] ??= this.attrs[key];
  }
  getAttribute(key) {
    return this.attrs[key] ?? null;
  }
  addEventListener(type, handler) {
    (this.attrs[`on:${type}`] ??= []).push(handler);
  }
  /** Fires one event type the way a press would; `currentTarget` is the element. */
  press(type = "click", event = {}) {
    for (const handler of this.attrs[`on:${type}`] ?? [])
      handler({ preventDefault: () => {}, stopPropagation: () => {}, currentTarget: this, target: this, ...event });
  }
  appendChild(child) {
    this.children.push(child);
    child.parentElement = this;
    return child;
  }
  /** The DOM `append`: takes strings, nodes and arrays, skipping null. */
  append(...nodes) {
    const add = (node) => {
      if (node === null || node === undefined || node === false) return;
      if (Array.isArray(node)) {
        node.forEach(add);
        return;
      }
      if (typeof node === "string" || typeof node === "number") this.children.push({ text: String(node) });
      else this.appendChild(node);
    };
    nodes.forEach(add);
  }
  replaceChildren() {
    this.children.length = 0;
  }
  querySelectorAll() {
    return [];
  }
  querySelector() {
    return null;
  }
  focus() {}
  setSelectionRange() {}
}

const textOf = (node) =>
  node === null || node === undefined
    ? ""
    : typeof node.text === "string"
      ? node.text
      : Array.isArray(node.children)
        ? node.children.map(textOf).join("")
        : "";

/** Finds every clickable element whose full text includes `needle`, depth-first; only
 *  elements that actually carry a click listener match, never their inner spans. */
const clickablesWithText = (root, needle) => {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (Array.isArray(child.attrs?.["on:click"]) && textOf(child).includes(needle)) found.push(child);
        walk(child);
      }
    }
  };
  walk(root);
  return found;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Finds a radio input by its value property, depth-first (dom.ts sets `value` as a
 *  property, the way the real DOM does). */
const findRadio = (root, value) => {
  let found = null;
  const walk = (node) => {
    if (!Array.isArray(node.children)) return;
    for (const child of node.children) {
      if (child.tagName === "INPUT" && child.attrs.type === "radio" && child.value === value) found = child;
      walk(child);
    }
  };
  walk(root);
  return found;
};

/** The stand-in worker: the same `PluginRequests` the real one answers, with neutral
 *  fixture data, plus the pushes the real one posts. */
async function runPanel() {
  const html = await readFile(new URL("../dist/panel.html", import.meta.url), "utf8");
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];

  const app = new El("div");
  const view = new El("div");
  const announce = new El("div");
  app.attrs.id = "app";
  view.attrs.id = "view";
  announce.attrs.id = "announce";
  const byId = new Map([
    ["app", app],
    ["view", view],
    ["announce", announce],
  ]);

  const opened = [];
  const requests = [];
  let status = { connection: null, legacy: null, attempt: null, apiOrigin: ORIGIN };
  let attempt = null;
  let context = { repository: { owner: "acme", repo: "widgets" }, workspace: "matched" };
  const pulls = {
    "acme/widgets": [{ number: 7, title: "Add widget polish", state: "open", isDraft: false, author: "dev", updatedAt: "2026-11-01T10:00:00Z" }],
    "acme/gadgets": [{ number: 8, title: "Gadget dashboard", state: "open", isDraft: false, author: "dev", updatedAt: "2026-11-02T10:00:00Z" }],
  };
  const connection = {
    origin: ORIGIN,
    webOrigin: "https://hub.example.com",
    mcpUrl: "https://api.hub.example.com/mcp",
    username: "dev",
    userId: "u-1",
    displayName: "Dev User",
    canWrite: true,
    expired: false,
  };
  const handlers = {
    "auth.status": () => status,
    "auth.start": () => {
      attempt = {
        attemptId: "a-1",
        origin: ORIGIN,
        phase: "pending",
        userCode: "WDJB-MJHT",
        verificationUri: "https://hub.example.com/device",
        verified: true,
        expiresAt: Date.now() + 15 * 60_000,
        message: null,
      };
      status = { ...status, attempt };
      return attempt;
    },
    "auth.cancel": () => {
      attempt = null;
      status = { ...status, attempt: null };
      return status;
    },
    "auth.signOut": () => ({ signedOut: true, revoked: true }),
    "repos.list": () => ({ repositories: [{ owner: "acme", repo: "widgets" }], total: 1 }),
    "pulls.list": ({ owner, repo }) => ({ pulls: pulls[`${owner}/${repo}`], total: pulls[`${owner}/${repo}`].length }),
    "pull.get": () => ({
      number: 7,
      title: "Add widget polish",
      state: "open",
      isDraft: false,
      author: "dev",
      body: "Polishes the widgets.",
      sourceBranch: "feat/polish",
      targetBranch: "main",
      sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      createdAt: "2026-10-30T09:00:00Z",
      updatedAt: "2026-11-01T10:00:00Z",
      canWrite: true,
      gate: null,
    }),
    "pull.checks": () => ({ checks: [{ name: "build", status: "completed", conclusion: "success", durationMs: 42000 }], total: 1 }),
    "pull.reviews": () => ({ reviews: [], total: 0 }),
    "pull.diff": () => ({
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      totalFiles: 1,
      filesTruncated: false,
      files: [
        {
          path: "src/app.ts",
          oldPath: null,
          status: "modified",
          additions: 2,
          deletions: 1,
          binary: false,
          truncated: false,
          patch: "@@ -1,2 +1,3 @@\n line one\n-old two\n+new two\n+new three\n",
        },
      ],
    }),
    "code.search": () => ({ results: [] }),
    "context.current": () => context,
    "review.submit": () => ({ id: "r-1", state: "approved" }),
  };
  const listeners = { "auth.changed": [], "context.changed": [], theme: [] };
  const orca = {
    api: { major: 1, minor: 10 },
    locale: "en",
    host: { has: () => true, call: async () => ({}) },
    on: (event, handler) => (listeners[event].push(handler), { dispose() {} }),
    plugin: {
      request: (name, input) => {
        requests.push(name);
        const handler = handlers[name];
        if (!handler) return Promise.reject(new Error(`[unknown_method] ${name}`));
        return Promise.resolve(handler(input ?? {}));
      },
      on: (event, handler) => (listeners[event].push(handler), { dispose() {} }),
    },
    storage: { get: async () => null, set: async () => {}, delete: async () => {}, keys: async () => [] },
    settings: { get: async () => undefined },
    secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
    shell: { openExternal: async (url) => (opened.push(url), { opened: true }) },
  };
  const documentStub = {
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => new El(tag),
    createElementNS: (_ns, tag) => new El(tag),
    createTextNode: (text) => ({ text }),
    documentElement: new El("html"),
    visibilityState: "visible",
    addEventListener: () => {},
  };

  // The panel's countdown interval would keep this process alive; unref it.
  const realSetInterval = globalThis.setInterval;
  const run = new Function(
    "orca",
    "document",
    "window",
    "CSS",
    "ResizeObserver",
    "navigator",
    "getSelection",
    "setInterval",
    script,
  );
  run(
    orca,
    documentStub,
    { orca },
    { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, "") },
    class {
      observe() {}
    },
    {},
    () => null,
    (fn, ms) => {
      const handle = realSetInterval(fn, ms);
      handle.unref?.();
      return handle;
    },
  );

  const push = (event, payload) => {
    for (const handler of listeners[event]) handler(payload);
  };
  const text = () => textOf(view);
  return { view, text, push, opened, orca, requests: () => requests, status: () => status, connect: () => {
    // The worker finishes the attempt, then posts the status: the attempt view keeps
    // the `connected` phase (only cancel or sign-out clears it), exactly like
    // Connection.finish().
    attempt = { ...attempt, phase: "connected" };
    status = { connection, legacy: null, attempt, apiOrigin: ORIGIN };
    push("auth.changed", { status });
  } };
}

export async function smokePanel() {
  const panel = await runPanel();
  await tick();
  assert.match(panel.text(), /Sign in with CV Hub/, "the signed-out panel shows the sign-in button");
  assert.match(panel.text(), /Connect to CV Hub/, "the signed-out panel shows its heading");

  // Sign-in: the worker hands the panel the attempt view; the panel shows the code and
  // opens the (already validated) address from the button press.
  const signIn = clickablesWithText(panel.view, "Sign in with CV Hub").at(-1);
  assert.ok(signIn, "the sign-in button is rendered");
  signIn.press();
  await tick();
  assert.match(panel.text(), /WDJB-MJHT/, "the pending attempt shows the user code");
  const approve = clickablesWithText(panel.view, "Open CV Hub to approve").at(-1);
  assert.ok(approve, "the approve button is rendered for a verified address");
  approve.press();
  await tick();
  assert.deepEqual(panel.opened, ["https://hub.example.com/device"], "the approve press opened the verification page");

  // Approval lands as a push: the panel enters the workspace, follows the detected
  // repository and lists its pull requests.
  panel.connect();
  await tick();
  assert.match(panel.text(), /acme \/ widgets/, "the detected repository is selected");
  assert.match(panel.text(), /Add widget polish/, "the repository's pull requests are listed");
  assert.equal(panel.opened.length, 1, "no link opened behind the panel's back");

  // The pull request detail, then the Files tab and its in-panel diff.
  clickablesWithText(panel.view, "Add widget polish").at(-1).press();
  await tick();
  assert.match(panel.text(), /Add widget polish #7/, "the detail header shows the pull request");
  assert.match(panel.text(), /feat\/polish/, "the source branch is shown");
  assert.match(panel.text(), /main/, "the target branch is shown");
  const filesTab = clickablesWithText(panel.view, "Files").find((el) => el.attrs.role === "tab");
  assert.ok(filesTab, "the Files tab is rendered");
  filesTab.press();
  await tick();
  assert.match(panel.text(), /1 file changed/, "the diff summary is shown");
  assert.match(panel.text(), /@@ -1,2 \+1,3 @@/, "the hunk header is drawn");
  assert.match(panel.text(), /new two/, "an added line is drawn");
  assert.match(panel.text(), /old two/, "a removed line is drawn");
  const splitToggle = clickablesWithText(panel.view, "Split").at(-1);
  assert.ok(splitToggle, "the unified/split toggle is rendered");
  splitToggle.press();
  await tick();
  assert.match(panel.text(), /new two/, "the split view still draws the added line");
  const openFile = clickablesWithText(panel.view, "Open in CV Hub").at(-1);
  assert.ok(openFile, "the per-file link is rendered");
  openFile.press();
  await tick();
  assert.equal(panel.opened.at(-1), "https://hub.example.com/dashboard/repositories/acme/widgets/pulls/7", "the per-file link opens the pull request on CV Hub");

  // Inspecting the Files tab is what pins the revision a review submits against: the
  // composer now reports the revision, and a self-review is labeled as one.
  const reviewsTab = clickablesWithText(panel.view, "Reviews").find((el) => el.attrs.role === "tab");
  assert.ok(reviewsTab, "the Reviews tab is rendered");
  reviewsTab.press();
  await tick();
  assert.match(panel.text(), /Reviewing revision aaaaaaa · inspected in the Files tab/, "the composer names the inspected revision");
  const approveOption = findRadio(panel.view, "approved");
  assert.ok(approveOption, "the approve option is rendered");
  approveOption.press("change");
  await tick();
  assert.match(panel.text(), /Self approve/, "approving your own pull request is labeled");
  const submit = clickablesWithText(panel.view, "Self approve").at(-1);
  assert.ok(submit, "the submit control is rendered");
  assert.equal(submit.attrs.disabled, undefined, "submitting is enabled once the revision is inspected");
  submit.press();
  await tick();
  assert.match(panel.text(), /Review submitted/, "the submitted review is confirmed");
  assert.ok(panel.requests().includes("review.submit"), "the review reached the worker with the inspected revision");

  // A focus move arrives as a push: the panel follows the new repository.
  panel.push("context.changed", { repository: { owner: "acme", repo: "gadgets" }, workspace: "matched" });
  await tick();
  assert.match(panel.text(), /acme \/ gadgets/, "the panel followed the focused workspace");
  assert.match(panel.text(), /Gadget dashboard/, "the new repository's pull requests are listed");
  assert.doesNotMatch(panel.text(), /Add widget polish/, "the old repository's list is gone");

  console.log("Panel smoke: boot, sign-in, workspace, pull requests, in-panel diff, review submission and links passed");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await smokePanel();
