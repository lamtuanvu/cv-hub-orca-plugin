// Orca's published manifest schema (format 2), fetched from the Orca repository at a pinned
// commit and cached under node_modules/.cache, so the manifest checks match what Orca loads.
import { mkdir, readFile, writeFile } from "node:fs/promises";

export const ORCA_SCHEMA_COMMIT = "460d15c6ba4a52e6e8d2354573b67f8e4eac3496";
const url = `https://raw.githubusercontent.com/stablyai/orca/${ORCA_SCHEMA_COMMIT}/docs/schemas/plugins/orca-plugin.v2.schema.json`;
const cacheDir = new URL("../node_modules/.cache/orca-schema/", import.meta.url);
const cacheFile = new URL(`orca-plugin.v2.${ORCA_SCHEMA_COMMIT}.json`, cacheDir);

export async function loadOrcaManifestSchema() {
  try {
    return JSON.parse(await readFile(cacheFile, "utf8"));
  } catch {
    /* not cached yet */
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't fetch Orca's manifest schema (${response.status}) from ${url}`);
  const text = await response.text();
  const schema = JSON.parse(text);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFile, text);
  return schema;
}
