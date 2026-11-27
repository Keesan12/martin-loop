import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGeminiCliAdapter } from "@martin/adapters";
import { createFileRunStore, runMartin } from "@martin/core";
import { afterEach, describe, expect, it } from "vitest";
import { executeCli } from "../src/index.js";
import { persistLoopArtifacts } from "../src/persistence.js";

const roots: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  delete process.env.MARTIN_TEST_GEMINI_MODE;
  delete process.env.MARTIN_TEST_GEMINI_OBSERVED_MODEL;
  delete process.env.MARTIN_RUNS_DIR;
  delete process.env.MARTIN_INTEGRITY_KEY_DIR;
  delete process.env.MARTIN_PERSISTENCE_LEASE_DIR;
  process.env.PATH = originalPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

type FixtureMode = "write" | "read" | "error" | "malformed" | "misleading" | "mismatch";

async function runControlled(mode: FixtureMode) {
  const root = await mkdtemp(join(tmpdir(), "martin-gemini-governed-"));
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
  process.env.MARTIN_PERSISTENCE_LEASE_DIR = join(root, "leases");
  process.env.MARTIN_TEST_GEMINI_MODE = mode;
  process.env.MARTIN_TEST_GEMINI_OBSERVED_MODEL = mode === "mismatch" ? "gemini-substituted-v2" : "gemini-router/local-v1";

  const fakeScript = join(binRoot, "fake-gemini.cjs");
  await writeFile(fakeScript, `const fs=require("node:fs");
const mode=process.env.MARTIN_TEST_GEMINI_MODE;
const model=process.env.MARTIN_TEST_GEMINI_OBSERVED_MODEL;
const emit=(value)=>console.log(JSON.stringify(value));
if(mode==="malformed"){ console.log("not-json"); return; }
emit({type:"init",timestamp:"2026-11-19T00:00:00.000Z",session_id:"fixture",model});
if(mode==="error"){ emit({type:"result",timestamp:"2026-11-19T00:00:01.000Z",status:"error",error:{type:"FatalAuthenticationError",message:"denied"}}); return; }
emit({type:"message",timestamp:"2026-11-19T00:00:01.000Z",role:"assistant",content:"Completed controlled Gemini fixture.",delta:true});
if(mode==="misleading") emit({type:"error",timestamp:"2026-11-19T00:00:01.500Z",severity:"error",message:"safety blocked"});
if(mode==="write") fs.writeFileSync("gemini-owned.txt","controlled write\\n");
emit({type:"result",timestamp:"2026-11-19T00:00:02.000Z",status:"success",stats:{input_tokens:120,output_tokens:30,total_tokens:150}});
`, "utf8");
  if (process.platform === "win32") {
    await writeFile(join(binRoot, "gemini.cmd"), `@echo off\r\nnode "%~dp0fake-gemini.cjs"\r\n`, "utf8");
  } else {
    const launcher = join(binRoot, "gemini");
    await writeFile(launcher, `#!/bin/sh\nnode "$(dirname "$0")/fake-gemini.cjs"\n`, "utf8");
    await chmod(launcher, 0o755);
  }
  process.env.PATH = `${binRoot}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;

  const mutationMode = mode === "read" ? "read_only" : "edit";
  const adapter = createGeminiCliAdapter({
    model: "gemini-router/local-v1",
    workingDirectory: workspace,
    readOnly: mutationMode === "read_only",
    providerExecutionTimeoutMs: 10_000
  });
  const store = createFileRunStore({ runsRoot });
  const result = await runMartin({
    workspaceId: `ws_gemini_${mode}`,
    projectId: "proj_gemini_governed",
    task: {
      title: `Controlled Gemini ${mode}`,
      objective: "Execute the controlled Gemini fixture and preserve terminal truth.",
      verificationPlan: [process.platform === "win32" ? "cmd /c exit 0" : "true"],
      mutationMode,
      repoRoot: workspace,
      ...(mode === "write" ? { allowedPaths: ["gemini-owned.txt"] } : {})
    },
    budget: { maxUsd: 5, softLimitUsd: 4, maxIterations: 1, maxTokens: 500_000 },
    adapter,
    store
  });
  result.loop.receiptScope = { repoRoot: workspace, workingDirectory: workspace, runsRoot };
  await persistLoopArtifacts(result.loop, { runsRoot });
  return { result, workspace, runsRoot };
}

describe("Gemini governed Core to CLI persistence", () => {
  it.each(["write", "read"] as const)("reconciles exact model, accounting, receipt, dossier and runs-verify for %s", { timeout: 30_000 }, async (mode) => {
    const { result, workspace, runsRoot } = await runControlled(mode);
    expect(result.loop.cost).toMatchObject({ tokensIn: 120, tokensOut: 30 });
    expect(result.loop.cost.providerSettlement).toMatchObject({ model: "gemini-router/local-v1", modelSource: "provider_reported", rawUsageAvailable: true });
    expect(result.loop.events.find((event) => event.type === "verification.completed")?.payload, JSON.stringify(result.loop.events)).toMatchObject({ passed: true });
    if (mode === "write") expect(await readFile(join(workspace, "gemini-owned.txt"), "utf8")).toBe("controlled write\n");
    const dossierResult = await executeCli(["--json", "dossier", "--loop-id", result.loop.loopId, "--runs-dir", runsRoot]);
    const verifyResult = await executeCli(["--json", "runs", "verify", "--loop-id", result.loop.loopId, "--runs-dir", runsRoot]);
    expect(dossierResult.exitCode, dossierResult.stderr || dossierResult.stdout).toBe(0);
    expect(verifyResult.exitCode, verifyResult.stderr || verifyResult.stdout).toBe(0);
    expect(JSON.parse(dossierResult.stdout).verifiedHandoff.receiptIntegrity.state).toBe("verified");
    expect(JSON.parse(verifyResult.stdout).verifiedHandoff.outcome).toBe("VERIFIED");
  });

  it.each(["error", "malformed", "misleading", "mismatch"] as const)("persists Gemini %s as non-verified failure", { timeout: 30_000 }, async (mode) => {
    const { result, runsRoot } = await runControlled(mode);
    expect(result.loop.events.find((event) => event.type === "verification.completed")?.payload).toMatchObject({ passed: false });
    const verifyResult = await executeCli(["--json", "runs", "verify", "--loop-id", result.loop.loopId, "--runs-dir", runsRoot]);
    expect(verifyResult.exitCode).not.toBe(0);
    expect(JSON.parse(verifyResult.stdout).verifiedHandoff.outcome).not.toBe("VERIFIED");
  });
});
