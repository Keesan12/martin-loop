import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/*/vitest.config.ts",
  "apps/*/vitest.config.ts",
  "benchmarks/vitest.config.ts"
]);

