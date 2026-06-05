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
  createVerifierOnlyAdapter,
  readGitChangedFiles,
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
      '"C:\\Users\\ExampleUser\\Projects\\node.exe" -e "process.exit(0)"';

    expect(splitCommand(command)).toEqual([
      "C:\\Users\\ExampleUser\\Projects\\node.exe",
      "-e",
      "process.exit(0)",
    ]);
  });
});

describe("createSpawnPlan", () => {
  it("unwraps Windows npm-style .cmd shims into a launchable host", async () => {
    if (process.platform !== "win32") {
      expect(true).toBe(true);
      return;
    }

    const tempRoot = await mkdtemp(join(tmpdir(), "martin-pnpm-shim-"));
    const pnpmPath = join(tempRoot, "pnpm.cmd");
    const scriptPath = join(tempRoot, "node_modules", "pnpm", "bin", "pnpm.cjs");

    try {
      await mkdir(join(tempRoot, "node_modules", "pnpm", "bin"), { recursive: true });
      await writeFile(scriptPath, "console.log('pnpm shim');\n", "utf8");
      await writeFile(
        pnpmPath,
        '@SETLOCAL\r\n@SET "_prog=node"\r\n"%_prog%" "%dp0%\\node_modules\\pnpm\\bin\\pnpm.cjs" %*\r\n',
        "utf8"
      );

      const plan = createSpawnPlan(pnpmPath, ["verify:shared-baseline"], process.cwd(), false);

      expect(plan.command.toLowerCase()).toMatch(/node(\.exe)?$/);
      expect(plan.args[0]?.toLowerCase()).toContain("pnpm");
      expect(plan.args[0]?.toLowerCase()).toContain("node_modules");
      expect(plan.args).toContain("verify:shared-baseline");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
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
    expect(plan.args[1]).toBe("/s");
    expect(plan.args[2]).toBe("/c");
    expect(plan.args[3]).toContain("__martin_nonexistent_verifier_cmd__");
    expect(plan.args[3]).toContain("run");
    expect(plan.args[3]).toContain("test");
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

  it("launches Windows batch commands through a working shell path", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const directory = await mkdtemp(join(tmpdir(), "martin-run-subprocess-batch-"));
    const commandPath = join(directory, "fake-cli.cmd");

    try {
      await writeFile(commandPath, "@echo off\r\necho OK:%1,%2\r\n", "utf8");

      const result = await runSubprocess(commandPath, ["foo", "bar"], {
        cwd: directory,
        timeoutMs: 5_000
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("OK:foo,bar");
      expect(result.stderr).toBe("");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("unwraps Windows npm-style command shims so verifier launches can run", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const directory = await mkdtemp(join(tmpdir(), "martin-run-subprocess-shim-"));
    const shimPath = join(directory, "fake-cli.cmd");
    const shimModuleDirectory = join(directory, "node_modules", "fake-cli", "bin");
    const scriptPath = join(shimModuleDirectory, "fake-cli.js");

    try {
      await mkdir(shimModuleDirectory, { recursive: true });
      await writeFile(
        shimPath,
        [
          "@ECHO off",
          "GOTO start",
          ":find_dp0",
          "SET dp0=%~dp0",
          "EXIT /b",
          ":start",
          "SETLOCAL",
          "CALL :find_dp0",
          'IF EXIST "%dp0%\\node.exe" (',
          '  SET "_prog=%dp0%\\node.exe"',
          ") ELSE (",
          '  SET "_prog=node"',
          '  SET PATHEXT=%PATHEXT:;.JS;=;%',
          ")",
          'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-cli\\bin\\fake-cli.js" %*',
          ""
        ].join("\r\n"),
        "utf8"
      );
      await writeFile(
        scriptPath,
        'process.stdout.write(`ARGS:${process.argv.slice(2).join(",")}`);',
        "utf8"
      );

      const result = await withPathPrefix(directory, async () =>
        runSubprocess("fake-cli", ["alpha", "beta"], {
          cwd: directory,
          timeoutMs: 5_000
        })
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("ARGS:alpha,beta");
      expect(result.stderr).toBe("");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("readGitChangedFiles", () => {
  it("parses NUL-delimited rename entries and keeps the destination path", async () => {
    const calls: SpawnCall[] = [];
    const changedFiles = await readGitChangedFiles(process.cwd(), 5_000, createScriptedSpawn(calls, [
      {
        stdout: ` M spaced name.ts\u0000R  old-name.ts\u0000renamed name.ts\u0000`
      }
    ]));

    expect(calls[0]?.command).toBe("git");
    expect(calls[0]?.args).toContain("-z");
    expect(changedFiles).toEqual(["spaced name.ts", "renamed name.ts"]);
  });
});

describe("createVerifierOnlyAdapter", () => {
  it("reports verifier-created file changes in proof-mode runs", async () => {
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

  it("ignores pre-existing dirty files when the verifier itself makes no new edits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-verify-only-dirty-"));

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
      await writeFile(join(directory, "tracked.txt"), "pre-existing dirty change", "utf8");

      const adapter = createVerifierOnlyAdapter({ workingDirectory: directory });
      const result = await adapter.execute(
        makeRequest({
          context: {
            taskTitle: "verify only",
            objective: "Run verification only",
            verificationPlan: [`"${process.execPath}" -e "process.exit(0)"`],
            focus: "verify only",
            remainingBudgetUsd: 8,
            remainingIterations: 1,
            remainingTokens: 10_000
          }
        })
      );

      expect(result.verification.passed).toBe(true);
      expect(result.execution?.changedFiles).toEqual([]);
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

  it("does not force-skip Claude permissions by default", async () => {
    const calls: SpawnCall[] = [];
    const adapter = createClaudeCliAdapter({
      spawnImpl: createScriptedSpawn(calls)
    });

    const result = await adapter.execute(makeRequest());

    expect(result.status).toBe("completed");
    expect(calls[0]?.command).toBe("claude");
    expect(calls[0]?.args).not.toContain("--dangerously-skip-permissions");
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
