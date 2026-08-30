// SPDX-FileCopyrightText: MartinLoop contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { resolveSmokeWorkspaceRoot } from "../../packages/mcp/scripts/smoke-paths.mjs";

test("packed MCP smoke canonicalizes temporary workspace aliases", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "martin-mcp-canonical-"));
  const target = path.join(fixtureRoot, "target");
  const alias = path.join(fixtureRoot, "alias");

  try {
    await symlink(fixtureRoot, target, process.platform === "win32" ? "junction" : "dir");
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    assert.equal(await resolveSmokeWorkspaceRoot(alias), await realpath(fixtureRoot));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
