# Vendored Orca plugin typings

Copied from the Orca repository (github.com/stablyai/orca), MIT licensed like this
plugin: the worker, frame, host and services typings from `resources/plugins/types/`,
which `orca plugin types` also writes. Only the files this plugin uses are kept, and the
agent-kind union in `orca-host.d.ts` is widened to `string`. They are vendored so
`pnpm type-check` runs without the Orca CLI.

The manifest schema is not vendored: `scripts/orca-schema.mjs` fetches it from Orca at a
pinned commit for the manifest test and the package check.
