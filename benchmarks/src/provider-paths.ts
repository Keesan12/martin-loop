import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import {
  createClaudeCliAdapter,
  createCodexCliAdapter,
  createDirectProviderAdapter,
  type SpawnLike
} from "@martin/adapters";
import type {
  MartinAdapter,
  MartinAdapterRequest,
  MartinAdapterResult
} from "@martin/core";

import type {
  ProviderPathAccountingMode,
  ProviderPathReport,
  ProviderPathSurface,
  ProviderPathVerdict
} from "./types.js";

const CLAUDE_JSON_RESPONSE = JSON.stringify({
  type: "result",
  result: "Claude CLI completed the task successfully.",
  usage: {
    inputTokens: 120,
    outputTokens: 36
  }
});

const CODEX_TEXT_RESPONSE = "Codex CLI completed the task successfully.";

export async function generateProviderPathReport(): Promise<ProviderPathReport> {
  const surfaces = await evaluateProviderPathSurfaces();

  return {
    generatedAt: new Date().toISOString(),
    verdict: decideProviderPathVerdict(surfaces),
    surfaces,
    summary: {
      totalSurfaces: surfaces.length,
      supportedForRc: surfaces.filter((surface) => surface.rcStatus === "supported_for_rc").length,
      unsupportedForRc: surfaces.filter((surface) => surface.rcStatus === "unsupported_for_rc").length,
      exactAccounting: surfaces.filter((surface) => surface.accountingMode === "exact").length,
      estimatedOnly: surfaces.filter((surface) => surface.accountingMode === "estimated_only").length,
      unavailableAccounting: surfaces.filter((surface) => surface.accountingMode === "unavailable").length
    }
  };
}

export function renderProviderPathReportMarkdown(report: ProviderPathReport): string {
  return [
    "# Martin Loop Phase 13 Provider Path Validation",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Verdict",
    `**${report.verdict.toUpperCase()}**`,
    "",
    "## Summary",
    `- Supported for RC: ${String(report.summary.supportedForRc)}/${String(report.summary.totalSurfaces)}`,
    `- Unsupported for RC: ${String(report.summary.unsupportedForRc)}/${String(report.summary.totalSurfaces)}`,
    `- Exact accounting surfaces: ${String(report.summary.exactAccounting)}`,
    `- Estimated-only surfaces: ${String(report.summary.estimatedOnly)}`,
    `- Unavailable accounting surfaces: ${String(report.summary.unavailableAccounting)}`,
    "",
    "## Surface Matrix",
    "| Surface | Transport | RC Status | Accounting | Usage Settlement | Notes |",
    "|---|---|---|---|---|---|",
    ...report.surfaces.map(
      (surface) =>
        `| ${surface.label} | ${surface.transport} | ${surface.rcStatus} | ${surface.accountingMode} | ${surface.usageSettlementCapable ? "yes" : "no"} | ${surface.notes.join("; ")} |`
    ),
    ""
  ].join("\n");
}

export async function writeProviderPathReport(outputDir: string): Promise<ProviderPathReport> {
  const report = await generateProviderPathReport();
  const markdown = renderProviderPathReportMarkdown(report);

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, "phase13-provider-path-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(outputDir, "phase13-provider-path-report.md"),
    `${markdown}\n`,
    "utf8"
  );

  return report;
}

async function evaluateProviderPathSurfaces(): Promise<ProviderPathSurface[]> {
  const request = createProviderPathRequest();

  const claude = createClaudeCliAdapter({
    spawnImpl: createSpawnMock({
      stdout: CLAUDE_JSON_RESPONSE
    })
  });
  const codex = createCodexCliAdapter({
    spawnImpl: createSpawnMock({
      stdout: CODEX_TEXT_RESPONSE
    })
  });
  const directHttp = createDirectProviderAdapter({
    providerId: "openai-compatible",
    model: "gpt-5.4-mini",
    transport: "http"
  });
  const routedHttp = createDirectProviderAdapter({
    providerId: "routed-provider",
    model: "gpt-5.4-mini",
    transport: "routed_http"
  });

  return [
    await evaluateSurface("claude_cli", "Claude CLI", claude, request, [
      "Structured JSON usage produces actual cost provenance in the current adapter."
    ]),
    await evaluateSurface("codex_cli", "Codex CLI", codex, request, [
      "Current Codex CLI adapter uses estimated accounting because settled usage is not emitted."
    ]),
    await evaluateSurface("direct_http_contract", "Direct Provider HTTP Contract", directHttp, request, [
      "Current direct-provider contract is present, but no live HTTP responder is wired for RC."
    ]),
    await evaluateSurface("routed_http_contract", "Routed Provider Contract", routedHttp, request, [
      "Current routed-provider contract is present, but no live routed HTTP responder is wired for RC."
    ])
  ];
}

async function evaluateSurface(
  surfaceId: string,
  label: string,
  adapter: MartinAdapter,
  request: MartinAdapterRequest,
  baseNotes: string[]
): Promise<ProviderPathSurface> {
  const result = await adapter.execute(request);
  const accountingMode = toAccountingMode(result.usage.provenance);
  const rcStatus = result.status === "completed" ? "supported_for_rc" : "unsupported_for_rc";

  return {
    surfaceId,
    label,
    kind: adapter.kind,
    providerId: adapter.metadata.providerId,
    model: adapter.metadata.model,
    transport: adapter.metadata.transport ?? (adapter.kind === "agent-cli" ? "cli" : "http"),
    rcStatus,
    accountingMode,
    usageSettlementCapable: adapter.metadata.capabilities?.usageSettlement === true,
    executionStatus: result.status,
    usageProvenance: result.usage.provenance ?? "actual",
    notes: [
      ...baseNotes,
      rcStatus === "supported_for_rc"
        ? `Execution completed with ${accountingMode} accounting.`
        : result.failure?.message ?? "Execution did not complete."
    ]
  };
}

function decideProviderPathVerdict(surfaces: ProviderPathSurface[]): ProviderPathVerdict {
  const supportedCliSurfaces = surfaces.filter(
    (surface) => surface.transport === "cli" && surface.rcStatus === "supported_for_rc"
  );
  const unsupportedContractsAreExplicit = surfaces
    .filter((surface) => surface.transport !== "cli")
    .every((surface) => surface.rcStatus === "unsupported_for_rc" && surface.notes.length > 0);

  return supportedCliSurfaces.length >= 2 && unsupportedContractsAreExplicit ? "go" : "no_go";
}

function createProviderPathRequest(): MartinAdapterRequest {
  return {
    loopId: "loop_provider_matrix",
    attemptId: "att_provider_matrix_1",
    context: {
      taskTitle: "Provider path smoke validation",
      objective: "Classify the current provider path support matrix without changing repo state.",
      verificationPlan: [],
      focus: "Surface transport and accounting behavior only.",
      remainingBudgetUsd: 5,
      remainingIterations: 1,
      remainingTokens: 5_000
    },
    previousAttempts: []
  };
}

function toAccountingMode(
  provenance: MartinAdapterResult["usage"]["provenance"]
): ProviderPathAccountingMode {
  if (provenance === "actual") {
    return "exact";
  }
  if (provenance === "estimated") {
    return "estimated_only";
  }
  return "unavailable";
}

function createSpawnMock(result: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): SpawnLike {
  return () => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = (() => true) as ChildProcess["kill"];

    queueMicrotask(() => {
      if (result.stdout) {
        stdout.write(result.stdout);
      }
      if (result.stderr) {
        stderr.write(result.stderr);
      }
      stdout.end();
      stderr.end();
      child.emit("close", result.exitCode ?? 0);
    });

    return child;
  };
}
