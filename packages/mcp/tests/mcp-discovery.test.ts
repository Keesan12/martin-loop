import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLoopRecord, type LoopEventDraft } from "@martin/contracts";
import { describe, expect, it } from "vitest";

import {
  listMartinPrompts,
  getMartinPrompt
} from "../src/prompts.js";
import {
  listMartinResources,
  listMartinResourceTemplates,
  MARTIN_STATIC_RESOURCE_URIS,
  readMartinResource
} from "../src/resources.js";

function makeLoopRecord() {
  const base = createLoopRecord({
    workspaceId: "ws_test",
    projectId: "proj_test",
    task: {
      title: "Repair discovery lane",
      objective: "Add MCP resources and prompts",
      verificationPlan: ["pnpm --filter @martinloop/mcp test"]
    },
    budget: {
      maxUsd: 12,
      softLimitUsd: 8,
      maxIterations: 4,
      maxTokens: 12_000
    },
    cost: {
      actualUsd: 4.25,
      avoidedUsd: 0.75,
      tokensIn: 900,
      tokensOut: 450
    }
  });

  const attemptId = "att_001";
  const events: LoopEventDraft[] = [
    {
      type: "run.started",
      lifecycleState: "running",
      payload: {
        adapterId: "codex-cli",
        providerId: "openai",
        model: "gpt-5-codex"
      }
    },
    {
      type: "verification.completed",
      lifecycleState: "verifying",
      payload: {
        attemptId,
        passed: false,
        summary: "Targeted MCP tests still fail because discovery handlers are missing."
      }
    }
  ];

  return {
    ...base,
    status: "failed",
    lifecycleState: "diminishing_returns",
    updatedAt: "2026-05-15T23:15:00.000Z",
    attempts: [
      {
        attemptId,
        index: 1,
        adapterId: "codex-cli",
        model: "gpt-5-codex",
        startedAt: "2026-05-15T23:00:00.000Z",
        completedAt: "2026-05-15T23:10:00.000Z",
        summary: "Added discovery helpers but server wiring is still pending.",
        failureClass: "verification_failure",
        intervention: "run_verifier"
      }
    ],
    events: events.map((event, index) => ({
      eventId: `evt_${index + 1}`,
      timestamp: `2026-05-15T23:0${index}:00.000Z`,
      ...event
    }))
  };
}

async function withRunsRoot<T>(fn: (runsRoot: string) => Promise<T>): Promise<T> {
  const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
  const runsRoot = await mkdtemp(join(tmpdir(), "martin-mcp-discovery-"));
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

describe("Martin MCP discovery resources", () => {
  it("lists the planned static resources and resource templates", () => {
    const listedResources = listMartinResources();
    const listedTemplates = listMartinResourceTemplates();

    expect(listedResources.resources.map((resource) => resource.uri)).toEqual([
      MARTIN_STATIC_RESOURCE_URIS.serverHealth,
      MARTIN_STATIC_RESOURCE_URIS.recentRuns,
      MARTIN_STATIC_RESOURCE_URIS.triage,
      MARTIN_STATIC_RESOURCE_URIS.latestSummary,
      MARTIN_STATIC_RESOURCE_URIS.latestProofCard,
      MARTIN_STATIC_RESOURCE_URIS.latestBudgetStatus,
      MARTIN_STATIC_RESOURCE_URIS.latestVerifierEvidence,
      MARTIN_STATIC_RESOURCE_URIS.latestRollbackEvidence,
      MARTIN_STATIC_RESOURCE_URIS.agentNextStep,
      MARTIN_STATIC_RESOURCE_URIS.mcpUsageGuide,
      MARTIN_STATIC_RESOURCE_URIS.agentStartGuide,
      MARTIN_STATIC_RESOURCE_URIS.publishReadinessGuide
    ]);
    expect(listedTemplates.resourceTemplates.map((template) => template.uriTemplate)).toEqual([
      "martin://runs/{loopId}",
      "martin://runs/{loopId}/attempts/{attemptIndex}",
      "martin://runs/{loopId}/verification"
    ]);
  });

  it("reads static guides, the recent-runs view, and triage output", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = {
        ...makeLoopRecord(),
        loopId: "loop_recent",
        updatedAt: "2026-05-16T00:00:00.000Z"
      };

      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");

      const guide = await readMartinResource({ uri: MARTIN_STATIC_RESOURCE_URIS.mcpUsageGuide, runsDir: runsRoot });
      const agentStart = await readMartinResource({ uri: MARTIN_STATIC_RESOURCE_URIS.agentStartGuide, runsDir: runsRoot });
      const recentRuns = await readMartinResource({ uri: MARTIN_STATIC_RESOURCE_URIS.recentRuns, runsDir: runsRoot });
      const triage = await readMartinResource({ uri: MARTIN_STATIC_RESOURCE_URIS.triage, runsDir: runsRoot });
      const latestSummary = await readMartinResource({ uri: MARTIN_STATIC_RESOURCE_URIS.latestSummary, runsDir: runsRoot });
      const latestProofCard = await readMartinResource({ uri: MARTIN_STATIC_RESOURCE_URIS.latestProofCard, runsDir: runsRoot });
      const budgetStatus = await readMartinResource({ uri: MARTIN_STATIC_RESOURCE_URIS.latestBudgetStatus, runsDir: runsRoot });
      const verifierEvidence = await readMartinResource({ uri: MARTIN_STATIC_RESOURCE_URIS.latestVerifierEvidence, runsDir: runsRoot });
      const rollbackEvidence = await readMartinResource({ uri: MARTIN_STATIC_RESOURCE_URIS.latestRollbackEvidence, runsDir: runsRoot });
      const nextStep = await readMartinResource({ uri: MARTIN_STATIC_RESOURCE_URIS.agentNextStep, runsDir: runsRoot });

      expect(guide.contents[0]?.text).toContain("martin_governed_coding_kickoff");
      expect(guide.contents[0]?.text).toContain("martin_start");
      expect(agentStart.contents[0]?.text).toContain("Install Profiles");
      expect(recentRuns.contents[0]?.text).toContain(`"${loop.loopId}"`);
      expect(recentRuns.contents[0]?.text).toContain("\"recentRuns\"");
      expect(triage.contents[0]?.text).toContain("\"findingCount\"");
      expect(triage.contents[0]?.text).toContain("\"verification_failed\"");
      expect(latestSummary.contents[0]?.text).toContain("\"kind\": \"latest-summary\"");
      expect(latestSummary.contents[0]?.text).toContain("\"whatMartinPrevented\"");
      expect(latestProofCard.contents[0]?.text).toContain("# Martin Proof Card");
      expect(latestProofCard.contents[0]?.text).toContain("Verifier: failed honestly");
      expect(budgetStatus.contents[0]?.text).toContain("\"kind\": \"budget-status\"");
      expect(verifierEvidence.contents[0]?.text).toContain("\"status\": \"failed\"");
      expect(rollbackEvidence.contents[0]?.text).toContain("\"kind\": \"rollback-evidence\"");
      expect(nextStep.contents[0]?.text).toContain("\"action\": \"debug_failed_run\"");
    });
  });

  it("degrades server health when an explicit runsDir is missing", async () => {
    await withRunsRoot(async (runsRoot) => {
      const missingRunsRoot = join(runsRoot, "missing");
      const health = await readMartinResource({
        uri: MARTIN_STATIC_RESOURCE_URIS.serverHealth,
        runsDir: missingRunsRoot
      });

      expect(health.contents[0]?.text).toContain("\"status\": \"degraded\"");
      expect(health.contents[0]?.text).toContain("\"exists\": false");
      expect(health.contents[0]?.text).toContain("Configured Martin runs root does not exist yet.");
    });
  });

  it("reads loop, attempt, and verification resources from persisted loop records", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = {
        ...makeLoopRecord(),
        loopId: "loop_debug"
      };

      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");

      const runResource = await readMartinResource({
        uri: `martin://runs/${loop.loopId}`,
        runsDir: runsRoot
      });
      const attemptResource = await readMartinResource({
        uri: `martin://runs/${loop.loopId}/attempts/1`,
        runsDir: runsRoot
      });
      const verificationResource = await readMartinResource({
        uri: `martin://runs/${loop.loopId}/verification`,
        runsDir: runsRoot
      });

      expect(runResource.contents[0]?.text).toContain("\"verificationCount\": 1");
      expect(runResource.contents[0]?.text).toContain("\"status\": \"failed\"");
      expect(attemptResource.contents[0]?.text).toContain("\"attemptIndex\": 1");
      expect(attemptResource.contents[0]?.text).toContain("\"passed\": false");
      expect(verificationResource.contents[0]?.text).toContain("\"latestVerification\"");
      expect(verificationResource.contents[0]?.text).toContain("\"summary\": \"Targeted MCP tests still fail because discovery handlers are missing.\"");
    });
  });

  it("falls back to ledger verification evidence for dynamic discovery resources", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = {
        ...makeLoopRecord(),
        loopId: "loop_ledger_resource",
        events: []
      };

      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");
      await writeFile(
        join(runsRoot, loop.loopId, "ledger.jsonl"),
        `${JSON.stringify({
          kind: "verification.completed",
          runId: loop.loopId,
          attemptIndex: 1,
          timestamp: "2026-05-16T00:05:00.000Z",
          payload: {
            passed: false,
            summary: "Ledger-backed verification failure."
          }
        })}\n`,
        "utf8"
      );

      const attemptResource = await readMartinResource({
        uri: `martin://runs/${loop.loopId}/attempts/1`,
        runsDir: runsRoot
      });
      const verificationResource = await readMartinResource({
        uri: `martin://runs/${loop.loopId}/verification`,
        runsDir: runsRoot
      });

      expect(attemptResource.contents[0]?.text).toContain("\"attemptIndex\": 1");
      expect(attemptResource.contents[0]?.text).toContain("\"passed\": false");
      expect(verificationResource.contents[0]?.text).toContain("\"verificationCount\": 1");
      expect(verificationResource.contents[0]?.text).toContain("\"summary\": \"Ledger-backed verification failure.\"");
    });
  });

  it("surfaces unreadable ledger evidence as a partial-data warning in dynamic resources", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = {
        ...makeLoopRecord(),
        loopId: "loop_malformed_ledger_resource"
      };

      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");
      await writeFile(join(runsRoot, loop.loopId, "ledger.jsonl"), "{not-json", "utf8");

      const verificationResource = await readMartinResource({
        uri: `martin://runs/${loop.loopId}/verification`,
        runsDir: runsRoot
      });

      expect(verificationResource.contents[0]?.text).toContain("\"latestVerification\"");
      expect(verificationResource.contents[0]?.text).toContain(
        "Verification ledger for 'loop_malformed_ledger_resource' is unreadable; ledger verification evidence is unavailable."
      );
      expect(verificationResource.contents[0]?.text).not.toContain("No verification.completed ledger events were found for this run.");
    });
  });

  it("loads dynamic run resources for loops discovered only from aggregate store files", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = {
        ...makeLoopRecord(),
        loopId: "loop_aggregate_only",
        updatedAt: "2026-05-16T00:10:00.000Z"
      };

      await writeFile(join(runsRoot, "aggregate.jsonl"), `${JSON.stringify(loop)}\n`, "utf8");

      const recentRuns = await readMartinResource({
        uri: MARTIN_STATIC_RESOURCE_URIS.recentRuns,
        runsDir: runsRoot
      });
      const runResource = await readMartinResource({
        uri: `martin://runs/${loop.loopId}`,
        runsDir: runsRoot
      });

      expect(recentRuns.contents[0]?.text).toContain(`"${loop.loopId}"`);
      expect(runResource.contents[0]?.text).toContain(`"${loop.loopId}"`);
      expect(runResource.contents[0]?.text).toContain(
        "Canonical run directory for loop_aggregate_only is not available; dossier data may be partial."
      );
    });
  });

  it("uses the same future-dated verification trust rules for resources and prompts", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = {
        ...makeLoopRecord(),
        loopId: "loop_future_resource",
        attempts: [
          {
            attemptId: "att_future_resource",
            index: 1,
            adapterId: "codex-cli",
            model: "gpt-5-codex",
            summary: "Future-dated verification should not be trusted."
          }
        ],
        events: [
          {
            eventId: "evt_1",
            timestamp: "2099-05-16T04:00:00.000Z",
            type: "verification.completed",
            lifecycleState: "verifying",
            payload: {
              attemptId: "att_future_resource",
              passed: true,
              summary: "Future verification should not leak into prompt guidance."
            }
          }
        ]
      };

      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");

      const verificationResource = await readMartinResource({
        uri: `martin://runs/${loop.loopId}/verification`,
        runsDir: runsRoot
      });
      const prompt = await getMartinPrompt({
        name: "martin_debug_failed_run",
        arguments: { loopId: loop.loopId },
        runsDir: runsRoot
      });
      const promptRequest = prompt.messages[5]?.content as { type: "text"; text: string };

      expect(verificationResource.contents[0]?.text).toContain("\"verificationCount\": 0");
      expect(verificationResource.contents[0]?.text).toContain(
        "Ignored 1 future-dated verification evidence item(s) that cannot be trusted yet."
      );
      expect(verificationResource.contents[0]?.text).not.toContain("Future verification should not leak into prompt guidance.");
      expect(promptRequest.text).not.toContain("Future verification should not leak into prompt guidance.");
    });
  });
});

describe("Martin MCP discovery prompts", () => {
  it("lists the planned prompt names", () => {
    const prompts = listMartinPrompts();

    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual([
      "martin_start",
      "martin_preflight",
      "martin_triage",
      "martin_resume",
      "martin_prove",
      "martin_release_check",
      "martin_governed_coding_kickoff",
      "martin_debug_failed_run",
      "martin_publish_readiness_review",
      "martin_triage_run_store"
    ]);
  });

  it("builds the governed kickoff prompt with guide resources", async () => {
    const prompt = await getMartinPrompt({
      name: "martin_start",
      arguments: {
        objective: "Ship the Martin MCP discovery lane",
        verificationPlan: "pnpm --filter @martinloop/mcp test, pnpm --filter @martinloop/mcp build",
        allowedPaths: "packages/mcp/src/**\npackages/mcp/tests/**",
        maxUsd: "5"
      }
    });

    expect(prompt.messages[1]?.content.type).toBe("resource");
    expect(prompt.messages[2]?.content.type).toBe("resource_link");
    expect(prompt.messages[3]?.content.type).toBe("text");
    expect((prompt.messages[3]?.content as { type: "text"; text: string }).text).toContain("Ship the Martin MCP discovery lane");
  });

  it("builds compact resume and proof prompts from latest evidence", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = {
        ...makeLoopRecord(),
        loopId: "loop_compact_prompts"
      };

      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");

      const resumePrompt = await getMartinPrompt({
        name: "martin_resume",
        runsDir: runsRoot
      });
      const provePrompt = await getMartinPrompt({
        name: "martin_prove",
        runsDir: runsRoot
      });

      expect(resumePrompt.messages[2]?.content.type).toBe("resource");
      expect((resumePrompt.messages[4]?.content as { type: "text"; text: string }).text).toContain("Resume from the latest Martin evidence");
      expect(provePrompt.messages[2]?.content.type).toBe("resource");
      expect((provePrompt.messages[4]?.content as { type: "text"; text: string }).text).toContain("Build a Martin proof receipt");
    });
  });

  it("builds the failed-run debug prompt from persisted run evidence", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = {
        ...makeLoopRecord(),
        loopId: "loop_prompt_debug"
      };

      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");

      const prompt = await getMartinPrompt({
        name: "martin_debug_failed_run",
        arguments: { loopId: loop.loopId },
        runsDir: runsRoot
      });

      expect(prompt.messages).toHaveLength(6);
      expect((prompt.messages[1]?.content as { type: "text"; text: string }).text).toContain("untrusted persisted run-store evidence");
      expect(prompt.messages[2]?.role).toBe("user");
      expect(prompt.messages[2]?.content.type).toBe("resource");
      expect(prompt.messages[3]?.role).toBe("user");
      expect(prompt.messages[3]?.content.type).toBe("resource");
      expect(prompt.messages[4]?.role).toBe("user");
      expect(prompt.messages[4]?.content.type).toBe("resource");
      expect((prompt.messages[5]?.content as { type: "text"; text: string }).text).toContain(loop.loopId);
    });
  });

  it("builds the publish-readiness prompt and can include a concrete run resource", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = {
        ...makeLoopRecord(),
        loopId: "loop_publish_review"
      };

      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");

      const prompt = await getMartinPrompt({
        name: "martin_release_check",
        arguments: {
          loopId: loop.loopId,
          focus: "discovery coverage"
        },
        runsDir: runsRoot
      });

      expect(prompt.messages[1]?.content.type).toBe("resource");
      expect(prompt.messages[2]?.content.type).toBe("resource");
      expect((prompt.messages[3]?.content as { type: "text"; text: string }).text).toContain("untrusted persisted evidence");
      expect(prompt.messages[4]?.role).toBe("user");
      expect(prompt.messages[4]?.content.type).toBe("resource");
      expect((prompt.messages[5]?.content as { type: "text"; text: string }).text).toContain("discovery coverage");
    });
  });

  it("builds the run-store triage prompt from the triage resource", async () => {
    await withRunsRoot(async (runsRoot) => {
      const loop = {
        ...makeLoopRecord(),
        loopId: "loop_triage_review"
      };

      await mkdir(join(runsRoot, loop.loopId), { recursive: true });
      await writeFile(join(runsRoot, loop.loopId, "loop-record.json"), JSON.stringify(loop), "utf8");

      const prompt = await getMartinPrompt({
        name: "martin_triage",
        arguments: {
          focus: "verification failures"
        },
        runsDir: runsRoot
      });

      expect(prompt.messages[1]?.content.type).toBe("resource");
      expect((prompt.messages[2]?.content as { type: "text"; text: string }).text).toContain("untrusted triage snapshot");
      expect(prompt.messages[3]?.role).toBe("user");
      expect(prompt.messages[3]?.content.type).toBe("resource");
      expect((prompt.messages[4]?.content as { type: "text"; text: string }).text).toContain("verification failures");
    });
  });
});
