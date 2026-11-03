export const SWARM_CHILD_MAX_WALL_CLOCK_MS = 240_000;
export const SWARM_PARENT_VERIFIER_ALLOWANCE_MS = 120_000;
const NODE_MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface SwarmExecutionShape {
  agents: number;
  maxConcurrency: number;
}

export function resolveSwarmDeadlineMs(
  shape: SwarmExecutionShape,
): number {
  assertPositiveSafeInteger(shape.agents, "agents");
  assertPositiveSafeInteger(shape.maxConcurrency, "maxConcurrency");
  if (shape.maxConcurrency > shape.agents) {
    throw new Error("maxConcurrency cannot exceed agents");
  }

  const executionWaves = Math.ceil(shape.agents / shape.maxConcurrency);
  const deadlineMs = (
    executionWaves * SWARM_CHILD_MAX_WALL_CLOCK_MS
    + SWARM_PARENT_VERIFIER_ALLOWANCE_MS
  );
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs > NODE_MAX_TIMER_DELAY_MS) {
    throw new Error("derived deadline exceeds the Node timer maximum");
  }
  return deadlineMs;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}
