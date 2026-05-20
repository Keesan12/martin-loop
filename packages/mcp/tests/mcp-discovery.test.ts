import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLoopEvent, createLoopRecord } from "@martin/contracts";
import { describe, expect, it } from "vitest";

import {
  listMartinResourceTemplates,
  listMartinResources,
  readMartinResource
} from "../src/resources.js";
import { getMartinPrompt, listMartinPrompts } from "../src/prompts.js";

async function withRunsRoot<T>(fn: (runsRoot: string) => Promise<T>): Promise<T> {
  const runsRoot = await mkdtemp(join(tmpdir(), "martin-mcp-discovery-"));
  const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
  process.env.MARTIN_RUNS_DIR = runsRoot;
  try {
    return await fn(runsRoot);
  } finally {
    if (previousRunsRoot === undefined) {
      delete process.env.MARTIN_RUNS_DIR;
    } else {
      process.env.MARTIN_RUNS_DIR = previousRunsRoot;
    }
    await rm(runsRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeRun(runsRoot: string) {
  const started = createLoopRecord({
    loopId: "loop_release_ready",
    workspaceId: "ws_test",
    projectId: "proj_test",
    task: {
      title: "Release MCP cockpit",
      objective: "Expose read-only run cockpit evidence",
      verificationPlan: ["pnpm test", "pnpm build"]
    },
    budget: {
      maxUsd: 10,
      softLimitUsd: 6,
      maxIterations: 3,
      maxTokens: 10_000
    },
    cost: {
      actualUsd: 2.4,
      avoidedUsd: 4,
      tokensIn: 800,
      tokensOut: 300
    },
    attempts: [
      {
        attemptId: "attempt_1",
        index: 1,
        adapterId: "stub",
        model: "test-model",
        startedAt: "2026-05-20T14:00:00.000Z",
        completedAt: "2026-05-20T14:02:00.000Z",
        summary: "Added read-only discovery.",
        failureClass: "verification_failure",
        intervention: "run_verifier"
      }
    ],
    createdAt: "2026-05-20T14:00:00.000Z",
    updatedAt: "2026-05-20T14:03:00.000Z"
  });

  const loop = appendLoopEvent(started, {
    type: "verification.completed",
    lifecycleState: "completed",
    timestamp: "2026-05-20T14:03:00.000Z",
    payload: { passed: true, summary: "All MCP release gates passed." }
  });

  await mkdir(join(runsRoot, loop.loopId), { recursive: true });
  await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");
  return loop;
}

describe("MCP discovery resources and prompts", () => {
  it("lists the 0.2.0 static resources and run templates", () => {
    expect(listMartinResources().map((resource) => resource.uri)).toEqual([
      "martin://runs/summary",
      "martin://runs/latest"
    ]);
    expect(listMartinResourceTemplates().map((template) => template.uriTemplate)).toEqual([
      "martin://runs/{loopId}",
      "martin://runs/{loopId}/attempts/{attemptIndex}",
      "martin://runs/{loopId}/verification"
    ]);
  });

  it("reads run summary latest run and templated run resources", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = await writeRun(runsRoot);

      const summary = await readMartinResource("martin://runs/summary");
      const latest = await readMartinResource("martin://runs/latest");
      const run = await readMartinResource(`martin://runs/${loop.loopId}`);
      const attempt = await readMartinResource(`martin://runs/${loop.loopId}/attempts/1`);
      const verification = await readMartinResource(`martin://runs/${loop.loopId}/verification`);

      expect(summary.contents[0]?.text).toContain("loop_release_ready");
      expect(latest.contents[0]?.text).toContain("Release MCP cockpit");
      expect(run.contents[0]?.text).toContain("verificationPlan");
      expect(attempt.contents[0]?.text).toContain("Added read-only discovery");
      expect(verification.contents[0]?.text).toContain("All MCP release gates passed");
    });
  });

  it("lists and renders prompts for review and triage", async () => {
    expect(listMartinPrompts().map((prompt) => prompt.name)).toEqual([
      "martin_review_run",
      "martin_triage_failures"
    ]);

    const review = getMartinPrompt("martin_review_run", {
      loopId: "loop_release_ready",
      objective: "Review MCP release readiness"
    });

    expect(review.messages[0]?.content.text).toContain("loop_release_ready");
    expect(review.messages[0]?.content.text).toContain("Review MCP release readiness");
  });
});
