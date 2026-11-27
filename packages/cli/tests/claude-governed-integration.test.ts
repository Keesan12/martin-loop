import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeCliAdapter } from "@martin/adapters";
import { createFileRunStore, runMartin } from "@martin/core";
import { afterEach, describe, expect, it } from "vitest";
import { executeCli } from "../src/index.js";
import { persistLoopArtifacts } from "../src/persistence.js";

const roots: string[] = [];
const originalPath = process.env.PATH;
afterEach(async () => {
  delete process.env.MARTIN_RUNS_DIR;
  delete process.env.MARTIN_INTEGRITY_KEY_DIR;
  delete process.env.MARTIN_TEST_CLAUDE_MODEL;
  process.env.PATH = originalPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function runControlled(observedModel: string) {
  const root = await mkdtemp(join(tmpdir(), "martin-claude-governed-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const runsRoot = join(root, "runs");
  const binRoot = join(root, "bin");
  await mkdir(workspace, { recursive: true });
  await mkdir(binRoot, { recursive: true });
  expect(spawnSync("git", ["init"], { cwd: workspace }).status).toBe(0);
  await writeFile(join(workspace, "README.md"), "controlled fixture\n", "utf8");
  expect(spawnSync("git", ["add", "README.md"], { cwd: workspace }).status).toBe(0);
  expect(spawnSync("git", ["-c", "user.name=MartinLoop Test", "-c", "user.email=test@martinloop.local", "commit", "-m", "fixture"], { cwd: workspace }).status).toBe(0);
  process.env.MARTIN_RUNS_DIR = runsRoot;
  process.env.MARTIN_INTEGRITY_KEY_DIR = join(root, "integrity");
  process.env.MARTIN_TEST_CLAUDE_MODEL = observedModel;
  const fakeScript = join(binRoot, "fake-claude.cjs");
  await writeFile(fakeScript, `const fs=require("node:fs");\nfs.writeFileSync("claude-owned.txt", "controlled write\\n");\nconsole.log(JSON.stringify({type:"system",subtype:"init",model:process.env.MARTIN_TEST_CLAUDE_MODEL,mcp_servers:[]}));\nconsole.log(JSON.stringify({type:"result",subtype:"success",result:"Completed the controlled Claude fixture by writing only claude-owned.txt and leaving all other repository files unchanged.",total_cost_usd:0.01,usage:{input_tokens:120,output_tokens:30}}));\n`, "utf8");
  if (process.platform === "win32") {
    await writeFile(join(binRoot, "claude.cmd"), `@echo off\r\nnode "%~dp0fake-claude.cjs"\r\n`, "utf8");
  } else {
    const launcher = join(binRoot, "claude");
    await writeFile(launcher, `#!/bin/sh\nnode "$(dirname "$0")/fake-claude.cjs"\n`, "utf8");
    await chmod(launcher, 0o755);
  }
  process.env.PATH = `${binRoot}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
  const adapter = createClaudeCliAdapter({ model: "claude-sonnet-4-6", workingDirectory: workspace });
  const store = createFileRunStore({ runsRoot });
  const result = await runMartin({
    workspaceId: `ws_${observedModel}`,
    projectId: "proj_claude_governed",
    task: {
      title: "Controlled Claude integration",
      objective: "Write the controlled fixture and verify it.",
      verificationPlan: [process.platform === "win32" ? "cmd /c exit 0" : "true"],
      mutationMode: "edit",
      repoRoot: workspace,
      allowedPaths: ["claude-owned.txt"]
    },
    budget: { maxUsd: 5, softLimitUsd: 4, maxIterations: 1, maxTokens: 500_000 },
    adapter,
    store
  });
  result.loop.receiptScope = { repoRoot: workspace, workingDirectory: workspace, runsRoot };
  await persistLoopArtifacts(result.loop, { runsRoot });
  return { result, root, workspace, runsRoot };
}

describe("Claude governed Core to CLI persistence", () => {
  it("reconciles exact model, accounting, verifier, receipt, dossier, and runs-verify truth", { timeout: 30_000 }, async () => {
    const { result, workspace, runsRoot } = await runControlled("claude-sonnet-4-6");
    expect(result.loop.cost).toMatchObject({ actualUsd: 0.01, tokensIn: 120, tokensOut: 30 });
    const verificationEvent = result.loop.events.find((event) => event.type === "verification.completed");
    expect(verificationEvent?.payload, JSON.stringify(result.loop.events)).toMatchObject({ passed: true });
    expect(await readFile(join(workspace, "claude-owned.txt"), "utf8")).toBe("controlled write\n");
    const dossierResult = await executeCli(["--json", "dossier", "--loop-id", result.loop.loopId, "--runs-dir", runsRoot]);
    const verifyResult = await executeCli(["--json", "runs", "verify", "--loop-id", result.loop.loopId, "--runs-dir", runsRoot]);
    expect(dossierResult.exitCode, dossierResult.stderr || dossierResult.stdout).toBe(0);
    expect(verifyResult.exitCode, verifyResult.stderr || verifyResult.stdout).toBe(0);
    const dossier = JSON.parse(dossierResult.stdout);
    const verified = JSON.parse(verifyResult.stdout);
    expect(dossier.loop.cost.providerSettlement).toMatchObject({ model: "claude-sonnet-4-6", rawUsageAvailable: true });
    expect(dossier.verifiedHandoff.receiptIntegrity.state).toBe("verified");
    expect(verified.verifiedHandoff.receiptIntegrity.state).toBe("verified");
    expect(verified.verification.status).toBe("passed");
  });

  it("persists a model mismatch as failed and never as a verified receipt", { timeout: 30_000 }, async () => {
    const { result, runsRoot } = await runControlled("claude-haiku-4-5");
    const verification = result.loop.events.find((event) => event.type === "verification.completed")?.payload;
    expect(verification).toMatchObject({ passed: false });
    expect(JSON.stringify(verification)).toMatch(/model mismatch/iu);
    const verifyResult = await executeCli(["--json", "runs", "verify", "--loop-id", result.loop.loopId, "--runs-dir", runsRoot]);
    expect(verifyResult.exitCode).not.toBe(0);
    expect(JSON.parse(verifyResult.stdout).verifiedHandoff.outcome).not.toBe("VERIFIED");
  });
});
