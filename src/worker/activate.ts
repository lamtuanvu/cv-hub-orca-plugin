import { z } from "zod";
import { Connection, type Clock } from "./connection";
import { readReviewFile } from "./pr-review";
import { searchCode } from "./mcp-client";
import { pullInput, pullPath, snapshotSchema, type Orca } from "../shared/contracts";
import { PANEL_COMMANDS, PAGE_SIZE, PRIVATE_COMMANDS } from "../shared/panel-contracts";
import { PANEL_PAYLOAD_LIMIT, byteLength, compileDataSchema } from "../shared/panel-schema";
import { CvHubError, type Fetch } from "./rest-client";

const clip = (value: string | null | undefined, max: number) => (value ?? "").slice(0, max);
const nullableClip = (value: string | null | undefined, max: number) => (value == null ? null : value.slice(0, max));
/** Keep a list inside Orca's 48 KiB panel budget by shortening one text field per item. */
function fitBudget<T extends Record<K, string>, K extends string>(wrap: (items: T[]) => unknown, items: T[], field: K, max: number): T[] {
  let limit = max;
  let out = items;
  while (limit > 40 && byteLength(wrap(out)) > PANEL_PAYLOAD_LIMIT - 2048) {
    limit = Math.floor(limit / 2);
    out = items.map((item) => ({ ...item, [field]: item[field].slice(0, limit) }));
  }
  return out;
}

/** Only a worker-coded error crosses to the panel. Anything else (schema failures, library
 *  errors, stack traces) becomes a generic message, so no response bodies, headers or tokens
 *  can leak through an exception. */
export function sanitize(error: unknown): Error {
  if (error instanceof CvHubError) return new Error(error.message.slice(0, 600));
  if (error instanceof z.ZodError) return new Error("[invalid_response] CV Hub returned an unexpected response");
  const text = error instanceof Error ? error.message : "";
  if (/^\[[a-z_]+\] /.test(text)) return new Error(text.slice(0, 600));
  return new Error("[error] The request failed");
}

export function registerCommands(orca: Orca, fetcher?: Fetch, clock?: Clock) {
  const connection = new Connection(orca.host, fetcher, clock);
  const outputs = new Map(Object.entries(PANEL_COMMANDS).map(([id, c]) => [id, compileDataSchema(c.output)]));
  const inputs = new Map(Object.entries(PANEL_COMMANDS).map(([id, c]) => [id, compileDataSchema(c.input)]));
  /** Panel-callable command: validated in and out against the same contract the host enforces. */
  const panel = (name: string, handler: (args: never) => Promise<unknown> | unknown) => {
    const id = `cvhub.${name}`;
    const input = inputs.get(id);
    const output = outputs.get(id);
    if (!input || !output) throw new Error(`No panel contract for ${id}`);
    orca.commands.register(id, async (args) => {
      try {
        const parsed = input.parse(args ?? {});
        const result = output.parse(await handler(parsed as never));
        if (byteLength(result) > PANEL_PAYLOAD_LIMIT) throw new CvHubError("too_large", "The result is too large to show");
        return result;
      } catch (error) {
        throw sanitize(error);
      }
    });
  };
  /** Worker-private command (native review loaders): never reachable from the panel. */
  const worker = (name: string, handler: (args: unknown) => Promise<unknown>) => {
    const id = `cvhub.${name}`;
    if (!PRIVATE_COMMANDS[id]) throw new Error(`${id} is not a declared private command`);
    orca.commands.register(id, async (args) => {
      try {
        return await handler(args);
      } catch (error) {
        throw sanitize(error);
      }
    });
  };

  panel("authStatus", () => connection.status());
  panel("authStart", (args) => connection.start(args));
  panel("authCancel", (args: { attemptId?: string | null }) => connection.cancel({ attemptId: args.attemptId ?? undefined }));
  panel("authOpenVerification", (args) => connection.openVerification(args));
  panel("disconnect", () => connection.disconnect());

  panel("listRepositories", async (args: { offset: number; search: string }) => {
    const client = await connection.client();
    const response = z
      .object({
        repositories: z.array(z.object({ slug: z.string(), owner: z.object({ slug: z.string() }).nullable() })),
        pagination: z.object({ total: z.number() }),
      })
      .parse(
        await client.json(
          `/api/v1/repos?${new URLSearchParams({ provider: "local", limit: String(PAGE_SIZE), offset: String(args.offset), search: args.search })}`,
        ),
      );
    return {
      repositories: response.repositories
        .filter((r) => r.owner)
        .slice(0, PAGE_SIZE)
        .map((r) => ({ owner: clip(r.owner!.slug, 256), repo: clip(r.slug, 256) })),
      total: Math.max(0, Math.floor(response.pagination.total)),
    };
  });

  const pullItem = z.object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.string(),
    isDraft: z.boolean().optional(),
    author: z.object({ username: z.string() }),
    body: z.string().nullable().optional(),
    sourceBranch: z.string(),
    targetBranch: z.string(),
    sourceSha: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  });
  panel("listPulls", async (args: { owner: string; repo: string; offset: number; state: string; mine: boolean }) => {
    const client = await connection.client();
    const query = new URLSearchParams({ state: args.state, limit: String(PAGE_SIZE), offset: String(args.offset) });
    if (args.mine) query.set("author", client.userId);
    const response = z
      .object({ pullRequests: z.array(pullItem), total: z.number() })
      .parse(await client.json(`/api/v1/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls?${query}`));
    return {
      pulls: response.pullRequests.slice(0, PAGE_SIZE).map((p) => ({
        number: p.number,
        title: clip(p.title, 300),
        state: clip(p.state, 32),
        isDraft: p.isDraft === true,
        author: clip(p.author.username, 256),
        updatedAt: nullableClip(p.updatedAt, 64),
      })),
      total: Math.max(0, Math.floor(response.total)),
    };
  });
  panel("getPull", async (args: { owner: string; repo: string; number: number }) => {
    const client = await connection.client();
    const { pullRequest: p } = z.object({ pullRequest: pullItem }).parse(await client.json(pullPath(args)));
    return {
      number: p.number,
      title: clip(p.title, 512),
      state: clip(p.state, 32),
      isDraft: p.isDraft === true,
      author: clip(p.author.username, 256),
      body: clip(p.body, 12000),
      sourceBranch: clip(p.sourceBranch, 1024),
      targetBranch: clip(p.targetBranch, 1024),
      sourceSha: p.sourceSha && /^[a-f0-9]{40}$/.test(p.sourceSha) ? p.sourceSha : null,
      createdAt: nullableClip(p.createdAt, 64),
      updatedAt: nullableClip(p.updatedAt, 64),
      canWrite: client.canWrite,
    };
  });
  panel("getPullChecks", async (args: { owner: string; repo: string; number: number }) => {
    const client = await connection.client();
    const result = z
      .object({
        checks: z.array(
          z.object({
            pipelineName: z.string(),
            status: z.string(),
            conclusion: z.string().nullable(),
            durationMs: z.number().nullable().optional(),
          }),
        ),
      })
      .parse(await client.json(`${pullPath(args)}/checks`));
    return {
      checks: result.checks.slice(0, 30).map((c) => ({
        name: clip(c.pipelineName, 256),
        status: clip(c.status, 64),
        conclusion: nullableClip(c.conclusion, 64),
        durationMs: c.durationMs == null || c.durationMs < 0 ? null : Math.floor(c.durationMs),
      })),
      total: result.checks.length,
    };
  });
  panel("listReviews", async (args: { owner: string; repo: string; number: number }) => {
    const client = await connection.client();
    const result = z
      .object({
        reviews: z.array(
          z.object({
            id: z.string(),
            state: z.string(),
            body: z.string().nullable(),
            commitSha: z.string().nullable().optional(),
            submittedAt: z.string().nullable().optional(),
            createdAt: z.string().optional(),
            reviewer: z.object({ username: z.string() }).nullable().optional(),
          }),
        ),
      })
      .parse(await client.json(`${pullPath(args)}/reviews`));
    const reviews = result.reviews.slice(-20).map((r) => ({
        id: clip(r.id, 64),
        state: clip(r.state, 32),
        body: clip(r.body, 1000),
        commitSha: r.commitSha && /^[a-f0-9]{40}$/.test(r.commitSha) ? r.commitSha : null,
        submittedAt: nullableClip(r.submittedAt ?? r.createdAt, 64),
        reviewer: nullableClip(r.reviewer?.username, 256),
      }));
    // Newest last, keeping the latest 20, shortened if needed to stay within the payload budget.
    return { reviews: fitBudget((items) => ({ reviews: items, total: 0 }), reviews, "body", 1000), total: result.reviews.length };
  });
  panel(
    "submitReview",
    async (args: { owner: string; repo: string; number: number; expectedHeadSha: string; state: string; body: string }) => {
      const client = await connection.client();
      if (!client.canWrite)
        throw new CvHubError(
          "read_only",
          "This sign-in was granted read-only access. Sign in again and allow repo:write to publish reviews",
        );
      const result = z
        .object({ review: z.object({ id: z.string(), state: z.string() }) })
        .parse(
          // Tied to the inspected head: the server answers 409 if the PR moved on. Never retried.
          await client.json(`${pullPath(args)}/reviews`, {
            method: "POST",
            body: JSON.stringify({ state: args.state, body: args.body, expectedHeadSha: args.expectedHeadSha }),
          }),
        );
      return { id: clip(result.review.id, 64), state: clip(result.review.state, 32) };
    },
  );
  panel("searchCode", async (args: { owner: string; repo: string; query: string }) => {
    const client = await connection.client();
    const results = await searchCode(client, args);
    const current = await connection.status();
    if (current.connection?.userId !== client.userId || current.connection?.origin !== client.origin)
      throw new CvHubError("connection_changed", "The connection changed. Search again");
    const items = results.slice(0, 8).map((r) => ({
      path: clip(r.path, 4096),
      symbol: clip(r.symbol, 512),
      line: r.line == null || r.line < 0 ? null : Math.floor(r.line),
      content: clip(r.content, 1200),
    }));
    return { results: fitBudget((list) => ({ results: list }), items, "content", 1200) };
  });

  // Native review loaders. Orca calls these only through the declared review provider; the
  // snapshot context (immutable SHAs, connection binding) never reaches the panel.
  worker("getReview", async (args) => {
    const input = pullInput.parse(args);
    const client = await connection.client();
    const { snapshot } = z.object({ snapshot: snapshotSchema }).parse(await client.json(`${pullPath(input)}/review-snapshot`));
    const { files, title, ...context } = snapshot;
    return {
      title: `${input.owner}/${input.repo} #${input.number} · ${title}`.slice(0, 512),
      revision: snapshot.headSha,
      context: { ...context, connectionId: client.connectionId },
      files: files.map((f) => ({
        path: f.path,
        ...(f.oldPath ? { oldPath: f.oldPath } : {}),
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        ...(f.binary ? { binary: true } : {}),
      })),
    };
  });
  worker("readReviewFile", async (args) => {
    const client = await connection.client();
    return readReviewFile(args, {
      connectionId: client.connectionId,
      json: (path) => client.json(path, {}, 16 * 1024 * 1024),
    });
  });
}
export default function activate(orca: Orca) {
  registerCommands(orca);
}
