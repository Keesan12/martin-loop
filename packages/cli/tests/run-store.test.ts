import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLoopRecord,
  type ExitKind,
  type LoopRecord,
  type TerminationEnvelopeV1,
} from "@martin/contracts";
import { describe, expect, it } from "vitest";

import {
  buildRunDossier,
  buildRunReceipt,
  buildVerifiedHandoffFromPersistedLoop,
  buildVerificationSummary,
  deriveLoopExecutionBoundary,
  findPersistedLoopEvidence,
  resolveCliEnvironment,
} from "../src/run-store.js";

type OperationalTerminationEnvelope = Extract<
  TerminationEnvelopeV1,
  { class: "operational_exit" }
>;

function makeTerminationEnvelope(
  primary: ExitKind,
  evidence: Record<string, unknown> = {},
): OperationalTerminationEnvelope {
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
      evaluatedAt: "2026-10-09T20:30:00.000Z",
      matches: [{ kind: primary, reason: `Persisted ${primary} reason.`, evidence }],
    },
  };
}

function makeLoopRecord(overrides: Partial<LoopRecord> = {}): LoopRecord {
  const loop = createLoopRecord({
    workspaceId: "ws_run_store",
    projectId: "proj_run_store",
    task: {
      title: "Repair verifier evidence handling",
      objective: "Repair verifier evidence handling",
      verificationPlan: ["npm test"],
    },
    budget: {
      maxUsd: 10,
      softLimitUsd: 6,
      maxIterations: 3,
      maxTokens: 10000,
    },
    cost: {
      actualUsd: 1,
      avoidedUsd: 0,
      tokensIn: 100,
      tokensOut: 50,
    },
  });

  return {
    ...loop,
    status: "completed" as const,
    lifecycleState: "completed" as const,
    attempts: [],
    events: [],
    ...overrides,
  };
}

function makeLifecycleTruthLoop(overrides: Partial<LoopRecord> = {}): LoopRecord {
  const loopId = overrides.loopId ?? "loop_cli_lifecycle_truth";
  const workspaceId = overrides.workspaceId ?? "ws_run_store";
  const attemptId = "attempt_lifecycle_truth";
  const verificationPlan = ["npm test"];
  const fileEffects = {
    observationStatus: "observed",
    touchedDuringExecution: ["src/kept.ts", "src/reverted.ts"],
    netChangedAtCompletion: ["src/kept.ts"],
    revertedBeforeCompletion: ["src/reverted.ts"],
  } as const;

  return makeLoopRecord({
    loopId,
    workspaceId,
    status: "completed",
    lifecycleState: "completed",
    task: {
      title: "Reconcile lifecycle truth",
      objective: "Reconcile lifecycle truth",
      repoRoot: "C:\\repo",
      verificationPlan,
      mutationMode: "edit",
    },
    receiptScope: {
      workingDirectory: "C:\\repo",
      runsRoot: "C:\\runs",
    },
    terminationEnvelope: makeTerminationEnvelope("goal_met", { verifierScore: 1 }),
    attempts: [{
      attemptId,
      index: 1,
      adapterId: "agent-cli:codex",
      model: "gpt-5.4",
      startedAt: "2026-10-09T20:29:00.000Z",
      completedAt: "2026-10-09T20:30:00.000Z",
    }],
    events: [
      {
        eventId: "evt_lifecycle_verified",
        timestamp: "2026-10-09T20:30:00.000Z",
        type: "verification.completed",
        lifecycleState: "verifying",
        payload: {
          passed: true,
          attemptIndex: 1,
          summary: "Verifier passed.",
          changedFiles: ["src/kept.ts"],
          binding: {
            runId: loopId,
            workspaceId,
            attemptId,
            cwd: "C:\\repo",
            runsRoot: "C:\\runs",
            commands: verificationPlan,
          },
          steps: [{
            command: "npm test",
            launched: true,
            completed: true,
            crashed: false,
            exitCode: 0,
            timedOut: false,
          }],
        },
      },
      {
        eventId: "evt_lifecycle_completed",
        timestamp: "2026-10-09T20:30:01.000Z",
        type: "run.completed",
        lifecycleState: "completed",
        payload: { reason: "goal_met", fileEffects },
      },
    ],
    ...overrides,
  });
}

function makePersistedDetail(
  loop: LoopRecord,
  integrity: { state: "verified" | "tamper_detected" } = { state: "verified" },
) {
  return {
    source: "canonical",
    runsRoot: "C:\\runs",
    loop: { ...loop, receiptIntegrity: integrity },
    warnings: [],
    integrity,
  };
}

describe("resolveCliEnvironment", () => {
  it("preserves the openai engine selection", () => {
    const environment = resolveCliEnvironment({ engine: "openai" });

    expect(environment.engine).toBe("openai");
  });

  it("respects MARTIN_LIVE=false by defaulting to proof mode", () => {
    const environment = resolveCliEnvironment({ env: { ...process.env, MARTIN_LIVE: "false" } });

    expect(environment.liveMode).toBe("proof");
  });

  it("honors explicit proof mode without requiring environment mutation", () => {
    const environment = resolveCliEnvironment({ liveMode: "proof" });

    expect(environment.liveMode).toBe("proof");
  });
});

describe("buildVerificationSummary", () => {
  it("treats malformed verification payloads as failed evidence instead of throwing", () => {
    const loop = makeLoopRecord({
      events: [
        {
          eventId: "evt_malformed",
          timestamp: "2026-06-06T20:00:00.000Z",
          type: "verification.completed",
          lifecycleState: "verifying",
          payload: null as unknown as Record<string, unknown>,
        },
      ],
    });

    expect(() => buildVerificationSummary(loop)).not.toThrow();
    expect(buildVerificationSummary(loop)).toMatchObject({
      status: "failed",
      eventCount: 1,
      steps: [],
      warnings: [],
    });
  });

  it("preserves external outcome evidence and the full verifier binding in persisted summaries", () => {
    const evidence = {
      kind: "external_outcome" as const,
      contractId: "booking-save",
      sha256: "a".repeat(64),
      path: "external-outcomes/booking-save.json",
    };
    const loop = makeLoopRecord({
      loopId: "loop_outcome_receipt",
      workspaceId: "workspace_outcome_receipt",
      task: {
        title: "Submit staging form",
        objective: "Submit staging form",
        repoRoot: "C:\\repo",
        verificationPlan: ["martin outcomes verify --contract trusted.json --json"],
        executionProfile: "staging_controlled",
        allowedNetworkDomains: ["staging.example.com"],
      },
      receiptScope: {
        workingDirectory: "C:\\repo",
        runsRoot: "C:\\runs",
      },
      attempts: [{
        attemptId: "attempt_outcome_1",
        index: 1,
        adapterId: "agent-cli:claude",
        model: "claude-sonnet-5-5",
        startedAt: "2026-10-05T18:00:00.000Z",
      }],
      events: [{
        eventId: "evt_outcome_verification",
        timestamp: "2026-10-05T18:01:00.000Z",
        type: "verification.completed",
        lifecycleState: "verifying",
        payload: {
          passed: true,
          attemptIndex: 1,
          binding: {
            runId: "loop_outcome_receipt",
            workspaceId: "workspace_outcome_receipt",
            attemptId: "attempt_outcome_1",
            cwd: "C:\\repo",
            runsRoot: "C:\\runs",
            executionProfile: "staging_controlled",
            allowedNetworkDomains: ["staging.example.com"],
            commands: ["martin outcomes verify --contract trusted.json --json"],
          },
          steps: [{
            command: "martin outcomes verify --contract trusted.json --json",
            launched: true,
            completed: true,
            crashed: false,
            exitCode: 0,
            timedOut: false,
            fastFail: true,
            evidence,
          }],
        },
      }],
    });

    const summary = buildVerificationSummary(loop);
    expect(summary.status).toBe("passed");
    expect(summary.binding).toMatchObject({
      runsRoot: "C:\\runs",
      executionProfile: "staging_controlled",
      allowedNetworkDomains: ["staging.example.com"],
    });
    expect(summary.steps[0]?.evidence).toEqual(evidence);
  });

  it("does not contradict a verifier-passed Windows run only because persisted path spelling differs", () => {
    const loop = makeLoopRecord({
      loopId: "loop_windows_binding",
      workspaceId: "workspace_windows_binding",
      task: {
        title: "Verify Windows binding",
        objective: "Verify Windows binding",
        repoRoot: "C:\\Repo\\Work",
        verificationPlan: ["npm test"],
      },
      receiptScope: {
        workingDirectory: "C:\\Repo\\Work",
        runsRoot: "C:\\Temp\\Martin-Runs",
      },
      attempts: [{
        attemptId: "attempt_windows_1",
        index: 1,
        adapterId: "agent-cli:codex",
        model: "gpt-5.4",
        startedAt: "2026-10-24T12:00:00.000Z",
      }],
      events: [{
        eventId: "evt_windows_verification",
        timestamp: "2026-10-24T12:01:00.000Z",
        type: "verification.completed",
        lifecycleState: "completed",
        payload: {
          passed: true,
          attemptIndex: 1,
          summary: "Verifier passed.",
          binding: {
            runId: "loop_windows_binding",
            workspaceId: "workspace_windows_binding",
            attemptId: "attempt_windows_1",
            cwd: "c:/repo/work/.",
            runsRoot: "c:/temp/martin-runs",
            commands: ["npm test"],
          },
          steps: [{
            command: "npm test",
            launched: true,
            completed: true,
            crashed: false,
            exitCode: 0,
            timedOut: false,
          }],
        },
      }],
    });

    expect(buildVerificationSummary(loop)).toMatchObject({
      status: "passed",
      summary: "Verifier passed.",
    });
  });

  it("does not invent timedOut or fastFail fields when persisted evidence omits them", () => {
    const loop = makeLoopRecord({
      events: [
        {
          eventId: "evt_sparse_step",
          timestamp: "2026-06-06T20:05:00.000Z",
          type: "verification.completed",
          lifecycleState: "verifying",
          payload: {
            passed: true,
            steps: [{ command: "npm test", launched: true }],
          },
        },
      ],
    });

    expect(buildVerificationSummary(loop).steps).toEqual([{ command: "npm test", launched: true }]);
  });
});

describe("buildVerifiedHandoffFromPersistedLoop", () => {
  it("preserves successful verifier lifecycle evidence for a budget-stopped governed run", () => {
    const loop = makeLoopRecord({
      loopId: "loop_ntaopvdc_shape",
      status: "exited",
      lifecycleState: "budget_exit",
      task: {
        title: "Prove the governed handoff",
        objective: "Prove the governed handoff",
        repoRoot: "C:\\repo",
        verificationPlan: ["npm test"],
      },
      metadata: {
        executionMode: "governed",
        governanceClaimEligible: "true",
      },
      attempts: [
        {
          attemptId: "attempt_real",
          index: 1,
          adapterId: "agent-cli:codex",
          model: "gpt-5.4",
          startedAt: "2026-09-06T11:59:00.000Z",
        },
      ],
      events: [
        {
          eventId: "evt_verified",
          timestamp: "2026-09-06T12:00:00.000Z",
          type: "verification.completed",
          lifecycleState: "verifying",
          payload: {
            passed: true,
            summary: "Verifier passed.",
            binding: {
              runId: "loop_ntaopvdc_shape",
              attemptId: "attempt_real",
              workspaceId: "ws_run_store",
              cwd: "C:\\repo",
              commands: ["npm test"],
            },
            steps: [
              {
                command: "npm test",
                launched: true,
                completed: true,
                crashed: false,
                exitCode: 0,
                output: "tests passed",
              },
            ],
          },
        },
        {
          eventId: "evt_exited",
          timestamp: "2026-09-06T12:00:01.000Z",
          type: "run.completed",
          lifecycleState: "budget_exit",
          payload: { reason: "budget_cap" },
        },
      ],
    });

    const handoff = buildVerifiedHandoffFromPersistedLoop({
      source: "canonical",
      runsRoot: "C:\\runs",
      loop,
      warnings: [],
      integrity: { state: "verified" },
    });

    expect(handoff.outcome).toBe("STOPPED");
    expect(handoff.governanceClaimEligible).toBe(true);
    expect(handoff.verification.status).toBe("PASSED");
    expect(handoff.verification.checks).toEqual([
      expect.objectContaining({ command: "npm test", status: "PASSED", exitCode: 0 }),
    ]);
  });

  it("exposes identical lifecycle truth and file effects through dossier and receipt", () => {
    const loop = makeLifecycleTruthLoop();
    const dossier = buildRunDossier(makePersistedDetail(loop));
    const handoff = dossier["verifiedHandoff"] as ReturnType<
      typeof buildVerifiedHandoffFromPersistedLoop
    >;
    const receipt = dossier["receipt"] as Record<string, unknown>;

    expect(handoff).toMatchObject({
      outcome: "VERIFIED",
      verification: { status: "PASSED" },
      receiptIntegrity: { state: "verified" },
      lifecycleTruth: {
        reasonCode: "goal_met",
        exhaustedLimits: [],
      },
      fileEffects: {
        observationStatus: "observed",
        touchedDuringExecution: ["src/kept.ts", "src/reverted.ts"],
        netChangedAtCompletion: ["src/kept.ts"],
        revertedBeforeCompletion: ["src/reverted.ts"],
      },
    });
    expect(receipt).toMatchObject({
      outcome: handoff.outcome,
      lifecycleTruth: handoff.lifecycleTruth,
      fileEffects: handoff.fileEffects,
    });
  });

  it("preserves reverted and observed no-edit file effects without conflating them", () => {
    const reverted = buildVerifiedHandoffFromPersistedLoop(
      makePersistedDetail(makeLifecycleTruthLoop()),
    );
    const noEditLoop = makeLifecycleTruthLoop({
      loopId: "loop_cli_observed_no_edit",
      task: {
        title: "Observe a pre-satisfied task",
        objective: "Observe a pre-satisfied task",
        repoRoot: "C:\\repo",
        verificationPlan: ["npm test"],
        mutationMode: "edit",
        definitionOfDonePreSatisfied: true,
      },
      events: makeLifecycleTruthLoop().events.map((event) =>
        event.type === "run.completed"
          ? {
              ...event,
              payload: {
                ...event.payload,
                fileEffects: {
                  observationStatus: "observed",
                  touchedDuringExecution: [],
                  netChangedAtCompletion: [],
                  revertedBeforeCompletion: [],
                },
              },
            }
          : {
              ...event,
              payload: {
                ...event.payload,
                binding: {
                  ...(event.payload["binding"] as Record<string, unknown>),
                  runId: "loop_cli_observed_no_edit",
                },
                changedFiles: [],
              },
            },
      ),
    });
    const noEdit = buildVerifiedHandoffFromPersistedLoop(makePersistedDetail(noEditLoop));

    expect(reverted.fileEffects).toMatchObject({
      touchedDuringExecution: ["src/kept.ts", "src/reverted.ts"],
      netChangedAtCompletion: ["src/kept.ts"],
      revertedBeforeCompletion: ["src/reverted.ts"],
    });
    expect(noEdit.fileEffects).toEqual({
      observationStatus: "observed",
      touchedDuringExecution: [],
      netChangedAtCompletion: [],
      revertedBeforeCompletion: [],
    });
  });

  it("describes turn-cap lifecycle truth only as iteration exhaustion", () => {
    const base = makeLifecycleTruthLoop();
    const loop = makeLifecycleTruthLoop({
      status: "exited",
      lifecycleState: "budget_exit",
      budget: { ...base.budget, maxIterations: 1 },
      terminationEnvelope: makeTerminationEnvelope("turn_cap", {
        turnsUsed: 1,
        maxTurns: 1,
      }),
      events: base.events.map((event) =>
        event.type === "run.completed"
          ? {
              ...event,
              lifecycleState: "budget_exit",
              payload: { ...event.payload, reason: "turn_cap" },
            }
          : event,
      ),
    });
    const handoff = buildVerifiedHandoffFromPersistedLoop(makePersistedDetail(loop));
    const receipt = buildRunReceipt(loop, buildVerificationSummary(loop), loop.receiptScope, handoff);
    const rendered = JSON.stringify(receipt);

    expect(handoff).toMatchObject({
      outcome: "STOPPED",
      lifecycleTruth: {
        reasonCode: "turn_cap",
        exhaustedLimits: ["iterations"],
      },
    });
    expect(rendered).toMatch(/iteration limit/iu);
    expect(rendered).not.toMatch(/dollar pressure|token pressure|uneconomical/iu);
  });

  it.each([
    {
      label: "verifier-failed",
      loop: () => {
        const base = makeLifecycleTruthLoop();
        return makeLifecycleTruthLoop({
          events: base.events.map((event) =>
            event.type === "verification.completed"
              ? {
                  ...event,
                  payload: {
                    ...event.payload,
                    passed: false,
                    summary: "Verifier failed.",
                    steps: [{
                      command: "npm test",
                      launched: true,
                      completed: true,
                      crashed: false,
                      exitCode: 1,
                    }],
                  },
                }
              : event,
          ),
        });
      },
      integrity: { state: "verified" as const },
    },
    {
      label: "denied",
      loop: () => makeLifecycleTruthLoop({
        status: "exited",
        lifecycleState: "human_escalation",
        terminationEnvelope: {
          schemaVersion: "termination/1",
          class: "guard_stop",
          guard: { reasonCode: "filesystem_policy_block", reason: "Denied path was restored." },
        },
      }),
      integrity: { state: "verified" as const },
    },
    {
      label: "proof-only",
      loop: () => {
        const base = makeLifecycleTruthLoop();
        return makeLifecycleTruthLoop({
          attempts: [{ ...base.attempts[0]!, adapterId: "direct:verifier:verify-only" }],
        });
      },
      integrity: { state: "verified" as const },
    },
    {
      label: "tampered",
      loop: () => makeLifecycleTruthLoop(),
      integrity: { state: "tamper_detected" as const },
    },
    {
      label: "forged-success",
      loop: () => makeLifecycleTruthLoop({ terminationEnvelope: undefined }),
      integrity: { state: "verified" as const },
    },
  ])("fails closed for $label lifecycle truth", ({ loop, integrity }) => {
    const dossier = buildRunDossier(makePersistedDetail(loop(), integrity));
    const handoff = dossier["verifiedHandoff"] as ReturnType<
      typeof buildVerifiedHandoffFromPersistedLoop
    >;
    const receipt = dossier["receipt"] as Record<string, unknown>;

    expect(handoff.outcome).not.toBe("VERIFIED");
    expect(receipt["outcome"]).toBe(handoff.outcome);
    if (handoff.outcome !== "VERIFIED") {
      expect(JSON.stringify({ handoff, receipt })).not.toContain('"outcome":"VERIFIED"');
    }
  });

  it("keeps legacy missing lifecycle and file-effect evidence unavailable", () => {
    const legacy = makeLoopRecord({
      status: "completed",
      lifecycleState: "completed",
      terminationEnvelope: undefined,
    });
    const handoff = buildVerifiedHandoffFromPersistedLoop(makePersistedDetail(legacy));

    expect(handoff.outcome).toBe("NEEDS_REVIEW");
    expect(handoff.lifecycleTruth).toMatchObject({ evidenceAvailable: false, exhaustedLimits: [] });
    expect(handoff.fileEffects).toMatchObject({ observationStatus: "unavailable" });
  });

  it("fails malformed observed file-effect evidence closed as unavailable", () => {
    const base = makeLifecycleTruthLoop();
    const malformed = makeLifecycleTruthLoop({
      events: base.events.map((event) =>
        event.type === "run.completed"
          ? {
              ...event,
              payload: {
                ...event.payload,
                fileEffects: {
                  observationStatus: "observed",
                  touchedDuringExecution: ["src/a.ts"],
                },
              },
            }
          : event,
      ),
    });

    expect(buildVerifiedHandoffFromPersistedLoop(makePersistedDetail(malformed)).fileEffects)
      .toEqual({
        observationStatus: "unavailable",
        touchedDuringExecution: [],
        netChangedAtCompletion: [],
        revertedBeforeCompletion: [],
        observationReason: "Persisted file-effect evidence was malformed or incomplete.",
      });
  });
});

describe("deriveLoopExecutionBoundary", () => {
  it("rejects legacy direct stub evidence even when metadata claims governed", () => {
    const loop = makeLoopRecord({
      metadata: {
        executionMode: "governed",
        governanceClaimEligible: "true",
      },
      attempts: [
        {
          attemptId: "attempt_stub",
          index: 1,
          adapterId: "direct:stub:stub",
          model: "stub",
          startedAt: "2026-08-18T00:00:00.000Z",
        },
      ],
    });

    expect(deriveLoopExecutionBoundary(loop)).toEqual({
      executionMode: "simulated",
      governanceClaimEligible: false,
    });
  });

  it("does not infer simulation from zero cost", () => {
    const loop = makeLoopRecord({
      cost: { actualUsd: 0, avoidedUsd: 0, tokensIn: 0, tokensOut: 0 },
      attempts: [
        {
          attemptId: "attempt_real",
          index: 1,
          adapterId: "agent-cli:codex",
          model: "gpt-5.4",
          startedAt: "2026-08-18T00:00:00.000Z",
        },
      ],
    });

    expect(deriveLoopExecutionBoundary(loop)).toEqual({
      executionMode: "governed",
      governanceClaimEligible: true,
    });
  });
});

describe("findPersistedLoopEvidence", () => {
  async function withRunsRoot<T>(fn: (runsRoot: string) => Promise<T>): Promise<T> {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-run-store-"));
    try {
      return await fn(runsRoot);
    } finally {
      await rm(runsRoot, { force: true, recursive: true }).catch(() => {});
    }
  }

  it("ignores invalid timestamps in workspace indexes when choosing the latest run", async () => {
    await withRunsRoot(async (runsRoot) => {
      const invalidLoop = makeLoopRecord({
        loopId: "aaa_invalid",
        updatedAt: "not-a-date",
      });
      const validLoop = makeLoopRecord({
        loopId: "zzz_valid",
        updatedAt: "2026-06-06T20:10:00.000Z",
      });

      for (const loop of [invalidLoop, validLoop]) {
        const loopDir = join(runsRoot, loop.loopId);
        await mkdir(loopDir, { recursive: true });
        await writeFile(join(loopDir, "loop-record.json"), JSON.stringify(loop), "utf8");
      }

      await writeFile(
        join(runsRoot, "workspace-a.jsonl"),
        `${JSON.stringify({ loopId: invalidLoop.loopId, updatedAt: "not-a-date" })}\n`,
        "utf8",
      );
      await writeFile(
        join(runsRoot, "workspace-b.jsonl"),
        `${JSON.stringify({ loopId: validLoop.loopId, updatedAt: validLoop.updatedAt })}\n`,
        "utf8",
      );

      await expect(findPersistedLoopEvidence(runsRoot)).resolves.toMatchObject({
        runsRoot,
        loop: expect.objectContaining({ loopId: validLoop.loopId }),
      });
    });
  });

  it("ignores invalid loop timestamps during directory fallback scanning", async () => {
    await withRunsRoot(async (runsRoot) => {
      const invalidLoop = makeLoopRecord({
        loopId: "aaa_invalid",
        updatedAt: "not-a-date",
      });
      const validLoop = makeLoopRecord({
        loopId: "zzz_valid",
        updatedAt: "2026-06-06T20:15:00.000Z",
      });

      for (const loop of [invalidLoop, validLoop]) {
        const loopDir = join(runsRoot, loop.loopId);
        await mkdir(loopDir, { recursive: true });
        await writeFile(join(loopDir, "loop-record.json"), JSON.stringify(loop), "utf8");
      }

      await expect(findPersistedLoopEvidence(runsRoot)).resolves.toMatchObject({
        runsRoot,
        loop: expect.objectContaining({ loopId: validLoop.loopId }),
      });
    });
  });

  it("shared runs-dir cannot cross-satisfy workspace evidence", async () => {
    await withRunsRoot(async (runsRoot) => {
      const workspaceA = makeLoopRecord({
        loopId: "loop_workspace_a",
        workspaceId: "workspace-A",
        updatedAt: "2026-06-06T20:20:00.000Z",
      });
      const workspaceB = makeLoopRecord({
        loopId: "loop_workspace_b",
        workspaceId: "workspace-B",
        updatedAt: "2026-06-06T20:19:00.000Z",
      });

      for (const loop of [workspaceA, workspaceB]) {
        const loopDir = join(runsRoot, loop.loopId);
        await mkdir(loopDir, { recursive: true });
        await writeFile(join(loopDir, "loop-record.json"), JSON.stringify(loop), "utf8");
      }

      await expect(
        findPersistedLoopEvidence(runsRoot, { workspaceId: "workspace-B" })
      ).resolves.toMatchObject({ loop: expect.objectContaining({ loopId: workspaceB.loopId }) });

      await expect(
        findPersistedLoopEvidence(runsRoot, { workspaceId: "workspace-C" })
      ).resolves.not.toHaveProperty("loop");
    });
  });

  it("implicit default storage does not globally scan legacy records for workspace evidence", async () => {
    await withRunsRoot(async (runsRoot) => {
      const previousRunsRoot = process.env["MARTIN_RUNS_DIR"];
      process.env["MARTIN_RUNS_DIR"] = runsRoot;
      const workspaceA = makeLoopRecord({
        loopId: "loop_default_workspace_a",
        workspaceId: "workspace-A",
        updatedAt: "2026-06-06T20:20:00.000Z",
      });
      const loopDir = join(runsRoot, workspaceA.loopId);
      await mkdir(loopDir, { recursive: true });
      await writeFile(join(loopDir, "loop-record.json"), JSON.stringify(workspaceA), "utf8");

      try {
        await expect(
          findPersistedLoopEvidence(undefined, { workspaceId: "workspace-A" })
        ).resolves.toMatchObject({ runsRoot, loop: undefined });
      } finally {
        if (previousRunsRoot === undefined) delete process.env["MARTIN_RUNS_DIR"];
        else process.env["MARTIN_RUNS_DIR"] = previousRunsRoot;
      }
    });
  });
});
