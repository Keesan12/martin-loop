// SPDX-FileCopyrightText: MartinLoop contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildInstallLinks,
  buildMcpConfig,
  loadMcpPackage
} from "../generate-install-links.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pluginRoot = path.join(repositoryRoot, "plugins", "martinloop");

test("install links use the exact registry package and valid host payloads", async () => {
  const packageMetadata = await loadMcpPackage(repositoryRoot);
  const config = buildMcpConfig(packageMetadata);
  const links = buildInstallLinks(packageMetadata);
  const readme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");

  assert.equal(packageMetadata.identifier, "@martinloop/mcp");
  assert.deepEqual(config.args, ["-y", `@martinloop/mcp@${packageMetadata.version}`]);

  const cursorUrl = new URL(links.cursor);
  assert.equal(cursorUrl.searchParams.get("name"), "martin-loop");
  assert.deepEqual(
    JSON.parse(Buffer.from(cursorUrl.searchParams.get("config"), "base64").toString("utf8")),
    config
  );

  const vscodePayload = JSON.parse(decodeURIComponent(links.vscode.split("?")[1]));
  assert.deepEqual(vscodePayload, { name: "martin-loop", ...config });
  assert.match(readme, new RegExp(links.vscode.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(readme, new RegExp(links.cursor.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("shared plugin manifests use one MCP and skill source without private data", async () => {
  const packageMetadata = await loadMcpPackage(repositoryRoot);
  const codexManifest = JSON.parse(
    await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")
  );
  const rootManifest = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf8"));
  const claudeManifest = JSON.parse(
    await readFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")
  );
  const mcpConfig = JSON.parse(await readFile(path.join(pluginRoot, ".mcp.json"), "utf8"));
  const marketplace = JSON.parse(
    await readFile(path.join(repositoryRoot, ".agents", "plugins", "marketplace.json"), "utf8")
  );
  const skill = await readFile(
    path.join(pluginRoot, "skills", "martinloop-govern", "SKILL.md"),
    "utf8"
  );

  assert.equal(codexManifest.name, "martinloop");
  assert.equal(rootManifest.name, codexManifest.name);
  assert.equal(claudeManifest.name, codexManifest.name);
  assert.equal(codexManifest.version, packageMetadata.version);
  assert.equal(marketplace.name, "martinloop");
  assert.equal(marketplace.plugins[0].source.path, "./plugins/martinloop");
  assert.deepEqual(mcpConfig.mcpServers["martin-loop"].args, [
    "-y",
    `${packageMetadata.identifier}@${packageMetadata.version}`
  ]);
  assert.match(skill, /VERIFIED/u);
  assert.match(skill, /STOPPED/u);
  assert.match(skill, /NEEDS_REVIEW/u);

  const publicSurface = JSON.stringify({ codexManifest, rootManifest, claudeManifest, marketplace, mcpConfig, skill });
  assert.doesNotMatch(publicSurface, /private[-_ ]repo|local-worktree|C:\\Users|internal\/main/iu);
});
