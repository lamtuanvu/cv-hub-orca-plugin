# Validation — 2026-09-25: plugin 0.3.0 on unmodified CV Hub

0.3.0 needs no CV Hub code change: the native review is built from the diff and blob endpoints CV Hub's web app uses, and sign-in uses a client registered with CV Hub's existing `register-device-agent-client.ts`. Orca [lamtuanvu/orca PR #1](https://github.com/lamtuanvu/orca/pull/1) at `75b02825` (upstream base `8d6fec59`, 1.4.197). Node 24.2.0, macOS arm64.

| Check | Result |
| --- | --- |
| Plugin TypeScript | Passed |
| Plugin tests | 46 passed. New or changed: native diff from `/diff` + `/blob/<headSha>` (rename original at the old path, added/deleted/binary/truncated sides, diff fetched once per revision, PR moved on → `revision_changed`, patch mismatch → error side, no leaks); `reversePatch` against 150 seeded `git diff` cases (CRLF, blank lines, empty files, missing final newlines); live head from `/commits?ref=refs/heads/<branch>`; submission refused without a request when the head moved, `expectedHeadSha` sent otherwise; verification page accepted on the API origin, the web host beside an `api.` API host, and loopback, and refused for lookalike hosts, other paths, ports or origins |
| Reconstruction fuzz (one-off, not committed) | 1,500 random edits reversed from real `git diff` output with no mismatch |
| Against CV Hub's own code (`getDiff` with patches, `getBlob`) on the local `devlocal/diff-demo` repository | All 10 changed files across its branch pairs rebuilt byte-for-byte to `git show <merge-base>:<path>` |
| Plugin build + package check | Passed |
| Electron e2e (`e2e/cv-hub-plugin.spec.ts`, fixture now serving `/diff`, `/blob` and `/commits`) on an Orca build of `75b02825` | 1 passed: sign-in → repository → PR → native diff shows original and modified text (diff and blob request URLs asserted) → unified → Approve enabled |

## Limits of this round

- Not run end to end against a live CV Hub with a real device-granted token after the rework; the endpoints were exercised through CV Hub's service code and the fixture only.
- The blob endpoint's handling of unusual paths (spaces, `#`, `%`, non-ASCII) is covered by the plugin's per-segment encoding test, not against a running API.
- Until CV Hub's review-integrity fix is deployed, a push landing between the plugin's head check and the submission can't be detected, CV Hub records reviews against the PR's creation-time commit, and merges count approvals from any commit.
- The limits of the 2026-09-24 round on Orca's confirmation dialog and review invalidation still apply.

# Validation — 2026-09-24: plugin 0.2.0 on the hardened Orca host

CV Hub base `48e729b` plus native-review API changes that 0.3.0 no longer needs (at that time uncommitted in the cv-hub monorepo, where this plugin lived as `packages/orca-plugin`). Orca [lamtuanvu/orca PR #1](https://github.com/lamtuanvu/orca/pull/1) at `75b02825` (upstream base `8d6fec59`, 1.4.197). Node 24.2.0, macOS arm64. Electron ran with `ORCA_BACKGROUND_LAUNCH=1` and an isolated profile.

| Check | Result |
| --- | --- |
| Plugin TypeScript | Passed |
| Plugin tests | 39 passed: OAuth lifecycle (pending, slow_down, denial, expiry, offline backoff, unregistered client, cancel race revoking late tokens, serialized refresh + rotation, rejected refresh → sign in again, 401 read retry without write replay, read-only grant, sign-out with failed remote revocation, PAT migration, cross-origin MCP discovery); browser authorization (non-blocking create/open, declined → handle cancelled, discovery-verified vs unverified destinations, same-origin fallback, host without `browser:authorize`, rate limit, cancel on denial); panel contracts (all schemas compile under Orca's dialect, loaders stay private, provider declared, manifest matches the generated one, every panel command returns a schema-valid ≤48 KiB view model with no tokens/extra fields from a hostile API, disallowed input rejected, server errors sanitized, snapshot loader returns only the contract shape); content loader (merge-base/old-path originals, head modified sides, `error` sides without leaks, replaced-account snapshots) |
| Plugin build + package check (worker activation, commands registered = declared, loaders not panel-callable, `browser:open-external` absent, inline panel syntax) | Passed |
| CV Hub API capability tests | 155 passed, including 9 new: renames read from `oldPath` at the merge base, added/deleted sides, inspected head still served after later pushes; hidden repositories → 404, PR not in repository → 404, mirrored repositories refused, moving refs and malformed numbers rejected |
| OAuth client registration on the local API (`cv-hub-orca`) | Created; `GET /oauth/client-info/cv-hub-orca` returns it |
| RFC 8414 metadata on the local API | `cv_hub_device_verification_uri` = `http://localhost:5174/device` |
| Bundled host patch | Regenerated as exactly `8d6fec59..75b02825` (38 files); applied to a clean base it reproduces `75b02825` |
| Electron e2e (`e2e/cv-hub-plugin.spec.ts`) on an Orca build of `75b02825`: install (manifest with panel contracts and review provider accepted) → enable → device-flow sign-in via panel commands → repository → PR → `diffs.openReview` by `providerId` → Monaco shows merge-base/head blobs (request URLs asserted) → unified → close → Approve enabled | 1 passed |
| Panel in a browser with a fixture bridge that rejects old `commandId` review params: code + copyable address, Orca-confirmation → declined → "Open browser again", approval → repositories → PR → review opened by provider, checks, review history | Passed by inspection |

## Limits of this round

- **Not yet run against the real CV Hub API with a human approval.** The first live attempt was stopped before any request because the host was being changed; it has not been repeated on `75b02825`. REST and MCP have not been called with a real device-granted token.
- The native `browser.openAuthorization` confirmation dialog was not exercised in Electron (the e2e does not click **Continue in browser**); the panel-side states were checked with a fixture bridge only.
- Review invalidation after a plugin refresh and the "sign-in interrupted" state after a worker restart are handled but were not reproduced in Orca.
- The e2e spec is shipped in this package (`e2e/`) and was run by copying it into the Orca checkout under a temporary name; Orca's own `tests/e2e/cv-hub-plugin.spec.ts` at `75b02825` still drives the 0.1.x PAT form and is unchanged.
- Orca's e2e global setup couldn't run its own build (the checkout pins a pnpm version missing from the corepack cache); Electron was built with `npx electron-vite build --mode e2e` and the spec ran with `SKIP_BUILD=1`, reusing the existing CLI bundle.
- Full CV Hub API type check remains unverified (see below). The one-line discovery change in `apps/api/src/app.ts` was checked by the running dev server, not `tsc`.

# Validation — 2026-09-23

Versions: CV Hub base `48e729bd10e8969eb8b79bc525396577c93ba0e4`; Orca base `8d6fec597bfae3f1e1bf961a6cae2837f925a3b2` (1.4.197). Node 24.2.0 on macOS arm64. All Electron runs used `ORCA_BACKGROUND_LAUNCH=1`, isolated app profiles, and a local fixture API. No live CV Hub account or production review was used.

| Check | Result |
| --- | --- |
| Plugin TypeScript | Passed |
| Plugin REST/connection/diff mapping/MCP SDK tests | 10 passed |
| Built bundle | Worker activation, declared command registration, and inline script syntax passed |
| API Git, route authorization, and immutable merge regression tests | 10 passed |
| Orca node and renderer TypeScript | Passed |
| Orca Electron/renderer build | Passed (existing chunk-size warnings) |
| Orca plugin regression subset excluding Git installer suite | 396 passed across 63 files |
| Orca changed-file lint | Passed after fixes |
| Electron flow: install → enable → connect → browse PR → native diff → unified view → close | Passed; no page errors |
| Pinned patch application check against clean research base | Passed |
| Whitespace check | Passed |

[Native diff screenshot](docs/native-review.png) was captured from the passing Electron test. It uses fixture before/after contents, not production data. The test asserts the exact merge-base/head blob request URLs and actual rendered Monaco text.

Corrections found through execution: Orca captures iframe form submit events; inline bundle embedding needed replacement callbacks to preserve dollar literals; Monaco needed a flex parent with constrained height; models must detach before disposal. A fresh whole-change review found stale approvals could count after a concurrent source push. Deterministic regression tests now require the exact approved full SHA, and merging uses that same SHA.

## Limits

- Full CV Hub API type checking did **not** finish: `tsc --noEmit` exhausted its default heap, and an 8 GiB retry also exited 134 with V8 out-of-memory. This is an unresolved validation limit; no claim that the API type check passes.
- The database-backed CV Hub tests could not run without PostgreSQL. The new capability tests use real Git and actual Hono routing with mocked database/access services; they do not replace database integration coverage. Updated `pr-merge-override.test.ts` also needs PostgreSQL.
- An earlier broad Orca plugin run had 412 passing tests and one timeout in the existing `installPluginFromGit` local Git fixture. The final 396-test regression subset excludes that installer file; it is not a claim of a green complete Orca suite.
- The Electron test uses the packaged plugin and real patched host with a fixture API. A live deployment/account and real MCP indexing/embedding service were not available. The MCP test exercises SDK initialization/discovery/tool invocation through a simulated JSON-RPC HTTP transport.
- The native view is a read-only dialog, one file at a time. Remote/web Orca, combined scrolling, binary rendering, and inline PR threads are outside this implementation.
