import { evaluateCostGovernor, type LoopRunRecord } from "@martin/core";

import { loadLoopRecordForStatus, loadLoopRecordsForInspect } from "./run-store.js";
import type { InspectableLoopRecord } from "./tool-support.js";

export interface RunSelectorInput {
  loopId?: string;
  runsDir?: string;
  latest?: boolean;
}

export interface RunSummary {
  loopId: string;
  title: string;
  objective: string;
  status: string;
  lifecycleState: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  costUsd: number;
  avoidedUsd: number;
  pressure: string;
  shouldStop: boolean;
  verificationCount: number;
}

export interface VerificationResultSummary {
  eventId?: string;
  timestamp?: string;
  lifecycleState?: string;
  passed?: boolean;
  summary?: string;
}

export function summarizeRun(loop: InspectableLoopRecord): RunSummary {
  const task = summarizeTask(loop);
  const costState = evaluateCostGovernor({
    budget: loop.budget,
    cost: {
      actualUsd: loop.cost.actualUsd,
      avoidedUsd: loop.cost.avoidedUsd ?? 0,
      tokensIn: loop.cost.tokensIn,
      tokensOut: loop.cost.tokensOut
    },
    attemptsUsed: loop.attempts.length
  });

  return {
    loopId: loop.loopId,
    title: task.title,
    objective: task.objective,
    status: loop.status,
    lifecycleState: loop.lifecycleState,
    createdAt: loop.createdAt,
    updatedAt: loop.updatedAt,
    attempts: loop.attempts.length,
    costUsd: loop.cost.actualUsd,
    avoidedUsd: loop.cost.avoidedUsd ?? 0,
    pressure: costState.pressure,
    shouldStop: costState.shouldStop,
    verificationCount: extractVerificationResults(loop).length
  };
}

export async function listRunSummaries(input: { runsDir?: string; limit?: number } = {}): Promise<RunSummary[]> {
  const inspection = await loadLoopRecordsForInspect({ runsDir: input.runsDir });
  const summaries = inspection.loops.map((loop) => summarizeRun(loop));

  summaries.sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt ?? left.createdAt);
    const rightTime = Date.parse(right.updatedAt ?? right.createdAt);
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  });

  return summaries.slice(0, input.limit ?? 20);
}

export async function loadSelectedRun(input: RunSelectorInput): Promise<InspectableLoopRecord> {
  const selectors = [input.loopId ? "loopId" : null, input.latest ? "latest" : null].filter(Boolean);
  if (selectors.length !== 1) {
    throw new Error("Provide exactly one of loopId or latest.");
  }

  const source = await loadLoopRecordForStatus({
    ...(input.loopId ? { loopId: input.loopId } : {}),
    ...(input.latest ? { latest: true } : {}),
    ...(input.runsDir ? { runsDir: input.runsDir } : {})
  });
  return source.loop;
}

export function extractVerificationResults(loop: InspectableLoopRecord): VerificationResultSummary[] {
  const events = "events" in loop && Array.isArray(loop.events) ? loop.events : [];
  return events
    .filter((event) => event?.type === "verification.completed")
    .map((event) => {
      const payload = isRecord(event.payload) ? event.payload : {};
      return {
        ...(typeof event.eventId === "string" ? { eventId: event.eventId } : {}),
        ...(typeof event.timestamp === "string" ? { timestamp: event.timestamp } : {}),
        ...(typeof event.lifecycleState === "string" ? { lifecycleState: event.lifecycleState } : {}),
        ...(typeof payload.passed === "boolean" ? { passed: payload.passed } : {}),
        ...(typeof payload.summary === "string" ? { summary: payload.summary } : {})
      };
    });
}

export function getAttempt(loop: InspectableLoopRecord, attemptIndex: number) {
  const attempt = loop.attempts.find((candidate) => candidate.index === attemptIndex);
  if (!attempt) {
    throw new Error("Attempt not found.");
  }
  return attempt;
}

export function buildRunDossier(loop: InspectableLoopRecord) {
  return {
    loopId: loop.loopId,
    generatedAt: new Date().toISOString(),
    sections: [
      {
        kind: "summary",
        content: summarizeRun(loop)
      },
      {
        kind: "task",
        content: summarizeTask(loop)
      },
      {
        kind: "budget",
        content: {
          budget: loop.budget,
          cost: loop.cost
        }
      },
      {
        kind: "attempts",
        content: loop.attempts
      },
      {
        kind: "verification",
        content: extractVerificationResults(loop)
      }
    ]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function summarizeTask(loop: Pick<InspectableLoopRecord, "loopId" | "task">): LoopRunRecord["task"] {
  return {
    title: loop.task?.title ?? loop.loopId,
    objective: loop.task?.objective ?? "Loop record summary"
  };
}
