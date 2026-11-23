import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { OrcaWorkerApi } from "orca/worker";
import type { Disposable } from "orca/host";
import type { PluginRequestInput, PluginRequestOutput, PluginRequests } from "orca";
import { DEFAULT_ORIGIN, STATUS_BAR_ID } from "../shared/manifest";
import { Connection, type Clock } from "./connection";
import { searchCode } from "./mcp-client";
import { diffForPanel, fetchPullDiff, pullInput, pullPath, sha } from "./pull-diff";
import { CvHubError, type Fetch } from "./rest-client";
import { candidateRepos, remotesFromGitOutput, type Remote, type RepoRef } from "./workspace-repo";
import type { AuthStatus, WorkspaceMatch } from "../shared/protocol";

const execFile = promisify(execFileCallback);
const clip = (value: string | null | undefined, max: number) => (value ?? "").slice(0, max);
const nullableClip = (value: string | null | undefined, max: number) => (value == null ? null : value.slice(0, max));
const host = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** Only a worker-coded error crosses to the panel. Anything else (schema failures, library
 *  errors, stack traces) becomes a generic message, so no response bodies, headers or tokens
 *  can leak through an exception. The `[code]` prefix is what the panel reads: Orca maps an
 *  unknown thrown code to `action_failed` but keeps the message. */
export function sanitize(error: unknown): CvHubError {
  if (error instanceof CvHubError) return error;
  if (error instanceof z.ZodError) return new CvHubError("invalid_response", "CV Hub returned an unexpected response");
  const text = error instanceof Error ? error.message : "";
  if (/^\[[a-z_]+\] /.test(text)) return new CvHubError("error", text.slice(0, 600));
  return new CvHubError("error", "The request failed");
}

/** The source branch's current head, read from git. The PR's own `sourceSha` is set when the PR
 *  is created and not updated on push, so it can't say whether the inspected revision is current. */
async function branchHead(
  client: { json(path: string): Promise<unknown> },
  pull: { owner: string; repo: string; sourceBranch: string },
): Promise<string | null> {
  const query = new URLSearchParams({ ref: `refs/heads/${pull.sourceBranch}`, limit: "1" });
  const { commits } = z
    .object({ commits: z.array(z.object({ sha: z.string() })) })
    .parse(await client.json(`/api/v1/repos/${encodeURIComponent(pull.owner)}/${encodeURIComponent(pull.repo)}/commits?${query}`));
  const head = commits[0]?.sha;
  return head && /^[a-f0-9]{40}$/.test(head) ? head : null;
}

// ---- request inputs, checked in the worker (the host carries only JSON) ----
const repoArgs = z.object({ owner: z.string().min(1).max(255), repo: z.string().min(1).max(255) });
const pullArgs = repoArgs.extend({ number: z.number().int().positive() });
const listArgs = repoArgs.extend({
  offset: z.number().int().min(0).max(1_000_000),
  state: z.enum(["open", "closed", "merged", "all"]),
  mine: z.boolean(),
});
const submitArgs = pullArgs.extend({
  expectedHeadSha: sha,
  state: z.enum(["approved", "changes_requested", "commented"]),
  body: z.string().max(12000),
});
const searchArgs = repoArgs.extend({ query: z.string().min(1).max(1000) });

export type WorkerDeps = { fetcher?: Fetch; clock?: Clock };

/** Everything the plugin's worker does: panel request handlers, the three palette commands,
 *  workspace-driven repository detection and the status bar item. */
export function registerPlugin(orca: OrcaWorkerApi, deps: WorkerDeps = {}) {
  const connection = new Connection(
    { storage: orca.storage, secrets: orca.secrets },
    deps.fetcher,
    deps.clock,
    () => void publishAuth(),
  );

  /** The API origin a new sign-in would use: the `apiOrigin` setting, with the server
   *  plugin 0.5 remembered kept while the setting still holds the default, so an upgrade
   *  never silently moves a self-hosted user to the public server. An invalid value is
   *  returned as-is; sign-in then names it and points at Settings. */
  async function signInOrigin(): Promise<string> {
    const setting = await orca.settings.get("apiOrigin");
    const configured = typeof setting === "string" ? setting.trim() : "";
    if (configured && configured !== DEFAULT_ORIGIN) return configured;
    const status = await connection.status();
    return status.connection?.origin ?? status.legacy?.origin ?? (configured || DEFAULT_ORIGIN);
  }
  async function authStatus(): Promise<AuthStatus> {
    const status = await connection.status();
    return { ...status, apiOrigin: await signInOrigin() };
  }

  // ---------- pushed state (the panel never polls) ----------
  let wasConnected = false;
  async function publishAuth() {
    let status: AuthStatus;
    try {
      status = await authStatus();
    } catch {
      return;
    }
    orca.panels.post("auth.changed", { status });
    if (status.connection && !status.connection.expired && !wasConnected) {
      await orca.host.call("notifications.show", {
        title: "CV Hub",
        body: `Signed in to CV Hub as @${status.connection.username}.`,
      }).catch(() => undefined);
      void refocus(lastWorkspaceId);
    }
    wasConnected = status.connection !== null && !status.connection.expired;
    void refreshStatusItem();
  }
  function publishContext() {
    orca.panels.post("context.changed", {
      repository: focused?.repo ?? null,
      workspace: focusedWhy,
    });
  }

  // ---------- repositories known to exist on this connection ----------
  const known = new Map<string, boolean>();
  async function exists(
    client: Awaited<ReturnType<Connection["client"]>>,
    ref: RepoRef,
  ): Promise<boolean> {
    const key = `${client.connectionId}|${ref.owner}/${ref.repo}`.toLowerCase();
    const cached = known.get(key);
    if (cached !== undefined) return cached;
    try {
      await client.json(`/api/v1/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`, {}, 256 * 1024);
      known.set(key, true);
      return true;
    } catch (error) {
      // Only a definite "no" is cached; a network blip is retried on the next poll.
      if (error instanceof CvHubError && (error.code === "not_found" || error.code === "forbidden")) known.set(key, false);
      if (known.size > 200) known.clear();
      return false;
    }
  }

  // ---------- repository detection for the focused workspace ----------
  let lastWorkspaceId: string | undefined;
  let focused: { repo: RepoRef } | null = null;
  let focusedWhy: WorkspaceMatch = "no_workspace";

  /** The focused workspace's remotes, read with git directly (no shell, bounded output). */
  async function remotesForWorkspace(workspaceId: string): Promise<Remote[] | null> {
    const listed = z
      .object({ workspaces: z.array(z.object({ id: z.string(), path: z.string() })) })
      .parse(await orca.host.call("workspace.list"));
    const workspace = listed.workspaces.find((w) => w.id === workspaceId);
    if (!workspace) return null;
    const { stdout } = await execFile("git", ["-C", workspace.path, "remote", "-v"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return remotesFromGitOutput(stdout);
  }

  /** Maps the focused workspace to a CV Hub repository and publishes the outcome. */
  // The detection in flight, so `context.current` answers with its result, not a stale one.
  let refocusing: Promise<void> = Promise.resolve();
  function refocus(workspaceId?: string): Promise<void> {
    lastWorkspaceId = workspaceId;
    const run = detect(workspaceId);
    refocusing = run.catch(() => undefined);
    return run;
  }
  async function detect(workspaceId?: string): Promise<void> {
    let found: { repo: RepoRef } | null = null;
    let why: WorkspaceMatch = workspaceId ? "not_found" : "no_workspace";
    let remotes: Remote[] | null = null;
    if (workspaceId) {
      try {
        remotes = await remotesForWorkspace(workspaceId);
      } catch {
        remotes = null;
      }
      if (remotes === null) why = "offline";
      else if (remotes.length === 0) why = "no_remote";
      else {
        const origin = (await connection.profile())?.origin ?? (await signInOrigin());
        const candidates = candidateRepos(origin, remotes);
        if (candidates.length === 0) why = "other_server";
        else
          try {
            const client = await connection.client();
            for (const ref of candidates.slice(0, 4)) {
              if (await exists(client, ref)) {
                found = { repo: ref };
                why = "matched";
                break;
              }
            }
          } catch {
            // Signed out or unreachable: the candidates stay unverified, no repo is claimed.
          }
      }
    }
    // A newer focus change won the race; drop this outcome.
    if (workspaceId !== lastWorkspaceId) return;
    focused = found;
    focusedWhy = why;
    publishContext();
    void refreshStatusItem();
  }
  const events = orca.events.on("workspace.changed", ({ context }) => {
    void refocus(context?.workspaceId);
  });

  // ---------- the status bar item ----------
  async function updateStatusItem(
    fields: { text?: string; tone?: "neutral" | "accent"; tooltip?: string; visible?: boolean },
  ): Promise<void> {
    // Desktop-only host method; a browser client simply has no status bar.
    if (!orca.host.has("statusBar.update")) return;
    await orca.host.call("statusBar.update", { id: STATUS_BAR_ID, ...fields }).catch(() => undefined);
  }
  /** `CV Hub: <n> open PRs` for the focused workspace's repository; `CV Hub: sign in`
   *  when signed out; hidden when signed in with no CV Hub repository detected. */
  async function refreshStatusItem(): Promise<void> {
    const status = await connection.status();
    if (!status.connection || status.connection.expired) {
      await updateStatusItem({ text: "CV Hub: sign in", tone: "accent", tooltip: "Sign in to CV Hub", visible: true });
      return;
    }
    const repo = focused?.repo;
    if (!repo) {
      await updateStatusItem({ visible: false });
      return;
    }
    try {
      const client = await connection.client();
      const query = new URLSearchParams({ state: "open", limit: "1" });
      const { total } = z
        .object({ total: z.number() })
        .parse(
          await client.json(
            `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls?${query}`,
          ),
        );
      const count = Math.max(0, Math.floor(total));
      await updateStatusItem({
        text: `CV Hub: ${count} open PR${count === 1 ? "" : "s"}`,
        tone: "neutral",
        tooltip: `${repo.owner}/${repo.repo} on ${host(status.connection.origin)}`,
        visible: true,
      });
    } catch {
      await updateStatusItem({
        text: "CV Hub",
        tone: "neutral",
        tooltip: `${repo.owner}/${repo.repo} — CV Hub is unreachable`,
        visible: true,
      });
    }
  }
  const statusTimer = setInterval(() => void refreshStatusItem(), 5 * 60 * 1000);

  // ---------- panel request handlers ----------
  function handle<K extends keyof PluginRequests>(
    name: K,
    handler: (input: PluginRequestInput<K>) => Promise<PluginRequestOutput<K>> | PluginRequestOutput<K>,
  ): Disposable {
    return orca.panels.handle(name, async (input: PluginRequestInput<K>) => {
      try {
        return await handler(input);
      } catch (error) {
        throw sanitize(error);
      }
    });
  }

  handle("auth.status", () => authStatus());
  handle("auth.start", async () => await connection.start(await signInOrigin()));
  handle("auth.cancel", async (input: { attemptId: string | null }) => {
    const { attemptId } = z.object({ attemptId: z.string().nullable() }).parse(input);
    await connection.cancel(attemptId ?? undefined);
    return authStatus();
  });
  handle("auth.signOut", () => connection.disconnect());

  const PAGE_SIZE = 20;
  handle("repos.list", async (input: { offset: number; search: string }) => {
    const args = z.object({ offset: z.number().int().min(0).max(1_000_000), search: z.string().max(100) }).parse(input);
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
  const gateSchema = z
    .object({
      approvals: z.number(),
      required: z.number(),
      blockedBy: z.array(z.object({ username: z.string() })),
      nonCountingApprovals: z.number().optional(),
    })
    .nullable()
    .optional()
    .catch(null);

  handle("pulls.list", async (input: { owner: string; repo: string; offset: number; state: "open" | "closed" | "merged" | "all"; mine: boolean }) => {
    const args = listArgs.parse(input);
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

  handle("pull.get", async (input: { owner: string; repo: string; number: number }) => {
    const args = pullArgs.parse(input);
    const client = await connection.client();
    const { pullRequest: p } = z.object({ pullRequest: pullItem.extend({ gate: gateSchema }) }).parse(await client.json(pullPath(args)));
    // Merged or closed PRs may have lost their branch; their recorded SHA is the best we have.
    // A failed lookup only loses the "new commits" hint; submitting checks the head again.
    const head =
      p.state === "open" ? await branchHead(client, { ...args, sourceBranch: p.sourceBranch }).catch(() => null) : null;
    const recorded = p.sourceSha && /^[a-f0-9]{40}$/.test(p.sourceSha) ? p.sourceSha : null;
    return {
      number: p.number,
      title: clip(p.title, 512),
      state: clip(p.state, 32),
      isDraft: p.isDraft === true,
      author: clip(p.author.username, 256),
      body: clip(p.body, 12000),
      sourceBranch: clip(p.sourceBranch, 1024),
      targetBranch: clip(p.targetBranch, 1024),
      sourceSha: head ?? recorded,
      createdAt: nullableClip(p.createdAt, 64),
      updatedAt: nullableClip(p.updatedAt, 64),
      canWrite: client.canWrite,
      // Served by CV Hub versions with the merge gate; older ones leave the merge to decide.
      gate: p.gate
        ? {
            approvals: Math.max(0, Math.floor(p.gate.approvals)),
            required: Math.max(0, Math.floor(p.gate.required)),
            blockedBy: p.gate.blockedBy.slice(0, 20).map((b) => clip(b.username, 256)),
            nonCountingApprovals: Math.max(0, Math.floor(p.gate.nonCountingApprovals ?? 0)),
          }
        : null,
    };
  });

  handle("pull.checks", async (input: { owner: string; repo: string; number: number }) => {
    const args = pullArgs.parse(input);
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

  handle("pull.reviews", async (input: { owner: string; repo: string; number: number }) => {
    const args = pullArgs.parse(input);
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
    return {
      // Newest last, keeping the latest 20.
      reviews: result.reviews.slice(-20).map((r) => ({
        id: clip(r.id, 64),
        state: clip(r.state, 32),
        body: clip(r.body, 1000),
        commitSha: r.commitSha && /^[a-f0-9]{40}$/.test(r.commitSha) ? r.commitSha : null,
        submittedAt: nullableClip(r.submittedAt ?? r.createdAt, 64),
        reviewer: nullableClip(r.reviewer?.username, 256),
      })),
      total: result.reviews.length,
    };
  });

  handle("pull.diff", async (input: { owner: string; repo: string; number: number }) => {
    const args = pullInput.parse(input);
    const client = await connection.client();
    const diff = await fetchPullDiff({ json: (path, maxBytes) => client.json(path, {}, maxBytes) }, args);
    return diffForPanel(diff);
  });

  handle("review.submit", async (input: { owner: string; repo: string; number: number; expectedHeadSha: string; state: "approved" | "changes_requested" | "commented"; body: string }) => {
    const args = submitArgs.parse(input);
    const client = await connection.client();
    if (!client.canWrite)
      throw new CvHubError(
        "read_only",
        "This sign-in was granted read-only access. Sign in again and allow repo:write to publish reviews",
      );
    // Refuse a review of a revision that is no longer the head. CV Hub versions that check
    // expectedHeadSha themselves answer 409 for a push that lands after this check; older ones
    // ignore the field, so this check is all that stands between the two.
    const { pullRequest } = z.object({ pullRequest: pullItem }).parse(await client.json(pullPath(args)));
    const head = await branchHead(client, { ...args, sourceBranch: pullRequest.sourceBranch });
    if (head !== args.expectedHeadSha)
      throw new CvHubError("stale_revision", "The PR changed. Open and review its latest changes before submitting");
    const result = z
      .object({ review: z.object({ id: z.string(), state: z.string() }) })
      .parse(
        // Never retried: a lost response is reported as an unknown outcome.
        await client.json(`${pullPath(args)}/reviews`, {
          method: "POST",
          body: JSON.stringify({ state: args.state, body: args.body, expectedHeadSha: args.expectedHeadSha }),
        }),
      );
    return { id: clip(result.review.id, 64), state: clip(result.review.state, 32) };
  });

  handle("code.search", async (input: { owner: string; repo: string; query: string }) => {
    const args = searchArgs.parse(input);
    const client = await connection.client();
    const results = await searchCode(client, args);
    const current = await connection.status();
    if (current.connection?.userId !== client.userId || current.connection?.origin !== client.origin)
      throw new CvHubError("connection_changed", "The connection changed. Search again");
    return {
      results: results.slice(0, 8).map((r) => ({
        path: clip(r.path, 4096),
        symbol: clip(r.symbol, 512),
        line: r.line == null || r.line < 0 ? null : Math.floor(r.line),
        content: clip(r.content, 1200),
      })),
    };
  });

  handle("context.current", async () => {
    await refocusing;
    return { repository: focused?.repo ?? null, workspace: focusedWhy };
  });

  // ---------- palette commands (also what the status bar item runs) ----------
  async function notify(title: string, body: string) {
    await orca.host.call("notifications.show", { title, body }).catch(() => undefined);
  }
  const commands = [
    orca.commands.register("cvhub.signIn", async () => {
      try {
        const status = await authStatus();
        if (status.connection && !status.connection.expired) {
          // The status bar runs this command while signed in; make that press useful.
          await refreshStatusItem();
          await notify("CV Hub", `Already signed in as @${status.connection.username}.`);
          return;
        }
        const attempt = await connection.start(status.apiOrigin);
        await notify(
          "CV Hub sign-in started",
          `Open the CV Hub panel in Orca’s right sidebar and continue with code ${attempt.userCode}.`,
        );
      } catch (error) {
        await notify("CV Hub sign-in failed", sanitize(error).message.replace(/^\[[a-z_]+\] /, ""));
      }
    }),
    orca.commands.register("cvhub.signOut", async () => {
      try {
        await connection.disconnect();
        await refreshStatusItem();
      } catch (error) {
        await notify("CV Hub sign-out failed", sanitize(error).message.replace(/^\[[a-z_]+\] /, ""));
      }
    }),
    orca.commands.register("cvhub.refresh", async () => {
      await refocus(lastWorkspaceId);
      await refreshStatusItem();
    }),
  ];

  void publishAuth();
  void refocus(lastWorkspaceId);

  return () => {
    clearInterval(statusTimer);
    events.dispose();
    for (const command of commands) command.dispose();
  };
}

let cleanup: (() => void) | null = null;

export default function activate(orca: OrcaWorkerApi) {
  cleanup = registerPlugin(orca);
}

export async function deactivate() {
  cleanup?.();
  cleanup = null;
}
