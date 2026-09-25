import { PANEL_COMMANDS, PRIVATE_COMMANDS, REVIEW_PROVIDER } from "./panel-contracts";

export const PLUGIN_VERSION = "0.3.0";

/** The full Orca manifest. scripts/build.mjs writes it to orca-plugin.json and dist/. */
export function buildManifest() {
  return {
    manifestVersion: 1,
    id: "cv-hub",
    publisher: "controlvector",
    name: "CV Hub",
    version: PLUGIN_VERSION,
    description:
      "Review CV Hub pull requests in Orca's native diff viewer, check CI and reviews, and search code through MCP. Signs in with CV Hub OAuth in your browser. Requires Orca with the native plugin review host (lamtuanvu/orca 75b02825).",
    engines: { orca: ">=1.4.197" },
    pluginApi: 1,
    main: "main.mjs",
    contributes: {
      panels: [{ id: "cv-hub", title: "CV Hub", icon: "git-pull-request", entry: "panel.html" }],
      commands: [
        ...Object.entries(PANEL_COMMANDS).map(([id, c]) => ({
          id,
          title: c.title,
          panel: { effect: c.effect, input: c.input, output: c.output },
        })),
        ...Object.entries(PRIVATE_COMMANDS).map(([id, title]) => ({ id, title })),
      ],
      reviewProviders: [REVIEW_PROVIDER],
    },
    capabilities: [
      { kind: "storage" },
      { kind: "secrets" },
      { kind: "commands:invoke-own" },
      { kind: "diffs:open" },
      { kind: "browser:authorize" },
    ],
  };
}
