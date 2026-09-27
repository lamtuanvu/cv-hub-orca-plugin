import { PANEL_COMMANDS, PRIVATE_COMMANDS, REVIEW_PROVIDER } from "./panel-contracts";

export const PLUGIN_VERSION = "0.4.0";

/** The full Orca manifest. scripts/build.mjs writes it to orca-plugin.json and dist/. */
export function buildManifest() {
  return {
    manifestVersion: 1,
    id: "cv-hub",
    publisher: "controlvector",
    name: "CV Hub",
    version: PLUGIN_VERSION,
    description:
      "Review CV Hub pull requests in Orca's native diff viewer, open PRs in your browser, and search code through MCP. Requires the CV Hub icon and browser-link patch in the lamtuanvu/orca fork.",
    engines: { orca: ">=1.4.214" },
    pluginApi: 1,
    main: "main.mjs",
    contributes: {
      panels: [{ id: "cv-hub", title: "CV Hub", icon: "cv-hub", entry: "panel.html" }],
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
      { kind: "browser:open-external" },
    ],
  };
}
