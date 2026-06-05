import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createLoopRecord } from "../../contracts/src/index.js";
import { executeCli, parseCliArguments } from "../src/index.js";

const FAST_VERIFIER = process.platform === "win32" ? "cmd /c exit 0" : "true";

describe("parseCliArguments", () => {
  it("parses a run command into a typed request", () => {
    const parsed = parseCliArguments([
      "run",
      "--workspace",
      "ws_ops",
      "--project",
      "proj_runtime",
      "--objective",
      "Repair the flaky CI gate",
      "--verify",
      "pnpm test",
      "--verify",
      "pnpm build",
      "--metadata",
      "owner=platform",
      "--metadata",
      "lane=nightly",
      "--budget-usd",
      "18",
      "--soft-limit-usd",
      "9.5",
      "--max-iterations",
      "4",
      "--max-tokens",
      "60000",
      "--policy",
      "balanced",
      "--telemetry",
      "control-plane"
    ]);

    expect(parsed).toEqual({
      command: "run",
      request: {
        workspaceId: "ws_ops",
        projectId: "proj_runtime",
        title: "Repair the flaky CI gate",
        objective: "Repair the flaky CI gate",
        verificationPlan: ["pnpm test", "pnpm build"],
        metadata: {
          policyProfile: "balanced",
          telemetryDestination: "control-plane",
          lane: "nightly",
          owner: "platform"
        },
        budget: {
          maxIterations: 4,
          maxTokens: 60000,
          maxUsd: 18,
          softLimitUsd: 9.5
        }
      }
    });
  });

  it("parses the built-in guide command", () => {
    expect(parseCliArguments(["guide", "mcp", "--host", "claude"])).toEqual({
      command: "guide",
      topic: "mcp",
      host: "claude"
    });
  });

  it("parses the interactive tour command", () => {
    expect(parseCliArguments(["tour", "--host", "codex"])).toEqual({
      command: "tour",
      host: "codex"
    });
  });

  it("parses --proof as a first-class run option", () => {
    expect(parseCliArguments([
      "run",
      "--objective",
      "Check the verifier path",
      "--proof",
      "--verify",
      "npm test"
    ])).toEqual({
      command: "run",
      request: expect.objectContaining({
        objective: "Check the verifier path",
        title: "Check the verifier path",
        proofMode: true,
        verificationPlan: ["npm test"]
      })
    });
  });
});

describe.sequential("executeCli", () => {
  it("renders the built-in command guide", async () => {
    const result = await executeCli(["--json", "guide", "start"]);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("guide");
    expect(payload.topic).toBe("start");
    expect(payload.recommendedSequence).toContain("martin-loop session-start");
    expect(payload.commandMap.some((entry: { topic: string }) => entry.topic === "mcp")).toBe(true);
  });

  it("renders the interactive tour", async () => {
    const result = await executeCli(["--json", "tour", "--host", "claude"]);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.command).toBe("tour");
    expect(payload.steps[0].command).toBe("martin-loop start");
    expect(
      payload.steps.some((step: { command: string }) => step.command.includes("martin-loop preflight"))
    ).toBe(true);
  });

  it("resolves effectivePolicy from config and applies it to the run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-config-"));
    const configPath = join(directory, "martin.config.yaml");

    try {
      await writeFile(
        configPath,
        [
          "policyProfile: strict",
          "budget:",
          "  maxUsd: 12",
          "  softLimitUsd: 7",
          "  maxIterations: 6",
          "  maxTokens: 45000",
          "governance:",
          "  destructiveActionPolicy: approval",
          "  telemetryDestination: control-plane",
          "  verifierRules:",
          `    - ${FAST_VERIFIER}`,
          `    - ${FAST_VERIFIER}`
        ].join("\n"),
        "utf8"
      );

      const prevLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";
      const result = await executeCli([
        "--json",
        "run",
        "--objective",
        "Repair flaky CI gate",
        "--config",
        configPath,
        "--unsafe-allow-unguarded-run"
      ]);
      if (prevLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = prevLive;
      }

      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(result.stdout);

      expect(payload.command).toBe("run");
      expect(payload.effectivePolicy).toEqual({
        configPath,
        destructiveActionPolicy: "approval",
        policyProfile: "strict",
        budget: {
          maxUsd: 12,
          softLimitUsd: 7,
          maxIterations: 6,
          maxTokens: 45000
        },
        verifierRules: [FAST_VERIFIER, FAST_VERIFIER],
        maxUsd: 12,
        softLimitUsd: 7,
        maxIterations: 6,
        maxTokens: 45000,
        telemetryDestination: "control-plane"
      });
      expect(payload.loop.budget).toEqual({
        maxUsd: 12,
        softLimitUsd: 7,
          maxIterations: 6,
          maxTokens: 45000
        });
      expect(payload.loop.task.verificationPlan).toEqual([FAST_VERIFIER, FAST_VERIFIER]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("surfaces effective governance policy metadata in run output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-effective-policy-"));
    const configPath = join(directory, "martin.config.yaml");
    const previousCwd = process.cwd();
    const previousInitCwd = process.env.INIT_CWD;
    const prevLive = process.env.MARTIN_LIVE;

    try {
      await writeFile(
        configPath,
        [
          "policyProfile: strict",
          "budget:",
          "  maxUsd: 5",
          "  softLimitUsd: 3",
          "  maxIterations: 5",
          "  maxTokens: 30000",
          "governance:",
          "  destructiveActionPolicy: approval",
          "  telemetryDestination: local-only",
          "  verifierRules:",
          `    - ${FAST_VERIFIER}`
        ].join("\n"),
        "utf8"
      );

      process.chdir(directory);
      process.env.INIT_CWD = directory;
      process.env.MARTIN_LIVE = "false";

      const result = await executeCli([
        "--json",
        "run",
        "--objective",
        "Repair flaky CI gate",
        "--budget-usd",
        "8",
        "--soft-limit-usd",
        "5",
        "--max-iterations",
        "3",
        "--max-tokens",
        "20000",
        "--policy",
        "balanced",
        "--telemetry",
        "control-plane",
        "--unsafe-allow-unguarded-run"
      ]);

      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(result.stdout);

      expect(payload.command).toBe("run");
      expect(payload.effectivePolicy).toEqual({
        configPath,
        destructiveActionPolicy: "approval",
        policyProfile: "balanced",
        budget: {
          maxUsd: 8,
          softLimitUsd: 5,
          maxIterations: 5,
          maxTokens: 30000
        },
        verifierRules: [FAST_VERIFIER],
        maxUsd: 8,
        softLimitUsd: 5,
        maxIterations: 5,
        maxTokens: 30000,
        telemetryDestination: "control-plane"
      });
      expect(payload.loop.task.verificationPlan).toEqual([FAST_VERIFIER]);
    } finally {
      process.chdir(previousCwd);

      if (previousInitCwd === undefined) {
        delete process.env.INIT_CWD;
      } else {
        process.env.INIT_CWD = previousInitCwd;
      }

      if (prevLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = prevLive;
      }

      await rm(directory, { force: true, recursive: true });
    }
  });

  it("supports verify-only runs without invoking a coding adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-verify-only-"));

    try {
      const result = await executeCli([
        "--json",
        "run",
        "--objective",
        "Verify the contracts package without edits",
        "--verify-only",
        "--verify",
        `"${process.execPath}" -e "process.exit(0)"`,
        "--cwd",
        directory,
        "--allow-path",
        "packages/contracts/**"
      ]);

      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(result.stdout);

      expect(payload.decision.lifecycleState).toBe("completed");
      expect(payload.loop.lifecycleState).toBe("completed");
      expect(payload.loop.task.mutationMode).toBe("verify_only");
      expect(payload.loop.cost.actualUsd).toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("resolves a relative --config path from INIT_CWD for filtered dev runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-init-cwd-"));
    const configPath = join(directory, "martin.config.example.yaml");
    const previousInitCwd = process.env.INIT_CWD;
    const previousMarinLive = process.env.MARTIN_LIVE;

    try {
      await writeFile(
        configPath,
        [
          "policyProfile: strict",
          "budget:",
          "  maxUsd: 12",
          "  softLimitUsd: 7",
          "  maxIterations: 6",
          "  maxTokens: 45000",
          "governance:",
          "  destructiveActionPolicy: approval",
          "  telemetryDestination: control-plane",
          "  verifierRules:",
          `    - ${FAST_VERIFIER}`,
          `    - ${FAST_VERIFIER}`
        ].join("\n"),
        "utf8"
      );

      process.env.INIT_CWD = directory;

      process.env.MARTIN_LIVE = "false";
      const result = await executeCli([
        "--json",
        "run",
        "--objective",
        "Repair flaky CI gate",
        "--config",
        ".\\martin.config.example.yaml",
        "--unsafe-allow-unguarded-run"
      ]);

      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(result.stdout);

      expect(payload.effectivePolicy.configPath).toBe(configPath);
      expect(payload.effectivePolicy.policyProfile).toBe("strict");
      expect(payload.loop.task.verificationPlan).toEqual([FAST_VERIFIER, FAST_VERIFIER]);
    } finally {
      if (previousInitCwd === undefined) {
        delete process.env.INIT_CWD;
      } else {
        process.env.INIT_CWD = previousInitCwd;
      }

      if (previousMarinLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousMarinLive;
      }

      await rm(directory, { force: true, recursive: true });
    }
  });

  it("surfaces bench as an RC-only workspace command instead of a publishable CLI feature", async () => {
    const result = await executeCli(["bench", "--suite", "ralphy-smoke"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("workspace-only RC surface");
    expect(result.stderr).toContain("@martin/benchmarks");
  });

  it("copies the seeded demo workspace into the default target directory", async () => {
    const previousCwd = process.cwd();
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-demo-default-"));

    try {
      process.chdir(directory);

      const result = await executeCli(["demo"]);
      const targetDirectory = join(directory, "martin-loop-demo");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(targetDirectory);
      expect(result.stdout).toContain("npm install");
      expect(result.stdout).toContain("npx martin-loop run");
      expect(result.stdout).toContain("--proof");
      expect(await readFile(join(targetDirectory, "README.md"), "utf8")).toContain("Demo Sandbox");
    } finally {
      process.chdir(previousCwd);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("supports --dir for the demo sandbox target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-demo-dir-"));
    const targetDirectory = join(directory, "custom-demo");

    try {
      const result = await executeCli(["demo", "--dir", targetDirectory]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(targetDirectory);
      expect(await readFile(join(targetDirectory, "package.json"), "utf8")).toContain(
        "martin-loop-demo-sandbox"
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("refuses to overwrite a non-empty demo target without --force", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-demo-blocked-"));
    const targetDirectory = join(directory, "existing demo");

    try {
      await mkdir(targetDirectory, { recursive: true });
      await writeFile(join(targetDirectory, "keep.txt"), "do not replace", "utf8");

      const result = await executeCli(["demo", "--dir", targetDirectory]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("already exists and is not empty");
      expect(await readFile(join(targetDirectory, "keep.txt"), "utf8")).toBe("do not replace");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("replaces a non-empty demo target when --force is provided", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-demo-force-"));
    const targetDirectory = join(directory, "existing demo");

    try {
      await mkdir(targetDirectory, { recursive: true });
      await writeFile(join(targetDirectory, "keep.txt"), "replace me", "utf8");

      const result = await executeCli(["demo", "--dir", targetDirectory, "--force"]);

      expect(result.exitCode).toBe(0);
      await expect(readFile(join(targetDirectory, "keep.txt"), "utf8")).rejects.toThrow();
      expect(await readFile(join(targetDirectory, "TASKS.md"), "utf8")).toContain("Optional live run");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("handles demo target paths with spaces and prints the guided next steps", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-demo-spaces-"));
    const targetDirectory = join(directory, "demo sandbox with spaces");

    try {
      const result = await executeCli(["demo", "--dir", targetDirectory]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`cd ${targetDirectory}`);
      expect(result.stdout).toContain("Optional live run");
      expect(await readFile(join(targetDirectory, "martin.config.yaml"), "utf8")).toContain(
        "strict_local"
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("inspects loop record files and returns a portfolio summary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-"));
    const filePath = join(directory, "loop.json");

    try {
      const loop = createLoopRecord(
        {
          workspaceId: "ws_ops",
          projectId: "proj_runtime",
          task: {
            title: "Repair the flaky CI gate",
            objective: "Repair the flaky CI gate",
            verificationPlan: ["pnpm test"]
          },
          cost: {
            actualUsd: 3,
            avoidedUsd: 7,
            tokensIn: 1200,
            tokensOut: 450
          }
        },
        {
          now: "2026-03-27T16:00:00.000Z",
          idFactory: (prefix) => `${prefix}_001`
        }
      );

      await writeFile(filePath, JSON.stringify(loop, null, 2), "utf8");

      const result = await executeCli(["--json", "inspect", "--file", filePath]);

      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(result.stdout);

      expect(payload.command).toBe("inspect");
      expect(payload.summary.totalActualUsd).toBe(3);
      expect(payload.summary.totalAvoidedUsd).toBe(7);
      expect(payload.summary.activeLoops).toBe(1);
      expect(payload.source).toBe(filePath);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("inspects persisted JSONL loop records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-jsonl-"));
    const filePath = join(directory, "loops.jsonl");

    try {
      const firstLoop = createLoopRecord({
        workspaceId: "ws_ops",
        projectId: "proj_runtime",
        task: {
          title: "Repair the flaky CI gate",
          objective: "Repair the flaky CI gate",
          verificationPlan: ["pnpm test"]
        },
        cost: {
          actualUsd: 3,
          avoidedUsd: 7,
          tokensIn: 1200,
          tokensOut: 450
        }
      });
      const secondLoop = createLoopRecord({
        workspaceId: "ws_docs",
        projectId: "proj_readme",
        task: {
          title: "Polish release docs",
          objective: "Polish release docs",
          verificationPlan: ["pnpm test"]
        },
        cost: {
          actualUsd: 2,
          avoidedUsd: 5,
          tokensIn: 800,
          tokensOut: 200
        }
      });

      await writeFile(
        filePath,
        `${JSON.stringify(firstLoop)}\n${JSON.stringify(secondLoop)}\n`,
        "utf8"
      );

      const result = await executeCli(["--json", "inspect", "--file", filePath]);

      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(result.stdout);

      expect(payload.command).toBe("inspect");
      expect(payload.summary.totalActualUsd).toBe(5);
      expect(payload.summary.totalAvoidedUsd).toBe(12);
      expect(payload.summary.activeLoops).toBe(2);
      expect(payload.source).toBe(filePath);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
