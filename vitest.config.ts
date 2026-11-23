import { defineConfig } from "vitest/config";

// Unit tests for the worker, the shared manifest/protocol and the helpers, in vitest as
// before. The panel is type-checked (tsc) and exercised through `orca plugin check`.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
