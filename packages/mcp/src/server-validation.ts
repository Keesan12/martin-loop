import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

import { resolveRunsRoot } from "@martin/core";

import {
  invalidArgumentsError,
  invalidPathError,
  invalidSelectorError
} from "./tools/tool-errors.js";
import type { MartinDoctorInput } from "./tools/doctor.js";
import type { MartinEvalInput } from "./tools/eval.js";
import type { MartinGetAttemptInput } from "./tools/get-attempt.js";
import type { MartinGetRunInput } from "./tools/get-run.js";
import type { MartinGetVerificationResultsInput } from "./tools/get-verification-results.js";
import type { GetStatusInput } from "./tools/get-status.js";
import type { InspectLoopInput } from "./tools/inspect-loop.js";
import type { MartinListRunsInput } from "./tools/list-runs.js";
import type { MartinLogsInput } from "./tools/logs.js";
import type { MartinPlanInput } from "./tools/plan.js";
import type { MartinPreflightInput } from "./tools/preflight.js";
import type { MartinCreatePrInput, MartinReviewPrInput } from "./tools/pr-tools.js";
import type { MartinRunDossierInput } from "./tools/run-dossier.js";
import type { MartinRunControlRequestInput } from "./tools/run-controls.js";
import type { RunLoopInput } from "./tools/run-loop.js";
import type { MartinTriageRunsInput } from "./tools/triage-runs.js";
import { MARTIN_ENGINE_VALUES, type MartinEngine } from "./tools/tool-support.js";

type ToolName =
  | "martin_run"
  | "martin_inspect"
  | "martin_status"
  | "martin_doctor"
  | "martin_plan"
  | "martin_preflight"
  | "martin_estimate"
  | "martin_logs"
  | "martin_cancel"
  | "martin_pause"
  | "martin_continue"
  | "martin_list_runs"
  | "martin_triage_runs"
  | "martin_get_run"
  | "martin_get_attempt"
  | "martin_get_verification_results"
  | "martin_run_dossier"
  | "martin_dossier"
  | "martin_eval"
  | "martin_pr_summary"
  | "martin_create_pr"
  | "martin_review_pr";

export { sanitizeToolErrorMessage } from "./tools/tool-errors.js";

export function validateToolInput(name: ToolName, args: unknown): unknown {
  switch (name) {
    case "martin_run":
      return validateRunInput(args);
    case "martin_inspect":
      return validateInspectInput(args);
    case "martin_status":
      return validateStatusInput(args);
    case "martin_doctor":
      return validateDoctorInput(args);
    case "martin_plan":
      return validatePlanInput(args);
    case "martin_preflight":
      return validatePreflightInput(args);
    case "martin_estimate":
      return validateEstimateInput(args);
    case "martin_logs":
      return validateLogsInput(args);
    case "martin_cancel":
    case "martin_pause":
    case "martin_continue":
      return validateRunControlInput(args);
    case "martin_list_runs":
      return validateListRunsInput(args);
    case "martin_triage_runs":
      return validateTriageRunsInput(args);
    case "martin_get_run":
      return validateGetRunInput(args);
    case "martin_get_attempt":
      return validateGetAttemptInput(args);
    case "martin_get_verification_results":
      return validateGetVerificationResultsInput(args);
    case "martin_run_dossier":
    case "martin_dossier":
      return validateRunDossierInput(args);
    case "martin_eval":
      return validateEvalInput(args);
    case "martin_pr_summary":
      return validateRunDossierInput(args);
    case "martin_create_pr":
      return validateCreatePrInput(args);
    case "martin_review_pr":
      return validateReviewPrInput(args);
    default:
      throw invalidArgumentsError(`Unknown tool: ${name}`, "Refresh the Martin tool manifest and retry.");
  }
}

export function resolveSafeRepoRoot(
  repoRoot?: string,
  workspaceRoot: string = process.env.MARTIN_MCP_WORKSPACE_ROOT ?? process.cwd()
): string {
  const baseRoot = resolve(workspaceRoot);
  const candidate = repoRoot ? resolve(baseRoot, repoRoot) : baseRoot;
  assertPathWithinRoot(candidate, baseRoot, "workingDirectory", {
    requireExistingCandidate: true,
    requireExistingRoot: true
  });
  return candidate;
}

export function resolveTrustedLoopRepoRoot(
  repoRoot?: string,
  workspaceRoot: string = process.env.MARTIN_MCP_WORKSPACE_ROOT ?? process.cwd()
): string {
  try {
    return resolveSafeRepoRoot(repoRoot, workspaceRoot);
  } catch {
    throw invalidPathError(
      "Run record points outside the trusted workspace.",
      "Inspect or promote only loop records that were created under the current workspace root."
    );
  }
}

export function resolveSafeRunsJsonPath(
  file: string,
  runsRoot: string = resolveRunsRoot(process.env)
): string {
  const baseRoot = resolve(runsRoot);
  const candidate = resolve(baseRoot, file);
  assertPathWithinRoot(candidate, baseRoot, "file", {
    requireExistingCandidate: true,
    requireExistingRoot: true
  });
  const extension = extname(candidate).toLowerCase();
  if (extension !== ".json" && extension !== ".jsonl") {
    throw invalidPathError(
      "Invalid file.",
      "Point file at a loop-record.json, a legacy .jsonl file, or a run directory under the runs root."
    );
  }
  return candidate;
}

export function resolveSafeRunsPath(
  file: string,
  runsRoot: string = resolveRunsRoot(process.env)
): string {
  const baseRoot = resolve(runsRoot);
  const candidate = resolve(baseRoot, file);
  assertPathWithinRoot(candidate, baseRoot, "file", {
    requireExistingCandidate: true,
    requireExistingRoot: true
  });

  const extension = extname(candidate).toLowerCase();
  if (extension && extension !== ".json" && extension !== ".jsonl") {
    throw invalidPathError(
      "Invalid file.",
      "Point file at a loop-record.json, a legacy .jsonl file, or a run directory under the runs root."
    );
  }

  return candidate;
}

export function resolveSafeRunsRootPath(
  runsRoot?: string,
  fallbackRunsRoot: string = resolveRunsRoot(process.env)
): string {
  const baseRoot = resolve(fallbackRunsRoot);
  const candidate = runsRoot ? resolve(baseRoot, runsRoot) : baseRoot;
  if (runsRoot && !existsSync(candidate)) {
    if (!isAbsolute(runsRoot)) {
      assertRawPathWithinRoot(candidate, baseRoot, "runsDir");
    }
    return candidate;
  }
  assertPathWithinRoot(candidate, baseRoot, "runsDir", {
    requireExistingCandidate: false,
    requireExistingRoot: false
  });
  return candidate;
}

function assertRawPathWithinRoot(candidatePath: string, rootPath: string, name: string): void {
  const relativePath = relative(resolve(rootPath), resolve(candidatePath));
  if (relativePath === "" || relativePath === ".") {
    return;
  }
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw invalidPathError(`Invalid ${name}.`);
  }
}

export function resolveSafeLoopRecordPath(
  loopId: string,
  runsRoot: string = resolveRunsRoot(process.env)
): string {
  const normalizedLoopId = requireLoopId(loopId, "loopId");
  return resolveSafeRunsJsonPath(`${normalizedLoopId}/loop-record.json`, runsRoot);
}

export function normalizeSafePathPatterns(value: unknown, name: string): string[] | undefined {
  const paths = optionalStringArray(value, name);
  if (!paths) {
    return undefined;
  }

  return paths.map((pattern) => {
    const normalized = pattern.replace(/\\/gu, "/").trim();
    if (
      normalized.length === 0 ||
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//u.test(normalized) ||
      normalized.split("/").includes("..")
    ) {
      throw invalidPathError(`Invalid ${name}.`);
    }
    return normalized;
  });
}

function validateRunInput(args: unknown): RunLoopInput {
  const record = requireObject(args);
  assertAllowedKeys(record, [
    "objective",
    "workingDirectory",
    "engine",
    "model",
    "context",
    "policyPack",
    "maxUsd",
    "maxIterations",
    "maxTokens",
    "verifyTimeoutMs",
    "maxMinutes",
    "maxFilesChanged",
    "maxCommands",
    "verificationPlan",
    "allowedPaths",
    "deniedPaths",
    "workspaceId",
    "projectId"
  ]);

  const engine = optionalEnum(record.engine, "engine", MARTIN_ENGINE_VALUES);
  return {
    objective: requireString(record.objective, "objective"),
    ...(record.workingDirectory !== undefined
      ? { workingDirectory: resolveSafeRepoRoot(requireString(record.workingDirectory, "workingDirectory")) }
      : {}),
    ...(engine ? { engine } : {}),
    ...optionalString(record.model, "model"),
    ...optionalString(record.context, "context"),
    ...optionalEnumAsObject(record.policyPack, "policyPack", [
      "solo-founder",
      "startup-team",
      "enterprise-strict",
      "oss-maintainer",
      "security-sensitive"
    ] as const),
    ...optionalPositiveNumber(record.maxUsd, "maxUsd"),
    ...optionalPositiveInteger(record.maxIterations, "maxIterations"),
    ...optionalPositiveInteger(record.maxTokens, "maxTokens"),
    ...optionalPositiveInteger(record.verifyTimeoutMs, "verifyTimeoutMs"),
    ...optionalPositiveInteger(record.maxMinutes, "maxMinutes"),
    ...optionalPositiveInteger(record.maxFilesChanged, "maxFilesChanged"),
    ...optionalPositiveInteger(record.maxCommands, "maxCommands"),
    ...optionalStringArrayAsObject(record.verificationPlan, "verificationPlan"),
    ...optionalPathPatternArrayAsObject(record.allowedPaths, "allowedPaths"),
    ...optionalPathPatternArrayAsObject(record.deniedPaths, "deniedPaths"),
    ...optionalString(record.workspaceId, "workspaceId"),
    ...optionalString(record.projectId, "projectId")
  };
}

function validateInspectInput(args: unknown): InspectLoopInput {
  const record = requireObject(args);
  assertAllowedKeys(record, ["file", "runsDir"]);
  const resolvedRunsDir =
    record.runsDir !== undefined
      ? resolveSafeRunsRootPath(requireString(record.runsDir, "runsDir"))
      : undefined;

  return {
    ...(record.file !== undefined
      ? {
          file: resolveSafeRunsPath(
            requireString(record.file, "file"),
            resolvedRunsDir ?? resolveRunsRoot(process.env)
          )
        }
      : {}),
    ...(resolvedRunsDir ? { runsDir: resolvedRunsDir } : {})
  };
}

function validateStatusInput(args: unknown): GetStatusInput {
  const record = requireObject(args);
  assertAllowedKeys(record, ["loopJson", "file", "loopId", "runsDir", "latest"]);
  const resolvedRunsDir =
    record.runsDir !== undefined
      ? resolveSafeRunsRootPath(requireString(record.runsDir, "runsDir"))
      : undefined;

  const selectors = [
    record.loopJson !== undefined ? "loopJson" : null,
    record.file !== undefined ? "file" : null,
    record.loopId !== undefined ? "loopId" : null,
    record.latest !== undefined ? "latest" : null
  ].filter((value): value is string => value !== null);

  if (selectors.length !== 1) {
    throw invalidSelectorError(
      "Provide exactly one of loopJson, file, loopId, or latest.",
      "Choose exactly one status selector per call."
    );
  }

  if (record.latest !== undefined && record.latest !== true) {
    throw invalidArgumentsError("Invalid latest.", "latest must be the literal boolean value true.");
  }

  return {
    ...(record.loopJson !== undefined
      ? { loopJson: requireString(record.loopJson, "loopJson") }
      : {}),
    ...(record.file !== undefined
      ? {
          file: resolveSafeRunsPath(
            requireString(record.file, "file"),
            resolvedRunsDir ?? resolveRunsRoot(process.env)
          )
        }
      : {}),
    ...(record.loopId !== undefined
      ? {
          loopId: requireLoopId(record.loopId, "loopId")
        }
      : {}),
    ...(resolvedRunsDir ? { runsDir: resolvedRunsDir } : {}),
    ...(record.latest === true ? { latest: true } : {})
  };
}

function validateDoctorInput(args: unknown): MartinDoctorInput {
  const record = requireObject(args);
  assertAllowedKeys(record, ["workingDirectory", "runsDir", "engine"]);

  return {
    ...(record.workingDirectory !== undefined
      ? { workingDirectory: resolveSafeRepoRoot(requireString(record.workingDirectory, "workingDirectory")) }
      : {}),
    ...(record.runsDir !== undefined
      ? { runsDir: resolveSafeRunsRootPath(requireString(record.runsDir, "runsDir")) }
      : {}),
    ...optionalEnumAsObject(record.engine, "engine", MARTIN_ENGINE_VALUES)
  };
}

function validatePreflightInput(args: unknown): MartinPreflightInput {
  return validateRunInput(args);
}

function validatePlanInput(args: unknown): MartinPlanInput {
  return validateRunInput(args);
}

function validateEstimateInput(args: unknown): {
  objective: string;
  engine?: MartinEngine;
  budgetUsd?: number;
  fileScope?: string[];
  workingDirectory?: string;
} {
  const record = requireObject(args);
  assertAllowedKeys(record, ["objective", "engine", "budgetUsd", "fileScope", "workingDirectory"]);

  const engine = optionalEnum(record.engine, "engine", MARTIN_ENGINE_VALUES);
  const fileScope = normalizeSafePathPatterns(record.fileScope, "fileScope");

  return {
    objective: requireString(record.objective, "objective"),
    ...(engine ? { engine } : {}),
    ...optionalPositiveNumber(record.budgetUsd, "budgetUsd"),
    ...(fileScope ? { fileScope } : {}),
    ...(record.workingDirectory !== undefined
      ? { workingDirectory: resolveSafeRepoRoot(requireString(record.workingDirectory, "workingDirectory")) }
      : {})
  };
}

function validateLogsInput(args: unknown): MartinLogsInput {
  const record = requireObject(args);
  assertAllowedKeys(record, ["file", "loopId", "runsDir", "latest", "limit"]);
  const resolvedRunsDir =
    record.runsDir !== undefined
      ? resolveSafeRunsRootPath(requireString(record.runsDir, "runsDir"))
      : undefined;

  const selectors = [
    record.file !== undefined ? "file" : null,
    record.loopId !== undefined ? "loopId" : null,
    record.latest !== undefined ? "latest" : null
  ].filter((value): value is string => value !== null);

  if (selectors.length !== 1) {
    throw invalidSelectorError(
      "Provide exactly one of file, loopId, or latest.",
      "Choose exactly one run selector per call."
    );
  }

  return {
    ...(record.file !== undefined
      ? {
          file: resolveSafeRunsPath(
            requireString(record.file, "file"),
            resolvedRunsDir ?? resolveRunsRoot(process.env)
          )
        }
      : {}),
    ...(record.loopId !== undefined ? { loopId: requireLoopId(record.loopId, "loopId") } : {}),
    ...(resolvedRunsDir ? { runsDir: resolvedRunsDir } : {}),
    ...(record.latest === true ? { latest: true } : {}),
    ...optionalPositiveInteger(record.limit, "limit")
  };
}

function validateListRunsInput(args: unknown): MartinListRunsInput {
  const record = requireObject(args);
  assertAllowedKeys(record, [
    "runsDir",
    "limit",
    "status",
    "lifecycleState",
    "adapterId",
    "model",
    "updatedAfter"
  ]);

  return {
    ...(record.runsDir !== undefined
      ? { runsDir: resolveSafeRunsRootPath(requireString(record.runsDir, "runsDir")) }
      : {}),
    ...optionalPositiveInteger(record.limit, "limit"),
    ...optionalString(record.status, "status"),
    ...optionalString(record.lifecycleState, "lifecycleState"),
    ...optionalString(record.adapterId, "adapterId"),
    ...optionalString(record.model, "model"),
    ...optionalString(record.updatedAfter, "updatedAfter")
  };
}

function validateGetRunInput(args: unknown): MartinGetRunInput {
  const record = requireObject(args);
  assertAllowedKeys(record, ["file", "loopId", "runsDir", "latest"]);
  const resolvedRunsDir =
    record.runsDir !== undefined
      ? resolveSafeRunsRootPath(requireString(record.runsDir, "runsDir"))
      : undefined;

  const selectors = [
    record.file !== undefined ? "file" : null,
    record.loopId !== undefined ? "loopId" : null,
    record.latest !== undefined ? "latest" : null
  ].filter((value): value is string => value !== null);

  if (selectors.length !== 1) {
    throw invalidSelectorError(
      "Provide exactly one of file, loopId, or latest.",
      "Choose exactly one run selector per call."
    );
  }

  if (record.latest !== undefined && record.latest !== true) {
    throw invalidArgumentsError("Invalid latest.", "latest must be the literal boolean value true.");
  }

  return {
    ...(record.file !== undefined
      ? {
          file: resolveSafeRunsPath(
            requireString(record.file, "file"),
            resolvedRunsDir ?? resolveRunsRoot(process.env)
          )
        }
      : {}),
    ...(record.loopId !== undefined
      ? { loopId: requireLoopId(record.loopId, "loopId") }
      : {}),
    ...(resolvedRunsDir ? { runsDir: resolvedRunsDir } : {}),
    ...(record.latest === true ? { latest: true } : {})
  };
}

function validateTriageRunsInput(args: unknown): MartinTriageRunsInput {
  const record = requireObject(args);
  assertAllowedKeys(record, [
    "runsDir",
    "limit",
    "status",
    "lifecycleState",
    "adapterId",
    "model",
    "updatedAfter",
    "includeHealthy"
  ]);

  return {
    ...(record.runsDir !== undefined
      ? { runsDir: resolveSafeRunsRootPath(requireString(record.runsDir, "runsDir")) }
      : {}),
    ...optionalPositiveInteger(record.limit, "limit"),
    ...optionalString(record.status, "status"),
    ...optionalString(record.lifecycleState, "lifecycleState"),
    ...optionalString(record.adapterId, "adapterId"),
    ...optionalString(record.model, "model"),
    ...optionalString(record.updatedAfter, "updatedAfter"),
    ...optionalBoolean(record.includeHealthy, "includeHealthy")
  };
}

function validateGetAttemptInput(args: unknown): MartinGetAttemptInput {
  const record = requireObject(args);
  assertAllowedKeys(record, ["file", "loopId", "runsDir", "attemptIndex"]);
  const resolvedRunsDir =
    record.runsDir !== undefined
      ? resolveSafeRunsRootPath(requireString(record.runsDir, "runsDir"))
      : undefined;

  const selectors = [
    record.file !== undefined ? "file" : null,
    record.loopId !== undefined ? "loopId" : null
  ].filter((value): value is string => value !== null);

  if (selectors.length !== 1) {
    throw invalidSelectorError(
      "Provide exactly one of file or loopId.",
      "Choose exactly one run selector per call."
    );
  }

  return {
    ...(record.file !== undefined
      ? {
          file: resolveSafeRunsPath(
            requireString(record.file, "file"),
            resolvedRunsDir ?? resolveRunsRoot(process.env)
          )
        }
      : {}),
    ...(record.loopId !== undefined
      ? { loopId: requireLoopId(record.loopId, "loopId") }
      : {}),
    ...(resolvedRunsDir ? { runsDir: resolvedRunsDir } : {}),
    ...optionalPositiveInteger(record.attemptIndex, "attemptIndex")
  };
}

function validateGetVerificationResultsInput(
  args: unknown
): MartinGetVerificationResultsInput {
  const record = requireObject(args);
  assertAllowedKeys(record, ["file", "loopId", "runsDir"]);
  const resolvedRunsDir =
    record.runsDir !== undefined
      ? resolveSafeRunsRootPath(requireString(record.runsDir, "runsDir"))
      : undefined;

  const selectors = [
    record.file !== undefined ? "file" : null,
    record.loopId !== undefined ? "loopId" : null
  ].filter((value): value is string => value !== null);

  if (selectors.length !== 1) {
    throw invalidSelectorError(
      "Provide exactly one of file or loopId.",
      "Choose exactly one run selector per call."
    );
  }

  return {
    ...(record.file !== undefined
      ? {
          file: resolveSafeRunsPath(
            requireString(record.file, "file"),
            resolvedRunsDir ?? resolveRunsRoot(process.env)
          )
        }
      : {}),
    ...(record.loopId !== undefined
      ? { loopId: requireLoopId(record.loopId, "loopId") }
      : {}),
    ...(resolvedRunsDir ? { runsDir: resolvedRunsDir } : {})
  };
}

function validateRunDossierInput(args: unknown): MartinRunDossierInput {
  const record = requireObject(args);
  assertAllowedKeys(record, ["file", "loopId", "runsDir", "latest", "format"]);
  const base = validateGetRunInput(args);
  return {
    ...base,
    ...optionalEnumAsObject(record.format, "format", ["json", "md", "github-pr"] as const)
  };
}

function validateEvalInput(args: unknown): MartinEvalInput {
  return validateGetRunInput(args);
}

function validateRunControlInput(args: unknown): MartinRunControlRequestInput {
  const record = requireObject(args);
  assertAllowedKeys(record, ["file", "loopId", "runsDir", "latest", "reason", "requestedBy"]);
  const base = validateGetRunInput(args);
  return {
    ...base,
    ...optionalString(record.reason, "reason"),
    ...optionalString(record.requestedBy, "requestedBy")
  };
}

function validateCreatePrInput(args: unknown): MartinCreatePrInput {
  const record = requireObject(args);
  assertAllowedKeys(record, ["file", "loopId", "runsDir", "latest", "format", "title", "base", "execute"]);
  const base = validateRunDossierInput(args);
  return {
    ...base,
    ...optionalString(record.title, "title"),
    ...optionalString(record.base, "base"),
    ...optionalBoolean(record.execute, "execute")
  };
}

function validateReviewPrInput(args: unknown): MartinReviewPrInput {
  const record = requireObject(args);
  assertAllowedKeys(record, ["file", "loopId", "runsDir", "latest", "format", "prBody"]);
  const base = validateRunDossierInput(args);
  return {
    ...base,
    ...optionalString(record.prBody, "prBody")
  };
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArgumentsError("Tool arguments must be an object.");
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: string[]): void {
  const unknownKeys = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknownKeys.length > 0) {
    throw invalidArgumentsError(`Unknown arguments: ${unknownKeys.join(", ")}`);
  }
}

function assertPathWithinRoot(
  candidatePath: string,
  rootPath: string,
  name: string,
  options: {
    requireExistingCandidate?: boolean;
    requireExistingRoot?: boolean;
  } = {}
): void {
  assertNoSymbolicLinkSegments(candidatePath, name, rootPath);
  const canonicalRoot = canonicalizePath(rootPath, name, options.requireExistingRoot ?? false);
  const canonicalCandidate = canonicalizePath(candidatePath, name, options.requireExistingCandidate ?? false);
  const relativePath = relative(canonicalRoot, canonicalCandidate);
  if (relativePath === "" || relativePath === ".") {
    return;
  }
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw invalidPathError(`Invalid ${name}.`);
  }
}

function assertNoSymbolicLinkSegments(pathValue: string, name: string, stopAtPath?: string): void {
  const stopAt = stopAtPath ? resolve(stopAtPath) : undefined;
  let current = resolve(pathValue);

  while (true) {
    if (existsSync(current)) {
      try {
        const stats = lstatSync(current);
        if (stats.isSymbolicLink()) {
          throw invalidPathError(`Invalid ${name}.`);
        }
      } catch (error) {
        if (error instanceof Error) {
          throw error;
        }
        throw invalidPathError(`Invalid ${name}.`);
      }
    }

    if (stopAt && relative(stopAt, current) === "") {
      break;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
}

function canonicalizePath(pathValue: string, name: string, requireExisting: boolean): string {
  const resolvedPath = resolve(pathValue);
  if (!existsSync(resolvedPath)) {
    if (requireExisting) {
      throw invalidPathError(`Invalid ${name}.`);
    }
    return resolvedPath;
  }

  try {
    const stats = lstatSync(resolvedPath);
    if (stats.isSymbolicLink()) {
      throw invalidPathError(`Invalid ${name}.`);
    }
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw invalidPathError(`Invalid ${name}.`);
  }

  try {
    return realpathSync.native(resolvedPath);
  } catch {
    throw invalidPathError(`Invalid ${name}.`);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidArgumentsError(`Invalid ${name}.`);
  }
  return value.trim();
}

function requireLoopId(value: unknown, name: string): string {
  const loopId = requireString(value, name);
  if (!/^[A-Za-z0-9._-]+$/u.test(loopId)) {
    throw invalidPathError(`Invalid ${name}.`, "loopId may only include letters, numbers, dots, underscores, and hyphens.");
  }
  return loopId;
}

function optionalString(value: unknown, name: string): Partial<Record<typeof name, string>> {
  if (value === undefined) {
    return {};
  }
  return { [name]: requireString(value, name) } as Partial<Record<typeof name, string>>;
}

function optionalPositiveNumber(
  value: unknown,
  name: string
): Partial<Record<typeof name, number>> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalidArgumentsError(`Invalid ${name}.`);
  }
  return { [name]: value } as Partial<Record<typeof name, number>>;
}

function optionalPositiveInteger(
  value: unknown,
  name: string
): Partial<Record<typeof name, number>> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalidArgumentsError(`Invalid ${name}.`);
  }
  return { [name]: value } as Partial<Record<typeof name, number>>;
}

function optionalNonNegativeInteger(
  value: unknown,
  name: string
): Partial<Record<typeof name, number>> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalidArgumentsError(`Invalid ${name}.`);
  }
  return { [name]: value } as Partial<Record<typeof name, number>>;
}

function optionalBoolean(
  value: unknown,
  name: string
): Partial<Record<typeof name, boolean>> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "boolean") {
    throw invalidArgumentsError(`Invalid ${name}.`);
  }
  return { [name]: value } as Partial<Record<typeof name, boolean>>;
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw invalidArgumentsError(`Invalid ${name}.`);
  }
  return value.map((item) => requireString(item, name));
}

function optionalStringArrayAsObject(
  value: unknown,
  name: string
): Partial<Record<typeof name, string[]>> {
  const values = optionalStringArray(value, name);
  return values ? ({ [name]: values } as Partial<Record<typeof name, string[]>>) : {};
}

function optionalPathPatternArrayAsObject(
  value: unknown,
  name: string
): Partial<Record<typeof name, string[]>> {
  const values = normalizeSafePathPatterns(value, name);
  return values ? ({ [name]: values } as Partial<Record<typeof name, string[]>>) : {};
}

function optionalEnum<T extends readonly string[]>(
  value: unknown,
  name: string,
  allowed: T
): T[number] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw invalidArgumentsError(`Invalid ${name}.`);
  }
  return value;
}

function optionalEnumAsObject<T extends readonly string[]>(
  value: unknown,
  name: string,
  allowed: T
): Partial<Record<typeof name, T[number]>> {
  const enumValue = optionalEnum(value, name, allowed);
  return enumValue ? ({ [name]: enumValue } as Partial<Record<typeof name, T[number]>>) : {};
}
