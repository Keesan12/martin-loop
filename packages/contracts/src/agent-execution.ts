export const DEFAULT_AGENT_EXECUTION_INTENT = "governed-autonomous" as const;
export type AgentExecutionIntent = typeof DEFAULT_AGENT_EXECUTION_INTENT;

/** Provider-neutral safety boundary every governed-autonomous adapter must honor. */
export const GOVERNED_AUTONOMOUS_BOUNDARY = {
  interaction: "non-interactive",
  writeScope: "workspace-only"
} as const;

export const DEFAULT_PROVIDER_EXECUTION_TIMEOUT_MS = 300_000;

export function normalizeProviderExecutionTimeoutMs(
  value: number | undefined
): number {
  const resolved = value ?? DEFAULT_PROVIDER_EXECUTION_TIMEOUT_MS;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error("providerExecutionTimeoutMs must be a positive finite number.");
  }
  return resolved;
}
