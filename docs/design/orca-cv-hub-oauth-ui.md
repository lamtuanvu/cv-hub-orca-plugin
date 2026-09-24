# Handover prompt: CV Hub for Orca — OAuth and GitHub-inspired UI

You are the product UI design and implementation agent for the CV Hub Orca plugin. Improve the existing working plugin, preserving its native PR diff integration. Deliver a usable implementation, not only mockups.

## User intent

Make CV Hub easy to use inside Orca: sign in, find a repository, select a PR, inspect its changes in Orca's native diff viewer, understand checks, and submit a review. Take inspiration from GitHub's repository and PR navigation, information density, status cues, and review workflow. Adapt this to an IDE sidebar; do not copy a full GitHub website into the panel.

Authentication must use CV Hub OAuth. This plugin is a public OAuth device client acting on the signed-in user's behalf. Replace the normal PAT-paste workflow with browser authorization. No embedded client secret, plugin password form, or separate account system.

## Workspace and current state

- CV Hub worktree: `/Users/vulam/kepler/worktrees/cv-hub-cv-hub-plugin-integration-3f13528b`.
- Plugin source: `packages/orca-plugin`; existing changes are uncommitted. Preserve them.
- Patched Orca checkout: `/tmp/orca-cv-hub-implementation`.
- Deliverable host patch: `packages/orca-plugin/host-patches/orca-native-plugin-reviews.patch`, pinned to Orca commit `8d6fec597bfae3f1e1bf961a6cae2837f925a3b2`.
- Read the plugin README, VALIDATION.md, and each checkout's applicable instructions first.
- The current plugin uses PAT authentication. OAuth below is the requested next implementation, not a completed feature.
- Working capabilities: hosted repository list/search, PR list/detail, native diffs, checks, top-level review history/submission, MCP code search.
- Existing diff viewer is a native dialog displaying one selected file, with a file navigator and split/unified modes. It is not an editor tab or a combined scrolling PR view.
- No inline comment threads, merge action, branch checkout, or remote/web Orca support in this scope. Do not invent working buttons for unsupported operations.

## Authentication workstream and UI contract

Implement OAuth first or coordinate its implementation against an explicit typed interface. If assigned UI-only responsibility, implement the presentation against a clearly labeled fixture adapter, document the missing production adapter, and do not claim live sign-in works.

Use a dedicated public client, proposed ID `cv-hub-orca`, display name `CV Hub for Orca`, registered on each CV Hub deployment. Reuse the existing authorization server and device grant. Supply an idempotent registration script and installation instructions. Do not reuse another application's identity or bake in a secret. Existing MCP dynamic registration requires a redirect URI, so do not assume it supports registration of a redirect-free device client unchanged.

Relevant existing server files:

- `apps/api/src/routes/device-auth.ts` and `services/device-auth.service.ts`.
- `apps/api/src/routes/oauth.ts` and `services/oauth.service.ts`.
- `apps/api/scripts/register-device-agent-client.ts` as a registration pattern, not an identity to reuse.
- `apps/api/src/middleware/auth.ts`, `middleware/mcp-auth.ts`, and `services/mcp-oauth.service.ts` for token/scope validation.

Flow:

1. User chooses the CV Hub API origin and clicks **Sign in with CV Hub**. Keep server settings compact and editable; never invent a production hostname. Local API is `http://localhost:3001`.
2. Worker sends a form POST to `/oauth/device/authorize` with its client ID and explicit scopes. Proposed initial scopes: `profile repo:read repo:write offline_access`. Explain that this includes publishing PR reviews. No admin/deploy scopes. Respect actual granted scopes; read-only authorization must still allow browsing.
3. Present the returned user code, verification URL, expiration, **Continue in browser**, **Copy code**, and **Cancel**. Always display the code even when using `verification_uri_complete`. Approval happens on CV Hub's existing `/device` page in the system browser. Never approve the request programmatically on the user's behalf.
4. Worker polls form POST `/oauth/token` using `urn:ietf:params:oauth:grant-type:device_code`, honoring the server interval, `slow_down`, expiry, denial, and bounded network backoff. The secret device code stays in the worker.
5. Store access and refresh tokens in Orca's encrypted secret store; expose only safe connection state/profile to the panel. Use access tokens for both REST and MCP. Verify identity and MCP discovery with the authenticated endpoints before declaring sign-in complete.
6. Refresh through `/oauth/token` with the refresh grant. Serialize refreshes, persist rotated tokens, honor expiry, and handle revocation with a clear **Sign in again** state. Never automatically replay a review POST after an uncertain result.
7. On sign-out, cancel pending authorization/refresh, clear local credentials and identity-scoped state, invalidate native review contexts, and attempt server revocation of the current tokens. Report failed remote revocation separately without retaining local credentials.

Proposed new worker commands: `auth.start`, `auth.status`, `auth.cancel`, `auth.openVerification`, plus existing status/disconnect behavior. Names are proposals; keep manifest, runtime validation, tests, and panel adapter synchronized. Bind authorization attempts to an opaque attempt ID, origin, and connection generation. Late poll/refresh results must not reconnect a canceled or switched account.

The panel bridge currently times out after 35 seconds. Do not make one command wait for an entire authorization flow; use short start/status/cancel calls with worker-owned state. Test panel reload and worker restart recovery. Migrate the existing PAT profile explicitly: prompt for OAuth sign-in, then replace/delete old credentials on success or disconnect; never pretend a PAT is an OAuth token.

Host dependency: the sandboxed panel blocks links, `window.open`, network requests, and form navigation. No supported browser-opening plugin API was found in this pinned host. Add a small, explicit host bridge capability for browser opening and update the patch/tests; do not bypass it with shell commands or weaken the panel sandbox. Resolve the active verification URL in trusted code; accept only validated HTTP(S) URLs, HTTPS except loopback development, and no credentials or executable URL schemes. The returned verification URL can use a different frontend origin from the API (locally 5174 versus 3001). Do not confuse browser navigation with token endpoint origin checks. Ensure Copy code works in the actual sandbox or provide a selectable-code fallback.

## UI direction

Use Orca's injected theme variables, restrained borders, compact spacing, readable typography, and consistent icons. Support dark and light themes. Use green/red/purple status accents with text/icon equivalents. Avoid oversized form controls, excessive blank space, gradients, dashboard tiles, and raw stack traces.

Design these connected views:

1. **Sign-in:** short explanation, server setting, primary sign-in button, browser approval state, connected identity. Explicit pending, denied, expired, offline, invalid-client, and reauthentication states with useful next actions.
2. **Repository and PR browser:** compact repository switcher with search; PR rows with title, number, author, state/draft indicator. Filters for Open, Closed, Merged, All, and My open PRs using existing APIs. Preserve pagination and selection. Do not fabricate counts, timestamps, labels, review-request filters, or unread status if the API does not supply them.
3. **PR details:** breadcrumb/back navigation, title and number, status, source → target branches, safe Markdown description, and compact Overview / Checks / Reviews sections. Keep **Open changes in Orca** prominent. On narrow panels show one level at a time and preserve list position when returning. On wider panels, use list/detail panes only where they remain readable.
4. **Review:** display current checks and existing top-level reviews, then a draft composer with Comment / Approve / Request changes. Explain why submission is disabled (read-only scope, no inspected snapshot, or stale revision). Preserve drafts during navigation, keyed by connection/account and PR. Clear sensitive state on sign-out/account switch. Handle uncertain submissions by reloading review history before a manual retry.
5. **Code search:** secondary navigation within the selected repository; query input and readable result snippets with file path, symbol, and line when available. Preserve MCP-backed behavior. Avoid a nonfunctional file-opening affordance if no supported host action exists.

Errors belong near the failed operation. Say what failed and give a relevant retry action; retain usable sections if checks or reviews fail independently. Provide optional sanitized diagnostic details, never credentials or an unbounded worker stack. Include skeletons, empty states, keyboard navigation, visible focus, accessible labels/status announcements, and protection against stale async responses overwriting a newer selection.

## Preserve native diff correctness

Use the existing `diffs.openReview` host action with snapshot command `cvhub.getReview` and content command `cvhub.readReviewFile`. The panel receives a review handle/revision; trusted host code owns file content loading and Monaco. Do not render replacement diffs inside the iframe.

Preserve immutable merge-base/head blobs, old/new rename paths, additions/deletions, binary/oversized/missing-file states, lazy loading, and split/unified controls. Submit reviews with the exact inspected full head SHA. A changed PR must require opening its new changes before submitting against that revision. Retain backend scope/ACL enforcement and stale-review protection.

Native dialog styling may be improved in `src/renderer/src/components/external-review/external-review-dialog.tsx` in the Orca checkout if needed. Preserve session ownership, close/disable invalidation, and model cleanup. Regenerate the deliverable host patch if host code changes.

## Implementation entry points

- Panel: `packages/orca-plugin/src/panel/{index.ts,index.html,style.css,bridge.ts}`; currently plain TypeScript/DOM and CSS, bundled with esbuild.
- Worker: `src/worker/{connection.ts,activate.ts,rest-client.ts,mcp-client.ts,pr-review.ts}` within the plugin.
- Runtime schemas: `src/shared/contracts.ts`; command/capability manifest: `orca-plugin.json`.
- Reuse the existing stack unless a dependency has a clear benefit. Bundle assets; the panel cannot load CDN scripts/fonts/images. Sanitize Markdown and route external navigation through the supported host bridge.

## Validation and delivery

Show the proposed layouts and interaction states before broad UI implementation. Then build the approved direction and deliver screenshots plus a working plugin package. Keep live integrations distinct from fixtures.

- Run plugin tests, type-check, build, and package validation. Add meaningful OAuth lifecycle tests (pending/slow-down/denial/expiry, refresh rotation, cancellation races, scope reduction, sign-out) and relevant host bridge tests.
- Verify authenticated REST and MCP with an actual device-granted token, not only a mocked PAT. Do not expose tokens in logs or screenshots. User approval in the browser remains a human action.
- Verify sign-in → repositories → PR → native diff → return → review; account switch/sign-out; dark/light and narrow/wide layouts. Test binary, rename, deletion, large-file, failed-request, and stale-head states. Do not publish test reviews to unrelated repositories.
- Build the ZIP and update README/VALIDATION with actual evidence and any remaining limitations. Do not claim OAuth or UI flows are complete based only on screenshots or mocked responses.
- Use `env -u NODE_OPTIONS` for Node/pnpm commands in this workspace. Agent-run Electron must keep `ORCA_BACKGROUND_LAUNCH=1`. Follow the README's development-profile instructions, not manual E2E environment variables.
- Existing local database and Git repositories contain user data. Do not reset them or rerun the broken historical migration chain. Read current Kepler task notes for local setup; the API uses an absolute `GIT_STORAGE_PATH` into the older worktree. Preserve it.

References: [OAuth device authorization](https://www.rfc-editor.org/rfc/rfc8628), [GitHub PR review workflow](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request). GitHub is interaction inspiration; implement only CV Hub/Orca capabilities verified above.
