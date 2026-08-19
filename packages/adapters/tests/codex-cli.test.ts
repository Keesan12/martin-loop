import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";

import type { MartinAdapterRequest } from "@martin/core";
import {
  createCodexCliAdapter,
  type CodexCapabilityProfile,
  type SpawnLike
} from "../src/index.js";

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

function createScriptedSpawn(calls: SpawnCall[], outputs: ScriptedSpawnOutput[] = [{ stdout: "done\n" }]): SpawnLike {
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
    const call: SpawnCall = { command, args: [...args], options, stdin: "" };
    calls.push(call);
    child.stdin.on("data", (chunk: Buffer | string) => {
      call.stdin += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    });
    process.nextTick(() => {
      if (output.stdout) child.stdout.write(output.stdout);
      if (output.stderr) child.stderr.write(output.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", output.exitCode ?? 0);
    });
    return child as ChildProcess;
  };
}

function request(verificationPlan: string[] = []): MartinAdapterRequest {
  return {
    loopId: "loop_codex_capability",
    workspaceId: "ws_codex_capability",
    attemptId: "att_codex_capability_1",
    context: {
      taskTitle: "Codex capability integration",
      objective: "Update the requested file and prove the result.",
      verificationPlan,
      focus: "Stay inside the requested scope.",
      remainingBudgetUsd: 8,
      remainingIterations: 3,
      remainingTokens: 10_000
    },
    previousAttempts: []
  };
}

function negotiatedProfile(overrides: Partial<CodexCapabilityProfile> = {}): CodexCapabilityProfile {
  return {
    binaryPath: "C:\\Program Files\\OpenAI\\Codex\\codex.exe",
    supportsExec: true,
    probeSucceeded: true,
    cwd: { flag: "--cd", scope: "exec" },
    sandbox: { flag: "--sandbox", scope: "exec", values: ["read-only", "workspace-write"] },
    json: { flag: "--json", scope: "exec" },
    color: { flag: "--color", scope: "exec", neverValue: "never" },
    promptTransport: "stdin-dash",
    promptTransports: ["stdin-dash", "argv"],
    selectedWriteStrategy: "sandbox",
    ...overrides
  };
}

describe("capability-driven Codex adapter", () => {
  it("routes provider execution to the exact selected binary while preserving Codex identity", async () => {
    const calls: SpawnCall[] = [];
    const selectedBinary = "C:\\Program Files\\OpenAI\\Codex\\codex.exe";
    const profile = negotiatedProfile({ binaryPath: selectedBinary });
    const adapter = createCodexCliAdapter({
      command: selectedBinary,
      capabilityProfile: profile,
      spawnImpl: createScriptedSpawn(calls)
    });
    const result = await adapter.execute(request());

    expect(result.status).toBe("completed");
    expect(adapter.metadata.providerId).toBe("codex");
    expect(calls[0]?.command).toBe(selectedBinary);
    expect(calls[0]?.args).toContain("workspace-write");
    expect(calls[0]?.args).not.toContain("--approve-for-me");
    expect(calls[0]?.stdin).toContain("OBJECTIVE:");
  });

  it("reuses the negotiated automation strategy instead of a fixed flag contract", async () => {
    const calls: SpawnCall[] = [];
    const profile = negotiatedProfile({
      sandbox: undefined,
      automation: { flag: "--full-auto", scope: "global", semantics: "automation-mode" },
      approval: { flag: "--full-auto", scope: "global", semantics: "automation-mode" },
      selectedWriteStrategy: "automation"
    });
    const adapter = createCodexCliAdapter({ capabilityProfile: profile, spawnImpl: createScriptedSpawn(calls) });
    const result = await adapter.execute(request());

    expect(result.status).toBe("completed");
    expect(calls[0]?.args[0]).toBe("--full-auto");
    expect(calls[0]?.args).not.toContain("--approve-for-me");
    expect(calls[0]?.args).not.toContain("danger-full-access");
  });

  it("preserves explicit model and read-only sandbox only when advertised", async () => {
    const calls: SpawnCall[] = [];
    const profile = negotiatedProfile({ model: { flag: "--model", scope: "exec" } });
    const adapter = createCodexCliAdapter({
      model: "gpt-5.5",
      sandbox: "read-only",
      extraArgs: ["--ignore-rules"],
      capabilityProfile: profile,
      spawnImpl: createScriptedSpawn(calls)
    });
    const result = await adapter.execute(request());

    expect(result.status).toBe("completed");
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      "--sandbox", "read-only", "--model", "gpt-5.5", "--ignore-rules"
    ]));
  });

  it("runs MartinLoop verification after successful Codex execution", async () => {
    const calls: SpawnCall[] = [];
    const verifier = process.platform === "win32" ? "cmd /c exit 0" : "true";
    const profile = negotiatedProfile();
    const adapter = createCodexCliAdapter({
      command: profile.binaryPath,
      capabilityProfile: profile,
      spawnImpl: createScriptedSpawn(calls, [{ stdout: "patched\n" }, { stdout: "ok\n" }])
    });
    const result = await adapter.execute(request([verifier]));

    expect(result.status).toBe("completed");
    expect(result.verification.passed).toBe(true);
    expect(calls[0]?.command).toBe(profile.binaryPath);
    expect(calls[1]?.command).toBe(process.platform === "win32" ? "cmd" : "true");
  });

  it("fails closed before verifier execution when Codex launch fails", async () => {
    const calls: SpawnCall[] = [];
    const verifier = process.platform === "win32" ? "cmd /c exit 0" : "true";
    const adapter = createCodexCliAdapter({
      capabilityProfile: negotiatedProfile(),
      spawnImpl: createScriptedSpawn(calls, [{ stderr: "unsupported invocation\n", exitCode: 2 }])
    });
    const result = await adapter.execute(request([verifier]));

    expect(result.status).toBe("failed");
    expect(result.verification.passed).toBe(false);
    expect(result.verification.summary).toContain("Verifier not run");
    expect(calls).toHaveLength(1);
  });

  it("settles Codex JSONL usage through an absolute selected binary", async () => {
    const calls: SpawnCall[] = [];
    const verifier = process.platform === "win32" ? "cmd /c exit 0" : "true";
    const profile = negotiatedProfile({ model: { flag: "--model", scope: "exec" } });
    const adapter = createCodexCliAdapter({
      command: profile.binaryPath,
      model: "gpt-5-codex",
      capabilityProfile: profile,
      spawnImpl: createScriptedSpawn(calls, [
        {
          stdout: [
            JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
            JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Patched and verified." } }),
            JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 200, reasoning_output_tokens: 50 } })
          ].join("\n"),
          exitCode: 0
        },
        { stdout: "ok\n", exitCode: 0 }
      ])
    });
    const result = await adapter.execute(request([verifier]));

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("Patched and verified");
    expect(result.usage.providerSettlement?.source).toBe("codex_jsonl");
    expect(result.usage.provenance).toBe("calculated");
    expect(result.usage.tokensIn).toBe(1500);
    expect(result.usage.tokensOut).toBe(250);
    expect(calls[0]?.command).toBe(profile.binaryPath);
  });
});
