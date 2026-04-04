import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanupRootTmpArtifacts,
  createReleaseMatrixPlan,
  resolveReleaseMatrixLane,
} from "../release-matrix.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("createReleaseMatrixPlan defines the frozen Windows macOS and Linux RC lanes", () => {
  const plan = createReleaseMatrixPlan({ rootDir: ROOT_DIR });

  assert.deepEqual(
    plan.lanes.map((lane) => ({ id: lane.id, runner: lane.runner, platform: lane.platform })),
    [
      { id: "windows", runner: "windows-latest", platform: "win32" },
      { id: "macos", runner: "macos-latest", platform: "darwin" },
      { id: "linux", runner: "ubuntu-latest", platform: "linux" },
    ],
  );

  for (const lane of plan.lanes) {
    const commands = lane.steps.map((step) => step.command.join(" "));
    assert.deepEqual(commands, [
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "pnpm oss:validate",
      "pnpm public:smoke",
      "pnpm repo:smoke",
      "pnpm rc:validate",
    ]);
  }
});

test("resolveReleaseMatrixLane maps local platforms to the matching release lane", () => {
  const plan = createReleaseMatrixPlan({ rootDir: ROOT_DIR });

  assert.equal(resolveReleaseMatrixLane(plan, "win32").id, "windows");
  assert.equal(resolveReleaseMatrixLane(plan, "darwin").id, "macos");
  assert.equal(resolveReleaseMatrixLane(plan, "linux").id, "linux");
});

test("cleanupRootTmpArtifacts removes orphan root _tmp files without touching normal files", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "martin-release-matrix-cleanup-"));

  try {
    const firstTmp = path.join(tempRoot, "_tmp_a1");
    const secondTmp = path.join(tempRoot, "_tmp_b2");
    const keepFile = path.join(tempRoot, "README.md");

    await writeFile(firstTmp, "", "utf8");
    await link(firstTmp, secondTmp);
    await writeFile(keepFile, "# keep\n", "utf8");

    const removed = await cleanupRootTmpArtifacts(tempRoot);
    removed.sort();

    assert.deepEqual(removed, ["_tmp_a1", "_tmp_b2"]);
    await assert.rejects(() => stat(firstTmp));
    await assert.rejects(() => stat(secondTmp));
    const keepStats = await stat(keepFile);
    assert.equal(keepStats.isFile(), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("the GitHub Actions workflow fans the release matrix out across all three operating systems", async () => {
  const workflowPath = path.join(ROOT_DIR, ".github", "workflows", "phase13-release-matrix.yml");
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /macos-latest/);
  assert.match(workflow, /ubuntu-latest/);
  assert.match(workflow, /pnpm release:matrix:local/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /MARTIN_RELEASE_MATRIX_OUTDIR/);
});
