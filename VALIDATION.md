# Validation — 2026-11-23: plugin 0.6.0 on stock Orca

0.6.0 is the stock-Orca rewrite: manifest format 2 (`trusted-worker`, no `publisher`), the
HTML panel on Orca's frozen `window.orca` frame API, `orca.panels.handle` request handlers,
`orca.panels.post` pushes, the `workspace.changed` event, the status bar item and the
`apiOrigin` setting. Every fork-only host API (panel command contracts, the native review
provider, worker browser authorization, the custom panel icon, `remotes` in
`workspace.readContext`) is gone, with `host-patches/` and its apply script. Node 24.2.0,
macOS arm64, Orca 1.4.268 (stock release).

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed (ajv added as a devDependency for the manifest schema test) |
| `pnpm type-check` (strict) | Passed against Orca's plugin typings vendored in `types/orca/` (worker code against `import type { OrcaWorkerApi } from "orca/worker"`, panel code against the `window.orca` frame typings of `orca/frame`) |
| `pnpm test` | 51 passed across 9 files: manifest validates against Orca's published format-2 schema (fetched from Orca at a pinned commit by `scripts/orca-schema.mjs`) and declares exactly the stock surface; OAuth lifecycle (pending, slow_down, denial, expiry, offline backoff, unregistered client, cancel race revoking late tokens, serialized refresh + rotation, rejected refresh → sign in again, 401 read retry without write replay, read-only grant, sign-out with failed remote revocation, PAT-era profile migration, cross-origin MCP discovery, verification-page trust rules, no device code or token in any panel view); panel diff (endpoint pinned, per-file status/counts, patch cut on a line boundary under the 64 KiB cap, payload budget, 400-file listing cap); the unified-patch parser (hunk numbering both sides, prologue skipped, `\ No newline` marker, new-file header, trailing-newline artifact); `git remote -v` parsing and remote → owner/repo mapping; Markdown (GitHub-flavored rendering, raw HTML shown as text, unsafe links dropped, web links opened through `shell.openExternal`, in jsdom); REST client, MCP search, PR web URL |
| `pnpm run package` (build + check + zip) | Passed: `dist/` holds exactly `orca-plugin.json`, `main.mjs`, `panel.html` (no stale `panel.js`); the built manifest validates against the schema; the worker activates on a stand-in host registering exactly the manifest's three commands and the thirteen panel handlers, answers `auth.status` signed-out, posts `auth.changed`, and sets the status bar to `CV Hub: sign in`; then `scripts/smoke-panel.mjs` runs the built panel against a stand-in DOM and `window.orca` frame — signed-out boot, device-code sign-in with the verification page opened from the button press, the `auth.changed` connected push entering the workspace, the pull-request list and detail, the in-panel Files diff (hunk header, added and removed lines, the split toggle), the review composer pinning the inspected revision and the Self-approve submission, the per-file external link, and a `context.changed` push switching repositories; `dist/cv-hub-0.6.0.zip` written |
| Acceptance grep (no fork API anywhere in `src scripts orca-plugin.json dist/orca-plugin.json README.md`) | Passed, plus `test -f dist/panel.html && ! test -f dist/panel.js` |
| `orca plugin validate dist` (Orca 1.4.268) | Passed |
| Installed in Orca 1.4.268 (`orca plugin install <folder> --approve …`) | Installed and running; Orca listed exactly the five capabilities, the panel, three commands, the `workspace.changed` event and the status bar item. Panel screenshots (`orca plugin shot`): signed-out view and the `CV Hub: sign in` status bar item; after a browser sign-in on a live CV Hub, the panel opened directly on the focused workspace's repository (badge "Workspace") and listed its pull requests |
| Bundle shape | `dist/main.mjs` is a Node ESM bundle with no runtime `orca` import (`orca/worker` is types only); `dist/panel.html` is one self-contained page — its script, styles and images are inlined, it loads no external assets and calls only `window.orca` (`plugin.request` / `plugin.on`, `shell.openExternal` from a press, `storage`, the `theme` event), the shape Orca's frame documentation prescribes so browser clients (`orca serve`) load it too |

## Not run

- Clicking through the HTML panel inside Orca: `orca plugin shot --act` drives components panels only, so the PR detail, diff, review and Markdown views were checked by the smoke test and jsdom tests, not by an automated in-app run.
- The optional `orca/testing`-based worker test: Orca's test kit is a large runtime module that would have to be vendored wholesale; the stand-in-host activation check in `scripts/check-package.mjs` covers the registration surface instead.
- The previous rounds validated the 0.1–0.5 plugin against a modified Orca host. That plugin no longer exists in this repository, so those records were removed with it; the behaviors they verified that survive in 0.6.0 (device flow, refresh/rotation, revocation, stale-head submission check, verification-address trust) are covered by the tests listed above.
