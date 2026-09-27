import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const checkout = process.argv[2];
if (!checkout)
  throw new Error("Usage: node scripts/apply-host-patch.mjs /path/to/clean/orca-checkout");
const metadata = JSON.parse(
  await readFile(new URL("../host-patches/base.json", import.meta.url), "utf8"),
);
const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
if (git("rev-parse", "HEAD").trim() !== metadata.commit)
  throw new Error(`Expected Orca commit ${metadata.commit}`);
if (git("status", "--porcelain").trim()) throw new Error("Use a clean isolated Orca checkout");
const patch = fileURLToPath(new URL(`../host-patches/${metadata.patch}`, import.meta.url));
git("apply", "--check", patch);
git("apply", patch);
console.log("Applied CV Hub icon and browser-link host extension. Build Orca from this checkout.");
