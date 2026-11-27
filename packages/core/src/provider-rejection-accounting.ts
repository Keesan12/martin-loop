interface RejectedProviderUsage {
  usd?: number;
  tokens: number;
  tokensIn: number;
  tokensOut: number;
}

const rejectedUsage = new WeakMap<Error, RejectedProviderUsage>();

export function retainRejectedProviderUsage(
  error: unknown,
  usage: { actualUsd: number; tokensIn: number; tokensOut: number; provenance?: string }
): RejectedProviderUsage {
  const nonnegativeInteger = (value: number): number => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const priced = (usage.provenance === "actual" || usage.provenance === "calculated")
    && Number.isFinite(usage.actualUsd) && usage.actualUsd >= 0;
  const tokensIn = nonnegativeInteger(usage.tokensIn);
  const tokensOut = nonnegativeInteger(usage.tokensOut);
  const retained = {
    ...(priced ? { usd: usage.actualUsd } : {}),
    tokens: nonnegativeInteger(tokensIn + tokensOut),
    tokensIn,
    tokensOut
  };
  if (error instanceof Error) rejectedUsage.set(error, retained);
  return retained;
}

export function readRejectedProviderUsage(error: unknown): RejectedProviderUsage | undefined {
  return error instanceof Error ? rejectedUsage.get(error) : undefined;
}
