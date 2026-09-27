import { arr, bool, int, nullable, obj, str, type DataSchema } from "./panel-schema";

/** Panel-callable commands and the native review provider. This file is the single source of
 *  truth: scripts/build.mjs writes the `panel` contracts and `reviewProviders` from it into
 *  orca-plugin.json, the worker validates its view models against it, and tests prove every
 *  schema compiles under Orca's bounded dialect. Anything not listed here is worker-private. */

const SHA = str(40, { minLength: 40 });
const owner = str(256, { minLength: 1 });
const repo = str(256, { minLength: 1 });
const number = int(1);
export const PAGE_SIZE = 20;
export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export const PULL_ACTIONS = ["close", "reopen", "ready", "draft"] as const;
/** How the focused worktree mapped to CV Hub: matched, or why it didn't. */
export const WORKSPACE_MATCH = ["matched", "no_worktree", "no_remote", "other_server", "not_found", "unsupported"] as const;

export const ATTEMPT_PHASES = ["pending", "denied", "expired", "offline", "invalid_client", "error", "connected"] as const;
/** Browser hand-off states: host confirmation, fallbacks, and host-side invalidation. */
export const BROWSER_STATES = ["idle", "confirming", "opened", "declined", "unavailable", "unverified", "rate_limited", "invalidated"] as const;

const connection = obj({
  origin: str(2048),
  mcpUrl: str(2048),
  username: str(256),
  userId: str(256),
  displayName: nullable(str(256)),
  canWrite: bool(),
  expired: bool(),
});
const attempt = obj({
  attemptId: str(64),
  origin: str(2048),
  phase: str(32, { enum: [...ATTEMPT_PHASES] }),
  userCode: str(32),
  verificationUri: str(2048),
  expiresAt: int(0),
  message: nullable(str(512)),
  browser: str(32, { enum: [...BROWSER_STATES] }),
  browserMessage: nullable(str(512)),
});
const status = obj({
  connection: nullable(connection),
  legacy: nullable(obj({ origin: str(2048), username: str(256) })),
  attempt: nullable(attempt),
});
const pullSummary = obj({
  number: int(1),
  title: str(512),
  state: str(32),
  isDraft: bool(),
  author: str(256),
  updatedAt: nullable(str(64)),
});
const empty = obj({});

export type PanelContract = { title: string; effect: "read" | "write"; input: DataSchema; output: DataSchema };
export const PANEL_COMMANDS: Record<string, PanelContract> = {
  "cvhub.authStatus": { title: "CV Hub: Sign-in status", effect: "read", input: empty, output: status },
  "cvhub.authStart": {
    title: "CV Hub: Sign in",
    effect: "write",
    input: obj({ origin: str(2048, { minLength: 1 }) }),
    output: attempt,
  },
  "cvhub.authCancel": {
    title: "CV Hub: Cancel sign-in",
    effect: "write",
    input: obj({ attemptId: nullable(str(64)) }, ["attemptId"]),
    output: status,
  },
  "cvhub.authOpenVerification": {
    title: "CV Hub: Continue sign-in in browser",
    effect: "write",
    input: obj({ attemptId: str(64, { minLength: 1 }) }),
    output: obj({ requested: bool(), browser: str(32, { enum: [...BROWSER_STATES] }), browserMessage: nullable(str(512)) }),
  },
  "cvhub.disconnect": { title: "CV Hub: Sign out", effect: "write", input: empty, output: obj({ signedOut: bool(), revoked: bool() }) },
  "cvhub.listRepositories": {
    title: "CV Hub: List repositories",
    effect: "read",
    input: obj({ offset: int(0, 1_000_000), search: str(100) }),
    output: obj({ repositories: arr(obj({ owner: str(256), repo: str(256) }), PAGE_SIZE), total: int(0) }),
  },
  "cvhub.activeRepository": {
    title: "CV Hub: Repository of the focused worktree",
    effect: "read",
    input: empty,
    output: obj({
      repository: nullable(obj({ owner: str(256), repo: str(256) })),
      source: str(16, { enum: ["workspace", "remembered", "none"] }),
      workspace: str(32, { enum: [...WORKSPACE_MATCH] }),
    }),
  },
  "cvhub.rememberRepository": {
    title: "CV Hub: Remember the selected repository",
    effect: "write",
    input: obj({ owner, repo }),
    output: obj({ ok: bool() }),
  },
  "cvhub.listPulls": {
    title: "CV Hub: List pull requests",
    effect: "read",
    input: obj({
      owner,
      repo,
      offset: int(0, 1_000_000),
      state: str(16, { enum: ["open", "closed", "merged", "all"] }),
      mine: bool(),
    }),
    output: obj({ pulls: arr(pullSummary, PAGE_SIZE), total: int(0) }),
  },
  "cvhub.getPull": {
    title: "CV Hub: Pull request details",
    effect: "read",
    input: obj({ owner, repo, number }),
    output: obj({
      number: int(1),
      title: str(512),
      state: str(32),
      isDraft: bool(),
      author: str(256),
      body: str(12000),
      sourceBranch: str(1024),
      targetBranch: str(1024),
      sourceSha: nullable(str(40)),
      createdAt: nullable(str(64)),
      updatedAt: nullable(str(64)),
      canWrite: bool(),
      gate: nullable(obj({ approvals: int(0), required: int(0), blockedBy: arr(str(256), 20), nonCountingApprovals: int(0) })),
    }),
  },
  "cvhub.mergePull": {
    title: "CV Hub: Merge pull request",
    effect: "write",
    input: obj({ owner, repo, number, expectedHeadSha: SHA, method: str(16, { enum: [...MERGE_METHODS] }) }),
    output: obj({ state: str(32) }),
  },
  "cvhub.updatePullState": {
    title: "CV Hub: Close, reopen or change draft state",
    effect: "write",
    input: obj({ owner, repo, number, action: str(16, { enum: [...PULL_ACTIONS] }) }),
    output: obj({ state: str(32), isDraft: bool() }),
  },
  "cvhub.getPullChecks": {
    title: "CV Hub: Pull request checks",
    effect: "read",
    input: obj({ owner, repo, number }),
    output: obj({
      checks: arr(obj({ name: str(256), status: str(64), conclusion: nullable(str(64)), durationMs: nullable(int(0)) }), 30),
      total: int(0),
    }),
  },
  "cvhub.listReviews": {
    title: "CV Hub: Review history",
    effect: "read",
    input: obj({ owner, repo, number }),
    output: obj({
      reviews: arr(
        obj({
          id: str(64),
          state: str(32),
          body: str(1000),
          commitSha: nullable(str(40)),
          submittedAt: nullable(str(64)),
          reviewer: nullable(str(256)),
        }),
        20,
      ),
      total: int(0),
    }),
  },
  "cvhub.submitReview": {
    title: "CV Hub: Submit review",
    effect: "write",
    input: obj({
      owner,
      repo,
      number,
      expectedHeadSha: SHA,
      state: str(32, { enum: ["approved", "changes_requested", "commented"] }),
      body: str(12000),
    }),
    output: obj({ id: str(64), state: str(32) }),
  },
  "cvhub.searchCode": {
    title: "CV Hub: Search code",
    effect: "read",
    input: obj({ owner, repo, query: str(1000, { minLength: 1 }) }),
    output: obj({
      results: arr(obj({ path: str(4096), symbol: str(512), line: nullable(int(0)), content: str(1200) }), 8),
    }),
  },
};

/** Worker-only commands: native review loaders. They must never gain a `panel` contract. */
export const PRIVATE_COMMANDS: Record<string, string> = {
  "cvhub.getReview": "CV Hub: Load review snapshot",
  "cvhub.readReviewFile": "CV Hub: Read review file",
};

export const REVIEW_PROVIDER = {
  id: "cvhub.pullRequest",
  title: "CV Hub pull request",
  snapshotCommand: "cvhub.getReview",
  contentCommand: "cvhub.readReviewFile",
  input: obj({ owner, repo, number }),
};
