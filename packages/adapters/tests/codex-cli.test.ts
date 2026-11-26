import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import type { MartinAdapterRequest } from "@martin/core";
import {
  createCodexCliAdapter,
  type CodexAutonomyResolution,
  type CodexCapabilityProfile,
  type SpawnLike
} from "../src/index.js";
import { markCodexAutonomyResolutionVerifiedByLaunchProbe } from "../src/codex-capabilities.js";

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

function codexSuccess(model = "gpt-6.1-sol", text = "Done.", inputTokens = 10, outputTokens = 5): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "thread_fixture" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_fixture", type: "agent_message", text } }),
    JSON.stringify({
      type: "turn.completed",
      ...(model ? { model } : {}),
      usage: {
        input_tokens: inputTokens, cached_input_tokens: 0, output_tokens: outputTokens, reasoning_output_tokens: 0
      }
    })
  ].join("\n");
}

function writeRetainedCodexSession(input: {
  home: string;
  cwd: string;
  id: string;
  turn: string;
  contextModel?: string;
  stale?: boolean;
  otherThread?: boolean;
  otherTurn?: boolean;
  duplicate?: boolean;
  usage: Record<string, number>;
}): void {
  // Field names and usage values come from the failed Codex 0.160.0 canary.
  // Replace private content and use a fresh clock and local fixture workspace.
  const now = new Date();
  const timestamp = new Date(now.getTime() - (input.stale ? 60_000 : 0)).toISOString();
  const [year, month, day] = now.toISOString().slice(0, 10).split("-");
  const directory = join(input.home, "sessions", year!, month!, day!);
  mkdirSync(directory, { recursive: true });
  const sessionId = input.otherThread ? "01900000-0000-7000-8000-000000000003" : input.id;
  const completedTurn = input.otherTurn ? "01900000-0000-7000-8000-000000000004" : input.turn;
  const records = [
    { type: "session_meta", payload: {
      id: sessionId, session_id: sessionId, cwd: input.cwd, timestamp, source: "exec", cli_version: "0.160.0"
    } },
    { type: "event_msg", payload: { type: "task_started", turn_id: input.turn, root_turn_id: input.turn } },
    { type: "turn_context", payload: {
      turn_id: input.turn, root_turn_id: input.turn, cwd: input.cwd, model: input.contextModel ?? "gpt-6.1-sol"
    } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: input.usage } } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: completedTurn } }
  ].map((record) => JSON.stringify({ timestamp, ...record })).join("\n") + "\n";
  writeFileSync(join(directory, `rollout-2026-11-24T16-41-43-${input.id}.jsonl`), records);
  if (input.duplicate) {
    writeFileSync(join(directory, `rollout-2026-11-24T16-41-44-${input.id}.jsonl`), records);
  }
}

function createScriptedSpawn(calls: SpawnCall[], outputs: ScriptedSpawnOutput[] = [{ stdout: codexSuccess() }]): SpawnLike {
  let index = 0;
  return (command, args = [], options) => {
    const output = outputs[index] ?? outputs.at(-1) ?? { stdout: codexSuccess() };
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
    approvalPolicy: {
      flag: "--ask-for-approval",
      scope: "exec",
      semantics: "approval-policy",
      values: ["never"]
    },
    json: { flag: "--json", scope: "exec" },
    color: { flag: "--color", scope: "exec", neverValue: "never" },
    promptTransport: "stdin-dash",
    promptTransports: ["stdin-dash", "argv"],
    ...overrides
  };
}

function rawAutonomy(
  overrides: Partial<CodexAutonomyResolution> = {}
): CodexAutonomyResolution {
  return {
    binaryPath: "C:\\Program Files\\OpenAI\\Codex\\codex.exe",
    intent: "governed-autonomous",
    strategy: "sandbox+approval",
    sandboxValue: "workspace-write",
    approvalValue: "never",
    ...overrides
  };
}

function negotiatedAutonomy(
  overrides: Partial<CodexAutonomyResolution> = {}
): CodexAutonomyResolution {
  return markCodexAutonomyResolutionVerifiedByLaunchProbe(rawAutonomy(overrides));
}

describe("capability-driven Codex adapter", () => {
  it("publishes catalog pricing to the host budget preflight", () => {
    const adapter = createCodexCliAdapter({
      model: "gpt-6-astra",
      capabilityProfile: negotiatedProfile(),
      autonomyResolution: negotiatedAutonomy()
    });

    expect(adapter.metadata.budgetPreflight).toMatchObject({
      minimumViableTokens: 128_000,
      pricePerMTokenUsd: 75
    });
  });

  it("publishes provider-conservative pricing when Codex selects its model automatically", () => {
    const adapter = createCodexCliAdapter({
      capabilityProfile: negotiatedProfile(),
      autonomyResolution: negotiatedAutonomy()
    });

    expect(adapter.metadata.budgetPreflight?.pricePerMTokenUsd).toBe(75);
  });

  it("rejects a structurally valid autonomy resolution that did not pass the launch probe", () => {
    expect(() => createCodexCliAdapter({
      capabilityProfile: negotiatedProfile(),
      autonomyResolution: rawAutonomy()
    })).toThrow(/not verified by the launch probe/iu);
  });

  it.each(["", " auto ", "default"])("rejects non-concrete explicit model authority %j", (model) => {
    expect(() => createCodexCliAdapter({
      model,
      capabilityProfile: negotiatedProfile({ model: { flag: "--model", scope: "exec" } }),
      autonomyResolution: negotiatedAutonomy()
    })).toThrow(/explicit live model is invalid/iu);
  });

  it("routes provider execution to the exact selected binary while preserving Codex identity", async () => {
    const calls: SpawnCall[] = [];
    const selectedBinary = "C:\\Program Files\\OpenAI\\Codex\\codex.exe";
    const profile = negotiatedProfile({ binaryPath: selectedBinary });
    const adapter = createCodexCliAdapter({
      command: selectedBinary,
      capabilityProfile: profile,
      autonomyResolution: negotiatedAutonomy({ binaryPath: selectedBinary }),
      spawnImpl: createScriptedSpawn(calls, [{ stdout: codexSuccess("gpt-5.5") }])
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
      approval: { flag: "--full-auto", scope: "global", semantics: "automation-mode" }
    });
    const adapter = createCodexCliAdapter({
      capabilityProfile: profile,
      autonomyResolution: negotiatedAutonomy({ strategy: "automation", sandboxValue: undefined, approvalValue: undefined }),
      spawnImpl: createScriptedSpawn(calls, [{ stdout: codexSuccess("gpt-5.5") }])
    });
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
      autonomyResolution: negotiatedAutonomy(),
      spawnImpl: createScriptedSpawn(calls, [{ stdout: codexSuccess("gpt-5.5") }])
    });
    const readOnlyRequest = request();
    (readOnlyRequest.context as any).mutationMode = "read_only";
    const result = await adapter.execute(readOnlyRequest);

    expect(result.status).toBe("completed");
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      "--sandbox", "read-only", "--model", "gpt-5.5", "--ignore-rules"
    ]));
    expect(calls[0]?.stdin).toContain("READ-ONLY EXECUTION");
    expect(calls[0]?.stdin).not.toContain("MAKE ALL REQUIRED FILE EDITS NOW");
  });

  it("runs MartinLoop verification after successful Codex execution", async () => {
    const calls: SpawnCall[] = [];
    const verifier = process.platform === "win32" ? "cmd /c exit 0" : "true";
    const profile = negotiatedProfile();
    const adapter = createCodexCliAdapter({
      command: profile.binaryPath,
      capabilityProfile: profile,
      autonomyResolution: negotiatedAutonomy(),
      spawnImpl: createScriptedSpawn(calls, [{ stdout: codexSuccess(undefined, "Patched.") }, { stdout: "ok\n" }])
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
      autonomyResolution: negotiatedAutonomy(),
      spawnImpl: createScriptedSpawn(calls, [{ stderr: "unsupported invocation\n", exitCode: 2 }])
    });
    const result = await adapter.execute(request([verifier]));

    expect(result.status).toBe("failed");
    expect(result.verification.passed).toBe(false);
    expect(result.verification.summary).toContain("Verifier not run");
    expect(calls).toHaveLength(1);
  });

  describe("failed Codex turns never reach the verifier", () => {
    const verifier = process.platform === "win32" ? "cmd /c exit 0" : "true";
    const usageLimit = "You've hit your usage limit. Try again later.";
    const failedTurn = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_fail" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "error", message: usageLimit }),
      JSON.stringify({ type: "turn.failed", error: { message: usageLimit } })
    ].join("\n");

    async function runWith(stdout: string, exitCode: number) {
      const calls: SpawnCall[] = [];
      const adapter = createCodexCliAdapter({
        capabilityProfile: negotiatedProfile(),
        autonomyResolution: negotiatedAutonomy(),
        spawnImpl: createScriptedSpawn(calls, [{ stdout, exitCode }, { stdout: "ok\n", exitCode: 0 }])
      });
      return { result: await adapter.execute(request([verifier])), calls };
    }

    it.each([1, 0])("fails a turn.failed stream (exit %i) without running the verifier", async (exitCode) => {
      const { result, calls } = await runWith(failedTurn, exitCode);

      expect(result.status).toBe("failed");
      expect(result.verification.passed).toBe(false);
      expect(result.verification.summary).toContain("Verifier not run");
      expect(result.failure?.message).toContain("usage limit");
      expect(calls).toHaveLength(1);
    });

    it("fails an error event without turn.completed and a nonzero exit", async () => {
      const stdout = [
        JSON.stringify({ type: "thread.started", thread_id: "thread_err" }),
        JSON.stringify({ type: "error", message: "stream disconnected" })
      ].join("\n");
      const { result, calls } = await runWith(stdout, 1);

      expect(result.status).toBe("failed");
      expect(result.verification.passed).toBe(false);
      expect(calls).toHaveLength(1);
    });

    it("keeps a settled turn.completed attempt even when the process exits nonzero", async () => {
      const stdout = codexSuccess(undefined, "Patched.");
      const { result, calls } = await runWith(stdout, 1);

      expect(result.status).toBe("completed");
      expect(result.verification.passed).toBe(true);
      expect(calls).toHaveLength(2);
    });

    it("rejects exit-0 streams without terminal success before verifier", async () => {
      const stdout = JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "Done." } });
      const { result, calls } = await runWith(stdout, 0);

      expect(result.status).toBe("failed");
      expect(result.verification.summary).toContain("Verifier not run");
      expect(calls).toHaveLength(1);
    });

    it.each([
      ["missing thread start", codexSuccess("gpt-6.1-sol").split("\n").slice(1).join("\n")],
      ["missing turn start", codexSuccess("gpt-6.1-sol").split("\n").filter((line) => !line.includes("turn.started")).join("\n")],
      ["malformed JSONL", `${JSON.stringify({ type: "thread.started" })}\nnot-json\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}`],
      ["misleading prose", `work complete\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}`],
      ["error terminal", [
        JSON.stringify({ type: "thread.started" }),
        JSON.stringify({ type: "error", message: "provider rejected turn" }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })
      ].join("\n")]
    ])("rejects %s output before verifier", async (_label, stdout) => {
      const { result, calls } = await runWith(stdout, 0);

      expect(result.status).toBe("failed");
      expect(result.verification.summary).toContain("Verifier not run");
      expect(calls).toHaveLength(1);
    });

    it("rejects a terminal event bound to a different model before verifier", async () => {
      const calls: SpawnCall[] = [];
      const adapter = createCodexCliAdapter({
        model: "gpt-6.1-sol",
        capabilityProfile: negotiatedProfile({ model: { flag: "--model", scope: "exec" } }),
        autonomyResolution: negotiatedAutonomy(),
        spawnImpl: createScriptedSpawn(calls, [
          { stdout: codexSuccess("gpt-6-astra", "Done.", 3000, 1000) },
          { stdout: "ok\n" }
        ])
      });

      const result = await adapter.execute(request([verifier]));
      expect(result.status).toBe("failed");
      expect(result.failure?.message).toMatch(/model.*mismatch/iu);
      expect(result.usage).toMatchObject({
        tokensIn: 3000, tokensOut: 1000, provenance: "calculated",
        providerSettlement: { model: "gpt-6-astra", modelSource: "provider_reported" }
      });
      expect(result.usage.actualUsd).toBeGreaterThan(0);
      expect(calls).toHaveLength(1);
    });

    it("accepts a structured terminal success bound to the exact requested model", async () => {
      const calls: SpawnCall[] = [];
      const adapter = createCodexCliAdapter({
        model: "gpt-6.1-sol",
        capabilityProfile: negotiatedProfile({ model: { flag: "--model", scope: "exec" } }),
        autonomyResolution: negotiatedAutonomy(),
        spawnImpl: createScriptedSpawn(calls, [
          { stdout: codexSuccess("gpt-6.1-sol", "Patched and verified.") },
          { stdout: "ok\n" }
        ])
      });

      const result = await adapter.execute(request([verifier]));
      expect(result.status).toBe("completed");
      expect(result.usage.providerSettlement?.model).toBe("gpt-6.1-sol");
      expect(calls).toHaveLength(2);
    });

    it.each([
      { scenario: "matching turn context", expected: "completed" },
      { scenario: "matching turn context with default model", expected: "completed", useDefault: true },
      { scenario: "no bound context", expected: "failed", omitContext: true },
      { scenario: "no bound context with default model", expected: "failed", omitContext: true, useDefault: true },
      { scenario: "conflicting model", expected: "failed", contextModel: "gpt-6.1-astra" },
      { scenario: "terminal and context disagree", expected: "failed", terminalModel: "gpt-6.1-sol", contextModel: "gpt-6.1-astra" },
      { scenario: "stale matching context", expected: "failed", stale: true },
      { scenario: "concurrent child's matching context", expected: "failed", otherCwd: true },
      { scenario: "other thread's matching context", expected: "failed", otherThread: true },
      { scenario: "different completed turn", expected: "failed", otherTurn: true },
      { scenario: "ambiguous matching session files", expected: "failed", duplicate: true },
      { scenario: "missing provider usage", expected: "failed", omitUsage: true },
      { scenario: "usage from another execution", expected: "failed", otherUsage: true }
    ])("validates retained Codex exec evidence with $scenario", async ({
      expected, contextModel, terminalModel, omitContext, stale, otherCwd, otherThread,
      otherTurn, duplicate, omitUsage, otherUsage, useDefault
    }) => {
      const root = await mkdtemp(join(tmpdir(), "martin-codex-session-fixture-"));
      const home = join(root, "codex-home");
      const cwd = join(root, "workspace");
      const id = "01900000-0000-7000-8000-000000000001";
      const turn = "01900000-0000-7000-8000-000000000002";
      const usage = {
        input_tokens: 147835, cached_input_tokens: 114048, output_tokens: 803, reasoning_output_tokens: 19
      };
      const stdout = [
        { type: "thread.started", thread_id: id },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "[sanitized]" } },
        { type: "turn.completed", model: terminalModel, usage: omitUsage ? undefined : usage }
      ].map((row) => JSON.stringify(row)).join("\n");
      const calls: SpawnCall[] = [];
      const spawn = createScriptedSpawn(calls, [{ stdout }, { stdout: "ok\n" }]);
      await mkdir(cwd);
      vi.stubEnv("CODEX_HOME", home);
      try {
        const adapter = createCodexCliAdapter({
          workingDirectory: cwd,
          ...(useDefault ? {} : { model: "gpt-6.1-sol" }),
          capabilityProfile: negotiatedProfile({ model: { flag: "--model", scope: "exec" } }),
          autonomyResolution: negotiatedAutonomy(),
          spawnImpl: (...args) => {
            if (calls.length === 0 && !omitContext) {
              writeRetainedCodexSession({
                home, cwd: otherCwd ? root : cwd, id, turn, contextModel, stale, otherThread,
                otherTurn, duplicate, usage: otherUsage ? { ...usage, input_tokens: 147836 } : usage
              });
            }
            return spawn(...args);
          }
        });
        const result = await adapter.execute(request([verifier]));
        expect(result.status).toBe(expected);
        expect(calls).toHaveLength(expected === "completed" ? 2 : 1);
        if (expected === "completed") {
          expect(result.usage.providerSettlement).toMatchObject({
            model: "gpt-6.1-sol", modelSource: "provider_reported", rawUsageAvailable: true
          });
          expect(result.usage.actualUsd).toBeGreaterThan(0);
        } else {
          expect(result.usage).toMatchObject({ tokensIn: usage.input_tokens, tokensOut: usage.output_tokens });
          expect(result.usage.providerSettlement?.rawUsageAvailable).toBe(true);
          if (omitUsage) {
            expect(result.failure?.message).toContain("did not include valid provider usage");
            expect(result.usage.actualUsd).toBeGreaterThan(0);
          }
          if (omitContext || stale || otherThread || otherCwd || otherUsage) {
            expect(result.usage.provenance).toBe("unavailable");
            expect(result.usage.providerSettlement?.model).toBeUndefined();
          }
        }
      } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("settles Codex JSONL usage through an absolute selected binary", async () => {
    const calls: SpawnCall[] = [];
    const verifier = process.platform === "win32" ? "cmd /c exit 0" : "true";
    const profile = negotiatedProfile({ model: { flag: "--model", scope: "exec" } });
    const adapter = createCodexCliAdapter({
      command: profile.binaryPath,
      model: "gpt-6.1-sol",
      capabilityProfile: profile,
      autonomyResolution: negotiatedAutonomy(),
      spawnImpl: createScriptedSpawn(calls, [
        {
          stdout: [
            JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
            JSON.stringify({ type: "turn.started" }),
            JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Patched and verified." } }),
            JSON.stringify({ type: "turn.completed", model: "gpt-6.1-sol", usage: { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 200, reasoning_output_tokens: 50 } })
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
    expect(result.usage.tokensIn).toBe(1200);
    expect(result.usage.tokensOut).toBe(200);
    expect(result.usage.cachedInputTokens).toBe(300);
    expect(result.usage.reasoningTokensOut).toBe(50);
    expect(result.usage.actualUsd).toBeCloseTo(0.00383, 6);
    expect(result.usage.providerSettlement?.pricingVersion).toBe(
      "official-provider-pricing@2026-11-03"
    );
    expect(calls[0]?.command).toBe(profile.binaryPath);
  });

  it("rejects a capability profile or resolution for a different exact binary", () => {
    expect(() => createCodexCliAdapter({
      command: "C:\\Tools\\codex-b.exe",
      capabilityProfile: negotiatedProfile({ binaryPath: "C:\\Tools\\codex-a.exe" }),
      autonomyResolution: negotiatedAutonomy({ binaryPath: "C:\\Tools\\codex-a.exe" })
    })).toThrow(/exact binary.*mismatch/iu);
  });
});
