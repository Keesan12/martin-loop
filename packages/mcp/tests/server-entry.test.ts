// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { mkdir, symlink, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { isDirectExecutionEntry } from "../src/server.js";

describe("server entrypoint", () => {
  const symlinkTest = process.platform === "win32" ? it.skip : it;

  symlinkTest("treats a symlinked bin path as direct execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-mcp-entry-"));
    const realScriptPath = join(root, "dist", "server.js");
    const symlinkPath = join(root, ".bin", "mcp");

    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(root, ".bin"), { recursive: true });
    await writeFile(realScriptPath, "// server entry placeholder\n", "utf8");
    await symlink(realScriptPath, symlinkPath, process.platform === "win32" ? "file" : "file");

    try {
      expect(isDirectExecutionEntry(symlinkPath, pathToFileURL(realScriptPath).href)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
