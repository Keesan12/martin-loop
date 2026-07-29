// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@martin/contracts": fileURLToPath(new URL("../contracts/src/index.ts", import.meta.url))
    }
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000
  }
});
