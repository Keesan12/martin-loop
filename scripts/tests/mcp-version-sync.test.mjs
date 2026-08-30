import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { synchronizeMcpVersion } from "../../packages/mcp/scripts/version-sync.mjs";
import { collectMcpVersionFailures } from "../../packages/mcp/scripts/verify-version-consistency.mjs";

test("MCP version sync derives server metadata and runtime source from package.json", async () => {
  const packageDir = await mkdtemp(path.join(os.tmpdir(), "martin-mcp-version-sync-"));
  try {
    await mkdir(path.join(packageDir, "src"), { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      `${JSON.stringify({ name: "@martinloop/mcp", version: "0.5.6" }, null, 2)}\n`,
    );
    await writeFile(
      path.join(packageDir, "server.json"),
      `${JSON.stringify({
        version: "0.5.5",
        packages: [{ registryType: "npm", identifier: "@martinloop/mcp", version: "0.5.5" }],
      }, null, 2)}\n`,
    );

    await synchronizeMcpVersion(packageDir);

    const server = JSON.parse(await readFile(path.join(packageDir, "server.json"), "utf8"));
    const runtime = await readFile(path.join(packageDir, "src", "package-version.ts"), "utf8");
    assert.equal(server.version, "0.5.6");
    assert.equal(server.packages[0].version, "0.5.6");
    assert.match(runtime, /MARTIN_MCP_PACKAGE_VERSION = "0\.5\.6"/);
    assert.deepEqual(await collectMcpVersionFailures(packageDir), []);

    await writeFile(
      path.join(packageDir, "src", "package-version.ts"),
      'export const MARTIN_MCP_PACKAGE_VERSION = "0.5.5";\n',
    );
    assert.deepEqual(
      await collectMcpVersionFailures(packageDir),
      ["runtime package version expected 0.5.6; received 0.5.5"],
    );
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
});

test("MCP version sync rejects invalid package versions without rewriting metadata", async () => {
  const packageDir = await mkdtemp(path.join(os.tmpdir(), "martin-mcp-version-sync-invalid-"));
  try {
    await mkdir(path.join(packageDir, "src"), { recursive: true });
    await writeFile(path.join(packageDir, "package.json"), '{"version":"latest"}\n');
    await writeFile(path.join(packageDir, "server.json"), '{"version":"0.5.5","packages":[]}\n');

    await assert.rejects(() => synchronizeMcpVersion(packageDir), /invalid or missing version/);
    assert.equal(
      await readFile(path.join(packageDir, "server.json"), "utf8"),
      '{"version":"0.5.5","packages":[]}\n',
    );
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
});
