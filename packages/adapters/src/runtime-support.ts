import type { MartinAdapter, MartinAdapterResult } from "@martin/core";

type StructuredError = NonNullable<NonNullable<MartinAdapterResult["execution"]>["structuredErrors"]>[number];
type DiffStats = NonNullable<NonNullable<MartinAdapterResult["execution"]>["diffStats"]>;

export function createAdapterCapabilities(
  overrides: Partial<NonNullable<MartinAdapter["metadata"]["capabilities"]>> = {}
): NonNullable<MartinAdapter["metadata"]["capabilities"]> {
  return {
    preflight: true,
    usageSettlement: false,
    diffArtifacts: false,
    structuredErrors: false,
    cachingSignals: false,
    ...overrides
  };
}

export function normalizeUsage(input: {
  actualUsd?: number;
  estimatedUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  provenance?: MartinAdapterResult["usage"]["provenance"];
}): MartinAdapterResult["usage"] {
  const provenance =
    input.provenance ??
    (input.estimatedUsd !== undefined ? "estimated" : "actual");
  const actualUsd =
    provenance === "estimated"
      ? input.estimatedUsd ?? input.actualUsd ?? 0
      : input.actualUsd ?? 0;

  return {
    actualUsd: roundUsd(actualUsd),
    ...(input.estimatedUsd !== undefined
      ? { estimatedUsd: roundUsd(input.estimatedUsd) }
      : {}),
    tokensIn: input.tokensIn ?? 0,
    tokensOut: input.tokensOut ?? 0,
    provenance
  };
}

export function diffStatsFromNumstat(stdout: string): DiffStats | undefined {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return undefined;
  }

  let filesChanged = 0;
  let addedLines = 0;
  let deletedLines = 0;

  for (const line of lines) {
    const [added, deleted] = line.split(/\s+/u);
    filesChanged += 1;
    addedLines += Number(added) || 0;
    deletedLines += Number(deleted) || 0;
  }

  return { filesChanged, addedLines, deletedLines };
}

export function normalizeStructuredErrors(
  errors: StructuredError[] | undefined
): StructuredError[] {
  return errors?.slice(0, 10) ?? [];
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
