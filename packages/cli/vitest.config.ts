import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@martin/adapters": fileURLToPath(new URL("../adapters/src/index.ts", import.meta.url)),
      "@martin/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@martin/benchmarks": fileURLToPath(
        new URL("../../benchmarks/src/index.ts", import.meta.url)
      ),
      "@martin/contracts": fileURLToPath(new URL("../contracts/src/index.ts", import.meta.url)),
      "@martin/presentation": fileURLToPath(
        new URL("../presentation/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    // CLI fixtures launch real subprocesses and exercise Windows filesystem
    // replacement/cleanup semantics. Parallel files can starve those child
    // processes and hold their temporary directories past hook deadlines.
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000
  }
});
