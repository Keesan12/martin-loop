import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLoopRecord } from "@martin/contracts";
import type { ExitKind, LoopRecord, TerminationEnvelopeV1 } from "@martin/contracts";
import { writeReceiptIntegrityMaterial } from "@martin/core";
import { describe, expect, it } from "vitest";

import { martinRunDossierTool } from "../src/tools/run-dossier.js";

type OperationalTerminationEnvelope = Extract<
  TerminationEnvelopeV1,
  { class: "operational_exit" }
>;

function operationalExit(primary: ExitKind): OperationalTerminationEnvelope {
  return {
    schemaVersion: "termination/1",
    class: "operational_exit",
    exit: {
      schemaVersion: "exit-evaluation/1",
      policyVersion: "exit-policy/1",
      shouldExit: true,
      primary,
      matched: [primary],
      phase: "post_attempt",
      evaluatedAt: "2026-10-09T16:00:02.000Z",
      matches: [
        {
          kind: primary,
          reason: `Persisted ${primary} reason.`,
          evidence: {}
        }
      ]
    }
  };
}

async function withRunsAndWorkspace<T>(
  fn: (input: { runsRoot: string; workspaceRoot: string }) => Promise<T>
): Promise<T> {
  const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
  const previousWorkspaceRoot = process.env.MARTIN_MCP_WORKSPACE_ROOT;
  const runsRoot = await mkdtemp(join(tmpdir(), "martin-mcp-dossier-runs-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "martin-mcp-dossier-workspace-"));
  process.env.MARTIN_RUNS_DIR = runsRoot;
  process.env.MARTIN_MCP_WORKSPACE_ROOT = workspaceRoot;

  try {
    return await fn({ runsRoot, workspaceRoot });
  } finally {
    if (previousRunsRoot === undefined) {
      delete process.env.MARTIN_RUNS_DIR;
    } else {
      process.env.MARTIN_RUNS_DIR = previousRunsRoot;
    }

    if (previousWorkspaceRoot === undefined) {
      delete process.env.MARTIN_MCP_WORKSPACE_ROOT;
    } else {
      process.env.MARTIN_MCP_WORKSPACE_ROOT = previousWorkspaceRoot;
    }

    await rm(runsRoot, { recursive: true, force: true }).catch(() => {});
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function persistSignedDossierFixture(input: {
  runsRoot: string;
  workspaceRoot: string;
  loopId: string;
  adapterId?: string;
  verificationPayload?: Record<string, unknown>;
  terminationEnvelope?: TerminationEnvelopeV1;
  fileEffects?: {
    observationStatus: "observed" | "unavailable";
    touchedDuringExecution: string[];
    netChangedAtCompletion: string[];
    revertedBeforeCompletion: string[];
    observationReason?: string;
  };
}): Promise<LoopRecord> {
  const attemptId = `attempt_${input.loopId}`;
  const command = "pnpm test";
  const binding = {
    runId: input.loopId,
    workspaceId: "ws_dossier_truth",
    attemptId,
    cwd: input.workspaceRoot,
    runsRoot: input.runsRoot,
    commands: [command]
  };
  const verificationPayload = input.verificationPayload ?? {
    attemptId,
    attemptIndex: 1,
    passed: true,
    summary: "Bound verifier passed.",
    steps: [
      {
        command,
        launched: true,
        completed: true,
        crashed: false,
        exitCode: 0,
        timedOut: false
      }
    ],
    binding,
    changedFiles: ["src/kept.ts"]
  };
  const fileEffects = input.fileEffects ?? {
    observationStatus: "observed" as const,
    touchedDuringExecution: ["src/kept.ts", "src/reverted.ts"],
    netChangedAtCompletion: ["src/kept.ts"],
    revertedBeforeCompletion: ["src/reverted.ts"]
  };
  const base = createLoopRecord({
    loopId: input.loopId,
    workspaceId: "ws_dossier_truth",
    projectId: "proj_dossier_truth",
    status: "completed",
    lifecycleState: "completed",
    task: {
      title: "Preserve dossier truth",
      objective: "Project the signed persisted evidence without contradiction.",
      repoRoot: input.workspaceRoot,
      mutationMode: "edit",
      allowedPaths: ["src/**"],
      deniedPaths: ["apps/**"],
      verificationPlan: [command]
    },
    receiptScope: {
      repoRoot: input.workspaceRoot,
      workingDirectory: input.workspaceRoot,
      runsRoot: input.runsRoot
    },
    terminationEnvelope: input.terminationEnvelope ?? operationalExit("goal_met")
  });
  const loop: LoopRecord = {
    ...base,
    attempts: [
      {
        attemptId,
        index: 1,
        adapterId: input.adapterId ?? "agent-cli:codex",
        model: "gpt-5.4",
        startedAt: "2026-10-09T16:00:00.000Z",
        completedAt: "2026-10-09T16:00:01.000Z"
      }
    ],
    events: [
      {
        eventId: `evt_verify_${input.loopId}`,
        timestamp: "2026-10-09T16:00:01.000Z",
        type: "verification.completed",
        lifecycleState: "completed",
        payload: verificationPayload
      },
      {
        eventId: `evt_complete_${input.loopId}`,
        timestamp: "2026-10-09T16:00:02.000Z",
        type: "run.completed",
        lifecycleState: "completed",
        payload: { fileEffects }
      }
    ]
  };
  const ledgerEntries = [
    {
      kind: "verification.completed" as const,
      runId: loop.loopId,
      attemptIndex: 1,
      timestamp: "2026-10-09T16:00:01.000Z",
      payload: verificationPayload
    },
    {
      kind: "run.completed" as const,
      runId: loop.loopId,
      timestamp: "2026-10-09T16:00:02.000Z",
      payload: { fileEffects }
    }
  ];
  const runDirectory = join(input.runsRoot, loop.loopId);
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, "loop-record.json"), `${JSON.stringify(loop, null, 2)}\n`, "utf8");
  await writeFile(
    join(runDirectory, "ledger.jsonl"),
    ledgerEntries.map((entry) => JSON.stringify(entry)).join("\n").concat("\n"),
    "utf8"
  );
  await writeReceiptIntegrityMaterial({
    runId: loop.loopId,
    runsRoot: input.runsRoot,
    loopRecord: loop,
    ledgerEntries,
    scope: loop.receiptScope,
    signedAt: loop.updatedAt
  });
  return loop;
}

describe("martinRunDossierTool", () => {
  it("keeps bound verification and persisted file effects consistent across the MCP dossier", { timeout: 20_000 }, async () => {
    await withRunsAndWorkspace(async ({ runsRoot, workspaceRoot }) => {
      const loop = await persistSignedDossierFixture({
        runsRoot,
        workspaceRoot,
        loopId: "loop_mcp_bound_truth"
      });

      const dossier = await martinRunDossierTool({ loopId: loop.loopId, runsDir: runsRoot });

      expect(dossier.receiptIntegrity.state).toBe("verified");
      expect(dossier.verification.status).toBe("passed");
      expect(dossier.verification.steps).toEqual([
        expect.objectContaining({ command: "pnpm test", launched: true, completed: true, exitCode: 0 })
      ]);
      expect(dossier.verifiedHandoff.verification.status).toBe("PASSED");
      expect(dossier.verifiedHandoff.outcome).toBe("VERIFIED");
      expect(dossier.review.outcome).toBe("passed");
      expect(dossier.verifiedHandoff.fileEffects).toEqual({
        observationStatus: "observed",
        touchedDuringExecution: ["src/kept.ts", "src/reverted.ts"],
        netChangedAtCompletion: ["src/kept.ts"],
        revertedBeforeCompletion: ["src/reverted.ts"]
      });
      expect(dossier.verifiedHandoff.scope.changedFiles).toEqual(["src/kept.ts"]);
    });
  });

  it("contradicts a passed label that lacks bound verifier steps", { timeout: 20_000 }, async () => {
    await withRunsAndWorkspace(async ({ runsRoot, workspaceRoot }) => {
      const loop = await persistSignedDossierFixture({
        runsRoot,
        workspaceRoot,
        loopId: "loop_mcp_unbound_claim",
        verificationPayload: {
          attemptId: "attempt_loop_mcp_unbound_claim",
          attemptIndex: 1,
          passed: true,
          summary: "Claimed pass without execution evidence."
        }
      });

      const dossier = await martinRunDossierTool({ loopId: loop.loopId, runsDir: runsRoot });

      expect(dossier.verification.status).toBe("contradicted");
      expect(dossier.verification.warnings).toContain(
        "Persisted verifier claimed success without complete bound execution evidence."
      );
      expect(dossier.verifiedHandoff.verification.status).toBe("CONTRADICTED");
      expect(dossier.verifiedHandoff.outcome).toBe("NEEDS_REVIEW");
      expect(dossier.review.outcome).toBe("needs_review");
    });
  });

  it("preserves proof-only verifier evidence while keeping it governance-ineligible", { timeout: 20_000 }, async () => {
    await withRunsAndWorkspace(async ({ runsRoot, workspaceRoot }) => {
      const loop = await persistSignedDossierFixture({
        runsRoot,
        workspaceRoot,
        loopId: "loop_mcp_proof_only",
        adapterId: "direct:verifier:verify-only"
      });

      const dossier = await martinRunDossierTool({ loopId: loop.loopId, runsDir: runsRoot });

      expect(dossier.verification.status).toBe("passed");
      expect(dossier.verifiedHandoff.verification.status).toBe("PASSED");
      expect(dossier.verifiedHandoff.executionMode).toBe("verification_only");
      expect(dossier.verifiedHandoff.governanceClaimEligible).toBe(false);
      expect(dossier.verifiedHandoff.outcome).toBe("NEEDS_REVIEW");
      expect(dossier.review.outcome).toBe("needs_review");
    });
  });

  it("preserves verifier failure diagnostics without governed success", { timeout: 20_000 }, async () => {
    await withRunsAndWorkspace(async ({ runsRoot, workspaceRoot }) => {
      const attemptId = "attempt_loop_mcp_verifier_failure";
      const loop = await persistSignedDossierFixture({
        runsRoot,
        workspaceRoot,
        loopId: "loop_mcp_verifier_failure",
        verificationPayload: {
          attemptId,
          attemptIndex: 1,
          passed: false,
          summary: "Regression verifier failed with exit code 1.",
          steps: [
            {
              command: "pnpm test",
              launched: true,
              completed: true,
              crashed: false,
              exitCode: 1,
              timedOut: false
            }
          ],
          binding: {
            runId: "loop_mcp_verifier_failure",
            workspaceId: "ws_dossier_truth",
            attemptId,
            cwd: workspaceRoot,
            runsRoot,
            commands: ["pnpm test"]
          },
          changedFiles: ["src/kept.ts"]
        }
      });

      const dossier = await martinRunDossierTool({ loopId: loop.loopId, runsDir: runsRoot });

      expect(dossier.verification.status).toBe("failed");
      expect(dossier.verification.summary).toBe("Regression verifier failed with exit code 1.");
      expect(dossier.verifiedHandoff.verification.status).toBe("FAILED");
      expect(dossier.verifiedHandoff.verification.checks[0]).toMatchObject({ exitCode: 1, status: "FAILED" });
      expect(dossier.verifiedHandoff.outcome).toBe("NEEDS_REVIEW");
      expect(dossier.review.outcome).toBe("needs_review");
    });
  });

  it("keeps denied-path touches as reverted evidence and stops the run", { timeout: 20_000 }, async () => {
    await withRunsAndWorkspace(async ({ runsRoot, workspaceRoot }) => {
      const loop = await persistSignedDossierFixture({
        runsRoot,
        workspaceRoot,
        loopId: "loop_mcp_denied_path",
        terminationEnvelope: {
          schemaVersion: "termination/1",
          class: "guard_stop",
          guard: {
            reasonCode: "surface_write_not_allowed",
            reason: "Denied path apps/leak.ts was restored.",
            failureClass: "safety_leash_blocked",
            safetySurface: "filesystem"
          }
        },
        fileEffects: {
          observationStatus: "observed",
          touchedDuringExecution: ["apps/leak.ts"],
          netChangedAtCompletion: [],
          revertedBeforeCompletion: ["apps/leak.ts"]
        }
      });

      const dossier = await martinRunDossierTool({ loopId: loop.loopId, runsDir: runsRoot });

      expect(dossier.verifiedHandoff.outcome).toBe("STOPPED");
      expect(dossier.verifiedHandoff.lifecycleTruth.reasonCode).toBe("surface_write_not_allowed");
      expect(dossier.verifiedHandoff.lifecycleTruth.reason).toContain("apps/leak.ts");
      expect(dossier.verifiedHandoff.fileEffects.touchedDuringExecution).toEqual(["apps/leak.ts"]);
      expect(dossier.verifiedHandoff.fileEffects.revertedBeforeCompletion).toEqual(["apps/leak.ts"]);
      expect(dossier.verifiedHandoff.fileEffects.netChangedAtCompletion).toEqual([]);
    });
  });

  it("keeps mutation-required observed no-edit runs in review", { timeout: 20_000 }, async () => {
    await withRunsAndWorkspace(async ({ runsRoot, workspaceRoot }) => {
      const loop = await persistSignedDossierFixture({
        runsRoot,
        workspaceRoot,
        loopId: "loop_mcp_no_edit",
        fileEffects: {
          observationStatus: "observed",
          touchedDuringExecution: [],
          netChangedAtCompletion: [],
          revertedBeforeCompletion: []
        },
        verificationPayload: {
          attemptId: "attempt_loop_mcp_no_edit",
          attemptIndex: 1,
          passed: true,
          summary: "Verifier passed but no edit persisted.",
          steps: [
            {
              command: "pnpm test",
              launched: true,
              completed: true,
              crashed: false,
              exitCode: 0,
              timedOut: false
            }
          ],
          binding: {
            runId: "loop_mcp_no_edit",
            workspaceId: "ws_dossier_truth",
            attemptId: "attempt_loop_mcp_no_edit",
            cwd: workspaceRoot,
            runsRoot,
            commands: ["pnpm test"]
          },
          changedFiles: []
        }
      });

      const dossier = await martinRunDossierTool({ loopId: loop.loopId, runsDir: runsRoot });

      expect(dossier.verification.status).toBe("passed");
      expect(dossier.verifiedHandoff.fileEffects.observationStatus).toBe("observed");
      expect(dossier.verifiedHandoff.scope.changedFiles).toEqual([]);
      expect(dossier.verifiedHandoff.outcome).toBe("NEEDS_REVIEW");
      expect(dossier.review.outcome).toBe("needs_review");
    });
  });

  it("keeps turn-cap and reverted-file diagnostics separate from verifier success", { timeout: 20_000 }, async () => {
    await withRunsAndWorkspace(async ({ runsRoot, workspaceRoot }) => {
      const turnCap = operationalExit("turn_cap");
      turnCap.exit.matches[0]!.evidence = { iterationsUsed: 1, maxIterations: 1 };
      const loop = await persistSignedDossierFixture({
        runsRoot,
        workspaceRoot,
        loopId: "loop_mcp_turn_cap",
        terminationEnvelope: turnCap
      });

      const dossier = await martinRunDossierTool({ loopId: loop.loopId, runsDir: runsRoot, format: "md" });

      expect(dossier.verification.status).toBe("passed");
      expect(dossier.verifiedHandoff.outcome).toBe("STOPPED");
      expect(dossier.verifiedHandoff.lifecycleTruth.reasonCode).toBe("turn_cap");
      expect(dossier.verifiedHandoff.lifecycleTruth.exhaustedLimits).toEqual(["iterations"]);
      expect(dossier.verifiedHandoff.fileEffects.revertedBeforeCompletion).toEqual(["src/reverted.ts"]);
      expect(dossier.review.outcome).toBe("failed");
      expect(dossier.review.nextAction).toContain("stopped");
      expect(dossier.rendered).toContain("| Termination Reason | turn cap: Persisted turn_cap reason. |");
      expect(dossier.rendered).toContain("| Exhausted Limits | iterations |");
      expect(dossier.rendered).toContain("| Reverted Before Completion | src/reverted.ts |");
    });
  });

  it("uses the trusted workspace root when a run record omits repoRoot", { timeout: 20_000 }, async () => {
    await withRunsAndWorkspace(async ({ runsRoot, workspaceRoot }) => {
      const loop = createLoopRecord({
        loopId: "loop_workspace_fallback",
        workspaceId: "ws_test",
        projectId: "proj_test",
        task: {
          title: "Inspect dossier workspace boundary",
          objective: "Review the latest public trust lane",
          allowedPaths: ["**"],
          verificationPlan: ["pnpm test"]
        },
        budget: {
          maxUsd: 5,
          softLimitUsd: 3,
          maxIterations: 2,
          maxTokens: 2000
        },
        cost: {
          actualUsd: 1.25,
          avoidedUsd: 0,
          tokensIn: 100,
          tokensOut: 50,
          provenance: "calculated"
        }
      });

      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");

      const dossier = await martinRunDossierTool({
        loopId: loop.loopId,
        runsDir: runsRoot
      });

      expect(dossier.review.risk.reasons).not.toContain(
        "Wide edit scope overlaps with sensitive repo areas."
      );
      expect(dossier.evaluation.warnings).not.toContain(
        "Wide edit scope overlaps with sensitive repo areas."
      );
      expect(dossier.inspection.runsRoot).toBe(runsRoot);
      expect(dossier.cost.provenance).toBe("calculated");
      expect(workspaceRoot).not.toBe(process.cwd());
    });
  });

  it("surfaces terminationEnvelope from a persisted loop record with wall_clock exit", { timeout: 20_000 }, async () => {
    await withRunsAndWorkspace(async ({ runsRoot }) => {
      const envelope: TerminationEnvelopeV1 = {
        schemaVersion: "termination/1",
        class: "operational_exit",
        exit: {
          schemaVersion: "exit_evaluation/1",
          policyVersion: "exit_policy/1",
          shouldExit: true,
          primary: "wall_clock",
          matched: ["wall_clock"],
          phase: "attempt_completed",
          evaluatedAt: "2026-07-30T00:00:00.000Z",
          matches: [
            {
              kind: "wall_clock",
              fired: true,
              reason: "Wall-clock limit reached (3600s).",
              evidence: {}
            }
          ]
        }
      };

      const loop = createLoopRecord({
        workspaceId: "ws_d5_mcp",
        projectId: "proj_d5_mcp",
        task: {
          title: "D5 MCP surface proof",
          objective: "Prove terminationEnvelope survives through MCP dossier tool.",
          verificationPlan: ["vitest run"]
        },
        terminationEnvelope: envelope
      });

      // Stamp the lifecycle state to match a wall_clock exit
      const terminatedLoop = {
        ...loop,
        status: "exited" as const,
        lifecycleState: "wall_clock" as const
      };

      await mkdir(join(runsRoot, terminatedLoop.loopId), { recursive: true });
      await writeFile(
        join(runsRoot, terminatedLoop.loopId, "loop-record.json"),
        JSON.stringify(terminatedLoop),
        "utf8"
      );

      const dossier = await martinRunDossierTool({
        loopId: terminatedLoop.loopId,
        runsDir: runsRoot
      });

      // MCP surface proof: termination identity must be present and correct
      expect(dossier.terminationEnvelope).toBeDefined();
      expect(dossier.terminationEnvelope?.class).toBe("operational_exit");
      expect(dossier.terminationEnvelope?.exit.primary).toBe("wall_clock");
      expect(dossier.loop.lifecycleState).toBe("wall_clock");
      expect(dossier.loop.loopId).toBe(terminatedLoop.loopId);
    });
  });
});
