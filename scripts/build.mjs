import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const out = new URL("dist/", root);
await mkdir(out, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("src/worker/activate.ts", root))],
  outfile: fileURLToPath(new URL("main.mjs", out)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
const panel = await build({
  entryPoints: [fileURLToPath(new URL("src/panel/index.ts", root))],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  write: false,
  outdir: "panel",
  minify: true,
  // The sandboxed panel cannot load remote or relative assets, so images are inlined.
  loader: { ".png": "dataurl" },
});
const js = panel.outputFiles
  .find((file) => file.path.endsWith(".js"))
  .text.replaceAll("</script", "<\\/script");
const css = panel.outputFiles.find((file) => file.path.endsWith(".css")).text;
let html = await readFile(new URL("src/panel/index.html", root), "utf8");
html = html
  .replace("</head>", () => `<style>${css}</style></head>`)
  .replace("</body>", () => `<script>${js}</script></body>`);
await writeFile(new URL("panel.html", out), html);
// The manifest is generated from src/shared/manifest.ts so panel contracts, the review
// provider, and the worker's own output validation can never drift apart.
const manifestModule = new URL("manifest.tmp.mjs", out);
await build({
  entryPoints: [fileURLToPath(new URL("src/shared/manifest.ts", root))],
  outfile: fileURLToPath(manifestModule),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
});
const { buildManifest, buildMarketplace } = await import(`${manifestModule.href}?t=${Date.now()}`);
await rm(manifestModule);
const manifestJson = JSON.stringify(buildManifest(), null, 2) + "\n";
await writeFile(new URL("orca-plugin.json", root), manifestJson);
await writeFile(new URL("orca-plugin.json", out), manifestJson);
await writeFile(
  new URL("orca-marketplace.json", root),
  JSON.stringify(buildMarketplace(), null, 2) + "\n",
);
console.log(`Plugin built: ${out.pathname}`);
