import type { MartinAdapter, MartinAdapterResult } from "@martin/core";

export function createScriptedAdapter(input: {
  adapterId: string;
  kind: MartinAdapter["kind"];
  label: string;
  providerId: string;
  model: string;
  transport?: "cli" | "http" | "routed_http";
  attempts: MartinAdapterResult[];
}): MartinAdapter {
  let executionIndex = 0;

  return {
    adapterId: input.adapterId,
    kind: input.kind,
    label: input.label,
    metadata: {
      providerId: input.providerId,
      model: input.model,
      ...(input.transport ? { transport: input.transport } : {})
    },
    async execute() {
      const scripted = input.attempts[executionIndex] ?? input.attempts.at(-1);
      executionIndex += 1;

      return (
        scripted ?? {
          status: "failed",
          summary: "Scripted adapter ran out of prepared attempts.",
          usage: {
            actualUsd: 0.1,
            tokensIn: 1,
            tokensOut: 1,
            provenance: "actual"
          },
          verification: {
            passed: false,
            summary: "No scripted verification result remained."
          },
          failure: {
            message: "Missing scripted benchmark attempt."
          }
        }
      );
    }
  };
}

export function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
