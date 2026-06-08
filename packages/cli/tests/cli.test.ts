import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStubDirectProviderAdapter } from "@martin/adapters";
import { afterEach, describe, expect, it } from "vitest";

import { createLoopRecord } from "../../contracts/src/index.js";
import { __setRunAdapterOverrideForTests, executeCli, parseCliArguments } from "../src/index.js";

function installFastRunAdapter(): void {
  __setRunAdapterOverrideForTests(
    createStubDirectProviderAdapter({
      providerId: "test",
      model: "fast",
      responder: () => ({
        status: "completed",
        summary: "Fast test adapter completed.",
        usage: {
          actualUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          provenance: "actual"
        },
        verification: {
          passed: true,
          summary: "Verification skipped in config-focused CLI tests."
        }
      })
    })
  );
}

afterEach(() => {
  __setRunAdapterOverrideForTests(undefined);
});

describe("parseCliArguments", () => {
  it("parses version flags and subcommand", () => {
    expect(parseCliArguments(["--version"])).toEqual({ command: "version" });
    expect(parseCliArguments(["-V"])).toEqual({ command: "version" });
    expect(parseCliArguments(["version"])).toEqual({ command: "version" });
  });

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
        },
        budgetOverrides: {
          maxIterations: true,
          maxTokens: true,
          maxUsd: true,
          softLimitUsd: true
        }
      }
    });
  });
});

describe("executeCli", () => {
  it("prints the public root package version", async () => {
    const rootPackageVersion = (
      JSON.parse(await readFile(join(process.cwd(), "..", "..", "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    const result = await executeCli(["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(rootPackageVersion);
  });

  it("resolves effectivePolicy from config and applies it to the run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-config-"));
    const configPath = join(directory, "martin.config.yaml");

    try {
      installFastRunAdapter();
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
        "--json",
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

  it("surfaces effective governance policy metadata in run output", { timeout: 45_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-policy-"));
    const configPath = join(directory, "martin.config.yaml");

    try {
      installFastRunAdapter();
      await writeFile(
        configPath,
        [
          "policyProfile: strict",
          "budget:",
          "  maxUsd: 12",
          "  softLimitUsd: 7",
          "  maxIterations: 5",
          "  maxTokens: 30000",
          "governance:",
          "  destructiveActionPolicy: approval",
          "  telemetryDestination: seeded-telemetry",
          "  verifierRules:",
          process.platform === "win32" ? "    - cmd /c exit 0" : "    - true",
          process.platform === "win32" ? "    - cmd /c exit 0" : "    - true"
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
        verifierRules: [
          process.platform === "win32" ? "cmd /c exit 0" : "true",
          process.platform === "win32" ? "cmd /c exit 0" : "true"
        ],
        maxUsd: 8,
        softLimitUsd: 5,
        maxIterations: 3,
        maxTokens: 20000,
        telemetryDestination: "control-plane"
      });
      expect(payload.loop.task.verificationPlan).toEqual([
        process.platform === "win32" ? "cmd /c exit 0" : "true",
        process.platform === "win32" ? "cmd /c exit 0" : "true"
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("supports verify-only runs without invoking a coding adapter", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-verify-only-"));

    try {
      const result = await executeCli([
        "--json",
        "run",
        "--objective",
        "Verify the contracts package without edits",
        "--engine",
        "codex",
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
    const packageDirectory = join(directory, "packages", "cli");
    const configPath = join(directory, "martin.config.example.yaml");
    const previousCwd = process.cwd();
    const previousInitCwd = process.env.INIT_CWD;
    const previousMarinLive = process.env.MARTIN_LIVE;

    try {
      installFastRunAdapter();
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
        "--json",
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

  it("prints the public under-$3 benchmark summary from the shipped fixture", async () => {
    const result = await executeCli(["bench", "--suite", "ralphy-smoke"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Under-$3 Challenge");
    expect(result.stdout).toContain("$2.30");
    expect(result.stdout).toContain("$5.20");
    expect(result.stdout).toContain("@martin/benchmarks");
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
      expect(result.stdout).toContain("MARTIN_LIVE=false");
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
