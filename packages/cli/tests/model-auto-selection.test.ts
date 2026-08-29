/** Model-authority regression guards. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { classifyRoute } from "../../core/src/routing.js";
import { parseCliArguments } from "../src/index.js";
import { resolveCliEnvironment } from "../src/run-store.js";

describe("model-agnostic route classification", () => {
  it("classifies orchestration without selecting a model or provider tier", () => {
    const direct = classifyRoute({
      objective: "Fix a typo in README",
      verificationPlan: [],
      budgetUsd: 2,
    });
    const consensus = classifyRoute({
      objective: "Migrate authentication credentials and rotate encryption keys",
      verificationPlan: [],
      budgetUsd: 15,
    });

    expect(direct.selectedMode).toBe("direct");
    expect(consensus.selectedMode).toBe("consensus");
    expect(direct).not.toHaveProperty("recommendedModelTier");
    expect(consensus).not.toHaveProperty("estimatedSavingVsSonnetUsd");
  });
});

describe("model authority", () => {
  it("allows only the explicit model override to reach delegated adapters", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
      "utf8",
    );
    const adapterSelection = source.slice(
      source.indexOf("function selectAdapter("),
      source.indexOf("function buildDoctorRecommendations("),
    );

    expect(source).not.toContain("autoSelectedModel");
    expect(source).not.toContain("autoSelectModel");
    expect(adapterSelection).toContain("const effectiveModel = modelOverride;");
    expect(adapterSelection).toContain(
      "...(effectiveModel ? { model: effectiveModel } : {})",
    );
    expect(adapterSelection).not.toContain("resolveModelForTier");
    expect(adapterSelection).not.toContain("classifyRoute");
  });

  it("contains no universal model router or concrete routing matrix", () => {
    const routingSource = readFileSync(
      fileURLToPath(new URL("../../core/src/routing.ts", import.meta.url)),
      "utf8",
    );
    const coreSource = readFileSync(
      fileURLToPath(new URL("../../core/src/index.ts", import.meta.url)),
      "utf8",
    );

    expect(routingSource).not.toContain("recommendedModelTier");
    expect(routingSource).not.toContain("resolveModelForTier");
    expect(routingSource).not.toContain("selectBestEngine");
    expect(routingSource).not.toContain("gpt-4o-mini");
    expect(coreSource).not.toContain("DEFAULT_FALLBACK_MODELS");
    expect(coreSource).not.toContain("fallbackModels");
  });
});

describe("estimate parsing", () => {
  it("preserves engine selection without implying model selection", () => {
    expect(parseCliArguments(["estimate", "Fix a typo", "--engine", "claude"])).toMatchObject({
      command: "estimate",
      engine: "claude",
    });
    expect(parseCliArguments(["estimate", "Optimize query", "--engine", "openai"])).toMatchObject({
      command: "estimate",
      engine: "openai",
    });
  });
});

// ---------------------------------------------------------------------------
// Runtime auto-selection contract — MartinLoop is agent/provider agnostic
// ---------------------------------------------------------------------------

describe("runtime auto-selection", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    "utf8",
  );
  const adapterSelection = source.slice(
    source.indexOf("function selectAdapter("),
    source.indexOf("function buildDoctorRecommendations("),
  );

  it("DEFAULT_ENGINE: estimate defaults to auto, not a specific vendor", () => {
    // Omitting --engine must produce "auto", never "claude" or another vendor.
    expect(
      parseCliArguments(["estimate", "Fix a bug"]),
    ).toMatchObject({ command: "estimate", engine: "auto" });
  });

  it("EXPLICIT_CLAUDE: explicit --engine claude is preserved", () => {
    expect(
      parseCliArguments(["estimate", "Fix a bug", "--engine", "claude"]),
    ).toMatchObject({ command: "estimate", engine: "claude" });
  });

  it("EXPLICIT_CODEX: explicit --engine codex is preserved", () => {
    expect(
      parseCliArguments(["estimate", "Fix a bug", "--engine", "codex"]),
    ).toMatchObject({ command: "estimate", engine: "codex" });
  });

  it("AUTO_RUNTIME_RESOLVER: resolveAutoEngine function exists and is the single resolution point", () => {
    expect(source).toContain("function resolveAutoEngine()");
  });

  it("IMPLICIT_CLAUDE_FALLBACK_REMOVED: selectAdapter does not fall through to Claude for unknown/auto engines", () => {
    // The old implicit fallback was: else return createClaudeCliAdapter(...)
    // The new contract: selectAdapter NEVER re-resolves "auto" — the execution boundary
    // upstream is the single resolution point. selectAdapter throws an internal error
    // if called with "auto" (contract violation guard).
    expect(adapterSelection).not.toContain("resolveAutoEngine()");
    expect(adapterSelection).toContain("Internal error");
    expect(adapterSelection).toContain("const resolvedEngine =");
    // No unguarded final return of Claude adapter — the last branch must be exhaustive throw.
    expect(adapterSelection).toContain("Unsupported engine:");
    // Claude must only be selected when resolvedEngine === "claude" explicitly.
    const claudeAdapterLines = adapterSelection
      .split("\n")
      .filter((line) => line.includes("createClaudeCliAdapter"));
    expect(claudeAdapterLines.length).toBeGreaterThan(0);
    // Every createClaudeCliAdapter call must be inside an if (resolvedEngine === "claude") guard.
    claudeAdapterLines.forEach((line) => {
      const lineIndex = adapterSelection.indexOf(line);
      const preceding = adapterSelection.slice(
        Math.max(0, lineIndex - 200),
        lineIndex,
      );
      expect(preceding).toMatch(/if \(resolvedEngine === "claude"\)/);
    });
  });

  it("HELP_DEFAULT: help text advertises auto as the default engine", () => {
    expect(source).toContain("auto (default)");
    expect(source).not.toMatch(/--engine.*claude \(default\)/);
  });

  it("UNKNOWN_ENGINE: no implicit catch-all vendor fallback in selectAdapter", () => {
    // The adapter selection block must throw on unknown engines rather than
    // silently instantiating any specific vendor's adapter.
    const lastAdapterBranch = adapterSelection.slice(
      adapterSelection.lastIndexOf("if (resolvedEngine"),
    );
    // After the last if-branch there must be an error throw, not a bare return.
    expect(lastAdapterBranch).toContain("throw new CliCommandError");
  });

  it("DOCTOR_AUTO: doctor command accepts auto engine without hardcoding a vendor", () => {
    const doctorResult = parseCliArguments(["doctor"]);
    // doctor with no --engine must not produce a vendor-specific engine
    expect(doctorResult).toMatchObject({ command: "doctor" });
    if ("engine" in doctorResult && doctorResult.engine !== undefined) {
      expect(doctorResult.engine).toBe("auto");
    }
  });

  it("NO_RUNTIME_NEUTRAL_ERROR: no-runtime error from resolveAutoEngine is provider-agnostic", () => {
    // The error message must not name a specific provider.
    const resolverFn = source.slice(
      source.indexOf("function resolveAutoEngine()"),
      source.indexOf("function renderMartinConfigYaml("),
    );
    expect(resolverFn).toContain("No supported coding-agent runtime was detected");
    expect(resolverFn).not.toMatch(/Codex not found|Claude not found|Gemini not found/);
  });

  it("OPENAI_AUTO_PROBE: resolveAutoEngine includes OpenAI-compatible provider in availability probe", () => {
    const resolverFn = source.slice(
      source.indexOf("function resolveAutoEngine()"),
      source.indexOf("function renderMartinConfigYaml("),
    );
    // Must check openai availability via resolveOpenAiCompatibleRuntimeConfig, not just CLI tools.
    expect(resolverFn).toContain("resolveOpenAiCompatibleRuntimeConfig()");
    expect(resolverFn).toContain(`{ id: "openai"`);
  });

  it("MULTIPLE_RUNTIME_AMBIGUITY: resolveAutoEngine fails closed when multiple runtimes present", () => {
    const resolverFn = source.slice(
      source.indexOf("function resolveAutoEngine()"),
      source.indexOf("function renderMartinConfigYaml("),
    );
    // Must throw a neutral error rather than silently picking the first candidate.
    expect(resolverFn).toContain("Multiple coding-agent runtimes detected");
    // The old implicit first-in-array selection must not be the only branch.
    expect(resolverFn).not.toContain("candidates.find((c) => c.available)");
  });

  it("HOST_IDE_PRECEDENCE: resolveAutoEngine checks trusted runtime hint before falling through to runtime count", () => {
    const resolverFn = source.slice(
      source.indexOf("function resolveAutoEngine()"),
      source.indexOf("function renderMartinConfigYaml("),
    );
    // detectTrustedRuntimeHint() must be called inside the resolver to supply the hint.
    // detectHostIDE() must NOT be called here — it is for display only, not execution selection.
    expect(resolverFn).toContain("detectTrustedRuntimeHint()");
    expect(resolverFn).not.toContain("detectHostIDE()");
    // The trusted hint must be checked before available.length comparisons.
    const hintIdx = resolverFn.indexOf("detectTrustedRuntimeHint()");
    const countIdx = resolverFn.indexOf("available.length");
    expect(hintIdx).toBeLessThan(countIdx);
  });

  it("SINGLE_RESOLVER: selectRecommendedEngine is removed in favour of resolveAutoEngine", () => {
    // Only one authoritative resolver must exist.
    expect(source).not.toContain("function selectRecommendedEngine(");
    expect(source).not.toContain("selectRecommendedEngine(");
  });

  it("EXECUTION_RESOLVES_RUNTIME_AFTER_GATE: resolution occurs after governance gate, before adapter construction", () => {
    const runFn = source.slice(
      source.indexOf("async function executeRunCommand("),
      source.indexOf("async function executePreflightCommand("),
    );
    // Saved preference check must appear AFTER evaluateCliRunGate (execution boundary).
    expect(runFn).toContain("engine.preference");
    const gateIdx = runFn.indexOf("evaluateCliRunGate(");
    const prefIdx = runFn.indexOf("engine.preference");
    const adapterIdx = runFn.indexOf("selectAdapter(");
    // gate < preference resolution < adapter construction
    expect(gateIdx).toBeLessThan(prefIdx);
    expect(prefIdx).toBeLessThan(adapterIdx);
  });

  it("SAVED_PREFERENCE_MEMORY_ENTRY_WINS: saved preference is read as MemoryEntry.value, not as raw string", () => {
    const runFn = source.slice(
      source.indexOf("async function executeRunCommand("),
      source.indexOf("async function executePreflightCommand("),
    );
    // getPreference returns MemoryEntry {value, key, kind, ...} — NOT a bare string.
    // The preference read must dereference .value; testing the object itself as a string is always false.
    expect(runFn).toContain("savedEnginePref.value");
    expect(runFn).toContain('typeof savedEnginePref.value === "string"');
    // The old broken pattern must not exist.
    expect(runFn).not.toContain('typeof savedEnginePref === "string"');
    // selectionReason must be set to "configured_preference" when preference wins.
    expect(runFn).toContain('selectionReason = "configured_preference"');
  });

  it("ENABLE_ENGINE_PERSISTENCE: enable command persists engine preference via recordPreference", () => {
    const enableFn = source.slice(
      source.indexOf("async function executeEnableCommand("),
      source.indexOf("async function executeReviewCommand("),
    );
    expect(enableFn).toContain("recordPreference");
    expect(enableFn).toContain("engine.preference");
  });

  it("ENGINE_CONFIG_WRITTEN: renderMartinConfigYaml accepts engine and writes it to YAML", () => {
    const renderFn = source.slice(
      source.indexOf("function renderMartinConfigYaml("),
      source.indexOf("function explainIntegrityState("),
    );
    // Function signature must include optional engine field.
    expect(renderFn).toContain("engine?: string");
    // Engine value must appear in the output when concrete.
    expect(renderFn).toContain("`engine: ${input.engine}`");
  });

  it("GENERIC_IDE_NEUTRAL: detectHostIDE generic fallback does not hardcode a vendor-specific install command", () => {
    const detectFn = source.slice(
      source.indexOf("function detectHostIDE()"),
      source.indexOf("function inspectGitRepository("),
    );
    // The generic case must not reference --host claude or any other specific vendor.
    const genericBlock = detectFn.slice(detectFn.lastIndexOf('host: "generic"'));
    expect(genericBlock).not.toContain("--host claude");
    expect(genericBlock).not.toContain("--host codex");
    expect(genericBlock).not.toContain("--host gemini");
  });
});

// ---------------------------------------------------------------------------
// resolveCliEnvironment invariant — MUST NOT choose a provider for auto/undefined
// ---------------------------------------------------------------------------

describe("resolveCliEnvironment engine normalization", () => {
  it("RESOLVE_CLI_ENVIRONMENT_UNDEFINED_IS_AUTO: undefined engine input → auto", () => {
    const env = resolveCliEnvironment({});
    expect(env.engine).toBe("auto");
  });

  it("RESOLVE_CLI_ENVIRONMENT_AUTO_STAYS_AUTO: explicit auto input → auto", () => {
    const env = resolveCliEnvironment({ engine: "auto" });
    expect(env.engine).toBe("auto");
  });

  it("NO_IMPLICIT_PROVIDER_DEFAULT_IN_NORMALIZATION: resolveCliEnvironment never returns a provider for auto/undefined", () => {
    const providers = ["claude", "codex", "gemini", "openai"];
    expect(providers).not.toContain(resolveCliEnvironment({}).engine);
    expect(providers).not.toContain(resolveCliEnvironment({ engine: "auto" }).engine);
  });

  it("EXPLICIT_ENGINE_PASSES_THROUGH_UNCHANGED: explicit providers pass through unchanged", () => {
    expect(resolveCliEnvironment({ engine: "claude" }).engine).toBe("claude");
    expect(resolveCliEnvironment({ engine: "codex" }).engine).toBe("codex");
    expect(resolveCliEnvironment({ engine: "gemini" }).engine).toBe("gemini");
    expect(resolveCliEnvironment({ engine: "openai" }).engine).toBe("openai");
  });
});

// ---------------------------------------------------------------------------
// Trusted runtime hint — separation from ambient credentials
// Pre-execution auto invariant — advisory surfaces must not resolve a provider
// ---------------------------------------------------------------------------

describe("trusted runtime hint and pre-execution auto invariant", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    "utf8",
  );

  const trustedHintFn = source.slice(
    source.indexOf("function detectTrustedRuntimeHint()"),
    source.indexOf("function resolveAutoEngine()"),
  );

  it("TRUSTED_RUNTIME_HINT_SEPARATE: detectTrustedRuntimeHint exists as a function separate from detectHostIDE", () => {
    expect(source).toContain("function detectTrustedRuntimeHint()");
    expect(source).toContain("function detectHostIDE()");
    // The two functions must be defined separately.
    expect(trustedHintFn).not.toContain("function detectHostIDE");
  });

  it("AMBIENT_GEMINI_KEY_NOT_TRUSTED: GEMINI_API_KEY must not be used as a trusted runtime hint signal", () => {
    // GEMINI_API_KEY may appear in comments documenting its exclusion.
    // The contract is: it must not drive a return value — Gemini has no trusted hint.
    expect(trustedHintFn).not.toContain('return "gemini"');
    expect(trustedHintFn).not.toMatch(/if\s*\(.*GEMINI_API_KEY.*\)\s*\{/);
  });

  it("AMBIENT_CODEX_HOME_NOT_TRUSTED: CODEX_HOME alone must not select Codex as a trusted runtime hint", () => {
    // CODEX_HOME may appear in comments documenting its exclusion.
    // The contract is: it must not be the sole conditional that returns "codex".
    expect(trustedHintFn).not.toMatch(/if\s*\(env\.CODEX_HOME\)/);
  });

  it("TRUSTED_RUNTIME_HINT_WINS: detectTrustedRuntimeHint uses only session-injected signals", () => {
    // Claude Code injects CLAUDE_CODE into child processes.
    expect(trustedHintFn).toContain("CLAUDE_CODE");
    // Codex injects CODEX_SANDBOX_MODE in active sandboxed sessions.
    expect(trustedHintFn).toContain("CODEX_SANDBOX_MODE");
  });

  it("PREEXECUTION_AUTO_STAYS_AUTO: collectStartEnvironmentSnapshot does not call resolveAutoEngine", () => {
    const snapshotFn = source.slice(
      source.indexOf("async function collectStartEnvironmentSnapshot("),
      source.indexOf("async function detectVerifierCommand("),
    );
    // Pre-execution snapshot must never resolve auto to a concrete provider.
    expect(snapshotFn).not.toContain("resolveAutoEngine");
    // recommendedEngine must be the literal "auto" — not a provider chosen by availability.
    expect(snapshotFn).toContain('"auto"');
  });

  it("ENABLE_WITHOUT_ENGINE_STAYS_AUTO: enable without --engine does not persist a vendor preference", () => {
    const enableFn = source.slice(
      source.indexOf("async function executeEnableCommand("),
      source.indexOf("async function executeReviewCommand("),
    );
    // The persistence guard must explicitly exclude "auto" from being written.
    expect(enableFn).toContain('engine !== "auto"');
    // When no --engine is given, the fallback uses snapshot.recommendedEngine (now always "auto").
    expect(enableFn).toContain("snapshot.recommendedEngine");
  });

  it("PREEXECUTION_RESOLVER_CALLS_ZERO: resolveAutoEngine is called only at the execution boundary", () => {
    // Count every call site of resolveAutoEngine() in the source.
    const callSites = source.split("resolveAutoEngine()").length - 1;
    // Exactly one call site: inside executeRunCommand after the governance gate.
    // The function definition itself does not count as a "call".
    const definitionOccurrences = (source.match(/function resolveAutoEngine\(\)/g) ?? []).length;
    const calls = callSites - definitionOccurrences;
    expect(calls).toBe(1);
  });
});
