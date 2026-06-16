import { defineWorkspace } from "vitest/config";

// Keep workspace test discovery explicit for OSS packages, demo apps, and benchmarks.
export default defineWorkspace([
  "packages/*/vitest.config.ts",
  "apps/*/vitest.config.ts"
]);

