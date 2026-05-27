import { defineWorkspace } from "vitest/config";

// Keep workspace test discovery explicit for packages and optional local apps.
export default defineWorkspace([
  "packages/*/vitest.config.ts",
  "apps/*/vitest.config.ts",
  "benchmarks/vitest.config.ts"
]);

