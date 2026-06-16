import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@martin/adapters": fileURLToPath(new URL("./packages/adapters/src/index.ts", import.meta.url)),
      "@martin/benchmarks": fileURLToPath(new URL("./benchmarks/src/index.ts", import.meta.url)),
      "@martin/cli": fileURLToPath(new URL("./packages/cli/src/index.ts", import.meta.url)),
      "@martin/contracts": fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)),
      "@martin/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@martinloop/mcp": fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url))
    }
  },
  test: {
    testTimeout: 15_000
  }
});
