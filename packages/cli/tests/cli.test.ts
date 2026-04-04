import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createLoopRecord } from "../../contracts/src/index.js";
import { executeCli, parseCliArguments } from "../src/index.js";

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
});

describe("executeCli", () => {
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
          "    - pnpm test",
          "    - pnpm lint"
        ].join("\n"),
        "utf8"
      );

      const prevLive = process.env.MARTIN_LIVE;
      process.env.MARTIN_LIVE = "false";
      const result = await executeCli([
        "run",
        "--objective",
        "Repair flaky CI gate",
        "--config",
        configPath
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
        verifierRules: ["pnpm test", "pnpm lint"],
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
      expect(payload.loop.task.verificationPlan).toEqual(["pnpm test", "pnpm lint"]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("surfaces effective governance policy metadata in run output", async () => {
    const configPath = join(process.env.INIT_CWD ?? process.cwd(), "martin.config.yaml");
    const prevLive = process.env.MARTIN_LIVE;
    process.env.MARTIN_LIVE = "false";
    const result = await executeCli([
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
      "control-plane"
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
      policyProfile: "balanced",
      budget: {
        maxUsd: 8,
        softLimitUsd: 5,
        maxIterations: 3,
        maxTokens: 20000
      },
      verifierRules: ["pnpm test"],
      maxUsd: 8,
      softLimitUsd: 5,
      maxIterations: 3,
      maxTokens: 20000,
      telemetryDestination: "control-plane"
    });
    expect(payload.loop.task.verificationPlan).toEqual(["pnpm test"]);
  });

  it("resolves a relative --config path from INIT_CWD for filtered dev runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-init-cwd-"));
    const packageDirectory = join(directory, "packages", "cli");
    const configPath = join(directory, "martin.config.example.yaml");
    const previousCwd = process.cwd();
    const previousInitCwd = process.env.INIT_CWD;
    const previousMarinLive = process.env.MARTIN_LIVE;

    try {
      await mkdir(packageDirectory, { recursive: true });
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
          "    - pnpm test",
          "    - pnpm lint"
        ].join("\n"),
        "utf8"
      );

      process.chdir(packageDirectory);
      process.env.INIT_CWD = directory;

      process.env.MARTIN_LIVE = "false";
      const result = await executeCli([
        "run",
        "--objective",
        "Repair flaky CI gate",
        "--config",
        ".\\martin.config.example.yaml"
      ]);

      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(result.stdout);

      expect(payload.effectivePolicy.configPath).toBe(configPath);
      expect(payload.effectivePolicy.policyProfile).toBe("strict");
      expect(payload.loop.task.verificationPlan).toEqual(["pnpm test", "pnpm lint"]);
    } finally {
      process.chdir(previousCwd);

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
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("workspace-only RC surface");
    expect(result.stderr).toContain("@martin/benchmarks");
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

      const result = await executeCli(["inspect", "--file", filePath]);

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
});
