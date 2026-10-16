import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

import type { MartinAdapterRequest } from "@martin/core";
import { createClaudeCliAdapter, type SpawnLike } from "../src/index.js";

interface ScriptedOutput {
  exitCode?: number;
  stdout?: string;
}

/** The first spawn is the Claude CLI; every later spawn is the verifier. */
function createScriptedSpawn(calls: string[], agent: ScriptedOutput): SpawnLike {
  return (command, args = []) => {
    const isAgent = calls.length === 0;
    calls.push([command, ...args].join(" "));
    const output = isAgent ? agent : { stdout: "ok\n", exitCode: 0 };
    const child = new EventEmitter() as Partial<ChildProcess> & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => {
      if (output.stdout) child.stdout.write(output.stdout);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", output.exitCode ?? 0);
    });
    return child as ChildProcess;
  };
}

function request(verificationPlan: string[]): MartinAdapterRequest {
  return {
    loopId: "loop_claude_error",
    workspaceId: "ws_claude_error",
    attemptId: "att_claude_error_1",
    context: {
      taskTitle: "Claude error result",
      objective: "Add multiply to math.js.",
      verificationPlan,
      focus: "Stay inside the requested scope.",
      remainingBudgetUsd: 8,
      remainingIterations: 3,
      remainingTokens: 10_000
    },
    previousAttempts: []
  };
}

function stream(result: Record<string, unknown>): string {
  return [
    JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-4-6" }),
    JSON.stringify({ type: "result", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01, ...result })
  ].join("\n");
}

describe("Claude error results never reach the verifier", () => {
  const verifier = process.platform === "win32" ? "cmd /c exit 0" : "true";

  async function runWith(agent: ScriptedOutput) {
    const calls: string[] = [];
    const adapter = createClaudeCliAdapter({ spawnImpl: createScriptedSpawn(calls, agent) });
    return { result: await adapter.execute(request([verifier])), calls };
  }

  it.each([
    ["is_error with an error subtype and exit 1", { subtype: "error_during_execution", is_error: true, result: "API Error: overloaded" }, 1],
    ["is_error on a success subtype and exit 0", { subtype: "success", is_error: true, result: "API Error: 529 overloaded" }, 0],
    ["an error_max_turns subtype", { subtype: "error_max_turns", is_error: false }, 0]
  ])("fails %s without running the verifier", async (_name, result, exitCode) => {
    const { result: outcome, calls } = await runWith({ stdout: stream(result), exitCode });

    expect(outcome.status).toBe("failed");
    expect(outcome.verification.passed).toBe(false);
    expect(outcome.verification.summary).toContain("Verifier not run");
    expect(calls).toHaveLength(1);
  });

  it("control: a successful Claude result still runs the verifier", async () => {
    const { result, calls } = await runWith({
      stdout: stream({ subtype: "success", is_error: false, result: "Patched." }),
      exitCode: 0
    });

    expect(result.status).toBe("completed");
    expect(result.verification.passed).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("retains authoritative error cost when Claude omits token usage", async () => {
    const { result, calls } = await runWith({
      stdout: [
        JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-4-6" }),
        JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error", total_cost_usd: 0.42 })
      ].join("\n"),
      exitCode: 0
    });

    expect(result.status).toBe("failed");
    expect(result.usage).toMatchObject({ actualUsd: 0.42, provenance: "actual" });
    expect(calls).toHaveLength(1);
  });
});
