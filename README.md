# CV Hub for Orca

Desktop plugin for CV Hub hosted Git repositories. Sign in with CV Hub in your browser, browse repositories and pull requests, open their changes in **Orca's native Monaco DiffViewer**, inspect CI checks and review history, submit a top-level review, and search code through CV Hub's Streamable HTTP MCP server.

**Requires the CV Hub icon and browser-link patch in [lamtuanvu/orca PR #4](https://github.com/lamtuanvu/orca/pull/4)** (commit `753f986b16`, based on fork `657a6a1d2a`, Orca 1.4.214). The older native-review patch alone cannot load this version’s new browser permission. Nothing extra is needed on CV Hub: sign-in uses its existing public OAuth client. Nothing here installs over your running Orca app.

![CV Hub monochrome mark at large, 24 px and 16 px sizes in light and dark colors](docs/assets/cv-hub-monochrome.png)

The monochrome vector is adapted from `apps/web/public/branding/controlvector/logo.png` in the CV Hub project. It inherits Orca’s text color in the sidebar and plugin header.

## Build and install

This repository holds the plugin only; the server side lives in [controlvector/cv-hub](https://hub.controlvector.io/controlvector/cv-hub). Design notes and the original implementation plan are in [`docs/design/`](docs/design/).

1. Nothing to set up on CV Hub. The plugin signs in as `cv-git-cli`, the public device-flow client CV Hub ships in every deployment for its own CLI tools (migration `0017_cv_git_oauth_client.sql`). Check a server with `GET <api-origin>/oauth/client-info/cv-git-cli`.

   What that means:
   - The plugin requests only `profile repo:read repo:write offline_access`, not the client's full scope set (which includes `repo:admin`).
   - The client is first-party, so CV Hub's approval page asks you to confirm the code but shows no separate consent screen.
   - In CV Hub's Authorized apps and audit logs, the plugin appears as the cv-git CLI. Revoking that app there signs out cv-git as well as Orca; to sign out only Orca, use **Sign out** in the plugin, which revokes its own tokens.
2. In this repository, run:

   ```sh
   pnpm install --frozen-lockfile
   pnpm build
   node scripts/check-package.mjs
   ```

3. Check out the patched fork commit, or apply the bundled patch to its exact base:

   ```sh
   git clone https://github.com/lamtuanvu/orca.git /tmp/orca-cv-hub
   git -C /tmp/orca-cv-hub checkout 657a6a1d2a5a6f8c63b3ed138a1084e83a5ed7e2
   node scripts/apply-host-patch.mjs /tmp/orca-cv-hub
   ```

   Follow that checkout's prerequisites and build instructions (`pnpm install`, `pnpm run build:desktop`). For an interactive launch, use the command below from the Orca checkout. `ORCA_DEV_USER_DATA_PATH` selects a development profile; do not use `ORCA_E2E_USER_DATA_DIR`, which requires the test harness's disposable-home setup. The host patch is pinned to the commit in [host-patches/base.json](host-patches/base.json); rebasing onto other versions needs review.

   ```sh
   env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE -u ORCA_BACKGROUND_LAUNCH \
     -u ORCA_E2E_USER_DATA_DIR -u ORCA_E2E_HOME_DIR \
     NODE_ENV=development \
     ORCA_DEV_USER_DATA_PATH=/tmp/orca-cv-hub-profile \
     node node_modules/electron/cli.js .
   ```

4. In the patched Orca, enable the plugin system in Settings → Plugins, install a local folder using the **absolute path to this repository's `dist/`**, then review and enable **CV Hub**. `pnpm run package` checks the build; to make a ZIP of the same three files, run `cd dist && zip -X ../artifacts/cv-hub-orca-0.4.0.zip main.mjs panel.html orca-plugin.json` (`artifacts/` is not committed) and can be extracted into a local install folder.

   **Upgrading to 0.4.0 requires re-approval.** Review and enable the plugin again to grant `browser:open-external` and its PR-opening command. On local deployments with separate API and web ports, sign out and sign in once to save the verified web origin; older profiles fall back to the API origin with an `api.` prefix removed.
5. Open **CV Hub** in the right sidebar. The server defaults to CV Hub at `https://api.hub.controlvector.io`; for a self-hosted or local server, open **Connection settings** and enter its **API origin** (not its frontend URL or an `/api` path; locally `http://localhost:3001`). The plugin remembers the server you last signed in to. HTTPS is required except for loopback development servers. Choose **Sign in with CV Hub**, then **Continue in browser** and approve the code on CV Hub's `/device` page. Approving read-only still allows browsing; publishing reviews needs `repo:write` and repository write access.
6. Choose a repository and PR, then **Open changes in Orca**. Close the native review dialog to submit feedback from the sidebar.

![Native CV Hub diff in Orca](docs/native-review.png)

## What the native review does

The review is built from the two endpoints CV Hub's own pull-request page uses. `GET .../pulls/:number/diff` fixes the revision: the target tip and source head SHAs, the changed files, and each file's patch (hunks relative to the merge base, which is what `base...head` diffs against). For each file Orca asks for, the worker loads the new side from `GET /api/v1/repos/:owner/:repo/blob/<headSha>/<path>` and rebuilds the old side by undoing that file's patch, which gives the merge-base version even after the target branch has moved on. Renames and copies, additions, deletions, empty files and missing final newlines are handled; the reconstruction is checked against git's own diffs in the tests. If a patch doesn't match the file, that file shows an error, never a guessed or empty original.

The diff is cached in the worker per review revision; after a worker restart it is refetched, and if the PR has moved on since the review opened, its files report that the pull request changed. Files whose patch CV Hub truncates (over 256 KiB, or past its 4 MiB total) show the new side with the old side marked as too large.

Orca owns the file navigation and read-only DiffViewer, with side-by-side/unified modes and model cleanup. Provider context and file contents stay out of the sandboxed iframe. Binary/non-UTF-8 files and files above 2 MiB are shown as explicit unsupported/limited states. Snapshot metadata is limited to 2,000 files / 1 MiB. File contents load lazily, one file at a time; only the diff is cached.

This version uses a native **dialog with one selected file**, not a central editor tab or combined scrolling diff. It does not stage, edit, merge, check out branches, or create inline threads. GitHub-mirrored repositories, Orca remote/web clients, and inline comments are outside this version.

## Reviews and authentication

Sign-in is the OAuth 2.0 device authorization grant (RFC 8628) with CV Hub's public CLI client `cv-git-cli`. The worker requests the code, polls `/oauth/token` (honoring `interval`, `slow_down`, expiry, denial, and a bounded offline backoff), and verifies identity (`/api/auth/me`) and MCP discovery with the new token before declaring the connection complete. The device code, access token and refresh token never reach the panel: the panel sees an opaque attempt ID, the user code, the verification address, and the account profile. Tokens live only in Orca's encrypted secret store; profile metadata uses private plugin storage.

The worker validates the verification address before offering to open it: it must be CV Hub's `/device` page on the API origin, or on the web host beside an `api.` API host (API `https://api.hub.example.com` → page `https://hub.example.com/device`), which is how CV Hub is deployed. A loopback API accepts a loopback page on any port, for local development. It then registers the URL with Orca (`browser.createAuthorization`, remaining lifetime capped at 900 s) and asks Orca to open it (`browser.openAuthorization`), which shows a native confirmation naming the server and destination. The panel command returns immediately; the confirmation outcome arrives through status polling, and each handle is cancelled after use, on completion, denial, failure or cancellation. Orca's handles never reach the panel. When Orca can't open the browser — declined, rate limited (one request per ten seconds), reset by a plugin refresh, missing host support, or an address the worker couldn't verify — the panel says why and always shows the user code and a copyable verification address. **Copy code**/**Copy address** use the clipboard when the sandbox allows it and otherwise select the text for ⌘C/Ctrl+C.

Refreshes are serialized and the rotated refresh token is persisted before use. A rejected refresh marks the session expired (**Sign in again**) without discarding repository selection or drafts for that account. A 401 on a read refreshes once and retries; writes are never replayed. Sign-out cancels any pending attempt, deletes local credentials first, then revokes the refresh and access tokens on the server and reports a failed revocation separately. Profiles saved by the earlier PAT version are shown a **Sign in again** prompt; the PAT is deleted after OAuth sign-in or sign-out and is never used as an OAuth token. Connections reject redirects and cross-origin MCP discovery. A new sign-in invalidates old native-review contexts. Authorization attempts live in the worker: reloading the panel resumes a pending attempt, but a worker restart ends it and the user starts again.

The panel compares the revision you inspected with the source branch's live head (`GET /api/v1/repos/:owner/:repo/commits?ref=refs/heads/<branch>&limit=1`), not the PR's `sourceSha` field, which older CV Hub versions set only when the PR is created and newer ones update after a push lands. Before submitting, the worker checks the head again and refuses a review of a revision that is no longer current. The submission also carries `expectedHeadSha`. CV Hub versions without the review-integrity fix ignore that field, so a push landing between the check and the submission can't be caught, and those versions record every review against the PR's creation-time commit and count approvals from any commit. Once the fix is deployed, CV Hub rejects a stale submission with 409 and counts approvals only for the commit being merged. Write requests are never automatically retried; after an uncertain result the panel requires reloading the review history, and only allows a retry once it confirms the review is absent. Feedback drafts are kept in the panel's memory, keyed by server, account, repository and PR; they are cleared on sign-out.

MCP code search discovers `search_code` on the authenticated `/mcp` endpoint; it returns up to eight bounded snippets. The panel displays the endpoint for separate coding-agent setup. Plugin installation does not add agent tools or skills.

## Orca host contract

Click the CV Hub web address in PR details to open it in your default browser. **Copy PR link** remains available (or text selection when the clipboard is unavailable). Both use the web origin verified during sign-in, including separate local frontend ports. If browser opening is unavailable, the panel explains how to copy the link. When reviewing your own PR, the approval option is labeled **Self approve** and uses the same permissions and current-revision checks as other approvals.

The plugin targets the fork’s native review host plus the icon and browser-link extension at `753f986b16`:

- **Explicit panel commands** (`commands:invoke-own`). Only commands with a `panel` contract in `orca-plugin.json` are callable from the iframe, each with a bounded input/output schema that Orca validates before running the command and before replying. The contracts live in `src/shared/panel-contracts.ts`; the build writes them into the manifest, and the worker checks its own view models against them too. Exposed: sign-in status/start/cancel/continue, sign-out, paginated repositories and pull requests, PR details, checks, reviews, review submission, PR browser opening, code search. Opening a PR takes only owner, repository and PR number; the worker derives its URL from the saved connection. No generic fetch, method forwarding or tokens are exposed.
- **Native review provider** (`diffs:open`). `contributes.reviewProviders` declares `cvhub.pullRequest` → snapshot `cvhub.getReview`, content `cvhub.readReviewFile`; both loaders are worker-only commands without panel contracts. The panel calls `diffs.openReview({ providerId: "cvhub.pullRequest", args: { owner, repo, number } })` and receives only `{ reviewId, revision }`. Failed file reads return an `error` side for that file.
- **Worker-only browser authorization** (`browser:authorize`), described above.
- **Worker-only browser links** (`browser:open-external`): `browser.openExternal({ url })` opens HTTPS or loopback HTTP in the desktop browser after plugin permission consent, without an extra confirmation per link. The iframe still cannot navigate or call this API directly; `cvhub.openPullRequest` builds the destination in the worker.

Refreshing, updating or disabling the plugin invalidates open reviews and pending browser handles; the panel asks you to reopen the review or start sign-in again. A worker restart ends a pending sign-in. The worker remains subject to Orca's trusted-plugin model: approving it grants native code execution; these capabilities describe what the panel may ask the host to do, not a Node sandbox.

## Verification

```sh
pnpm type-check
pnpm test
pnpm build
node scripts/check-package.mjs
```

The Electron test for this plugin version is `e2e/cv-hub-plugin.spec.ts` (device-flow sign-in against a local fixture API, then the native diff). Copy it into the Orca checkout's `tests/e2e/`, then, after its E2E build prerequisites:

```sh
ORCA_BACKGROUND_LAUNCH=1 CV_HUB_PLUGIN_PATH=/absolute/path/to/cv-hub-orca-plugin/dist pnpm exec playwright test --config tests/playwright.config.ts cv-hub-plugin.spec.ts --workers=1
```

See [VALIDATION.md](VALIDATION.md) for the executed checks and environment limits.
