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

async function fixtureRoot(): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "martin-audit-fixture-"));
  const project = join(scratch, "projects", "-work-app");
  await mkdir(project, { recursive: true });
  const lines: string[] = [];
  const usage = { input_tokens: 2000, output_tokens: 800, cache_read_input_tokens: 40000, cache_creation_input_tokens: 2000 };
  let request = 0;
  let minute = 0;
  const assistant = (blocks: unknown[]) => {
    lines.push(JSON.stringify({
      type: "assistant", sessionId: "s1", cwd: "/work/app",
      timestamp: "2026-09-20T10:" + String(minute++).padStart(2, "0") + ":00Z",
      requestId: "r" + request, message: { id: "m" + request++, model: "claude-sonnet-4-5", usage, content: blocks },
    }));
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
