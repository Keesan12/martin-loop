import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MartinAdapterRequest } from "@martin/core";

import {
  createAgentCliAdapter,
  createSpawnPlan,
  createClaudeCliAdapter,
  createCodexCliAdapter,
  createGeminiCliAdapter,
  createVerifierOnlyAdapter,
  type SpawnLike
} from "../src/index.js";
import { DEFAULT_CODEX_CHATGPT_MODEL } from "../src/codex-launcher.js";
import { containsShellOperator, readGitChangedFiles, readGitExecutionArtifacts, runSubprocess, splitCommand } from "../src/cli-bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<MartinAdapterRequest> = {}): MartinAdapterRequest {
  return {
    loopId: "loop_test",
    attemptId: "att_test_1",
    context: {
      taskTitle: "Fix the off-by-one error",
      objective: "Correct the index calculation in counter.ts so the result is 10 not 9.",
      verificationPlan: ["pnpm test -- counter"],
      focus: "Fix only the index calculation. Do not touch other code.",
      remainingBudgetUsd: 8,
      remainingIterations: 3,
      remainingTokens: 10_000
    },
    previousAttempts: [],
    ...overrides
  };
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  options?: SpawnOptions;
  stdin: string;
}

interface ScriptedSpawnOutput {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

function createScriptedSpawn(
  calls: SpawnCall[],
  outputs: ScriptedSpawnOutput[] = [{ stdout: "done\n" }]
): SpawnLike {
  let index = 0;

  return (command, args = [], options) => {
    const output = outputs[index] ?? outputs.at(-1) ?? { stdout: "done\n" };
    index += 1;

    const child = new EventEmitter() as Partial<ChildProcess> & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;

    const call: SpawnCall = {
      command,
      args: [...args],
      options,
      stdin: ""
    };
    calls.push(call);

    child.stdin.on("data", (chunk: Buffer | string) => {
      call.stdin += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    });

    process.nextTick(() => {
      if (output.stdout) {
        child.stdout.write(output.stdout);
      }
      if (output.stderr) {
        child.stderr.write(output.stderr);
      }
      child.stdout.end();
      child.stderr.end();
      child.emit("close", output.exitCode ?? 0);
    });

    return child as ChildProcess;
  };
}

/**
 * Simulates a CLI emitting newline-delimited `stream-json` events one at a
 * time (each `data` event arriving separately, as a real subprocess would),
 * so the streaming usage inspector can observe them incrementally and request
 * early termination via `child.kill()`.
 */
function createStreamingSpawn(calls: SpawnCall[], lines: string[]): SpawnLike {
  return (command, args = [], options) => {
    const child = new EventEmitter() as Partial<ChildProcess> & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();

    let killed = false;
    let closed = false;
    const emitClose = (code: number) => {
      if (closed) {
        return;
      }
      closed = true;
      child.emit("close", code);
    };

    child.kill = () => {
      if (!killed) {
        killed = true;
        child.stdout.end();
        child.stderr.end();
        setImmediate(() => emitClose(143));
      }
      return true;
    };

    const call: SpawnCall = { command, args: [...args], options, stdin: "" };
    calls.push(call);
    child.stdin.on("data", (chunk: Buffer | string) => {
      call.stdin += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    });

    void (async () => {
      for (const line of lines) {
        if (killed) {
          return;
        }
        child.stdout.write(`${line}\n`);
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (!killed) {
        child.stdout.end();
        child.stderr.end();
        emitClose(0);
      }
    })();

    return child as ChildProcess;
  };
}

async function withPathPrefix<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const original = process.env[pathKey] ?? "";
  process.env[pathKey] =
    original.length > 0
      ? `${directory}${process.platform === "win32" ? ";" : ":"}${original}`
      : directory;

  try {
    return await fn();
  } finally {
    process.env[pathKey] = original;
  }
}
// ---------------------------------------------------------------------------
// Generic adapter factory
// ---------------------------------------------------------------------------

describe("createAgentCliAdapter", () => {
  it("returns correct adapterId, kind, and metadata", () => {
    const adapter = createAgentCliAdapter({
      command: "mytool",
      argsBuilder: (prompt) => ["--run", prompt],
      model: "mytool-v1",
      label: "My tool"
    });

    expect(adapter.adapterId).toBe("agent-cli:mytool");
    expect(adapter.kind).toBe("agent-cli");
    expect(adapter.label).toBe("My tool");
    expect(adapter.metadata.providerId).toBe("mytool");
    expect(adapter.metadata.model).toBe("mytool-v1");
    expect(adapter.metadata.transport).toBe("cli");
    expect(adapter.metadata.capabilities.usageSettlement).toBe(false);
  });

  it("uses adapterIdSuffix when provided", () => {
    const adapter = createAgentCliAdapter({
      command: "claude",
      adapterIdSuffix: "claude-sonnet",
      argsBuilder: (p) => [p]
    });

    expect(adapter.adapterId).toBe("agent-cli:claude-sonnet");
  });

  it("returns failed with stalled message when subprocess times out", async () => {
    const adapter = createAgentCliAdapter({
      command: process.execPath,
      argsBuilder: () => ["-e", "setTimeout(() => {}, 10_000)"],
      timeoutMs: 50
    });

    const result = await adapter.execute(makeRequest());

    expect(result.status).toBe("failed");
    expect(result.verification.passed).toBe(false);
    expect(result.failure?.message).toContain("stalled");
  });

  it("normalizes sync ENOENT spawn failures into failed adapter results", async () => {
    const adapter = createAgentCliAdapter({
      command: "definitely-not-a-real-binary-xyzabc",
      argsBuilder: (p) => [p],
      spawnImpl() {
        const error = new Error("spawn ENOENT");
        Object.assign(error, { code: "ENOENT" });
        throw error;
      }
    });

    const result = await adapter.execute(makeRequest());

    expect(result.status).toBe("failed");
    expect(result.failure?.message).toContain("environment_mismatch");
  });

  it("normalizes sync EPERM spawn failures into failed adapter results", async () => {
    const adapter = createAgentCliAdapter({
      command: "codex",
      argsBuilder: () => ["--full-auto", "test"],
      spawnImpl() {
        const error = new Error("spawn EPERM");
        Object.assign(error, { code: "EPERM" });
        throw error;
      }
    });

    const result = await adapter.execute(makeRequest());

    expect(result.status).toBe("failed");
    expect(result.verification.passed).toBe(false);
    expect(result.failure?.message).toContain("environment_mismatch");
  });

  it("runs verification and returns completed when all commands pass", async () => {
    const adapter = createAgentCliAdapter({
      command: process.platform === "win32" ? "cmd" : "echo",
      argsBuilder: () =>
        process.platform === "win32" ? ["/c", "echo", "done"] : ["done"]
    });

    const request = makeRequest({
      context: {
        taskTitle: "test",
        objective: "test",
        verificationPlan: process.platform === "win32" ? ["cmd /c exit 0"] : ["true"],
        focus: "test",
        remainingBudgetUsd: 8,
        remainingIterations: 3,
        remainingTokens: 10_000
      }
    });

    const result = await adapter.execute(request);

    expect(result.status).toBe("completed");
    expect(result.verification.passed).toBe(true);
  });

  it("returns failed when verification command exits non-zero", async () => {
    const adapter = createAgentCliAdapter({
      command: process.platform === "win32" ? "cmd" : "echo",
      argsBuilder: () =>
        process.platform === "win32" ? ["/c", "echo", "done"] : ["done"]
    });

    const request = makeRequest({
      context: {
        taskTitle: "test",
        objective: "test",
        verificationPlan: process.platform === "win32" ? ["cmd /c exit 1"] : ["false"],
        focus: "test",
        remainingBudgetUsd: 8,
        remainingIterations: 3,
        remainingTokens: 10_000
      }
    });

    const result = await adapter.execute(request);

    expect(result.status).toBe("failed");
    expect(result.verification.passed).toBe(false);
    expect(result.failure).toBeDefined();
  });

  it("includes prior attempt context in the prompt (via argsBuilder inspection)", () => {
    const capturedArgs: string[] = [];

    const adapter = createAgentCliAdapter({
      command: process.platform === "win32" ? "cmd" : "echo",
      argsBuilder: (prompt) => {
        capturedArgs.push(prompt);
        return process.platform === "win32" ? ["/c", "echo", "ok"] : ["ok"];
      }
    });

    const request = makeRequest({
      previousAttempts: [
        {
          attemptId: "att_1",
          index: 1,
          adapterId: "agent-cli:claude",
          model: "claude",
          startedAt: "2025-01-01T00:00:00Z",
          summary: "Changed wrong line.",
          failureClass: "logic_error",
          intervention: "change_model"
        }
      ]
    });

    void adapter.execute(request);

    expect(capturedArgs[0]).toContain("PRIOR FAILED ATTEMPTS");
    expect(capturedArgs[0]).toContain("logic_error");
    expect(capturedArgs[0]).toContain("change_model");
  });

  it("passes empty verification with no commands", async () => {
    const adapter = createAgentCliAdapter({
      command: process.platform === "win32" ? "cmd" : "echo",
      argsBuilder: () =>
        process.platform === "win32" ? ["/c", "echo", "done"] : ["done"]
    });

    const request = makeRequest({
      context: {
        taskTitle: "test",
        objective: "test",
        verificationPlan: [],
        focus: "test",
        remainingBudgetUsd: 8,
        remainingIterations: 3,
        remainingTokens: 10_000
      }
    });

    const result = await adapter.execute(request);

    expect(result.status).toBe("completed");
    expect(result.verification.summary).toContain("No verification commands");
  });

  it("preserves quoted verifier arguments and executable paths when tokenizing verification commands", () => {
    expect(splitCommand(`"${process.execPath}" -e "process.exit(0)"`)).toEqual([
      process.execPath,
      "-e",
      "process.exit(0)"
    ]);
  });

  it("returns estimated cost provenance when the CLI does not emit settled usage", async () => {
    const adapter = createAgentCliAdapter({
      command: process.execPath,
      argsBuilder: () => ["-e", "console.log('done')"],
      supportsJsonOutput: false
    });

    const result = await adapter.execute(
      makeRequest({
        context: {
          taskTitle: "test",
          objective: "test",
          verificationPlan: [],
          focus: "test",
          remainingBudgetUsd: 8,
          remainingIterations: 3,
          remainingTokens: 10_000
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(result.usage.provenance).toBe("estimated");
    expect(result.usage.estimatedUsd).toBeGreaterThan(0);
  });
});

describe("splitCommand", () => {
  it("preserves backslashes inside quoted Windows executable paths", () => {
    const command =
      '"C:\\Projects\\Example\\node.exe" -e "process.exit(0)"';

    expect(splitCommand(command)).toEqual([
      "C:\\Projects\\Example\\node.exe",
      "-e",
      "process.exit(0)",
    ]);
  });
});

describe("containsShellOperator", () => {
  it("detects && operator", () => {
    expect(containsShellOperator("bun run lint && bun run test")).toBe(true);
  });

  it("detects || operator", () => {
    expect(containsShellOperator("cmd1 || cmd2")).toBe(true);
  });

  it("detects ; operator", () => {
    expect(containsShellOperator("cmd1; cmd2")).toBe(true);
  });

  it("detects | pipe operator", () => {
    expect(containsShellOperator("cat file | grep foo")).toBe(true);
  });

  it("does not match && inside double quotes", () => {
    expect(containsShellOperator('echo "a && b"')).toBe(false);
  });

  it("does not match && inside single quotes", () => {
    expect(containsShellOperator("echo 'a && b'")).toBe(false);
  });

  it("returns false for simple commands", () => {
    expect(containsShellOperator("bun run lint")).toBe(false);
    expect(containsShellOperator("pnpm test -- counter")).toBe(false);
    expect(containsShellOperator("npm run build")).toBe(false);
  });
});

describe("createSpawnPlan", () => {
  it("wraps absolute Windows .cmd verifiers with cmd.exe", () => {
    if (process.platform !== "win32") {
      expect(true).toBe(true);
      return;
    }

    const pnpmPath = "C:\\Tools\\Example Path\\npm\\pnpm.cmd";
    const plan = createSpawnPlan(
      pnpmPath,
      ["verify shared baseline", "--filter", "pkg with spaces"],
      process.cwd(),
      false
    );

    expect(plan.command.toLowerCase()).toContain("cmd.exe");
    expect(plan.args[0]).toBe("/d");
    expect(plan.args[1]).toBe("/c");
    expect(plan.args[2]).toBe("C:\\Tools\\Example Path\\npm\\pnpm.cmd");
    expect(plan.args[3]).toBe("verify shared baseline");
    expect(plan.args[5]).toBe("pkg with spaces");
  });

  it("wraps absolute Windows PowerShell scripts through powershell.exe", () => {
    if (process.platform !== "win32") {
      expect(true).toBe(true);
      return;
    }

    const scriptPath = "C:\\Tools\\npm\\codex.ps1";
    const plan = createSpawnPlan(scriptPath, ["--version"], process.cwd(), false);

    expect(plan.command.toLowerCase()).toContain("powershell.exe");
    expect(plan.args.slice(0, 4)).toEqual([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File"
    ]);
    expect(plan.args[4]).toBe(scriptPath);
    expect(plan.args[5]).toBe("--version");
  });

  it("falls back to cmd.exe shell when command is not found in PATH on Windows (regression: loop_b6800tz2)", () => {
    if (process.platform !== "win32") {
      // On non-Windows the plan passes the command through unchanged.
      const plan = createSpawnPlan("pnpm-not-in-path", ["test"], process.cwd(), false);
      expect(plan.command).toBe("pnpm-not-in-path");
      return;
    }

    // Use a command that will never be on disk so resolveWindowsCommand returns undefined.
    const plan = createSpawnPlan("__martin_nonexistent_verifier_cmd__", ["run", "test"], process.cwd(), false);

    // Must route through cmd.exe so Windows can try PATH resolution itself.
    expect(plan.command.toLowerCase()).toMatch(/cmd\.exe|comspec/i);
    expect(plan.args[0]).toBe("/d");
    expect(plan.args[1]).toBe("/c");
    expect(plan.args[2]).toContain("__martin_nonexistent_verifier_cmd__");
    expect(plan.args[3]).toBe("run");
    expect(plan.args[4]).toBe("test");
  });

  it("preserves raw command when preserveRawForInjectedSpawn is true regardless of platform", () => {
    const plan = createSpawnPlan("pnpm", ["test"], process.cwd(), true);
    expect(plan.command).toBe("pnpm");
    expect(plan.args).toEqual(["test"]);
  });
});

describe("runSubprocess", () => {
  it("does not mark timeout when the process has exited but close arrives later", async () => {
    const spawnImpl: SpawnLike = () => {
      const child = new EventEmitter() as Partial<ChildProcess> & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: Writable;
        exitCode: number | null;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        }
      });
      child.exitCode = null;
      child.kill = () => true;

      setTimeout(() => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
      }, 0);

      setTimeout(() => {
        child.emit("close", 0, null);
      }, 30);

      return child as ChildProcess;
    };

    const result = await runSubprocess("codex", ["exec", "-"], {
      cwd: process.cwd(),
      timeoutMs: 10,
      spawnImpl
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("handles closed stdin pipes without surfacing an unhandled EPIPE", async () => {
    const spawnImpl: SpawnLike = () => {
      const child = new EventEmitter() as Partial<ChildProcess> & {
        stdout: PassThrough;
        stderr: PassThrough;
        stdin: Writable;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) {
          const error = new Error("write EPIPE") as NodeJS.ErrnoException;
          error.code = "EPIPE";
          callback(error);
        }
      });
      child.kill = () => true;

      process.nextTick(() => {
        child.emit("close", 0);
      });

      return child as ChildProcess;
    };

    const result = await runSubprocess("codex", ["exec", "-"], {
      cwd: process.cwd(),
      timeoutMs: 1_000,
      spawnImpl,
      stdinData: "OBJECTIVE: test"
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.timedOut).toBe(false);
  });
});

describe("createVerifierOnlyAdapter", () => {
  it("short-circuits git inspection outside a repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-no-git-"));
    let spawnCalls = 0;
    const spawnImpl: SpawnLike = () => {
      spawnCalls += 1;
      throw new Error("git subprocess should not run outside a repository");
    };

    try {
      await expect(readGitChangedFiles(directory, 1_000, spawnImpl)).resolves.toEqual([]);
      await expect(readGitExecutionArtifacts(directory, 1_000, spawnImpl)).resolves.toEqual({});
      expect(spawnCalls).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("skips baseline diff scans when verify-only has no verification steps", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-verify-empty-"));

    try {
      const adapter = createVerifierOnlyAdapter({ workingDirectory: directory });
      const result = await adapter.execute(
        makeRequest({
          context: {
            taskTitle: "verify only",
            objective: "Run verification only",
            verificationPlan: [],
            verificationStack: [],
            focus: "verify only",
            remainingBudgetUsd: 8,
            remainingIterations: 1,
            remainingTokens: 10_000
          }
        })
      );

      expect(result.status).toBe("completed");
      expect(result.execution?.changedFiles).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports verifier-created file changes instead of treating verify-only as clean", async () => {
    const trustedWorkspaceRoot = join(process.cwd(), ".tmp");
    await mkdir(trustedWorkspaceRoot, { recursive: true });
    const directory = await mkdtemp(join(trustedWorkspaceRoot, "martin-verify-only-"));
    const calls: SpawnCall[] = [];

    try {
      const adapter = createVerifierOnlyAdapter({
        workingDirectory: directory,
        spawnImpl: createScriptedSpawn(calls, [
          { stdout: "" },
          { stdout: "" },
          { stdout: " M tracked.txt\u0000" }
        ])
      });
      const result = await adapter.execute(
        makeRequest({
          context: {
            taskTitle: "verify only",
            objective: "Run verification only",
            verificationPlan: [
              `"${process.execPath}" -e "require('node:fs').writeFileSync('tracked.txt','changed')"`
            ],
            focus: "verify only",
            remainingBudgetUsd: 8,
            remainingIterations: 1,
            remainingTokens: 10_000
          }
        })
      );

      expect(result.verification.passed).toBe(true);
      expect(result.execution?.changedFiles).toContain("tracked.txt");
      expect(calls.some((call) => call.command === "git")).toBe(true);
      expect(calls.some((call) => call.command === process.execPath)).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Claude-specific factory
// ---------------------------------------------------------------------------

describe("createClaudeCliAdapter", () => {
  it("returns correct adapterId and kind", () => {
    const adapter = createClaudeCliAdapter();

    expect(adapter.adapterId).toBe("agent-cli:claude");
    expect(adapter.kind).toBe("agent-cli");
    expect(adapter.metadata.providerId).toBe("claude");
    expect(adapter.metadata.transport).toBe("cli");
  });

  it("surfaces model in metadata when provided", () => {
    const adapter = createClaudeCliAdapter({ model: "claude-opus-4-6" });

    expect(adapter.metadata.model).toBe("claude-opus-4-6");
  });

  it("returns failed gracefully when claude is not installed", async () => {
    const adapter = createClaudeCliAdapter({
      timeoutMs: 2_000,
      spawnImpl() {
        const error = new Error("spawn ENOENT");
        Object.assign(error, { code: "ENOENT" });
        throw error;
      }
    });
    const result = await adapter.execute(makeRequest());

    expect(result.status).toBe("failed");
    expect(result.failure?.message).toContain("environment_mismatch");
  });

  it("skips git probes when repoRoot is outside a repository", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "martin-non-repo-"));
    const calls: SpawnCall[] = [];
    const adapter = createClaudeCliAdapter({
      spawnImpl: createScriptedSpawn(calls, [
        {
          stdout: JSON.stringify({
            type: "result",
            result: "Patched the target file.",
            usage: {
              input_tokens: 12,
              output_tokens: 8
            }
          })
        },
        { stdout: "" },
        { stdout: "src/index.ts\n" },
        { stdout: "1\t0\tsrc/index.ts\n" },
        { stdout: "src/index.ts\n" }
      ])
    });

    try {
      const result = await adapter.execute(
        makeRequest({
          context: {
            taskTitle: "test",
            objective: "patch then check scope",
            verificationPlan: [],
            focus: "test",
            remainingBudgetUsd: 8,
            remainingIterations: 3,
            remainingTokens: 10_000,
            repoRoot,
            allowedPaths: ["src/**"]
          }
        })
      );

      expect(result.status).toBe("completed");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).toBe("claude");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("requests stream-json output so usage can be observed incrementally", async () => {
    const calls: SpawnCall[] = [];
    const adapter = createClaudeCliAdapter({
      spawnImpl: createScriptedSpawn(calls, [
        {
          stdout:
            '{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":5}}}\n' +
            '{"type":"result","subtype":"success","result":"done","total_cost_usd":0.0042,"usage":{"input_tokens":10,"output_tokens":5}}\n'
        }
      ])
    });

    const result = await adapter.execute(makeRequest());

    expect(result.status).toBe("completed");
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(["--output-format", "stream-json", "--verbose"])
    );
    // Prefers Claude's own authoritative total_cost_usd over a pricing-table estimate.
    expect(result.usage?.actualUsd).toBeCloseTo(0.0042, 6);
    expect(result.usage?.provenance).toBe("actual");
    expect(result.summary).toContain("done");
  });

  describe("streaming usage circuit breaker", () => {
    function streamingTurn(inputTokens: number, outputTokens: number): string {
      return JSON.stringify({
        type: "assistant",
        message: { usage: { input_tokens: inputTokens, output_tokens: outputTokens } }
      });
    }

    it("kills a runaway subprocess once cumulative cost crosses the remaining budget", async () => {
      const calls: SpawnCall[] = [];
      // claude-sonnet-4-6 pricing: $0.003/1K in, $0.015/1K out.
      // Each turn below costs (5000/1000)*0.003 + (1000/1000)*0.015 = $0.03.
      // remainingBudgetUsd = 0.05 (well above the prompt-size preflight estimate,
      // so we actually reach the subprocess) → cap crossed partway through turn 2.
      const lines = [
        streamingTurn(5000, 1000),
        streamingTurn(5000, 1000),
        streamingTurn(5000, 1000),
        streamingTurn(5000, 1000),
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "finished after a very long runaway session",
          total_cost_usd: 3.5,
          usage: { input_tokens: 20_000, output_tokens: 4_000 }
        })
      ];

      const adapter = createClaudeCliAdapter({
        spawnImpl: createStreamingSpawn(calls, lines)
      });

      const result = await adapter.execute(
        makeRequest({
          context: {
            taskTitle: "test",
            objective: "make a tiny change",
            verificationPlan: [],
            focus: "stay small",
            remainingBudgetUsd: 0.05,
            remainingIterations: 1,
            remainingTokens: 50_000
          }
        })
      );

      expect(result.status).toBe("failed");
      expect(result.failure?.classHint).toBe("budget_pressure");
      expect(result.summary).toContain("circuit breaker");
      expect(result.failure?.message).toContain("Streaming usage cap exceeded");

      // Bounded to ~2 turns' worth of spend, not the eventual $3.50 runaway total.
      expect(result.usage?.actualUsd).toBeGreaterThan(0.05);
      expect(result.usage?.actualUsd).toBeLessThan(0.5);
      expect(result.usage?.tokensIn).toBeLessThanOrEqual(10_000);
      expect(result.usage?.tokensOut).toBeLessThanOrEqual(2_000);
      expect(result.usage?.provenance).toBe("estimated");

      // The subprocess was actually terminated — not allowed to run to completion.
      expect(result.summary).not.toContain("runaway session");
    });

    it("does not interfere with normal completion when usage stays under the cap", async () => {
      const calls: SpawnCall[] = [];
      const lines = [
        streamingTurn(50, 20),
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "small change applied",
          total_cost_usd: 0.0009,
          usage: { input_tokens: 50, output_tokens: 20 }
        })
      ];

      const adapter = createClaudeCliAdapter({
        spawnImpl: createStreamingSpawn(calls, lines)
      });

      const result = await adapter.execute(
        makeRequest({
          context: {
            taskTitle: "test",
            objective: "make a tiny change",
            verificationPlan: [],
            focus: "stay small",
            remainingBudgetUsd: 5,
            remainingIterations: 1,
            remainingTokens: 50_000
          }
        })
      );

      expect(result.status).toBe("completed");
      expect(result.summary).toContain("small change applied");
      expect(result.usage?.actualUsd).toBeCloseTo(0.0009, 6);
    });

    it("terminates when total_cost_usd on any event exceeds the cap", async () => {
      const calls: SpawnCall[] = [];
      // Simulate an event that carries total_cost_usd (authoritative) but no
      // per-turn usage — the inspector should still detect the overspend.
      const lines = [
        JSON.stringify({ type: "content_block_start", total_cost_usd: 0.02 }),
        JSON.stringify({ type: "content_block_delta", total_cost_usd: 0.06 }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "should not reach here",
          total_cost_usd: 3.5,
          usage: { input_tokens: 50_000, output_tokens: 10_000 }
        })
      ];

      const adapter = createClaudeCliAdapter({
        spawnImpl: createStreamingSpawn(calls, lines)
      });

      const result = await adapter.execute(
        makeRequest({
          context: {
            taskTitle: "test",
            objective: "make a change",
            verificationPlan: [],
            focus: "stay small",
            remainingBudgetUsd: 0.05,
            remainingIterations: 1,
            remainingTokens: 50_000
          }
        })
      );

      expect(result.status).toBe("failed");
      expect(result.failure?.classHint).toBe("budget_pressure");
      // Should NOT contain the final result text (subprocess was killed before it arrived)
      expect(result.summary).not.toContain("should not reach here");
    });

    it("terminates when usage is on top-level event (not nested in message)", async () => {
      const calls: SpawnCall[] = [];
      // Usage at top-level: { type: "...", usage: { input_tokens, output_tokens } }
      const lines = [
        JSON.stringify({ type: "turn_complete", usage: { input_tokens: 10_000, output_tokens: 2_000 } }),
        JSON.stringify({ type: "turn_complete", usage: { input_tokens: 10_000, output_tokens: 2_000 } }),
        JSON.stringify({ type: "turn_complete", usage: { input_tokens: 10_000, output_tokens: 2_000 } }),
        JSON.stringify({
          type: "result",
          result: "runaway",
          total_cost_usd: 5.0,
          usage: { input_tokens: 30_000, output_tokens: 6_000 }
        })
      ];

      const adapter = createClaudeCliAdapter({
        spawnImpl: createStreamingSpawn(calls, lines)
      });

      const result = await adapter.execute(
        makeRequest({
          context: {
            taskTitle: "test",
            objective: "tiny fix",
            verificationPlan: [],
            focus: "minimal",
            remainingBudgetUsd: 0.05,
            remainingIterations: 1,
            remainingTokens: 50_000
          }
        })
      );

      expect(result.status).toBe("failed");
      expect(result.failure?.classHint).toBe("budget_pressure");
      expect(result.summary).toContain("circuit breaker");
    });

    it("applies 80% safety margin so termination fires before 100% of cap", async () => {
      const calls: SpawnCall[] = [];
      // sonnet pricing: $0.003/1K in, $0.015/1K out
      // Single turn: (2000/1000)*0.003 + (500/1000)*0.015 = $0.006 + $0.0075 = $0.0135
      // With cap $0.05, effective cap at 80% = $0.04
      // After 3 turns: cumulative = $0.0405 → exceeds $0.04
      const lines = [
        JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 2000, output_tokens: 500 } } }),
        JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 2000, output_tokens: 500 } } }),
        JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 2000, output_tokens: 500 } } }),
        JSON.stringify({ type: "result", result: "completed too much", total_cost_usd: 0.1, usage: { input_tokens: 6000, output_tokens: 1500 } })
      ];

      const adapter = createClaudeCliAdapter({
        spawnImpl: createStreamingSpawn(calls, lines)
      });

      const result = await adapter.execute(
        makeRequest({
          context: {
            taskTitle: "test",
            objective: "small task",
            verificationPlan: [],
            focus: "tight",
            remainingBudgetUsd: 0.05,
            remainingIterations: 1,
            remainingTokens: 50_000
          }
        })
      );

      expect(result.status).toBe("failed");
      expect(result.failure?.classHint).toBe("budget_pressure");
      // Terminated at 80% threshold, not 100%
      expect(result.failure?.message).toContain("80% threshold");
    });
  });
});

// ---------------------------------------------------------------------------
// Codex-specific factory
// ---------------------------------------------------------------------------

describe("createCodexCliAdapter", () => {
  it("returns correct adapterId and kind", () => {
    const adapter = createCodexCliAdapter();

    expect(adapter.adapterId).toBe("agent-cli:codex");
    expect(adapter.kind).toBe("agent-cli");
    expect(adapter.metadata.providerId).toBe("codex");
    expect(adapter.metadata.transport).toBe("cli");
  });

  it("surfaces model in metadata when provided", () => {
    const adapter = createCodexCliAdapter({ model: "o3" });

    expect(adapter.metadata.model).toBe("o3");
  });

  it("uses codex exec with an explicit writable sandbox instead of legacy full-auto", async () => {
    const calls: SpawnCall[] = [];
    const workingDirectory = join(tmpdir(), "martin codex path with spaces");
    const adapter = createCodexCliAdapter({
      fullAuto: true,
      workingDirectory,
      spawnImpl: createScriptedSpawn(calls)
    });
    const result = await adapter.execute(
      makeRequest({
        context: {
          taskTitle: "test",
          objective: "update the target file",
          verificationPlan: [],
          focus: "test",
          remainingBudgetUsd: 8,
          remainingIterations: 3,
          remainingTokens: 10_000
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(calls[0]?.command).toBe("codex");
    expect(calls[0]?.args).toEqual([
      "exec",
      "--ignore-user-config",
      "--cd",
      workingDirectory,
      "--sandbox",
      "workspace-write",
      "--json",
      "--color",
      "never",
      "--model",
      DEFAULT_CODEX_CHATGPT_MODEL,
      "-"
    ]);
    expect(calls[0]?.args).not.toContain("--full-auto");
    expect(calls[0]?.args).not.toContain("--stdin-prompt");
    expect(calls[0]?.options?.cwd).toBe(workingDirectory);
    expect(calls[0]?.stdin).toContain("OBJECTIVE:");
    expect(calls[0]?.stdin).toContain("update the target file");
  });

  it("enforces token guardrails via streamingUsageCap, not --max-tokens subprocess flag", async () => {
    const calls: SpawnCall[] = [];
    const adapter = createClaudeCliAdapter({
      spawnImpl: createScriptedSpawn(calls)
    });

    const result = await adapter.execute(makeRequest());

    expect(result.status).toBe("completed");
    // --max-tokens does not exist in the claude CLI; token cap is enforced by
    // the streaming budget circuit breaker (streamingUsageCap), not a subprocess flag.
    // Regression guard: ensure this flag is never re-introduced.
    expect(calls[0]?.args).not.toContain("--max-tokens");
  });


  it("preserves custom Codex model, sandbox, and extra exec flags before stdin prompt", async () => {
    const calls: SpawnCall[] = [];
    const adapter = createCodexCliAdapter({
      model: "gpt-5.5",
      sandbox: "read-only",
      extraArgs: ["--ignore-rules"],
      spawnImpl: createScriptedSpawn(calls)
    });
    const result = await adapter.execute(
      makeRequest({
        context: {
          taskTitle: "test",
          objective: "inspect only",
          verificationPlan: [],
          focus: "test",
          remainingBudgetUsd: 8,
          remainingIterations: 3,
          remainingTokens: 10_000
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(calls[0]?.args).toEqual([
      "exec",
      "--ignore-user-config",
      "--cd",
      expect.any(String),
      "--sandbox",
      "read-only",
      "--json",
      "--color",
      "never",
      "--model",
      "gpt-5.5",
      "--ignore-rules",
      "-"
    ]);
  });

  it("runs MartinLoop verification after successful Codex exec completion", async () => {
    const calls: SpawnCall[] = [];
    const adapter = createCodexCliAdapter({
      spawnImpl: createScriptedSpawn(calls, [{ stdout: "patched\n" }, { stdout: "ok\n" }])
    });
    const result = await adapter.execute(
      makeRequest({
        context: {
          taskTitle: "test",
          objective: "patch then verify",
          verificationPlan: process.platform === "win32" ? ["cmd /c exit 0"] : ["true"],
          focus: "test",
          remainingBudgetUsd: 8,
          remainingIterations: 3,
          remainingTokens: 10_000
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(result.verification.passed).toBe(true);
    expect(calls[0]?.command).toBe("codex");
    expect(calls[1]?.command).toBe(process.platform === "win32" ? "cmd" : "true");
  });

  it("fails closed when Codex exits non-zero before emitting structured completion", async () => {
    const calls: SpawnCall[] = [];
    const adapter = createCodexCliAdapter({
      spawnImpl: createScriptedSpawn(calls, [
        {
          stdout: "usage: codex exec ...\n",
          stderr: "launch failed\n",
          exitCode: 2
        }
      ])
    });
    const result = await adapter.execute(
      makeRequest({
        context: {
          taskTitle: "test",
          objective: "patch then verify",
          verificationPlan: process.platform === "win32" ? ["cmd /c exit 0"] : ["true"],
          focus: "test",
          remainingBudgetUsd: 8,
          remainingIterations: 3,
          remainingTokens: 10_000
        }
      })
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("exited before verifier execution");
    expect(result.verification.passed).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("settles authoritative Codex usage from JSONL turn.completed output", async () => {
    const calls: SpawnCall[] = [];
    const adapter = createCodexCliAdapter({
      model: "gpt-5-codex",
      spawnImpl: createScriptedSpawn(calls, [
        {
          stdout: [
            JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
            JSON.stringify({
              type: "item.completed",
              item: { id: "item_1", type: "agent_message", text: "Patched the failing test and re-ran verification." }
            }),
            JSON.stringify({
              type: "turn.completed",
              usage: {
                input_tokens: 1200,
                cached_input_tokens: 300,
                output_tokens: 200,
                reasoning_output_tokens: 50
              }
            })
          ].join("\n"),
          stderr: "",
          exitCode: 0
        },
        { stdout: "ok\n", stderr: "", exitCode: 0 }
      ])
    });

    const result = await adapter.execute(
      makeRequest({
        context: {
          taskTitle: "test",
          objective: "patch then verify",
          verificationPlan: process.platform === "win32" ? ["cmd /c exit 0"] : ["true"],
          focus: "test",
          remainingBudgetUsd: 8,
          remainingIterations: 3,
          remainingTokens: 10_000
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("Patched the failing test");
    expect(result.usage.provenance).toBe("actual");
    expect(result.usage.tokensIn).toBe(1500);
    expect(result.usage.cachedInputTokens).toBe(300);
    expect(result.usage.tokensOut).toBe(250);
    expect(result.usage.reasoningTokensOut).toBe(50);
    expect(result.usage.providerSettlement?.source).toBe("codex_jsonl");
    expect(result.usage.actualUsd).toBeCloseTo(0.0040375, 6);
  });

  it("reports pre-verifier Codex launch failures without running verifier commands", async () => {
    const calls: SpawnCall[] = [];
    const adapter = createCodexCliAdapter({
      spawnImpl: createScriptedSpawn(calls, [
        { exitCode: 2, stderr: "unexpected argument '--full-auto'\n" }
      ])
    });
    const result = await adapter.execute(
      makeRequest({
        context: {
          taskTitle: "test",
          objective: "patch then verify",
          verificationPlan: process.platform === "win32" ? ["cmd /c exit 0"] : ["true"],
          focus: "test",
          remainingBudgetUsd: 8,
          remainingIterations: 3,
          remainingTokens: 10_000
        }
      })
    );

    expect(result.status).toBe("failed");
    // Diagnostic summary surfaces exit code and stderr so failures are
    // actionable rather than a generic "before verifier execution" message.
    expect(result.summary).toContain("codex exited (code 2)");
    expect(result.summary).toContain("--full-auto");
    expect(result.verification.summary).toContain("Verifier not run");
    expect(result.failure?.message).toContain("environment_mismatch");
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Gemini-specific factory
// ---------------------------------------------------------------------------

describe("createGeminiCliAdapter", () => {
  it("returns correct adapterId and kind", () => {
    const adapter = createGeminiCliAdapter();

    expect(adapter.adapterId).toBe("agent-cli:gemini");
    expect(adapter.kind).toBe("agent-cli");
    expect(adapter.metadata.providerId).toBe("gemini");
    expect(adapter.metadata.model).toBe("flash");
    expect(adapter.metadata.transport).toBe("cli");
  });

  it("uses Gemini headless mode with stdin-backed prompts", async () => {
    const calls: SpawnCall[] = [];
    const adapter = createGeminiCliAdapter({
      spawnImpl: createScriptedSpawn(calls, [
        {
          stdout: JSON.stringify({
            response: "Patched the failing function.",
            stats: {
              inputTokens: 120,
              cachedReadTokens: 30,
              outputTokens: 45,
              thoughtTokens: 10,
              totalTokens: 205
            }
          })
        },
        { stdout: "ok\n" }
      ])
    });

    const result = await adapter.execute(
      makeRequest({
        context: {
          taskTitle: "test",
          objective: "patch then verify",
          verificationPlan: process.platform === "win32" ? ["cmd /c exit 0"] : ["true"],
          focus: "test",
          remainingBudgetUsd: 8,
          remainingIterations: 3,
          remainingTokens: 10_000
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(calls[0]?.command).toBe("gemini");
    expect(calls[0]?.args).toEqual([
      "--model",
      "flash",
      "--prompt",
      "",
      "--approval-mode",
      "yolo",
      "--output-format",
      "json"
    ]);
    expect(calls[0]?.stdin).toContain("OBJECTIVE:");
    expect(result.summary).toContain("Patched the failing function");
    expect(result.usage.provenance).toBe("actual");
    expect(result.usage.tokensIn).toBe(150);
    expect(result.usage.tokensOut).toBe(55);
    expect(result.usage.cachedInputTokens).toBe(30);
    expect(result.usage.reasoningTokensOut).toBe(10);
    expect(result.usage.providerSettlement?.source).toBe("gemini_json");
  });
});
