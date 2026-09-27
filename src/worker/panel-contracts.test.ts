import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerCommands } from "./activate";
import { PANEL_COMMANDS, PRIVATE_COMMANDS, REVIEW_PROVIDER } from "../shared/panel-contracts";
import { PANEL_PAYLOAD_LIMIT, byteLength, compileDataSchema } from "../shared/panel-schema";
import { buildManifest } from "../shared/manifest";
import type { Orca } from "../shared/contracts";

const ORIGIN = "https://api.hub.example";
const SECRETS = ["AT-SECRET", "RT-SECRET", "Bearer", "x-internal-debug"];

function signedInHost(workspace: unknown = null) {
  const values = new Map<string, unknown>([
    [
      "storage:connection",
      { kind: "oauth", connectionId: "conn-1", origin: ORIGIN, mcpUrl: `${ORIGIN}/mcp`, username: "mara", userId: "u1", displayName: null, scopes: ["repo:read", "repo:write"] },
    ],
    ["secrets:oauth", JSON.stringify({ accessToken: "AT-SECRET", refreshToken: "RT-SECRET", expiresAt: Date.now() + 3600_000 })],
  ]);
  const host: Orca["host"] = {
    call: async (method, raw) => {
      if (method === "workspace.readContext") return workspace;
      const args = raw as { key: string; value?: unknown };
      const key = method.split(".")[0] + ":" + args.key;
      if (method.endsWith(".get")) return { value: values.get(key) ?? null };
      if (method.endsWith(".set")) values.set(key, args.value);
      else values.delete(key);
      return { ok: true };
    },
  };
  return host;
}
/** A server that returns extra, internal and oversized fields the panel must never see. */
const hostileApi = async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const extra = { internalToken: "AT-SECRET", _debug: { header: "Bearer AT-SECRET" } };
  const long = "é".repeat(5000);
  const p = (n: number) => ({ number: n, title: long, state: "open", isDraft: false, author: { username: "jtan", email: "x@y" }, body: long, sourceBranch: "feature", targetBranch: "main", sourceSha: "a".repeat(40), createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-24T00:00:00Z", ...extra });
  if (url.pathname === "/api/v1/repos")
    return Response.json({ repositories: Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, slug: `repo-${i}`, owner: { slug: "acme", id: "o" }, ...extra })), pagination: { total: 25 } });
  if (url.pathname.endsWith("/pulls")) return Response.json({ pullRequests: Array.from({ length: 25 }, (_, i) => p(i + 1)), total: 25 });
  if (url.pathname.endsWith("/pulls/7")) return Response.json({ pullRequest: p(7) });
  if (url.pathname.endsWith("/commits"))
    return Response.json({ commits: [{ sha: "d".repeat(40), message: long, author: { email: "x@y" }, ...extra }] });
  if (url.pathname.endsWith("/checks"))
    return Response.json({ checks: Array.from({ length: 40 }, () => ({ id: "c", pipelineName: "build", status: "completed", conclusion: "success", durationMs: 1200, logsUrl: "https://internal", ...extra })) });
  if (url.pathname.endsWith("/reviews"))
    return Response.json({ reviews: Array.from({ length: 30 }, (_, i) => ({ id: `v${i}`, state: "commented", body: long, commitSha: "b".repeat(40), submittedAt: "2026-09-24T00:00:00Z", reviewer: { username: "dlee", email: "d@e" }, ...extra })) });
  return new Response("not found", { status: 404 });
};
function commands(fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = hostileApi, workspace: unknown = null) {
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  registerCommands({ commands: { register: (id, h) => handlers.set(id, async (a) => h(a)) }, host: signedInHost(workspace) }, fetcher);
  return handlers;
}

describe("panel command contracts", () => {
  it("compile under Orca's bounded schema dialect", () => {
    for (const [id, c] of Object.entries(PANEL_COMMANDS)) {
      expect(() => compileDataSchema(c.input), `${id} input`).not.toThrow();
      expect(() => compileDataSchema(c.output), `${id} output`).not.toThrow();
    }
    expect(() => compileDataSchema(REVIEW_PROVIDER.input)).not.toThrow();
    expect(() => compileDataSchema({ type: "object", properties: {} })).toThrow(); // additionalProperties required
    expect(() => compileDataSchema({ type: "string", pattern: "x" })).toThrow(); // unsupported keyword
  });

  it("declare loaders privately and the review provider exactly as Orca requires", () => {
    const manifest = buildManifest();
    const byId = new Map(manifest.contributes.commands.map((c) => [c.id, c]));
    for (const id of Object.keys(PRIVATE_COMMANDS)) expect(byId.get(id)).not.toHaveProperty("panel");
    expect(manifest.contributes.reviewProviders).toEqual([REVIEW_PROVIDER]);
    expect(manifest.capabilities.map((c) => c.kind).sort()).toEqual(
      ["browser:authorize", "commands:invoke-own", "diffs:open", "secrets", "storage", "workspace:read"],
    );
    // Nothing panel-callable can load review snapshots or file contents.
    expect(Object.keys(PANEL_COMMANDS).filter((id) => /review(File)?$|getReview/.test(id) && id !== "cvhub.listReviews" && id !== "cvhub.submitReview")).toEqual([]);
  });

  it("orca-plugin.json matches the generated manifest (run the build after changing contracts)", () => {
    const file = JSON.parse(readFileSync(new URL("../../orca-plugin.json", import.meta.url), "utf8"));
    expect(file).toEqual(JSON.parse(JSON.stringify(buildManifest())));
  });

  it("registers every declared command, and nothing else", () => {
    const handlers = commands();
    expect([...handlers.keys()].sort()).toEqual(buildManifest().contributes.commands.map((c) => c.id).sort());
  });

  it.each([
    ["cvhub.listRepositories", { offset: 0, search: "" }],
    ["cvhub.listPulls", { owner: "acme", repo: "demo", offset: 0, state: "all", mine: false }],
    ["cvhub.getPull", { owner: "acme", repo: "demo", number: 7 }],
    ["cvhub.getPullChecks", { owner: "acme", repo: "demo", number: 7 }],
    ["cvhub.listReviews", { owner: "acme", repo: "demo", number: 7 }],
    ["cvhub.authStatus", {}],
  ])("%s returns a bounded, sanitized view model", async (id, args) => {
    const result = await commands().get(id)!(args);
    expect(() => compileDataSchema(PANEL_COMMANDS[id].output).parse(result)).not.toThrow();
    expect(byteLength(result)).toBeLessThanOrEqual(PANEL_PAYLOAD_LIMIT);
    const text = JSON.stringify(result);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toContain("email");
    expect(text).not.toContain("logsUrl");
  });

  it("rejects panel input that the contract does not allow", async () => {
    const list = commands().get("cvhub.listPulls")!;
    await expect(list({ owner: "acme", repo: "demo", offset: 0, state: "all", mine: false, url: "https://evil" })).rejects.toThrow("[invalid_response]");
    await expect(commands().get("cvhub.getPull")!({ owner: "acme", repo: "demo", number: 0 })).rejects.toThrow();
  });

  it("turns server failures into short coded errors without bodies or tokens", async () => {
    const failing = commands(async () => new Response("Authorization: Bearer AT-SECRET stack at x.ts:1", { status: 500 }));
    const error = await failing.get("cvhub.getPull")!({ owner: "acme", repo: "demo", number: 7 }).catch((e: Error) => e);
    expect((error as Error).message).toBe("[server_error] CV Hub request failed (500)");
    const garbled = commands(async () => Response.json({ unexpected: "AT-SECRET" }));
    const e2 = await garbled.get("cvhub.getPull")!({ owner: "acme", repo: "demo", number: 7 }).catch((e: Error) => e);
    expect((e2 as Error).message).toBe("[invalid_response] CV Hub returned an unexpected response");
  });

  it("reports the source branch's live head, not the PR's creation-time SHA", async () => {
    const pull = (await commands().get("cvhub.getPull")!({ owner: "acme", repo: "demo", number: 7 })) as { sourceSha: string };
    expect(pull.sourceSha).toBe("d".repeat(40));
  });

  it("refuses to submit a review for a revision that is no longer the head", async () => {
    const posted: string[] = [];
    const h = commands(async (input, init) => {
      if (init?.method === "POST") {
        posted.push(String(init.body));
        return Response.json({ review: { id: "v1", state: "approved" } }, { status: 201 });
      }
      return hostileApi(input);
    });
    const submit = h.get("cvhub.submitReview")!;
    const args = { owner: "acme", repo: "demo", number: 7, state: "approved", body: "" };
    await expect(submit({ ...args, expectedHeadSha: "a".repeat(40) })).rejects.toThrow("[stale_revision]");
    expect(posted).toEqual([]);
    await expect(submit({ ...args, expectedHeadSha: "d".repeat(40) })).resolves.toEqual({ id: "v1", state: "approved" });
    expect(JSON.parse(posted[0])).toMatchObject({ state: "approved", expectedHeadSha: "d".repeat(40) });
  });

  it("builds the review from the web diff and never returns patches or tokens to anything but Orca", async () => {
    const diff = {
      baseSha: "b".repeat(40), headSha: "c".repeat(40), totalAdditions: 1,
      files: [{ path: "a.ts", status: "renamed", oldPath: "old.ts", additions: 1, deletions: 1, patch: "@@ SECRET", truncated: false }],
    };
    const h = commands(async (input) =>
      new URL(String(input)).pathname.endsWith("/diff") ? Response.json({ diff }) : hostileApi(input),
    );
    const review = (await h.get("cvhub.getReview")!({ owner: "acme", repo: "demo", number: 7 })) as Record<string, unknown>;
    expect(review).toEqual({
      title: `acme/demo #7 · ${"é".repeat(5000)}`.slice(0, 512),
      revision: "c".repeat(40),
      context: { owner: "acme", repo: "demo", number: 7, baseSha: "b".repeat(40), headSha: "c".repeat(40), connectionId: "conn-1" },
      files: [{ path: "a.ts", oldPath: "old.ts", status: "renamed", additions: 1, deletions: 1 }],
    });
    expect(JSON.stringify(review)).not.toMatch(/SECRET|patch/);
  });

  it("finds the focused worktree's repository from its CV Hub remote", async () => {
    const asked: string[] = [];
    const api = async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      asked.push(path);
      return path === "/api/v1/repos/acme/widgets" ? Response.json({ repository: { slug: "widgets" } }) : new Response("", { status: 404 });
    };
    const context = (remotes: unknown) => ({ branch: "main", displayName: "wt", terminals: [], remotes });
    const active = (remotes: unknown) => commands(api, context(remotes)).get("cvhub.activeRepository")!({});
    await expect(
      active([
        { name: "github", url: "git@github.com:someone-else/widgets.git" },
        { name: "origin", url: "https://git.hub.example/acme/widgets.git" },
      ]),
    ).resolves.toEqual({ repository: { owner: "acme", repo: "widgets" }, source: "workspace", workspace: "matched" });
    expect(asked).toEqual(["/api/v1/repos/acme/widgets"]);
    await expect(active([{ name: "origin", url: "git@github.com:a/b.git" }])).resolves.toMatchObject({ repository: null, workspace: "other_server" });
    await expect(active([{ name: "origin", url: "https://hub.example/acme/gone.git" }])).resolves.toMatchObject({ repository: null, workspace: "not_found" });
    await expect(active([])).resolves.toMatchObject({ repository: null, workspace: "no_remote" });
    // A host that reports no remotes can't say which repository is active.
    await expect(commands(api, { branch: "main", displayName: "wt", terminals: [] }).get("cvhub.activeRepository")!({})).resolves.toMatchObject({ workspace: "unsupported" });
  });

  it("falls back to the repository last chosen on this connection", async () => {
    const h = commands();
    await h.get("cvhub.rememberRepository")!({ owner: "acme", repo: "demo" });
    await expect(h.get("cvhub.activeRepository")!({})).resolves.toEqual({ repository: { owner: "acme", repo: "demo" }, source: "remembered", workspace: "no_worktree" });
  });

  it("merges only the head the user saw, and passes on CV Hub's reason for refusing", async () => {
    const writes: Array<{ path: string; method?: string; body?: string }> = [];
    let refuse = false;
    const h = commands(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method && init.method !== "GET") {
        writes.push({ path, method: init.method, body: init.body as string });
        if (refuse) return Response.json({ error: "Requires 2 approvals, has 0" }, { status: 400 });
        return Response.json({ pullRequest: { state: "merged", isDraft: false }, merged: true });
      }
      return hostileApi(input);
    });
    const merge = h.get("cvhub.mergePull")!;
    const args = { owner: "acme", repo: "demo", number: 7, method: "squash" };
    await expect(merge({ ...args, expectedHeadSha: "a".repeat(40) })).rejects.toThrow("[stale_revision]");
    expect(writes).toEqual([]);
    await expect(merge({ ...args, expectedHeadSha: "d".repeat(40) })).resolves.toEqual({ state: "merged" });
    expect(writes[0]).toEqual({ path: "/api/v1/repos/acme/demo/pulls/7/merge", method: "PUT", body: JSON.stringify({ mergeMethod: "squash" }) });
    refuse = true;
    await expect(merge({ ...args, expectedHeadSha: "d".repeat(40) })).rejects.toThrow("[rejected] Requires 2 approvals, has 0");
  });

  it("closes, reopens and toggles draft through CV Hub's own endpoints", async () => {
    const writes: string[] = [];
    const h = commands(async (input, init) => {
      writes.push(`${init?.method} ${new URL(String(input)).pathname} ${init?.body ?? ""}`);
      return Response.json({ pullRequest: { state: "open", isDraft: false, ...{ internalToken: "AT-SECRET" } } });
    });
    const update = h.get("cvhub.updatePullState")!;
    for (const action of ["close", "reopen", "ready", "draft"]) await update({ owner: "acme", repo: "demo", number: 7, action });
    expect(writes).toEqual([
      'PATCH /api/v1/repos/acme/demo/pulls/7 {"state":"closed"}',
      "POST /api/v1/repos/acme/demo/pulls/7/reopen ",
      'PATCH /api/v1/repos/acme/demo/pulls/7 {"isDraft":false}',
      'PATCH /api/v1/repos/acme/demo/pulls/7 {"isDraft":true}',
    ]);
    await expect(update({ owner: "acme", repo: "demo", number: 7, action: "delete" })).rejects.toThrow();
  });
});
