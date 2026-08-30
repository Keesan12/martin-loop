import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import serverJson from "../server.json";

import { rewritePackageSpecifiers, workspaceBuildCommandArgs } from "../scripts/build-package-lib.mjs";

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

  it("rewrites transitive workspace dependencies vendored through core", () => {
    const rewritten = rewritePackageSpecifiers(
      [
        'import { evaluate } from "@martin/policy";',
        'import { compileContext } from "@martin/headlessos-core";',
        'import type { AuditExporter } from "@martin/audit-exporter";'
      ].join("\n"),
      {
        targetPath: "C:/repo/packages/mcp/dist/vendor/core/index.js",
        distDir: "C:/repo/packages/mcp/dist",
      },
    );

    expect(rewritten).toContain('../policy/index.js');
    expect(rewritten).toContain('../headlessos-core/index.js');
    expect(rewritten).toContain('../audit-exporter/index.js');
  });
});

describe("workspaceBuildCommandArgs", () => {
  it("avoids --dir so Windows paths with spaces are not reparsed by pnpm", () => {
    expect(workspaceBuildCommandArgs("@martin/contracts")).toEqual([
      "--filter",
      "@martin/contracts",
      "build"
    ]);
  });
});

describe("package manifest", () => {
  it("keeps both MCP bin aliases pointed at the packaged entrypoint", () => {
    expect(packageJson.bin).toEqual({
      mcp: "./dist/server.js",
      "martin-loop-mcp": "./dist/server.js",
    });
  });

  it("ships server metadata and exposes the server module through package exports", () => {
    expect(packageJson.files).toContain("server.json");
    expect(packageJson.exports).toEqual({
      ".": {
        types: "./dist/server.d.ts",
        import: "./dist/server.js",
        default: "./dist/server.js",
      },
      "./server.json": "./server.json",
      "./package.json": "./package.json",
    });
    expect(packageJson).not.toHaveProperty("main");
    expect(packageJson).not.toHaveProperty("types");
  });

  it("keeps package and server metadata in parity", () => {
    const npmPackage = serverJson.packages.find(
      (pkg) => pkg.registryType === "npm" && pkg.transport?.type === "stdio"
    );

    expect(packageJson.name).toBe("@martinloop/mcp");
    expect(packageJson.mcpName).toBe(serverJson.name);
    expect(packageJson.version).toBe(serverJson.version);
    expect(npmPackage?.identifier).toBe(packageJson.name);
    expect(npmPackage?.version).toBe(packageJson.version);
  });

  it("keeps the current public manifest stdio-only until a real remote lane exists", () => {
    const remoteEntries = "remotes" in serverJson && Array.isArray(serverJson.remotes)
      ? serverJson.remotes
      : [];

    expect(remoteEntries).toHaveLength(0);
  });
});
