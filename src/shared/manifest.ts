/** The full Orca plugin manifest, format 2. scripts/build.mjs writes it to
 *  orca-plugin.json (repo root) and dist/, and src/shared/manifest.test.ts
 *  validates the generated object against Orca's published schema. */

export const PLUGIN_VERSION = "0.6.2";

export const PLUGIN_REPOSITORY_URL = "https://github.com/lamtuanvu/cv-hub-orca-plugin";

/** CV Hub's public API origin; the `apiOrigin` setting overrides it for
 *  self-hosted servers. HTTPS is required except for loopback development. */
export const DEFAULT_ORIGIN = "https://api.hub.controlvector.io";

/** The Orca release that ships every manifest field used here: status bar items
 *  arrived in 1.4.248. */
export const MIN_ORCA = "1.4.248";

/** The status bar item: `statusBar.update` names it. Ids here are kebab-case (no dots,
 *  unlike command ids), which Orca's manifest schema enforces. */
export const STATUS_BAR_ID = "cvhub-status";

export function buildManifest() {
  return {
    $schema: "https://raw.githubusercontent.com/stablyai/orca/main/docs/schemas/plugins/orca-plugin.v2.schema.json",
    manifestVersion: 2,
    execution: "trusted-worker",
    id: "cv-hub",
    // No `publisher`: Orca derives the install identity from the repository owner.
    name: "CV Hub",
    version: PLUGIN_VERSION,
    description:
      "Browse CV Hub repositories and pull requests in Orca: read diffs, checks and review history, submit reviews, and search code. Signs in with CV Hub in your browser.",
    license: "MIT",
    repository: PLUGIN_REPOSITORY_URL,
    engines: { orca: `>=${MIN_ORCA}` },
    pluginApi: 1,
    main: "main.mjs",
    contributes: {
      panels: [{ id: "cv-hub", title: "CV Hub", icon: "code", entry: "panel.html", ui: "html" }],
      commands: [
        { id: "cvhub.signIn", title: "CV Hub: Sign in" },
        { id: "cvhub.signOut", title: "CV Hub: Sign out" },
        { id: "cvhub.refresh", title: "CV Hub: Refresh open pull requests" },
      ],
      events: [{ on: "workspace.changed" }],
      settings: [
        {
          key: "apiOrigin",
          title: "CV Hub API origin",
          type: "string",
          default: DEFAULT_ORIGIN,
          description:
            "The origin of the CV Hub API, such as https://api.hub.example.com — not the web app's address and not an /api path. HTTPS is required except for loopback development servers.",
        },
      ],
      statusBarItems: [
        {
          id: STATUS_BAR_ID,
          icon: "code",
          text: "CV Hub",
          tone: "neutral",
          tooltip: "CV Hub",
          command: "cvhub.signIn",
        },
      ],
    },
    capabilities: [
      { kind: "storage:own" },
      { kind: "secrets:own" },
      { kind: "settings:own" },
      { kind: "workspace:read" },
      { kind: "notifications:show" },
    ],
  };
}
