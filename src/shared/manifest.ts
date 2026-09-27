import { PANEL_COMMANDS, PRIVATE_COMMANDS, REVIEW_PROVIDER } from "./panel-contracts";

export const PLUGIN_VERSION = "0.4.0";

export const PLUGIN_REPOSITORY_URL = "https://github.com/lamtuanvu/cv-hub-orca-plugin.git";

/** The Git tag CI publishes for a version: a commit holding only the built plugin files. */
export function pluginReleaseRef(version: string = PLUGIN_VERSION): string {
  return `plugin-v${version}`;
}

/** The full Orca manifest. scripts/build.mjs writes it to orca-plugin.json and dist/. */
export function buildManifest() {
  return {
    manifestVersion: 1,
    id: "cv-hub",
    publisher: "controlvector",
    name: "CV Hub",
    version: PLUGIN_VERSION,
    description:
      "Review CV Hub pull requests in Orca's native diff viewer, check CI and reviews, and search code through MCP. Signs in with CV Hub OAuth in your browser. Requires the lamtuanvu/orca build of Orca (native plugin review host).",
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
      { kind: "workspace:read" },
    ],
  };
}

/** The Orca marketplace index. scripts/build.mjs writes it to orca-marketplace.json, so a
 * version bump also moves the listing to that version's built tag. Orca shows "Update
 * available" when the listed ref differs from the installed one. */
export function buildMarketplace() {
  const manifest = buildManifest();
  return {
    name: "CV Hub",
    owner: manifest.publisher,
    plugins: [
      {
        id: `${manifest.publisher}.${manifest.id}`,
        source: { kind: "git", url: PLUGIN_REPOSITORY_URL, ref: pluginReleaseRef() },
        description: manifest.description,
        categories: ["source-control", "code-review"],
      },
    ],
  };
}
