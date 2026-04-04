import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readRunGraph } from "../lib/server/ingest-run-read-model.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("readRunGraph", () => {
  it("hydrates patch, grounding, leash, and budget truth from persisted attempt artifacts", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-control-plane-ingest-"));
    tempDirs.push(runsRoot);

    const runDirectory = join(runsRoot, "run_truth");
    const attemptDirectory = join(runDirectory, "artifacts", "attempt-001");
    await mkdir(attemptDirectory, { recursive: true });

    await writeJson(join(runDirectory, "contract.json"), {
      runId: "run_truth",
      workspaceId: "ws_truth",
      projectId: "proj_truth",
      task: {
        title: "Repair grounding truth",
        objective: "Use persisted artifacts to explain why the attempt was discarded.",
        repoRoot: "C:/repo",
        verificationPlan: ["pnpm --filter @martin/core test"]
      },
      budget: {
        maxUsd: 8,
        softLimitUsd: 4,
        maxIterations: 3,
        maxTokens: 16000
      },
      createdAt: "2026-04-03T11:00:00.000Z"
    });

    await writeJson(join(runDirectory, "state.json"), {
      phase: "VERIFY",
      currentAttempt: 1,
      activeModel: "gpt-5.4-mini"
    });

    await writeLedger(join(runDirectory, "ledger.jsonl"), [
      {
        kind: "attempt.admitted",
        runId: "run_truth",
        attemptIndex: 1,
        timestamp: "2026-04-03T11:00:01.000Z",
        payload: {
          adapterId: "direct:openai:gpt-5.4-mini",
          providerId: "openai",
          model: "gpt-5.4-mini",
          transport: "http"
        }
      },
      {
        kind: "budget.settled",
        runId: "run_truth",
        attemptIndex: 1,
        timestamp: "2026-04-03T11:00:30.000Z",
        payload: {
          actualUsd: 1.12,
          estimatedUsd: 1.36,
          tokensIn: 240,
          tokensOut: 110,
          provenance: "estimated",
          patchCost: { usd: 0.82 },
          verificationCost: { usd: 0.3 },
          varianceUsd: -0.24
        }
      },
      {
        kind: "grounding.violations_found",
        runId: "run_truth",
        attemptIndex: 1,
        timestamp: "2026-04-03T11:00:31.000Z",
        payload: {
          violationCount: 1,
          resolvedFiles: ["packages/core/src/index.ts"],
          contentOnly: true,
          violations: [
            {
              kind: "symbol_not_found",
              detail: "Referenced symbol MissingType was not found in the repo index."
            }
          ]
        }
      },
      {
        kind: "safety.violations_found",
        runId: "run_truth",
        attemptIndex: 1,
        timestamp: "2026-04-03T11:00:32.000Z",
        payload: {
          surface: "filesystem",
          blocked: true,
          profile: "ci_safe",
          violations: [
            {
              kind: "patch_outside_allowed_paths",
              detail: "Patch touched apps/control-plane/page.tsx outside the approved scope."
            }
          ]
        }
      },
      {
        kind: "attempt.discarded",
        runId: "run_truth",
        attemptIndex: 1,
        timestamp: "2026-04-03T11:00:33.000Z",
        payload: {
          decision: "DISCARD",
          reason:
            "Patch discarded. Reasons: grounding_failure, verifier_regressed. Attempt summary: Grounding contradicted the claimed fix.",
          reasonCodes: ["grounding_failure", "verifier_regressed"],
          score: -0.42
        }
      },
      {
        kind: "run.exited",
        runId: "run_truth",
        timestamp: "2026-04-03T11:00:34.000Z",
        payload: {
          lifecycleState: "human_escalation",
          status: "exited",
          reason: "Grounding evidence contradicted the claimed repair."
        }
      }
    ]);

    await writeJson(join(attemptDirectory, "compiled-context.json"), {
      loopId: "run_truth",
      attemptNumber: 1
    });
    await writeJson(join(attemptDirectory, "grounding-scan.json"), {
      violationCount: 1,
      resolvedFiles: ["packages/core/src/index.ts"],
      contentOnly: true,
      violations: [
        {
          kind: "symbol_not_found",
          detail: "Referenced symbol MissingType was not found in the repo index."
        }
      ]
    });
    await writeJson(join(attemptDirectory, "leash.json"), {
      surface: "filesystem",
      blocked: true,
      profile: "ci_safe",
      violations: [
        {
          kind: "patch_outside_allowed_paths",
          detail: "Patch touched apps/control-plane/page.tsx outside the approved scope."
        }
      ]
    });
    await writeJson(join(attemptDirectory, "patch-score.json"), {
      score: -0.42,
      verifierScore: 0,
      verifierDelta: -1,
      diffRiskScore: 0.21,
      noveltyScore: 0.48,
      costUsd: 1.12,
      reasonCodes: ["grounding_failure", "verifier_regressed"]
    });
    await writeJson(join(attemptDirectory, "patch-decision.json"), {
      decision: "DISCARD",
      summary:
        "Patch discarded. Reasons: grounding_failure, verifier_regressed. Attempt summary: Grounding contradicted the claimed fix.",
      reasonCodes: ["grounding_failure", "verifier_regressed"]
    });

    const graph = await readRunGraph(runDirectory);
    const attempt = graph.attempts[0];

    expect(graph.run.lifecycleState).toBe("human_escalation");
    expect(graph.run.stopReason).toBe("Grounding evidence contradicted the claimed repair.");
    expect(graph.run.costProvenance).toBe("estimated");
    expect(graph.run.latestPatchDecision).toBe("DISCARD");
    expect(graph.run.groundingViolationCount).toBe(1);
    expect(graph.run.blockedSafetyViolationCount).toBe(1);
    expect(graph.run.budgetVarianceUsd).toBe(-0.24);
    expect(attempt?.patchDecision).toBe("DISCARD");
    expect(attempt?.patchReasonCodes).toEqual(["grounding_failure", "verifier_regressed"]);
    expect(attempt?.groundingViolationCount).toBe(1);
    expect(attempt?.groundingContentOnly).toBe(true);
    expect(attempt?.safetyViolationCount).toBe(1);
    expect(attempt?.safetySurface).toBe("filesystem");
    expect(attempt?.budgetProvenance).toBe("estimated");
    expect(attempt?.budgetVarianceUsd).toBe(-0.24);
    expect(attempt?.patchScore).toBe(-0.42);
  });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeLedger(path: string, rows: unknown[]): Promise<void> {
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}
