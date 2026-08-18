import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  recordMartinMcpInstall,
  rollbackMartinMcpInstall,
  uninstallMartinMcp,
  verifyMartinMcpInstall
} from "../src/mcp-install-state.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "martin-mcp-install-state-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MCP install state", () => {
  it("records, verifies, and rolls back an existing host config", async () => {
    const root = await makeRoot();
    const stateRoot = join(root, "state");
    const targetPath = join(root, "mcp.json");
    const previousContent = '{"existing":true}\n';
    const installedContent = '{"mcpServers":{"martin-loop":{}}}\n';
    await writeFile(targetPath, previousContent, { encoding: "utf8", flag: "wx" });

    await recordMartinMcpInstall({
      host: "cursor",
      scope: "project",
      targetPath,
      content: installedContent,
      previousContent,
      stateRoot
    });

    const selector = { host: "cursor", scope: "project", targetPath, stateRoot };
    expect(await verifyMartinMcpInstall(selector)).toMatchObject({ status: "ok", targetPath });

    await rollbackMartinMcpInstall(selector);
    expect(await readFile(targetPath, "utf8")).toBe(previousContent);
    expect(await verifyMartinMcpInstall(selector)).toMatchObject({ status: "missing_record" });
  });

  it("refuses rollback after the installed config was modified", async () => {
    const root = await makeRoot();
    const stateRoot = join(root, "state");
    const targetPath = join(root, "mcp.json");
    await recordMartinMcpInstall({
      host: "codex",
      scope: "project",
      targetPath,
      content: "installed\n",
      stateRoot
    });
    await writeFile(targetPath, "operator change\n", "utf8");

    const selector = { host: "codex", scope: "project", targetPath, stateRoot };
    expect(await verifyMartinMcpInstall(selector)).toMatchObject({ status: "modified" });
    await expect(rollbackMartinMcpInstall(selector)).rejects.toThrow("verification is modified");
  });

  it("uninstalls all recorded revisions back to the original config", async () => {
    const root = await makeRoot();
    const stateRoot = join(root, "state");
    const targetPath = join(root, "mcp.json");
    await writeFile(targetPath, "original\n", "utf8");
    await recordMartinMcpInstall({
      host: "claude",
      scope: "project",
      targetPath,
      content: "first\n",
      previousContent: "original\n",
      stateRoot
    });
    await recordMartinMcpInstall({
      host: "claude",
      scope: "project",
      targetPath,
      content: "second\n",
      previousContent: "first\n",
      stateRoot
    });

    const records = await uninstallMartinMcp({
      host: "claude",
      scope: "project",
      targetPath,
      stateRoot
    });
    expect(records).toHaveLength(2);
    expect(await readFile(targetPath, "utf8")).toBe("original\n");
  });
});
