import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface WorkspaceEdit {
  path: string;
  content: string;
}

export interface WorkspaceEditPlan {
  summary?: string;
  edits: WorkspaceEdit[];
  deletions: string[];
}

export interface WorkspaceSnapshotOptions {
  workingDirectory: string;
  allowedPaths?: string[];
  deniedPaths?: string[];
  maxFiles?: number;
  maxBytes?: number;
  maxFileBytes?: number;
}

export interface ApplyWorkspaceEditsOptions {
  workingDirectory: string;
  responseText: string;
  allowedPaths?: string[];
  deniedPaths?: string[];
}

const DEFAULT_MAX_FILES = 48;
const DEFAULT_MAX_BYTES = 120_000;
const DEFAULT_MAX_FILE_BYTES = 24_000;
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".martin",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern.trim());
  let source = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i] ?? "";
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      continue;
    }
    source += ch.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  source += "$";
  return new RegExp(source, "u");
}

function matchesAny(path: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }
  const normalized = normalizePath(path);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

export function pathAllowedByGovernance(
  path: string,
  allowedPaths: string[] | undefined,
  deniedPaths: string[] | undefined,
): boolean {
  const normalized = normalizePath(path);
  if (matchesAny(normalized, deniedPaths)) {
    return false;
  }
  if (!allowedPaths || allowedPaths.length === 0) {
    return true;
  }
  return matchesAny(normalized, allowedPaths);
}

function assertSafeRelativePath(path: string, workingDirectory: string): string {
  const normalized = normalizePath(path.trim());
  if (!normalized || isAbsolute(path) || normalized.startsWith("../") || normalized === "..") {
    throw new Error(`WORKSPACE_EDIT_INVALID_PATH: ${path}`);
  }
  const target = resolve(workingDirectory, normalized);
  const rel = relative(resolve(workingDirectory), target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`WORKSPACE_EDIT_PATH_ESCAPE: ${path}`);
  }
  return normalized;
}

async function assertNoSymlinkTraversal(path: string, workingDirectory: string): Promise<void> {
  const root = resolve(workingDirectory);
  const segments = normalizePath(path).split("/").filter(Boolean);
  let cursor = root;

  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new Error(`WORKSPACE_EDIT_SYMLINK_REJECTED: ${path}`);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

function extractJsonPayload(responseText: string): string {
  const trimmed = responseText.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]?.trim();
  if (fenced) {
    return fenced;
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }
  return trimmed;
}

export function parseWorkspaceEditPlan(responseText: string): WorkspaceEditPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonPayload(responseText));
  } catch (error) {
    throw new Error(
      `WORKSPACE_EDIT_PROTOCOL_INVALID_JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("WORKSPACE_EDIT_PROTOCOL_INVALID_SHAPE: expected JSON object");
  }

  const record = parsed as Record<string, unknown>;
  const rawEdits = record.edits ?? [];
  const rawDeletions = record.deletions ?? [];
  if (!Array.isArray(rawEdits) || !Array.isArray(rawDeletions)) {
    throw new Error("WORKSPACE_EDIT_PROTOCOL_INVALID_SHAPE: edits/deletions must be arrays");
  }

  const edits: WorkspaceEdit[] = rawEdits.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`WORKSPACE_EDIT_PROTOCOL_INVALID_EDIT: edits[${index}]`);
    }
    const edit = entry as Record<string, unknown>;
    if (typeof edit.path !== "string" || typeof edit.content !== "string") {
      throw new Error(`WORKSPACE_EDIT_PROTOCOL_INVALID_EDIT: edits[${index}] requires path/content strings`);
    }
    return { path: edit.path, content: edit.content };
  });

  const deletions = rawDeletions.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`WORKSPACE_EDIT_PROTOCOL_INVALID_DELETION: deletions[${index}]`);
    }
    return entry;
  });

  if (edits.length === 0 && deletions.length === 0) {
    throw new Error("WORKSPACE_EDIT_PROTOCOL_NO_CHANGES: model returned no workspace edits");
  }

  return {
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
    edits,
    deletions,
  };
}

export async function applyWorkspaceEditPlan(
  plan: WorkspaceEditPlan,
  options: Omit<ApplyWorkspaceEditsOptions, "responseText">,
): Promise<{ changedFiles: string[]; summary?: string }> {
  const normalizedEdits = plan.edits.map((edit) => ({
    ...edit,
    path: assertSafeRelativePath(edit.path, options.workingDirectory),
  }));
  const normalizedDeletions = plan.deletions.map((path) =>
    assertSafeRelativePath(path, options.workingDirectory),
  );

  const proposedPaths = [
    ...normalizedEdits.map((edit) => edit.path),
    ...normalizedDeletions,
  ];
  const duplicate = proposedPaths.find((path, index) => proposedPaths.indexOf(path) !== index);
  if (duplicate) {
    throw new Error(`WORKSPACE_EDIT_PROTOCOL_DUPLICATE_PATH: ${duplicate}`);
  }

  for (const path of proposedPaths) {
    if (!pathAllowedByGovernance(path, options.allowedPaths, options.deniedPaths)) {
      throw new Error(`WORKSPACE_EDIT_GOVERNANCE_REJECTED: ${path}`);
    }
    await assertNoSymlinkTraversal(path, options.workingDirectory);
  }

  for (const edit of normalizedEdits) {
    const target = resolve(options.workingDirectory, edit.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, edit.content, "utf8");
  }
  for (const path of normalizedDeletions) {
    await rm(resolve(options.workingDirectory, path), { force: true });
  }

  return {
    changedFiles: proposedPaths,
    ...(plan.summary ? { summary: plan.summary } : {}),
  };
}

export async function applyWorkspaceEdits(
  options: ApplyWorkspaceEditsOptions,
): Promise<{ changedFiles: string[]; summary?: string }> {
  return applyWorkspaceEditPlan(parseWorkspaceEditPlan(options.responseText), options);
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const absolute = resolve(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, absolute)));
      continue;
    }
    if (entry.isFile()) {
      files.push(normalizePath(relative(root, absolute)));
    }
  }
  return files;
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  return sample.includes(0);
}

function scoreSnapshotPath(
  path: string,
  allowedPaths: string[] | undefined,
  deniedPaths: string[] | undefined,
): number {
  let score = 0;
  if (matchesAny(path, allowedPaths)) score += 100;
  if (matchesAny(path, deniedPaths)) score += 50;
  if (/^(?:src|app|lib|test|tests|config)\//u.test(path)) score += 25;
  if (/^(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|README\.md)$/u.test(path)) score += 20;
  if (/\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|json|yaml|yml|toml|md)$/u.test(path)) score += 10;
  return score;
}

export async function buildWorkspaceSnapshot(
  options: WorkspaceSnapshotOptions,
): Promise<string> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const root = resolve(options.workingDirectory);
  const candidates = (await walkFiles(root)).sort((a, b) => {
    const scoreDelta =
      scoreSnapshotPath(b, options.allowedPaths, options.deniedPaths) -
      scoreSnapshotPath(a, options.allowedPaths, options.deniedPaths);
    return scoreDelta || a.localeCompare(b);
  });

  const sections: string[] = [];
  let totalBytes = 0;
  let included = 0;
  for (const path of candidates) {
    if (included >= maxFiles || totalBytes >= maxBytes) break;
    const absolute = resolve(root, path);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      continue;
    }
    if (!info.isFile() || info.size > maxFileBytes) continue;
    let buffer: Buffer;
    try {
      buffer = await readFile(absolute);
    } catch {
      continue;
    }
    if (isProbablyBinary(buffer)) continue;
    const content = buffer.toString("utf8");
    const section = `--- FILE: ${path} ---\n${content}\n--- END FILE ---`;
    const sectionBytes = Buffer.byteLength(section, "utf8");
    if (totalBytes + sectionBytes > maxBytes) continue;
    sections.push(section);
    totalBytes += sectionBytes;
    included += 1;
  }

  return sections.join("\n\n");
}
