/** The panel ↔ worker contract, declared once. Both sides import this module so
 *  `plugin.request` (panel) and `orca.panels.handle` (worker) are typed end to end.
 *  This module is types only: it compiles to nothing and carries no values. */
export {};

/** A repository on a CV Hub server. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** The sign-in in progress, as the panel may see it. The device code and every
 *  token stay in the worker; this view carries only the user code and the
 *  verification address the worker has already validated. */
export interface AuthAttemptView {
  attemptId: string;
  origin: string;
  phase: "pending" | "denied" | "expired" | "invalid_client" | "error" | "connected";
  userCode: string;
  /** The pre-filled address when it checked out, else the raw one to open by hand. */
  verificationUri: string;
  /** Whether the address was confirmed to belong to this CV Hub deployment; only
   *  then may the panel offer to open it. */
  verified: boolean;
  expiresAt: number;
  message: string | null;
}

export interface ConnectionView {
  origin: string;
  webOrigin: string | null;
  mcpUrl: string;
  username: string;
  userId: string;
  displayName: string | null;
  canWrite: boolean;
  expired: boolean;
}

export type AuthStatus = {
  connection: ConnectionView | null;
  legacy: { origin: string; username: string } | null;
  attempt: AuthAttemptView | null;
  /** The API origin a new sign-in would use (the `apiOrigin` setting, with the
   *  previously remembered server kept when the setting is still the default). */
  apiOrigin: string;
};

export interface PullSummary {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  author: string;
  /** ISO timestamp or null. */
  updatedAt: string | null;
}

export interface PullDetail extends PullSummary {
  body: string;
  sourceBranch: string;
  targetBranch: string;
  /** The source branch's current head, best known. */
  sourceSha: string | null;
  createdAt: string | null;
  canWrite: boolean;
  /** The merge gate, when this CV Hub serves one. */
  gate: {
    approvals: number;
    required: number;
    blockedBy: string[];
    nonCountingApprovals: number;
  } | null;
}

export interface CheckItem {
  name: string;
  status: string;
  conclusion: string | null;
  durationMs: number | null;
}

export interface ReviewItem {
  id: string;
  state: string;
  body: string;
  commitSha: string | null;
  submittedAt: string | null;
  reviewer: string | null;
}

/** How the focused workspace mapped to CV Hub. */
export type WorkspaceMatch =
  | "matched"
  | "no_workspace"
  | "no_remote"
  | "other_server"
  | "not_found"
  | "offline";

/** One changed file, with its unified patch capped for the panel's diff view
 *  (64 KiB). `truncated` is set when CV Hub truncated the patch itself or the
 *  worker cut it to fit; then `patch` holds the shortened text or is omitted
 *  entirely when even that does not fit the panel's payload budget. */
export interface DiffFileView {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed" | "copied";
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  patch: string | null;
}

export interface DiffView {
  headSha: string;
  baseSha: string;
  totalFiles: number;
  /** More files changed than the panel lists. */
  filesTruncated: boolean;
  files: DiffFileView[];
}

export interface SearchResult {
  path: string;
  symbol: string;
  line: number | null;
  content: string;
}

declare module "orca" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginRequests {
    /** Sign-in state: the connection, any attempt in flight, and the API origin a
     *  new sign-in would use. */
    "auth.status": { input: {}; output: AuthStatus };
    /** Starts the OAuth device flow against the configured API origin. */
    "auth.start": { input: {}; output: AuthAttemptView };
    /** Cancels the pending attempt, or any attempt when `attemptId` is null. */
    "auth.cancel": { input: { attemptId: string | null }; output: AuthStatus };
    /** Revokes and removes the saved sign-in. */
    "auth.signOut": { input: {}; output: { signedOut: boolean; revoked: boolean } };
    /** Repositories hosted on the signed-in CV Hub, one page at a time. */
    "repos.list": {
      input: { offset: number; search: string };
      output: { repositories: RepoRef[]; total: number };
    };
    /** Pull requests of one repository, one page at a time. */
    "pulls.list": {
      input: { owner: string; repo: string; offset: number; state: "open" | "closed" | "merged" | "all"; mine: boolean };
      output: { pulls: PullSummary[]; total: number };
    };
    /** One pull request, with the source branch's live head. */
    "pull.get": { input: RepoRef & { number: number }; output: PullDetail };
    "pull.checks": {
      input: RepoRef & { number: number };
      output: { checks: CheckItem[]; total: number };
    };
    "pull.reviews": {
      input: RepoRef & { number: number };
      output: { reviews: ReviewItem[]; total: number };
    };
    /** The changed files with their patches, capped for the panel's diff view. */
    "pull.diff": { input: RepoRef & { number: number }; output: DiffView };
    /** Publishes a review for the inspected revision; refused when the branch moved. */
    "review.submit": {
      input: RepoRef & {
        number: number;
        expectedHeadSha: string;
        state: "approved" | "changes_requested" | "commented";
        body: string;
      };
      output: { id: string; state: string };
    };
    /** Code search through CV Hub's MCP endpoint. */
    "code.search": {
      input: RepoRef & { query: string };
      output: { results: SearchResult[] };
    };
    /** The CV Hub repository detected for Orca's focused workspace. */
    "context.current": {
      input: {};
      output: { repository: RepoRef | null; workspace: WorkspaceMatch };
    };
  }

  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginPanelEvents {
    /** The worker's own view of sign-in, pushed at every phase change so the
     *  panel never polls. */
    "auth.changed": { status: AuthStatus };
    /** The repository detected for the focused workspace, when focus moves. */
    "context.changed": { repository: RepoRef | null; workspace: WorkspaceMatch };
  }
}
