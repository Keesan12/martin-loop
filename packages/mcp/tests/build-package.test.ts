import { describe, expect, it } from "vitest";

import { rewritePackageSpecifiers } from "../scripts/build-package-lib.mjs";

describe("rewritePackageSpecifiers", () => {
  it("rewrites nested internal package subpaths without truncating them", () => {
    const rewritten = rewritePackageSpecifiers(
      'import { helper } from "@martin/core/utils/helper";',
      {
        targetPath: "C:/repo/packages/mcp/dist/server.js",
        distDir: "C:/repo/packages/mcp/dist",
      },
    );

    expect(rewritten).toContain('./vendor/core/utils/helper.js');
  });

  it("preserves explicit js extensions instead of appending them twice", () => {
    const rewritten = rewritePackageSpecifiers(
      'export * from "@martin/adapters/runtime-support.js";',
      {
        targetPath: "C:/repo/packages/mcp/dist/server.js",
        distDir: "C:/repo/packages/mcp/dist",
      },
    );

    expect(rewritten).toContain('./vendor/adapters/runtime-support.js');
    expect(rewritten).not.toContain("runtime-support.js.js");
  });
});
