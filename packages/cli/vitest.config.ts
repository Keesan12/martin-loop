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
      "@martin/contracts": fileURLToPath(new URL("../contracts/src/index.ts", import.meta.url))
    }
  },
  test: {
    include: ["tests/**/*.test.ts"]
  }
});
