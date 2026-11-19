import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AUDIT_HELP, executeAuditCommand } from "../src/audit.js";
import { parseCliArguments } from "../src/index.js";

let scratch: string | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

async function fixtureRoot(
  splitMessages = false,
  model = "claude-sonnet-4-6",
  cacheWriteShape: "5m" | "1h" | "mixed" | "aggregate" = "5m",
): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "martin-audit-fixture-"));
  const project = join(scratch, "projects", "-work-app");
  await mkdir(project, { recursive: true });
  const lines: string[] = [];
  const cacheCreation = cacheWriteShape === "5m"
    ? { ephemeral_5m_input_tokens: 2000 }
    : cacheWriteShape === "1h"
      ? { ephemeral_1h_input_tokens: 2000 }
      : cacheWriteShape === "mixed"
        ? { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 }
        : undefined;
  const usage = {
    input_tokens: 2000,
    output_tokens: 800,
    cache_read_input_tokens: 40000,
    cache_creation_input_tokens: 2000,
    ...(cacheCreation === undefined ? {} : { cache_creation: cacheCreation }),
  };
  let request = 0;
  let minute = 0;
  const assistant = (blocks: unknown[]) => {
    const row = {
      type: "assistant", sessionId: "s1", cwd: "/work/app",
      timestamp: "2026-09-20T10:" + String(minute++).padStart(2, "0") + ":00Z",
      requestId: "r" + request, message: { id: "m" + request++, model, usage, content: blocks },
    };
    if (splitMessages) {
      lines.push(JSON.stringify({ ...row, message: { ...row.message, content: [{ type: "text", text: "Checking the change." }] } }));
      for (const block of blocks) {
        const toolRow = JSON.stringify({ ...row, message: { ...row.message, content: [block] } });
        lines.push(toolRow, toolRow);
      }
    } else {
      lines.push(JSON.stringify(row));
    }
  };
  const result = (id: string, failed: boolean) => {
    lines.push(JSON.stringify({
      type: "user", sessionId: "s1",
      timestamp: "2026-09-20T10:" + String(minute++).padStart(2, "0") + ":30Z",
      message: { content: [{ type: "tool_result", tool_use_id: id, is_error: failed, content: failed ? "Exit code 1\nFAIL" : "ok" }] },
    }));
  };
  assistant([{ type: "tool_use", id: "e0", name: "Edit", input: {} }]);
  const outcomes = [true, true, true, true, false, true, false, true, true];
  for (let index = 0; index < outcomes.length; index += 1) {
    const id = "t" + index;
    assistant([{ type: "tool_use", id, name: "Bash", input: { command: "npm test" } }]);
    result(id, outcomes[index] ?? false);
    assistant([{ type: "tool_use", id: "e" + (index + 1), name: "Edit", input: {} }]);
  }
  await writeFile(join(project, "s1.jsonl"), lines.join("\n") + "\n", "utf8");
  return scratch;
}

describe("martin audit", () => {
  it("rejects invalid audit days during parsing and preserves valid boundaries", () => {
    for (const value of [undefined, "", "--offline", "NaN", "Infinity", "0", "-1", "1.2"]) {
      const argv = ["audit", "--days"];
      if (value !== undefined) argv.push(value);
      expect(() => parseCliArguments(argv)).toThrow(/--days.*positive integer|--days requires/iu);
    }
    expect(parseCliArguments(["audit", "--days", "1", "--offline"])).toMatchObject({
      command: "audit",
      days: 1,
      offline: true,
    });
    expect(AUDIT_HELP).toContain("Use the official provider catalog only");
  });

  it("produces deterministic loop-tax metrics", async () => {
    const root = await fixtureRoot();
    const result = await executeAuditCommand({ directory: root, share: false, offline: true }, "json");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { summary: Record<string, unknown> };
    expect(payload.summary).toMatchObject({
      sessions: 1,
      spendUsd: 0.71,
      loopTaxUsd: 0.49,
      loopTaxPct: 68,
      fixLoops: 3,
      failedVerifierRuns: 7,
      longestLoop: 4,
      stuckLoops: 1,
      sessionsEndedOnRed: 1,
      sessionsEditedWithoutVerifier: 0,
      pricing: "official provider catalog",
      unpricedTurns: 0,
    });
  });

  it("prefers the official catalog over conflicting live fallback prices", async () => {
    const root = await fixtureRoot(false, "claude-sonnet-5-5");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      "claude-sonnet-5-5": {
        input_cost_per_token: 1,
        output_cost_per_token: 1,
        cache_read_input_token_cost: 1,
        cache_creation_input_token_cost: 1,
      },
    }), { status: 200 })));

    const result = await executeAuditCommand({ directory: root, share: false, offline: false }, "json");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { summary: Record<string, unknown> };
    expect(payload.summary).toMatchObject({
      spendUsd: 0.4,
      loopTaxUsd: 0.27,
      loopTaxPct: 68,
      pricing: "official provider catalog + LiteLLM fallback",
      unpricedTurns: 0,
    });
  });

  it.each([
    ["1h", 0.46],
    ["mixed", 0.43],
    ["aggregate", 0.46],
  ] as const)("prices %s cache-write usage without understating it", async (cacheWriteShape, spendUsd) => {
    const root = await fixtureRoot(false, "claude-sonnet-5-5", cacheWriteShape);
    const result = await executeAuditCommand({ directory: root, share: false, offline: true }, "json");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).summary).toMatchObject({ spendUsd, unpricedTurns: 0 });
  });

  it("uses LiteLLM only for catalog-unknown models and fails closed offline", async () => {
    const root = await fixtureRoot(false, "claude-private-model");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      "claude-private-model": {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 15e-6,
        cache_read_input_token_cost: 0.3e-6,
        cache_creation_input_token_cost: 3.75e-6,
      },
    }), { status: 200 })));

    const online = await executeAuditCommand({ directory: root, share: false, offline: false }, "json");
    expect(JSON.parse(online.stdout).summary).toMatchObject({ spendUsd: 0.71, unpricedTurns: 0 });

    const offline = await executeAuditCommand({ directory: root, share: false, offline: true }, "json");
    expect(JSON.parse(offline.stdout).summary).toMatchObject({
      spendUsd: 0,
      loopTaxUsd: 0,
      pricing: "official provider catalog",
      unpricedTurns: 19,
    });
  });

  it("marks loop allocation as a lower bound when an authoritative session total includes an unpriced loop turn", async () => {
    scratch = await mkdtemp(join(tmpdir(), "martin-audit-mixed-pricing-"));
    const project = join(scratch, "projects", "-work-app");
    await mkdir(project, { recursive: true });
    const rows = [
      {
        type: "assistant", sessionId: "mixed", cwd: "/work/app", requestId: "r1",
        message: {
          id: "m1", model: "claude-sonnet-5-5", usage: { input_tokens: 1_000_000 },
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }],
        },
      },
      {
        type: "user", sessionId: "mixed",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Exit code 1\nFAIL" }] },
      },
      {
        type: "assistant", sessionId: "mixed", cwd: "/work/app", requestId: "r2",
        message: { id: "m2", model: "claude-unknown", usage: { input_tokens: 1_000_000 }, content: [] },
      },
      {
        type: "assistant", sessionId: "mixed", cwd: "/work/app", requestId: "r3",
        message: {
          id: "m3", model: "claude-sonnet-5-5", usage: { input_tokens: 1_000_000 },
          content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }],
        },
      },
      {
        type: "user", sessionId: "mixed",
        message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: false, content: "ok" }] },
      },
      { type: "cost-state", sessionId: "mixed", totalCostUSD: 10 },
    ];
    await writeFile(join(project, "mixed.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");

    const result = await executeAuditCommand({ directory: scratch, share: false, offline: true }, "json");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).summary).toMatchObject({
      spendUsd: 10,
      loopTaxUsd: 2,
      loopTaxPct: 20,
      loopCostStatus: "lower_bound",
      unpricedTurns: 1,
    });
    const human = await executeAuditCommand({ directory: scratch, share: false, offline: true }, "human");
    expect(human.stdout).toContain("Known spend inside fix loops");
    expect(human.stdout).toContain("at least 20% loop tax");
    expect(human.stdout).toContain("Loop spend and percentage are lower bounds");
  });

  it("writes share artifacts", async () => {
    const root = await fixtureRoot();
    const previous = process.cwd();
    process.chdir(root);
    try {
      const result = await executeAuditCommand({ directory: root, share: true, offline: true }, "human");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Wrote loop-tax-card.svg and loop-tax.md");
      expect(await readFile(join(root, "loop-tax-card.svg"), "utf8")).toContain("68%");
      expect(await readFile(join(root, "loop-tax.md"), "utf8")).toContain("**68%**");
    } finally {
      process.chdir(previous);
    }
  });

  it("counts verifier runs from split assistant messages without duplicating cost or tool blocks", async () => {
    const root = await fixtureRoot(true);
    const result = await executeAuditCommand({ directory: root, share: false, offline: true }, "json");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { summary: Record<string, unknown>; topSessions: Record<string, unknown>[] };
    expect(payload.summary).toMatchObject({
      sessions: 1,
      spendUsd: 0.71,
      loopTaxUsd: 0.49,
      loopTaxPct: 68,
      fixLoops: 3,
      failedVerifierRuns: 7,
      longestLoop: 4,
      stuckLoops: 1,
    });
    expect(payload.topSessions).toEqual([expect.objectContaining({ edits: 10, verifies: 9 })]);
  });

  it("deduplicates copied tool blocks while retaining call lookup for new fork results", async () => {
    const root = await fixtureRoot(true);
    const project = join(root, "projects", "-work-app");
    const original = await readFile(join(project, "s1.jsonl"), "utf8");
    const copiedRows: Record<string, unknown>[] = original.trim().split("\n").map((line) => ({
      ...JSON.parse(line) as Record<string, unknown>, sessionId: "s2",
    }));
    copiedRows.push({
      type: "assistant", sessionId: "s2", cwd: "/work/app",
      timestamp: "2026-09-20T11:00:00Z", requestId: "fork-request",
      message: { id: "fork-message", model: "claude-sonnet-4-5", usage: { input_tokens: 2000 }, content: [] },
    }, {
      type: "user", sessionId: "s2", timestamp: "2026-09-20T11:00:30Z",
      message: { content: [{ type: "tool_result", tool_use_id: "t8", is_error: true, content: "Exit code 1\nNew failure on the fork" }] },
    });
    await writeFile(join(project, "s2-fork.jsonl"), copiedRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");

    const result = await executeAuditCommand({ directory: root, share: false, offline: true }, "json");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { summary: Record<string, unknown>; topSessions: Record<string, unknown>[] };
    expect(payload.summary).toMatchObject({ sessions: 2, fixLoops: 4, failedVerifierRuns: 8 });
    expect(payload.topSessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "s1", edits: 10, verifies: 9 }),
      expect.objectContaining({ id: "s2", edits: 0, verifies: 1 }),
    ]));
  });

  it("counts distinct edit blocks in one turn once across resumed copies", async () => {
    const root = await fixtureRoot(true);
    const project = join(root, "projects", "-work-app");
    const original = await readFile(join(project, "s1.jsonl"), "utf8");
    const blocks = [
      { type: "tool_use", id: "extra-edit", name: "Edit", input: {} },
      { type: "tool_use", id: "extra-write", name: "Write", input: {} },
    ];
    const rows = blocks.map((block) => JSON.stringify({
      type: "assistant", sessionId: "s1", requestId: "r0",
      message: { id: "m0", usage: { input_tokens: 2000 }, content: [block] },
    }));
    // A resumed row may omit usage, so tool dedupe must not depend on turn-cost dedupe.
    rows.push(JSON.stringify({
      type: "assistant", sessionId: "s1", requestId: "resumed",
      message: { id: "resumed", content: blocks },
    }));
    const resumed = original + rows.join("\n") + "\n";
    await writeFile(join(project, "s1.jsonl"), resumed, "utf8");
    await writeFile(join(project, "s1-resumed.jsonl"), resumed, "utf8");

    const result = await executeAuditCommand({ directory: root, share: false, offline: true }, "json");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { summary: Record<string, unknown>; topSessions: Record<string, unknown>[] };
    expect(payload.summary).toMatchObject({ sessions: 1, spendUsd: 0.71, fixLoops: 3, failedVerifierRuns: 7 });
    expect(payload.topSessions).toEqual([expect.objectContaining({ edits: 12, verifies: 9 })]);
  });

  it("deduplicates copied Claude history across files", async () => {
    const root = await fixtureRoot();
    const project = join(root, "projects", "-work-app");
    const original = await readFile(join(project, "s1.jsonl"), "utf8");
    await writeFile(join(project, "s1-copy.jsonl"), original, "utf8");

    const result = await executeAuditCommand({ directory: root, share: false, offline: true }, "json");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { summary: Record<string, unknown> };
    expect(payload.summary).toMatchObject({
      sessions: 1,
      spendUsd: 0.71,
      loopTaxUsd: 0.49,
      loopTaxPct: 68,
      fixLoops: 3,
      failedVerifierRuns: 7,
      longestLoop: 4,
      stuckLoops: 1,
    });
  });

  it("handles an empty project filter", async () => {
    const root = await fixtureRoot();
    const result = await executeAuditCommand({ directory: root, project: "missing", share: false, offline: true }, "json");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { summary: Record<string, unknown> };
    expect(payload.summary).toMatchObject({ sessions: 0, from: null, to: null, spendUsd: 0, loopTaxUsd: 0 });
  });
});
