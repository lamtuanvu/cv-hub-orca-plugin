import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { loadOrcaManifestSchema } from "../../scripts/orca-schema.mjs";
import { DEFAULT_ORIGIN, MIN_ORCA, buildManifest } from "./manifest";

const schema = await loadOrcaManifestSchema();

describe("the generated Orca manifest", () => {
  it("validates against Orca's published format-2 schema", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    const ok = validate(buildManifest());
    const errors = (validate.errors ?? []).map(({ instancePath, message }) => `${instancePath} ${message}`);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it("declares exactly the stock-Orca surface the code uses", () => {
    const manifest = buildManifest();
    expect(manifest.manifestVersion).toBe(2);
    expect(manifest.execution).toBe("trusted-worker");
    expect(manifest.id).toBe("cv-hub");
    expect(manifest).not.toHaveProperty("publisher");
    expect(manifest.engines).toEqual({ orca: `>=${MIN_ORCA}` });
    expect(manifest.pluginApi).toBe(1);
    expect(manifest.contributes.panels).toEqual([
      { id: "cv-hub", title: "CV Hub", icon: "code", entry: "panel.html", ui: "html" },
    ]);
    expect(manifest.contributes.commands.map((c: { id: string }) => c.id)).toEqual([
      "cvhub.signIn",
      "cvhub.signOut",
      "cvhub.refresh",
    ]);
    expect(manifest.contributes.events).toEqual([{ on: "workspace.changed" }]);
    expect(manifest.contributes.settings).toEqual([
      {
        key: "apiOrigin",
        title: "CV Hub API origin",
        type: "string",
        default: DEFAULT_ORIGIN,
        description: expect.any(String),
      },
    ]);
    expect(manifest.contributes.statusBarItems).toEqual([
      expect.objectContaining({ id: "cvhub-status", icon: "code", command: "cvhub.signIn" }),
    ]);
    expect(manifest.capabilities.map((c: { kind: string }) => c.kind).sort()).toEqual([
      "notifications:show",
      "secrets:own",
      "settings:own",
      "storage:own",
      "workspace:read",
    ]);
    // Orca refuses unknown keys at every level, so nothing undeclared may ride along.
    expect(Object.keys(manifest).sort()).toEqual(
      [
        "$schema",
        "capabilities",
        "contributes",
        "description",
        "engines",
        "execution",
        "id",
        "license",
        "main",
        "manifestVersion",
        "name",
        "pluginApi",
        "repository",
        "version",
      ].sort(),
    );
  });
});
