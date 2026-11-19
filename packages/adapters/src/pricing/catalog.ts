export type PricingProvider = "openai" | "anthropic" | "google";
export type PricingServiceTier = "standard" | "batch" | "flex" | "fast" | "ultrafast";
export type CacheWriteDuration = "5m" | "30m" | "1h" | "12h";
export type PricingResolutionStatus = "exact" | "alias" | "unknown" | "expired" | "ambiguous";

export interface TokenRatesPerMillion {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: Partial<Record<CacheWriteDuration, number>>;
}

export interface PricingSourceMetadata {
  url: string;
  retrievedAt: string;
}

export interface PricingBand {
  serviceTier: PricingServiceTier;
  minInputTokensExclusive?: number;
  effectiveFrom: string;
  effectiveUntil?: string;
  ratesPerMillion: TokenRatesPerMillion;
}

export interface PricingAlias {
  kind: "exact" | "dated-suffix";
  value: string;
}

export interface ProviderPricingEntry {
  provider: PricingProvider;
  canonicalModelId: string;
  aliases?: readonly PricingAlias[];
  source: PricingSourceMetadata;
  pricing: readonly PricingBand[];
}

export interface ResolvedProviderPricing {
  status: PricingResolutionStatus;
  canonicalModelId?: string;
  entry?: ProviderPricingEntry;
  pricing?: PricingBand;
}

export interface ResolveProviderPricingOptions {
  provider?: PricingProvider;
  at?: Date;
  serviceTier?: PricingServiceTier;
  inputTokens?: number;
}

const OPENAI_PRICING_SOURCE: PricingSourceMetadata = {
  url: "https://developers.openai.com/api/docs/pricing",
  retrievedAt: "2026-11-03"
};

const ANTHROPIC_PRICING_SOURCE: PricingSourceMetadata = {
  url: "https://platform.claude.com/docs/en/about-claude/pricing",
  retrievedAt: "2026-11-03"
};

const GOOGLE_PRICING_SOURCE: PricingSourceMetadata = {
  url: "https://ai.google.dev/gemini-api/docs/pricing",
  retrievedAt: "2026-11-03"
};

const LEGACY_PRICING_SOURCE: PricingSourceMetadata = {
  url: "https://developers.openai.com/api/docs/pricing",
  retrievedAt: "2026-10-04"
};

function standardBand(ratesPerMillion: TokenRatesPerMillion): PricingBand {
  return { serviceTier: "standard", effectiveFrom: "2026-11-03", ratesPerMillion };
}

function datedAndShortAliases(canonicalModelId: string, shortAlias: string): readonly PricingAlias[] {
  return [
    { kind: "dated-suffix", value: canonicalModelId },
    { kind: "exact", value: `claude-${shortAlias}` },
    { kind: "exact", value: shortAlias }
  ];
}

function openAiStandardBands(
  rates: TokenRatesPerMillion,
  longRates: TokenRatesPerMillion
): readonly PricingBand[] {
  return [
    standardBand(rates),
    {
      serviceTier: "standard",
      minInputTokensExclusive: 272_000,
      effectiveFrom: "2026-11-03",
      ratesPerMillion: longRates
    }
  ];
}

function geminiPromotionalBands(
  promotional: TokenRatesPerMillion,
  standard: TokenRatesPerMillion
): readonly PricingBand[] {
  return [
    { serviceTier: "standard", effectiveFrom: "2026-11-03", effectiveUntil: "2026-12-31", ratesPerMillion: promotional },
    { serviceTier: "standard", effectiveFrom: "2027-01-01", ratesPerMillion: standard }
  ];
}

const PROVIDER_PRICING_CATALOG: readonly ProviderPricingEntry[] = [
  {
    provider: "openai",
    canonicalModelId: "gpt-6-astra",
    source: OPENAI_PRICING_SOURCE,
    pricing: openAiStandardBands(
      { input: 10, output: 50, cachedInput: 1, cacheWrite: { "30m": 12.5, "12h": 25 } },
      { input: 20, output: 75, cachedInput: 2, cacheWrite: { "30m": 25, "12h": 50 } }
    )
  },
  {
    provider: "openai",
    canonicalModelId: "gpt-6.1-sol",
    source: OPENAI_PRICING_SOURCE,
    pricing: openAiStandardBands(
      { input: 2, output: 10, cachedInput: 0.1, cacheWrite: { "30m": 2.5, "12h": 5 } },
      { input: 4, output: 15, cachedInput: 0.2, cacheWrite: { "30m": 5, "12h": 10 } }
    )
  },
  {
    provider: "openai",
    canonicalModelId: "gpt-6.1-terra",
    source: OPENAI_PRICING_SOURCE,
    pricing: openAiStandardBands(
      { input: 1, output: 5, cachedInput: 0.05, cacheWrite: { "30m": 1.25, "12h": 2.5 } },
      { input: 2, output: 7.5, cachedInput: 0.1, cacheWrite: { "30m": 2.5, "12h": 5 } }
    )
  },
  {
    provider: "openai",
    canonicalModelId: "gpt-6-luna",
    source: OPENAI_PRICING_SOURCE,
    pricing: openAiStandardBands(
      { input: 0.1, output: 0.5, cachedInput: 0.01, cacheWrite: { "30m": 0.125, "12h": 0.25 } },
      { input: 0.2, output: 0.75, cachedInput: 0.02, cacheWrite: { "30m": 0.25, "12h": 0.5 } }
    )
  },
  {
    provider: "openai",
    canonicalModelId: "gpt-5.3-codex",
    aliases: [{ kind: "dated-suffix", value: "gpt-5.3-codex" }],
    source: OPENAI_PRICING_SOURCE,
    pricing: [standardBand({ input: 1.75, output: 14, cachedInput: 0.175 })]
  },
  {
    provider: "openai",
    canonicalModelId: "gpt-6-sol",
    source: LEGACY_PRICING_SOURCE,
    pricing: openAiStandardBands(
      { input: 2, output: 10, cachedInput: 0.2, cacheWrite: { "30m": 2.5, "12h": 5 } },
      { input: 4, output: 15, cachedInput: 0.4, cacheWrite: { "30m": 5, "12h": 10 } }
    )
  },
  {
    provider: "openai",
    canonicalModelId: "gpt-5.6-sol",
    source: LEGACY_PRICING_SOURCE,
    pricing: openAiStandardBands(
      { input: 4, output: 20, cachedInput: 0.4, cacheWrite: { "30m": 5, "12h": 10 } },
      { input: 8, output: 30, cachedInput: 0.8, cacheWrite: { "30m": 10, "12h": 20 } }
    )
  },
  ...([
    ["gpt-5-codex", 1.25, 10, 0.125, "codex"],
    ["gpt-5.1-codex", 1.25, 10, 0.125],
    ["gpt-5.1-codex-max", 1.25, 10, 0.125],
    ["gpt-5.2-codex", 1.75, 14, 0.175],
    ["codex-mini-latest", 1.5, 6, 0.375]
  ] as const).map(([canonicalModelId, input, output, cachedInput, alias]) => ({
    provider: "openai" as const,
    canonicalModelId,
    ...(alias ? { aliases: [{ kind: "exact" as const, value: alias }] } : {}),
    source: LEGACY_PRICING_SOURCE,
    pricing: [standardBand({ input, output, cachedInput })]
  })),
  {
    provider: "anthropic",
    canonicalModelId: "claude-fable-5-1",
    aliases: datedAndShortAliases("claude-fable-5-1", "fable"),
    source: ANTHROPIC_PRICING_SOURCE,
    pricing: [standardBand({ input: 10, output: 50, cachedInput: 0.25, cacheWrite: { "5m": 12.5, "1h": 20 } })]
  },
  {
    provider: "anthropic",
    canonicalModelId: "claude-opus-5-5",
    aliases: datedAndShortAliases("claude-opus-5-5", "opus"),
    source: ANTHROPIC_PRICING_SOURCE,
    pricing: [standardBand({ input: 4, output: 20, cachedInput: 0.2, cacheWrite: { "5m": 5, "1h": 8 } })]
  },
  {
    provider: "anthropic",
    canonicalModelId: "claude-sonnet-5-5",
    aliases: datedAndShortAliases("claude-sonnet-5-5", "sonnet"),
    source: ANTHROPIC_PRICING_SOURCE,
    pricing: [standardBand({ input: 2, output: 10, cachedInput: 0.1, cacheWrite: { "5m": 2.5, "1h": 4 } })]
  },
  {
    provider: "anthropic",
    canonicalModelId: "claude-haiku-5-5",
    aliases: datedAndShortAliases("claude-haiku-5-5", "haiku"),
    source: ANTHROPIC_PRICING_SOURCE,
    pricing: [
      standardBand({ input: 0.1, output: 0.5, cachedInput: 0.01, cacheWrite: { "5m": 0.125, "1h": 0.2 } }),
      {
        serviceTier: "standard",
        minInputTokensExclusive: 100_000,
        effectiveFrom: "2026-11-03",
        ratesPerMillion: { input: 0.5, output: 2.5, cachedInput: 0.05, cacheWrite: { "5m": 0.625, "1h": 1 } }
      }
    ]
  },
  {
    provider: "anthropic",
    canonicalModelId: "claude-opus-4-6",
    aliases: [{ kind: "dated-suffix", value: "claude-opus-4-6" }],
    source: ANTHROPIC_PRICING_SOURCE,
    pricing: [standardBand({ input: 5, output: 25, cachedInput: 0.5, cacheWrite: { "5m": 6.25, "1h": 10 } })]
  },
  {
    provider: "anthropic",
    canonicalModelId: "claude-sonnet-4-6",
    aliases: [{ kind: "dated-suffix", value: "claude-sonnet-4-6" }],
    source: ANTHROPIC_PRICING_SOURCE,
    pricing: [standardBand({ input: 3, output: 15, cachedInput: 0.3, cacheWrite: { "5m": 3.75, "1h": 6 } })]
  },
  {
    provider: "anthropic",
    canonicalModelId: "claude-haiku-4-5",
    aliases: [{ kind: "dated-suffix", value: "claude-haiku-4-5" }],
    source: ANTHROPIC_PRICING_SOURCE,
    pricing: [standardBand({ input: 1, output: 5, cachedInput: 0.1, cacheWrite: { "5m": 1.25, "1h": 2 } })]
  },
  {
    provider: "google",
    canonicalModelId: "gemini-4-argon",
    source: GOOGLE_PRICING_SOURCE,
    pricing: [
      {
        serviceTier: "standard",
        effectiveFrom: "2026-11-03",
        effectiveUntil: "2026-11-30",
        ratesPerMillion: { input: 2, output: 10, cachedInput: 0.1 }
      },
      {
        serviceTier: "standard",
        effectiveFrom: "2026-12-01",
        ratesPerMillion: { input: 4, output: 20, cachedInput: 0.2 }
      }
    ]
  },
  {
    provider: "google",
    canonicalModelId: "gemini-3.8-flash",
    source: GOOGLE_PRICING_SOURCE,
    pricing: geminiPromotionalBands(
      { input: 0.75, output: 3.75, cachedInput: 0.075 },
      { input: 1.5, output: 7.5, cachedInput: 0.15 }
    )
  },
  {
    provider: "google",
    canonicalModelId: "gemini-3.6-flash",
    source: GOOGLE_PRICING_SOURCE,
    pricing: geminiPromotionalBands(
      { input: 0.75, output: 3.75, cachedInput: 0.075 },
      { input: 1.5, output: 7.5, cachedInput: 0.15 }
    )
  },
  {
    provider: "google",
    canonicalModelId: "gemini-3.5-flash-lite",
    source: GOOGLE_PRICING_SOURCE,
    pricing: [standardBand({ input: 0.3, output: 2.5, cachedInput: 0.03 })]
  },
  {
    provider: "google",
    canonicalModelId: "gemini-3.1-flash-lite",
    source: GOOGLE_PRICING_SOURCE,
    pricing: [standardBand({ input: 0.25, output: 1.5, cachedInput: 0.025 })]
  },
  {
    provider: "google",
    canonicalModelId: "gemini-3.1-pro-preview",
    source: GOOGLE_PRICING_SOURCE,
    pricing: [
      standardBand({ input: 2, output: 12, cachedInput: 0.2 }),
      { serviceTier: "standard", minInputTokensExclusive: 200_000, effectiveFrom: "2026-11-03", ratesPerMillion: { input: 4, output: 18, cachedInput: 0.4 } }
    ]
  },
  {
    provider: "google",
    canonicalModelId: "gemini-3-flash-preview",
    source: GOOGLE_PRICING_SOURCE,
    pricing: [standardBand({ input: 0.5, output: 3, cachedInput: 0.05 })]
  },
  {
    provider: "google",
    canonicalModelId: "gemini-2.5-pro",
    source: GOOGLE_PRICING_SOURCE,
    pricing: [
      standardBand({ input: 1.25, output: 10, cachedInput: 0.125 }),
      { serviceTier: "standard", minInputTokensExclusive: 200_000, effectiveFrom: "2026-11-03", ratesPerMillion: { input: 2.5, output: 15, cachedInput: 0.25 } }
    ]
  },
  {
    provider: "google",
    canonicalModelId: "gemini-2.5-flash",
    source: GOOGLE_PRICING_SOURCE,
    pricing: [standardBand({ input: 0.3, output: 2.5, cachedInput: 0.03 })]
  },
  {
    provider: "google",
    canonicalModelId: "gemini-2.5-flash-lite",
    source: GOOGLE_PRICING_SOURCE,
    pricing: [standardBand({ input: 0.1, output: 0.4, cachedInput: 0.01 })]
  }
];

function isAliasMatch(entry: ProviderPricingEntry, model: string): boolean {
  return entry.aliases?.some((alias) => alias.kind === "exact"
    ? model === alias.value
    : model.startsWith(`${alias.value}-`) && /^\d{8}$/u.test(model.slice(alias.value.length + 1))) ?? false;
}

function selectPricingBand(
  entry: ProviderPricingEntry,
  options: Required<Pick<ResolveProviderPricingOptions, "at" | "serviceTier" | "inputTokens">>
): PricingBand | undefined {
  const timestamp = options.at.getTime();
  return entry.pricing
    .filter((band) => band.serviceTier === options.serviceTier)
    .filter((band) => timestamp >= new Date(`${band.effectiveFrom}T00:00:00.000Z`).getTime())
    .filter((band) => band.effectiveUntil === undefined || timestamp <= new Date(`${band.effectiveUntil}T23:59:59.999Z`).getTime())
    .filter((band) => options.inputTokens > (band.minInputTokensExclusive ?? -1))
    .sort((left, right) => (right.minInputTokensExclusive ?? -1) - (left.minInputTokensExclusive ?? -1))[0];
}

export function resolveProviderPricing(
  modelLabel: string | undefined,
  options: ResolveProviderPricingOptions = {}
): ResolvedProviderPricing {
  const model = modelLabel?.trim().toLowerCase();
  if (!model) return { status: "unknown" };

  const candidates = PROVIDER_PRICING_CATALOG.filter((entry) =>
    (options.provider === undefined || entry.provider === options.provider) &&
    (entry.canonicalModelId === model || isAliasMatch(entry, model))
  );
  if (candidates.length === 0) return { status: "unknown" };
  if (candidates.length > 1) return { status: "ambiguous" };

  const entry = candidates[0];
  if (!entry) return { status: "unknown" };
  const pricing = selectPricingBand(entry, {
    at: options.at ?? new Date(),
    serviceTier: options.serviceTier ?? "standard",
    inputTokens: options.inputTokens ?? 0
  });
  if (!pricing) {
    return { status: "expired", canonicalModelId: entry.canonicalModelId, entry };
  }
  return {
    status: entry.canonicalModelId === model ? "exact" : "alias",
    canonicalModelId: entry.canonicalModelId,
    entry,
    pricing
  };
}

/**
 * Returns a conservative, model-specific scalar for host budget admission.
 * The host has a total-token estimate rather than an input/output split, so
 * using the highest currently active billable token rate avoids understating
 * spend while retaining the catalog as the pricing source of truth.
 */
export function resolveBudgetPreflightPricePerMTokenUsd(
  modelLabel: string | undefined,
  options: ResolveProviderPricingOptions = {}
): number | undefined {
  const model = modelLabel?.trim();
  const entries = model
    ? (() => {
        const resolution = resolveProviderPricing(model, options);
        return resolution.entry ? [resolution.entry] : [];
      })()
    : options.provider === undefined
      ? []
      : PROVIDER_PRICING_CATALOG.filter((entry) => entry.provider === options.provider);
  if (entries.length === 0) return undefined;

  const at = options.at ?? new Date();
  const serviceTier = options.serviceTier ?? "standard";
  const timestamp = at.getTime();
  const activeRates = entries.flatMap((entry) => entry.pricing)
    .filter((band) => band.serviceTier === serviceTier)
    .filter((band) => timestamp >= new Date(`${band.effectiveFrom}T00:00:00.000Z`).getTime())
    .filter((band) => band.effectiveUntil === undefined || timestamp <= new Date(`${band.effectiveUntil}T23:59:59.999Z`).getTime())
    .flatMap((band) => [
      band.ratesPerMillion.input,
      band.ratesPerMillion.output,
      ...(band.ratesPerMillion.cachedInput === undefined ? [] : [band.ratesPerMillion.cachedInput]),
      ...Object.values(band.ratesPerMillion.cacheWrite ?? {})
    ]);

  return activeRates.length === 0 ? undefined : Math.max(...activeRates);
}
