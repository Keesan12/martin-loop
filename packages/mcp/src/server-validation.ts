import { extname, isAbsolute, relative, resolve } from "node:path";

import { resolveRunsRoot } from "@martin/core";

import type { GetStatusInput } from "./tools/get-status.js";
import type { InspectLoopInput } from "./tools/inspect-loop.js";
import type { RunLoopInput } from "./tools/run-loop.js";

type ToolName = "martin_run" | "martin_inspect" | "martin_status";

export function validateToolInput(name: ToolName, args: unknown): unknown {
  switch (name) {
    case "martin_run":
      return validateRunInput(args);
    case "martin_inspect":
      return validateInspectInput(args);
    case "martin_status":
      return validateStatusInput(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function sanitizeToolErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /([A-Za-z]:\\|\/|policy\.rego|policy\.wasm|\.pem|\.env)/u.test(message)
    ? "Tool execution failed."
    : message;
}

export function resolveSafeRepoRoot(
  repoRoot?: string,
  workspaceRoot: string = process.env.MARTIN_MCP_WORKSPACE_ROOT ?? process.cwd()
): string {
  const baseRoot = resolve(workspaceRoot);
  const candidate = repoRoot ? resolve(baseRoot, repoRoot) : baseRoot;
  assertPathWithinRoot(candidate, baseRoot, "workingDirectory");
  return candidate;
}

export function resolveSafeRunsJsonPath(
  file: string,
  runsRoot: string = resolveRunsRoot(process.env)
): string {
  const baseRoot = resolve(runsRoot);
  const candidate = resolve(baseRoot, file);
  assertPathWithinRoot(candidate, baseRoot, "file");
  const extension = extname(candidate).toLowerCase();
  if (extension !== ".json" && extension !== ".jsonl") {
    throw new Error("Invalid file.");
  }
  return candidate;
}

export function resolveSafeRunsPath(
  file: string,
  runsRoot: string = resolveRunsRoot(process.env)
): string {
  const baseRoot = resolve(runsRoot);
  const candidate = resolve(baseRoot, file);
  assertPathWithinRoot(candidate, baseRoot, "file");

  const extension = extname(candidate).toLowerCase();
  if (extension && extension !== ".json" && extension !== ".jsonl") {
    throw new Error("Invalid file.");
  }

  return candidate;
}

export function resolveSafeRunsRootPath(
  runsRoot?: string,
  fallbackRunsRoot: string = resolveRunsRoot(process.env)
): string {
  const baseRoot = resolve(fallbackRunsRoot);
  const candidate = runsRoot ? resolve(baseRoot, runsRoot) : baseRoot;
  assertPathWithinRoot(candidate, baseRoot, "runsDir");
  return candidate;
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
      throw new Error(`Invalid ${name}.`);
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
    "maxUsd",
    "maxIterations",
    "maxTokens",
    "verificationPlan",
    "allowedPaths",
    "deniedPaths",
    "workspaceId",
    "projectId"
  ]);

  const engine = optionalEnum(record.engine, "engine", ["claude", "codex"] as const);
  return {
    objective: requireString(record.objective, "objective"),
    ...(record.workingDirectory !== undefined
      ? { workingDirectory: resolveSafeRepoRoot(requireString(record.workingDirectory, "workingDirectory")) }
      : {}),
    ...(engine ? { engine } : {}),
    ...optionalString(record.model, "model"),
    ...optionalPositiveNumber(record.maxUsd, "maxUsd"),
    ...optionalPositiveInteger(record.maxIterations, "maxIterations"),
    ...optionalPositiveInteger(record.maxTokens, "maxTokens"),
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
  return {
    ...(record.file !== undefined
      ? { file: resolveSafeRunsPath(requireString(record.file, "file")) }
      : {}),
    ...(record.runsDir !== undefined
      ? { runsDir: resolveSafeRunsRootPath(requireString(record.runsDir, "runsDir")) }
      : {})
  };
}

function validateStatusInput(args: unknown): GetStatusInput {
  const record = requireObject(args);
  assertAllowedKeys(record, ["loopJson", "file", "loopId", "runsDir", "latest"]);

  const selectors = [
    record.loopJson !== undefined ? "loopJson" : null,
    record.file !== undefined ? "file" : null,
    record.loopId !== undefined ? "loopId" : null,
    record.latest !== undefined ? "latest" : null
  ].filter((value): value is string => value !== null);

  if (selectors.length !== 1) {
    throw new Error("Provide exactly one of loopJson, file, loopId, or latest.");
  }

  if (record.latest !== undefined && record.latest !== true) {
    throw new Error("Invalid latest.");
  }

  return {
    ...(record.loopJson !== undefined
      ? { loopJson: requireString(record.loopJson, "loopJson") }
      : {}),
    ...(record.file !== undefined
      ? { file: resolveSafeRunsPath(requireString(record.file, "file")) }
      : {}),
    ...(record.loopId !== undefined
      ? { loopId: requireLoopId(record.loopId, "loopId") }
      : {}),
    ...(record.runsDir !== undefined
      ? { runsDir: resolveSafeRunsRootPath(requireString(record.runsDir, "runsDir")) }
      : {}),
    ...(record.latest === true ? { latest: true } : {})
  };
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object.");
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: string[]): void {
  const unknownKeys = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown arguments: ${unknownKeys.join(", ")}`);
  }
}

function assertPathWithinRoot(candidatePath: string, rootPath: string, name: string): void {
  const relativePath = relative(rootPath, candidatePath);
  if (relativePath === "" || relativePath === ".") {
    return;
  }
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Invalid ${name}.`);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${name}.`);
  }
  return value.trim();
}

function requireLoopId(value: unknown, name: string): string {
  const loopId = requireString(value, name);
  if (!/^[A-Za-z0-9._-]+$/u.test(loopId)) {
    throw new Error(`Invalid ${name}.`);
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
    throw new Error(`Invalid ${name}.`);
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
    throw new Error(`Invalid ${name}.`);
  }
  return { [name]: value } as Partial<Record<typeof name, number>>;
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${name}.`);
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
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}
