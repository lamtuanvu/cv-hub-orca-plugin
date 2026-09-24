import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerCommands } from "./activate";
import { PANEL_COMMANDS, PRIVATE_COMMANDS, REVIEW_PROVIDER } from "../shared/panel-contracts";
import { PANEL_PAYLOAD_LIMIT, byteLength, compileDataSchema } from "../shared/panel-schema";
import { buildManifest } from "../shared/manifest";
import type { Orca } from "../shared/contracts";

const ORIGIN = "https://api.hub.example";
const SECRETS = ["AT-SECRET", "RT-SECRET", "Bearer", "x-internal-debug"];

function signedInHost() {
  const values = new Map<string, unknown>([
    [
      "storage:connection",
      { kind: "oauth", connectionId: "conn-1", origin: ORIGIN, mcpUrl: `${ORIGIN}/mcp`, username: "mara", userId: "u1", displayName: null, scopes: ["repo:read", "repo:write"] },
    ],
    ["secrets:oauth", JSON.stringify({ accessToken: "AT-SECRET", refreshToken: "RT-SECRET", expiresAt: Date.now() + 3600_000 })],
  ]);
  const host: Orca["host"] = {
    call: async (method, raw) => {
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
  if (url.pathname.endsWith("/checks"))
    return Response.json({ checks: Array.from({ length: 40 }, () => ({ id: "c", pipelineName: "build", status: "completed", conclusion: "success", durationMs: 1200, logsUrl: "https://internal", ...extra })) });
  if (url.pathname.endsWith("/reviews"))
    return Response.json({ reviews: Array.from({ length: 30 }, (_, i) => ({ id: `v${i}`, state: "commented", body: long, commitSha: "b".repeat(40), submittedAt: "2026-09-24T00:00:00Z", reviewer: { username: "dlee", email: "d@e" }, ...extra })) });
  return new Response("not found", { status: 404 });
};
function commands(fetcher = hostileApi) {
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  registerCommands({ commands: { register: (id, h) => handlers.set(id, async (a) => h(a)) }, host: signedInHost() }, fetcher);
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
      ["browser:authorize", "commands:invoke-own", "diffs:open", "secrets", "storage"],
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

  it("never returns review snapshot context or tokens from the snapshot loader to anything but Orca", async () => {
    const snapshot = {
      owner: "acme", repo: "demo", number: 7, repositoryId: "r", title: "T",
      baseSha: "b".repeat(40), mergeBaseSha: "a".repeat(40), headSha: "c".repeat(40),
      files: [{ path: "a.ts", status: "renamed", oldPath: "old.ts", additions: 1, deletions: 1, binary: false, patch: "@@ secret" }],
    };
    const h = commands(async () => Response.json({ snapshot }));
    const review = (await h.get("cvhub.getReview")!({ owner: "acme", repo: "demo", number: 7 })) as Record<string, unknown>;
    expect(review).toEqual({
      title: "acme/demo #7 · T",
      revision: "c".repeat(40),
      context: { owner: "acme", repo: "demo", number: 7, repositoryId: "r", baseSha: "b".repeat(40), mergeBaseSha: "a".repeat(40), headSha: "c".repeat(40), connectionId: "conn-1" },
      files: [{ path: "a.ts", oldPath: "old.ts", status: "renamed", additions: 1, deletions: 1 }],
    });
    expect(JSON.stringify(review)).not.toMatch(/SECRET|patch/);
  });
});
