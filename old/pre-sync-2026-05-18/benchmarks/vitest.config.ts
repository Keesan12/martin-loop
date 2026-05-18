import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@martin/core": fileURLToPath(new URL("../packages/core/src/index.ts", import.meta.url)),
      "@martin/contracts": fileURLToPath(
        new URL("../packages/contracts/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    include: ["tests/**/*.test.ts"]
  }
});
