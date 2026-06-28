import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findPortabilityViolations,
  runPublicPortabilityGuard,
  shouldScanPath,
} from "../public-portability-guard.mjs";

test("findPortabilityViolations detects local machine paths and internal repo names", () => {
  const windowsPath = findPortabilityViolations(
    "See C:\\Users\\Example\\OneDrive\\Documents\\notes.md",
    "README.md",
  );
  const internalRepo = findPortabilityViolations(
    "Mirror from ML_Main_Repo_Internal before release.",
    "docs/guide.md",
  );

  assert.ok(windowsPath.length > 0);
  assert.ok(internalRepo.length > 0);
});

test("shouldScanPath skips known fixture and guard files", () => {
  assert.equal(shouldScanPath("scripts/tests/public-copy-scan.test.mjs"), false);
  assert.equal(shouldScanPath("packages/core/tests/runtime.test.ts"), false);
  assert.equal(shouldScanPath("scripts/public-copy-scan.mjs"), false);
  assert.equal(shouldScanPath("scripts/public-portability-guard.mjs"), false);
  assert.equal(shouldScanPath("packages/core/src/index.ts"), true);
});

test("runPublicPortabilityGuard passes on clean portable files", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "martin-portability-clean-"));
  await mkdir(path.join(rootDir, "packages", "core", "src"), { recursive: true });
  await mkdir(path.join(rootDir, "docs"), { recursive: true });

  await writeFile(
    path.join(rootDir, "packages", "core", "src", "index.ts"),
    "export const message = 'portable';\n",
  );
  await writeFile(path.join(rootDir, "docs", "quickstart.md"), "# Quickstart\n");

  const result = await runPublicPortabilityGuard({
    rootDir,
    files: ["packages/core/src/index.ts", "docs/quickstart.md"],
  });

  assert.equal(result.checkedFiles, 2);
  assert.equal(result.trackedFiles, 2);
});

test("runPublicPortabilityGuard fails when source includes local machine dependencies", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "martin-portability-fail-"));
  await mkdir(path.join(rootDir, "packages", "core", "src"), { recursive: true });

  await writeFile(
    path.join(rootDir, "packages", "core", "src", "index.ts"),
    "export const leakedPath = 'C:\\\\Users\\\\Example\\\\Desktop\\\\proof.txt';\n",
  );

  await assert.rejects(
    () =>
      runPublicPortabilityGuard({
        rootDir,
        files: ["packages/core/src/index.ts"],
      }),
    /Public portability guard failed/i,
  );
});

test("runPublicPortabilityGuard skips deleted tracked files in a dirty worktree candidate set", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "martin-portability-missing-"));
  await mkdir(path.join(rootDir, "docs"), { recursive: true });

  await writeFile(path.join(rootDir, "docs", "kept.md"), "# Kept\n");

  const result = await runPublicPortabilityGuard({
    rootDir,
    files: ["docs/deleted.md", "docs/kept.md"],
  });

  assert.equal(result.checkedFiles, 1);
  assert.equal(result.trackedFiles, 2);
});

