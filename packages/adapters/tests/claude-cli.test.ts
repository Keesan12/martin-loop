import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { runSubprocess, splitCommand } from "../src/cli-bridge.js";

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
      '"C:\\Users\\ExampleUser\\Projects\\node.exe" -e "process.exit(0)"';

    expect(splitCommand(command)).toEqual([
      "C:\\Users\\ExampleUser\\Projects\\node.exe",
      "-e",
      "process.exit(0)",
    ]);
  });
});

describe("createSpawnPlan", () => {
  it("wraps absolute Windows .cmd verifiers with cmd.exe", () => {
    if (process.platform !== "win32") {
      expect(true).toBe(true);
      return;
    }

    const pnpmPath = "C:\\Users\\Example User\\AppData\\Roaming\\npm\\pnpm.cmd";
    const plan = createSpawnPlan(
      pnpmPath,
      ["verify shared baseline", "--filter", "pkg with spaces"],
      process.cwd(),
      false
    );

    expect(plan.command.toLowerCase()).toContain("cmd.exe");
    expect(plan.args[0]).toBe("/d");
    expect(plan.args[1]).toBe("/s");
    expect(plan.args[2]).toBe("/c");
    expect(plan.args[3]).toContain('"C:\\Users\\Example User\\AppData\\Roaming\\npm\\pnpm.cmd"');
    expect(plan.args[3]).toContain('"verify shared baseline"');
    expect(plan.args[3]).toContain('"pkg with spaces"');
  });

  it("wraps absolute Windows PowerShell scripts through powershell.exe", () => {
    if (process.platform !== "win32") {
      expect(true).toBe(true);
      return;
    }

    const scriptPath = "C:\\Users\\ExampleUser\\AppData\\Roaming\\npm\\codex.ps1";
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
    expect(plan.args[2]).toContain("run");
    expect(plan.args[2]).toContain("test");
  });

  it("preserves raw command when preserveRawForInjectedSpawn is true regardless of platform", () => {
    const plan = createSpawnPlan("pnpm", ["test"], process.cwd(), true);
    expect(plan.command).toBe("pnpm");
    expect(plan.args).toEqual(["test"]);
  });
});

describe("runSubprocess", () => {
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
  it("reports verifier-created file changes instead of treating verify-only as clean", { timeout: 15000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-verify-only-"));

    try {
      spawnSync("git", ["init"], { cwd: directory, stdio: "ignore" });
      await writeFile(join(directory, "tracked.txt"), "original", "utf8");
      spawnSync("git", ["add", "tracked.txt"], { cwd: directory, stdio: "ignore" });
      spawnSync(
        "git",
        [
          "-c",
          "user.email=martin@example.com",
          "-c",
          "user.name=Martin Test",
          "commit",
          "-m",
          "seed"
        ],
        { cwd: directory, stdio: "ignore" }
      );

      const adapter = createVerifierOnlyAdapter({ workingDirectory: directory });
      const result = await adapter.execute(
        makeRequest({
          context: {
            taskTitle: "verify only",
            objective: "Run verification only",
            verificationPlan: [
              `"${process.execPath}" -e "require('node:fs').writeFileSync('tracked.txt','changed')"`
            ],
            mutationMode: "verify_only",
            focus: "verify only",
            remainingBudgetUsd: 8,
            remainingIterations: 1,
            remainingTokens: 10_000
          }
        })
      );

      expect(result.verification.passed).toBe(true);
      expect(result.execution?.changedFiles).toContain("tracked.txt");
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

  it("routes no-diff and scope git probes through the injected spawn implementation", async () => {
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
          repoRoot: "C:\\repo with spaces",
          allowedPaths: ["src/**"]
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(5);
    expect(calls[0]?.command).toBe("claude");
    expect(calls.slice(1).map((call) => call.command)).toEqual(["git", "git", "git", "git"]);
    expect(calls[1]?.args).toEqual(["diff", "--name-only", "HEAD"]);
    expect(calls[4]?.args).toEqual(["diff", "--name-only", "HEAD"]);
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
      "--cd",
      workingDirectory,
      "--sandbox",
      "workspace-write",
      "--json",
      "--color",
      "never",
      "-"
    ]);
    expect(calls[0]?.args).not.toContain("--full-auto");
    expect(calls[0]?.args).not.toContain("--stdin-prompt");
    expect(calls[0]?.options?.cwd).toBe(workingDirectory);
    expect(calls[0]?.stdin).toContain("OBJECTIVE:");
    expect(calls[0]?.stdin).toContain("update the target file");
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
    expect(result.summary).toContain("before verifier execution");
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
