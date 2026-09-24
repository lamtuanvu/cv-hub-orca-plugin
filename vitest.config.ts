import { defineConfig } from "vitest/config";

// e2e/ holds the Electron spec that runs inside a patched Orca checkout (see README).
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
