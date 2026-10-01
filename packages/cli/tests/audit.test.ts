import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeAuditCommand } from "../src/audit.js";

let scratch: string | undefined;

afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

async function fixtureRoot(splitMessages = false): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "martin-audit-fixture-"));
  const project = join(scratch, "projects", "-work-app");
  await mkdir(project, { recursive: true });
  const lines: string[] = [];
  const usage = { input_tokens: 2000, output_tokens: 800, cache_read_input_tokens: 40000, cache_creation_input_tokens: 2000 };
  let request = 0;
  let minute = 0;
  const assistant = (blocks: unknown[]) => {
    const row = {
      type: "assistant", sessionId: "s1", cwd: "/work/app",
      timestamp: "2026-09-20T10:" + String(minute++).padStart(2, "0") + ":00Z",
      requestId: "r" + request, message: { id: "m" + request++, model: "claude-sonnet-4-5", usage, content: blocks },
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
      pricing: "bundled prices",
    });
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
