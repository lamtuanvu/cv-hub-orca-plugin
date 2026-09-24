# Orca CV Hub Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task after design review. Steps use checkbox syntax. This document is a proposed build plan, not authorization to implement or a claim that the proposed Orca APIs exist.

**Goal:** Browse CV Hub PRs in an Orca plugin and review their immutable changes through Orca's native diff components.

**Architecture:** A sandboxed sidebar panel invokes its own Node worker through a new generic Orca bridge. The worker uses CV Hub REST/MCP and supplies immutable review manifests and lazily fetched file bodies to a new Orca native external-review surface. CV Hub exposes the merge-base SHA needed for correct comparison.

**Tech Stack:** Orca Electron/React/TypeScript/Zod/Monaco; CV Hub Hono/TypeScript; MCP SDK Streamable HTTP; Vitest. Bundle the panel to inline HTML/JS/CSS and the worker to ESM.

**Spec:** [Research and proposed design](../specs/2026-09-23-orca-cv-hub-design.md).

## Global constraints

- Desktop first; CV Hub hosted Git repositories first.
- PR native diffs must work without cloning or checking out a PR.
- Use the existing Orca diff renderer; no separate plugin Monaco/diff implementation.
- All `commands.invokeOwn`, `diffs.openReview`, and related capability names below are proposed additions.
- Credentials stay in the worker/Orca secret vault and never enter persisted panel or editor state.
- Compare immutable merge-base/head SHAs, not moving branch names or target tip/head.
- PR diffs are read-only and have no staging, saving, or local file mutation behavior.
- No product dependencies, product code, release, or upstream PR are created by this planning task.

## Review focus

- Diverged target and force-pushed source: display only the captured PR changes; ignore stale responses after refresh.
- Empty/absent/error sides: a failed blob read must never appear as a deletion or empty file.
- Rename and unusual paths: use old path on the original side, preserve Unicode/spaces/#/%/tabs, reject traversal in any future filesystem adapter.
- Worker/window/account replacement: results stay bound to their initiating owner; never cross accounts, windows, or plugin generations.
- Large/binary data and lifecycle: bounded fetching/caching, explicit fallback, released models, and no secret-bearing logs.

## Repositories and file ownership

Orca changes belong in `stablyai/orca`, on a future attached development worktree. `/tmp/cv-hub-orca-research` is only a research checkout. The plugin can initially live at `packages/orca-plugin` in this CV Hub monorepo, which is already covered by `pnpm-workspace.yaml`. Its release artifact must have `orca-plugin.json` at the artifact root; a pinned Git install cannot be assumed to select a monorepo subdirectory.

| Location | Responsibility |
| --- | --- |
| Orca `src/shared/plugins/plugin-host-api.ts`, `plugin-capabilities.ts` | Public method schemas, version/capability metadata |
| Orca `src/main/plugins/plugin-panel-controller.ts`, `plugin-host-method-bindings.ts`, `plugin-host-service-bindings.ts` | Verified panel identity, invocation ownership, service routing |
| Orca new `src/shared/plugins/plugin-review-contract.ts` | Provider-neutral external-review DTO schemas |
| Orca new `src/main/plugins/plugin-review-sessions.ts` | Owned snapshot/loader registry, bounded requests and invalidation |
| Orca new `src/renderer/src/components/external-review/` | Native review tab, file tree, lazy sections, read-only single-file diff |
| Orca editor tab types/actions, IPC/preload/runtime adapters | Open/render/close external review and preserve originating window |
| CV Hub `apps/api/src/services/git/git-backend.service.ts` | Merge-base resolution, metadata-only comparisons, bounded text retrieval |
| CV Hub `apps/api/src/services/pr.service.ts`, `routes/pull-requests.ts` | Immutable PR snapshot route and review authorization |
| CV Hub `apps/api/src/mcp/tools/repo.ts` | Additive `merge_base_sha` output |
| Plugin `src/worker/{activate,connection,rest-client,mcp-client,pr-review}.ts` | Command handlers, auth, service clients, normalization |
| Plugin `src/shared/contracts.ts` | Validated panel DTOs and worker content-command args/results |
| Plugin `src/panel/{index,connection,pr-list,pr-detail}.tsx` | Connection/repository selection and PR workflows |
| Plugin `scripts/build.mjs`, `orca-plugin.json`, `README.md` | Bundled artifacts, declared commands/capabilities, install instructions |

## Proposed core contracts

These DTOs are a concrete starting point for Task 1's Orca API review. Runtime schemas must enforce the constraints listed below; TypeScript types alone are insufficient.

```ts
type SnapshotFile = {
  path: string;
  oldPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';
  additions: number;
  deletions: number;
  binary: boolean;
};

type ReviewSnapshot = {
  connectionId: string; // nonsecret, resolves to worker-owned origin/account
  repositoryId: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  baseSha: string;      // target tip; preserve existing API meaning
  mergeBaseSha: string; // actual original side
  headSha: string;
  files: SnapshotFile[];
};

type OpenReviewInput = {
  review: ReviewSnapshot;
  contentCommandId: string; // same plugin's declared worker command
};
type OpenReviewResult = { reviewId: string };

type ReviewFileInput = {
  review: Omit<ReviewSnapshot, 'files'>;
  file: SnapshotFile; // selected by host from the stored manifest
};
type FileSide =
  | { kind: 'text'; content: string }
  | { kind: 'absent' }
  | { kind: 'binary'; size?: number }
  | { kind: 'limited'; size?: number; reason: string }
  | { kind: 'error'; code: string; message: string };
type ReviewFileResult = { original: FileSide; modified: FileSide };
```

The host supplies plugin/window/session identity outside plugin-controlled DTOs. Bind `connectionId` to an account generation and reject stale generations after reconnect. The host must not invoke arbitrary content commands with arbitrary filesystem paths; command identity is manifest-checked and input comes from its owned snapshot.

Initial proposed limits: 2,000 files and 1 MiB serialized metadata per review; 2 MiB UTF-8 text per side; 4 concurrent content loads; 32 MiB text cache per plugin; 30-second calls. Return explicit limited states when exceeded. Retain Orca's renderer limits as a second layer. These are transport/memory limits, not assurances that every under-limit file renders quickly. Review them against real PR fixtures in Task 6.

## Task 1: Prove panel → worker → native diff in Orca

**Deliverable:** A fixture plugin opens a read-only native diff containing supplied original/modified text, with correct ownership. This is the feasibility gate before building the CV Hub UI.

**Modify:** Orca host API/capability tables, panel/controller/service bindings, worker invocation plumbing, and renderer/preload event routing listed above.
**Create:** `src/shared/plugins/plugin-review-contract.ts`, `src/main/plugins/plugin-review-sessions.ts`, `src/renderer/src/components/external-review/external-review-tab.tsx`, `examples/plugins/external-review/{orca-plugin.json,main.mjs,panel.html}` and colocated tests.
**Consumes:** Existing panel sessions, command registry/worker manager, consent gate, `DiffViewer`.
**Produces:** `commands.invokeOwn`, `diffs.openReview`, validated review DTOs, origin-bound review session lifecycle.

- [ ] Add failing bridge tests: a panel can invoke its own declared command; caller-supplied plugin identity, another plugin's command, built-in command aliases, invalid args, oversized replies, and revoked sessions fail.
- [ ] Add the panel method and `commands:invoke-own` capability. Resolve identity from the existing session token; use existing worker startup/timeouts. Extend host method scope/schema deliberately instead of claiming this is workspace access.
- [ ] Thread a host-owned originating renderer/window context across asynchronous worker calls. Test focus changes and closed/replaced windows; reject unavailable origins rather than opening somewhere else.
- [ ] Add `diffs.openReview`/`diffs:open` with owned manifest and same-plugin content loader. Route only opaque review IDs to the renderer. Add limits and cancellation to the new content transport.
- [ ] Render a single selected text file through existing `DiffViewer`, with distinct snapshot model keys, `editable={false}`, no `worktreeId` or local save/stage callbacks, and no implicit local diff notes.
- [ ] Test worker restart, plugin disable/uninstall, tab close, repeated-open deduplication, and disposal of Monaco models. Keep the snapshot in host memory; a restarted worker receives enough pinned input to refetch.
- [ ] Add the fixture panel and worker. Demonstrate a native before/after diff in a running Orca build. Confirm that data never passes through relaxed iframe networking or parent-store access.
- [ ] Run the focused Orca Vitest suites and `pnpm typecheck`. Commit only after the runtime demonstration works. Record the host API version/minimum engine that actually contains the new hooks.

**Stop criterion:** If upstream API direction changes, adjust this contract before the CV Hub plugin relies on it. A panel-local imitation of the diff renderer does not pass this milestone.

## Task 2: Expose a correct, immutable CV Hub PR snapshot

**Deliverable:** PR metadata and blobs can be joined into the exact native before/after diff.

**Modify:** `apps/api/src/services/git/git-backend.service.ts`, `services/pr.service.ts`, `routes/pull-requests.ts`, `mcp/tools/repo.ts`.
**Create/extend tests:** `services/git/git-backend.diff.test.ts`, new `services/pr-review-snapshot.test.ts`, new `routes/pr-review-snapshot.test.ts`.
**Consumes:** Existing repository authorization and Git diff/blob services.
**Produces:** Additive `mergeBaseSha`/`merge_base_sha` and proposed `GET /api/v1/repos/:owner/:repo/pulls/:number/review-snapshot` returning `{ snapshot }` with metadata-only files and resolved SHA fields.

- [ ] Add a Git fixture in which main and feature diverge. Assert original text comes from the merge base, not main's latest tip. Run it red before modifying comparison output.
- [ ] Resolve target/head once, compute `git merge-base` from those SHAs, and generate metadata against the pinned merge-base/head pair. Preserve the old meaning of `baseSha` and add `mergeBaseSha` to REST and `merge_base_sha` to MCP.
- [ ] Add the snapshot route with explicit repository access checks, local-provider gating, metadata size/file-count errors, and no full patch payload. It must return the SHAs actually used by Git, not possibly stale PR database fields.
- [ ] Add bounded blob retrieval for the plugin path: inspect object size before decoding, preserve binary as a separate state, and avoid reading an oversized object merely to report it is oversized. Retain existing generic blob API compatibility; add explicit bounded options or a dedicated snapshot-file route as part of this change's contract tests.
- [ ] Test modified/added/deleted/renamed/copied/empty/binary files, unusual encoded paths, inaccessible repositories, no merge base, moved branches, and unavailable old objects. A missing ref returns a named unavailable/error state, not an empty side.
- [ ] Define deleted-branch behavior: while retained SHA snapshots remain readable, existing tabs work; if no reconstructable snapshot exists, show unavailable. Do not promise historical PR reconstruction until retained snapshot metadata is implemented.
- [ ] Run `pnpm --filter @cv-hub/api test:run src/services/git/git-backend.diff.test.ts src/services/pr-review-snapshot.test.ts src/routes/pr-review-snapshot.test.ts`, the affected MCP tool tests, and `pnpm --filter @cv-hub/api type-check`; commit the contract change.

## Task 3: Installable plugin with connection and PR browsing

**Deliverable:** Install the bundled plugin, connect a CV Hub account, select a repository, and browse paginated PRs in Orca.

**Create:** `packages/orca-plugin/package.json`, `tsconfig.json`, `orca-plugin.json`, `scripts/build.mjs`, `src/shared/contracts.ts`, worker `activate.ts`, `connection.ts`, `rest-client.ts`, panel entry/connection/PR-list modules, and their tests.
**Consumes:** Task 1 own-command bridge and existing CV Hub PR REST endpoints.
**Produces:** Declared commands `cvhub.connect`, `cvhub.disconnect`, `cvhub.listRepositories`, `cvhub.listPulls`, `cvhub.getPull` and a bundled plugin release directory.

- [ ] Add contract tests with fake host/HTTP transport for success, invalid credentials, pagination, malformed DTOs, 429 responses, timeouts, and account switching.
- [ ] Build an ESM worker and self-contained inline panel document compatible with Orca CSP. Validate the manifest with Orca's parser; declare only required capabilities (`storage`, `secrets`, and the new own-command/diff capabilities). Set the engine minimum from Task 1, not the old sample's version.
- [ ] Implement connection discovery using `/api/mcp/connection-info` and scoped PAT storage through `secrets.set`. Clear token input after setup, return masked connection state only, and purge cache/secret on disconnect. Redact sensitive command args and HTTP headers.
- [ ] Implement an origin-bound REST client with URL-segment encoding, bounded response reads, explicit errors, cancellation, and limited retries for reads. Never automatically retry review writes.
- [ ] Implement explicit repository selection and paged PR list/detail DTOs. Clip long descriptions in list replies to remain within the panel bridge budget. Do not infer the remote repository from a branch/display name.
- [ ] Add useful loading, empty, disconnected, forbidden, and unsupported-provider states. Use the host's injected design tokens and accessible keyboard controls.
- [ ] Run plugin tests/typecheck/build, install the generated directory through Orca's local plugin UI, and verify browsing against a development CV Hub instance. Commit the installable browsing milestone.

## Task 4: Real PR files in Orca native review tabs

**Deliverable:** The first end-to-end user goal: **Open changes** displays accurate native PR diffs without a local checkout.

**Create:** Plugin `src/worker/pr-review.ts` and tests; Orca `external-review/{external-review-sections,external-review-content,external-review-file-tree}.tsx`/tests as required.
**Modify:** Plugin PR detail panel/manifest/activation; Orca external-review session and tab implementation.
**Consumes:** Task 2 snapshot and bounded blobs; Task 1 native review host API.
**Produces:** Worker commands `cvhub.openPullChanges`, `cvhub.readReviewFile`, lazy combined and single-file native review.

- [ ] Add normalization tests using the spec's complete status matrix. For rename, assert original fetch uses `oldPath@mergeBaseSha`; for deletion, assert only the modified side is absent; for a failed original read, assert an error state.
- [ ] `cvhub.openPullChanges` fetches the snapshot, adds the nonsecret connection binding, calls `diffs.openReview`, and returns only the review handle/summary to the panel.
- [ ] `cvhub.readReviewFile` checks the current connection/account generation and reads pinned contents. Return the `FileSide` union without collapsing empty/limited/error cases. Enforce concurrency, memory limits, and request cancellation.
- [ ] Reuse native `DiffSectionItem`, diff file-tree primitives, and lazy/virtualized loading patterns for the external-review view. Keep provider-independent rendering separate from the current GitHub-specific wrapper.
- [ ] Add unified/side-by-side controls, navigation, read-only labels, explicit snapshot refresh, and a binary/oversize/unavailable placeholder. Expose existing native diff preferences where compatible.
- [ ] Test two PRs with identical paths, two CV Hub origins, target divergence, force-push during loading, worker idle/restart, and account replacement. Assert stale responses cannot update the new review's models.
- [ ] Run focused tests/typechecks in both repositories and demonstrate at least one real multi-file PR in Orca. Verify no checkout or dirty-worktree change occurred; commit this milestone.

## Task 5: Checks, review history, and explicit review submission

**Deliverable:** Users can inspect CI/reviews and submit a top-level review from the plugin.

**Modify:** CV Hub `routes/pull-requests.ts`, `services/pr.service.ts` as required for authorization; plugin PR detail and worker commands.
**Create:** Plugin `src/worker/pr-actions.ts`, `src/panel/pr-reviews.tsx`, `src/panel/pr-checks.tsx`, plus authorization/action tests.
**Consumes:** Existing `/checks`, `/reviews`, `/commits`; scoped authentication.
**Produces:** `cvhub.getPullChecks`, `cvhub.listReviews`, `cvhub.submitReview`.

- [ ] Test a read-only PAT attempting review writes and a reader without repository write permission. Enforce backend scope/repository authorization before enabling these controls.
- [ ] Normalize check/review history DTOs and render them with bounded pagination/results. Handle missing checks as empty, separately from fetch failure.
- [ ] Implement explicit Comment / Approve / Request changes submission with retained drafts and a visible result. Re-read current PR/head before submission; if the reviewed head changed, require refreshing/reviewing the new snapshot rather than silently approving unseen changes.
- [ ] On a timeout after a write, show uncertain status and read back reviews before allowing a retry. No blind mutation retries.
- [ ] Test success, forbidden, stale head, timeout-after-success, and draft preservation. Run affected CV Hub/plugin tests and demonstrate submission against a test PR.
- [ ] Keep merge and inline threads out of this milestone. Inline threads require a dedicated backend contract for file/side/commit anchoring and corresponding Orca callbacks; existing DB columns are not a complete API.

## Task 6: MCP intelligence and release validation

**Deliverable:** A focused first intelligence action plus a reproducible, compatible plugin release.

**Create:** Plugin `src/worker/mcp-client.ts`, `src/panel/code-search.tsx`, README and release fixture/tests.
**Consumes:** Discovered Streamable HTTP `/mcp`, `tools/list`, CV Hub `search_code`; prior connection and worker bridge.
**Produces:** `cvhub.searchCode`, a visual result list, documented release artifact and agent connection instructions.

- [ ] Use the MCP SDK for initialization/tool discovery/calls; decode the selected tool's response and surface `isError`. Make feature availability explicit when a deployment lacks a tool. Keep REST as the PR/blob transport.
- [ ] Add a semantic-search panel action and render bounded file/symbol results. Treat credit/quota errors as distinct from empty search results. Do not dispatch tasks or trigger CI as a side effect of browsing.
- [ ] Document the discovered MCP endpoint/scopes for coding agents. State that plugin installation does not automatically configure every agent's MCP client.
- [ ] Test packaged panel CSP behavior, offline/auth expiry, maximum-size fixtures, many-file scrolling, worker crash/reload, disable/uninstall, and two simultaneously open windows. Check that logs, settings, tab snapshots, and artifacts contain no PAT.
- [ ] Test a clean local install of the release artifact on the minimum patched Orca version and a newer supported build. Verify stock Orca lacking the new capabilities rejects installation clearly. Desktop validation is required; SSH-workspace usage runs the plugin on the desktop host, not implicitly on SSH.
- [ ] Publish only after a separate release instruction. For a Git-distributed plugin, provide a release repository/branch with manifest at root and a pinned ref; document the two Orca extension dependencies if they are not yet upstream.

## Follow-on roadmap

| Milestone | UI | Additional contract work |
| --- | --- | --- |
| Inline PR review | Native line comments and threads | CV Hub thread APIs, immutable anchors/outdated handling, Orca comment callbacks including supported sides |
| Code intelligence | Symbol details, callers/callees, dependency graph | Focused typed MCP adapters and result-size limits |
| CI/CD | Pipeline/run/log screens, explicit rerun | Mutation permission checks and unconfirmed-write handling |
| Tasks/executors | Task queue, executor health, explicit dispatch | Task lifecycle mapping and update strategy |
| Workspace awareness | Automatic repository association, checkout links | Public stable workspace/remote identity API in Orca |
| Agent integration | Selected-agent MCP setup | Explicit agent-specific configuration API; no manifest support currently |
| Remote/mobile/external Git providers | Same review semantics across targets | Host transport/secret parity and provider-aware CV Hub blob/snapshot contracts |

Do not expand this work into the whole roadmap before the native-diff milestone passes. The critical dependency chain is **Orca hooks → CV Hub snapshot → plugin connection/browsing → native PR diffs**.


## Implementation record — 2026-09-23

Built under `packages/orca-plugin`; server snapshot/blob endpoints are in this branch. Generic Orca hooks ship as a pinned host patch, since the Orca repository is not a registered repository on this task. See the package README for build/install instructions and VALIDATION.md for test evidence.

Implementation decisions: native DiffViewer is presented in a read-only dialog with one selected file and lazy content loading. Central editor tabs and combined scrolling are deferred. Main binds window/plugin/approval to snapshot loader commands; file contents never go through the panel. The panel receives a review handle and immutable revision. Checks, top-level reviews, and MCP code search are included; inline threads remain unsupported by CV Hub.

The final review found an approval race: a push after submission's head check could leave an old approval eligible for a newer head. Merge eligibility now requires the exact full commit SHA, and Git merges that captured SHA; legacy review submissions resolve the live full source SHA. Approvals with missing/stale SHAs require resubmission.

Real Electron testing caught and fixed blocked iframe form submission, dollar-expansion corrupting the packaged inline script, a missing flex container for Monaco height, and disposing models before detaching the diff editor.
