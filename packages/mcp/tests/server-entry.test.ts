import { mkdir, symlink, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { isDirectExecutionEntry } from "../src/server.js";

describe("server entrypoint", () => {
  it("treats a linked bin path as direct execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-mcp-entry-"));
    const realScriptPath = join(root, "dist", "server.js");
    const linkedEntryPath = process.platform === "win32"
      ? join(root, "linked-dist", "server.js")
      : join(root, ".bin", "mcp");

    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(realScriptPath, "// server entry placeholder\n", "utf8");
    if (process.platform === "win32") {
      await symlink(join(root, "dist"), join(root, "linked-dist"), "junction");
    } else {
      await mkdir(join(root, ".bin"), { recursive: true });
      await symlink(realScriptPath, linkedEntryPath, "file");
    }

    try {
      expect(isDirectExecutionEntry(linkedEntryPath, pathToFileURL(realScriptPath).href)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
