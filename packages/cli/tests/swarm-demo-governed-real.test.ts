import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executePersistedSwarmDemoCommand } from "../src/swarm-command-private.js";

const execFileAsync = promisify(execFile);

let scratchRoot: string;
let previousIntegrityKeyDir: string | undefined;

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

beforeEach(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), "martin-governed-demo-real-"));
  previousIntegrityKeyDir = process.env["MARTIN_INTEGRITY_KEY_DIR"];
  process.env["MARTIN_INTEGRITY_KEY_DIR"] = join(scratchRoot, "integrity");
  await git(scratchRoot, ["init"]);
  await git(scratchRoot, ["config", "user.email", "governed-demo@example.invalid"]);
  await git(scratchRoot, ["config", "user.name", "Governed Demo"]);
  await writeFile(join(scratchRoot, "README.md"), "governed demo fixture\n", "utf8");
  await writeFile(join(scratchRoot, ".gitignore"), "runs/\nintegrity/\n", "utf8");
  await git(scratchRoot, ["add", "."]);
  await git(scratchRoot, ["commit", "-m", "fixture"]);
});

afterEach(async () => {
  if (previousIntegrityKeyDir === undefined) delete process.env["MARTIN_INTEGRITY_KEY_DIR"];
  else process.env["MARTIN_INTEGRITY_KEY_DIR"] = previousIntegrityKeyDir;
  await rm(scratchRoot, { recursive: true, force: true });
});

async function readAllJson(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl")) found.push(await readFile(path, "utf8"));
    }
  }
  await walk(root);
  return found;
}

describe("governed provider-free swarm demo (real runtime, no mocked runLiveSwarm)", () => {
  it("completes with authoritative verified evidence and truthful local-deterministic identity", async () => {
    const runsDir = join(scratchRoot, "runs");
    const result = await executePersistedSwarmDemoCommand({
      mode: "governed",
      cwd: scratchRoot,
      runsDir,
      agents: 2,
      maxConcurrency: 2,
      budgetUsd: 0,
      engine: "codex",
    }, "json");

    const diagnostics = result.exitCode === 0 ? "" : [...new Set(
      (await readAllJson(runsDir)).join("\n").match(/"(?:reason|message|failureClass|summary|command|exitCode|launched|completed|passed|verificationState|processCloseState|diagnostic)"\s*:\s*"[^"]{3,200}"/gu) ?? [],
    )].slice(0, 60).join("\n");
    expect(result.exitCode, `${result.stdout}\n${result.stderr}\n${diagnostics}`).toBe(0);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output).toMatchObject({
      outcome: { state: "verified" },
      authoritative: true,
      providerExecuted: false,
      providerSpendUsd: 0,
      simulationFallbackCalls: 0,
    });

    const documents = (await readAllJson(runsDir)).join("\n");
    expect(documents).toContain("local-deterministic");
    expect(documents).toContain("deterministic-governed");
    expect(documents).not.toContain("providerSettlement");
    expect(documents).not.toContain("LIVE_ENGINE_PROVIDER_MISMATCH");
    expect(documents).toMatch(/"swarm\.providerBindingMode"\s*:\s*"provider_free_deterministic"/u);
    // The recorded child verification is the plan's real command, not a made-up label.
    expect(documents).toContain("node --version");
    expect(documents).not.toContain("provider-free-deterministic-check");

    // The authority chain is exactly zero: no nominal budget anywhere.
    const budgetValues = [...documents.matchAll(/"(?:maxUsd|softLimitUsd|actualUsd|estimatedUsd|preflightEstimateUsd|estimatedAttemptCostUsd)"\s*:\s*([0-9.eE+-]+)/gu)]
      .map((match) => Number(match[1]));
    expect(budgetValues.length).toBeGreaterThan(0);
    expect(budgetValues.filter((value) => value !== 0)).toEqual([]);

    // The real execution identity is local-deterministic; no provider executed.
    expect(documents).not.toMatch(/"providerId"\s*:\s*"openai/u);
    expect(documents).toMatch(/"executionProviderId"\s*:\s*"local-deterministic"/u);
    expect(documents).toMatch(/"providerExecuted"\s*:\s*false/u);
    expect(documents).not.toMatch(/"providerExecuted"\s*:\s*true/u);
  }, 120_000);
});
