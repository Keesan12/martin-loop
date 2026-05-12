import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../../packages/mcp/package.json" with { type: "json" };
import serverJson from "../../packages/mcp/server.json" with { type: "json" };
import { assertMcpPackageMetadataParity } from "../../packages/mcp/scripts/smoke-package.mjs";
import { resolvePublishedPackageSpec } from "../../packages/mcp/scripts/smoke-published-package.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGE_DIR = path.join(ROOT_DIR, "packages", "mcp");

test("MCP package and server metadata stay in parity", () => {
  assert.doesNotThrow(() => assertMcpPackageMetadataParity(packageJson, serverJson));
});

test("published smoke fails closed by default when the package is unavailable", async () => {
  const tempPackDir = await mkdtemp(path.join(os.tmpdir(), "martin-mcp-pack-test-"));

  try {
    await assert.rejects(
      () =>
        resolvePublishedPackageSpec({
          packageDir: PACKAGE_DIR,
          tempPackDir,
          lookupPublishedVersion: async () => ({
            found: false,
            reason: "simulated registry miss",
          }),
          buildLocalFallbackPackageSpec: async () => {
            throw new Error("fallback should not run");
          },
        }),
      /MARTIN_MCP_ALLOW_LOCAL_FALLBACK=1/,
    );
  } finally {
    await rm(tempPackDir, { recursive: true, force: true });
  }
});

test("published smoke allows an explicit local fallback when opted in", async () => {
  const tempPackDir = await mkdtemp(path.join(os.tmpdir(), "martin-mcp-pack-test-"));

  try {
    const resolved = await resolvePublishedPackageSpec({
      packageDir: PACKAGE_DIR,
      tempPackDir,
      allowLocalFallback: true,
      lookupPublishedVersion: async () => ({
        found: false,
        reason: "simulated registry miss",
      }),
      buildLocalFallbackPackageSpec: async () => "C:/tmp/martinloop-mcp.tgz",
    });

    assert.equal(resolved, "C:/tmp/martinloop-mcp.tgz");
  } finally {
    await rm(tempPackDir, { recursive: true, force: true });
  }
});
