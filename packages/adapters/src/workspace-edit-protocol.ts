import { lstat, mkdir, readFile, readdir, rmdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, posix, relative, resolve, sep, win32 } from "node:path";

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

export interface AppliedWorkspaceEdits {
  changedFiles: string[];
  summary?: string;
  rollback: () => Promise<void>;
}

const DEFAULT_MAX_FILES = 48;
const DEFAULT_MAX_BYTES = 120_000;
const DEFAULT_MAX_FILE_BYTES = 24_000;
export const MAX_WORKSPACE_EDIT_CHANGES = 64;
export const MAX_WORKSPACE_EDIT_FILE_BYTES = 262_144;
export const MAX_WORKSPACE_EDIT_TOTAL_BYTES = 524_288;
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
  return value.replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, "");
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
  const segments = normalized.split("/");
  if (
    !normalized ||
    posix.isAbsolute(path) ||
    win32.isAbsolute(path) ||
    segments.includes("..")
  ) {
    throw new Error(`WORKSPACE_EDIT_INVALID_PATH: ${path}`);
  }
  const target = resolve(workingDirectory, normalized);
  const rel = relative(resolve(workingDirectory), target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || posix.isAbsolute(rel) || win32.isAbsolute(rel)) {
    throw new Error(`WORKSPACE_EDIT_PATH_ESCAPE: ${path}`);
  }
  return normalizePath(rel);
}

function canonicalTargetKey(path: string, workingDirectory: string): string {
  const absolute = resolve(workingDirectory, path);
  return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
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

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], diagnostic: string): void {
  const extra = Object.keys(record).find((key) => !allowed.includes(key));
  if (extra) {
    throw new Error(`${diagnostic}: unexpected field ${extra}`);
  }
}

export function parseWorkspaceEditPlan(responseText: string): WorkspaceEditPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch (error) {
    throw new Error(
      `WORKSPACE_EDIT_PROTOCOL_INVALID_JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("WORKSPACE_EDIT_PROTOCOL_INVALID_SHAPE: expected JSON object");
  }

  const record = parsed as Record<string, unknown>;
  assertExactKeys(record, ["summary", "edits", "deletions"], "WORKSPACE_EDIT_PROTOCOL_INVALID_SHAPE");
  if (record.summary !== undefined && typeof record.summary !== "string") {
    throw new Error("WORKSPACE_EDIT_PROTOCOL_INVALID_SHAPE: summary must be a string");
  }
  const rawEdits = record.edits;
  const rawDeletions = record.deletions;
  if (!Array.isArray(rawEdits) || !Array.isArray(rawDeletions)) {
    throw new Error("WORKSPACE_EDIT_PROTOCOL_INVALID_SHAPE: edits/deletions must be arrays");
  }
  if (rawEdits.length + rawDeletions.length > MAX_WORKSPACE_EDIT_CHANGES) {
    throw new Error(`WORKSPACE_EDIT_PROTOCOL_TOO_MANY_CHANGES: maximum is ${String(MAX_WORKSPACE_EDIT_CHANGES)}`);
  }

  let totalContentBytes = 0;
  const edits: WorkspaceEdit[] = rawEdits.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`WORKSPACE_EDIT_PROTOCOL_INVALID_EDIT: edits[${index}]`);
    }
    const edit = entry as Record<string, unknown>;
    assertExactKeys(edit, ["path", "content"], `WORKSPACE_EDIT_PROTOCOL_INVALID_EDIT: edits[${String(index)}]`);
    if (typeof edit.path !== "string" || typeof edit.content !== "string") {
      throw new Error(`WORKSPACE_EDIT_PROTOCOL_INVALID_EDIT: edits[${index}] requires path/content strings`);
    }
    const contentBytes = Buffer.byteLength(edit.content, "utf8");
    if (contentBytes > MAX_WORKSPACE_EDIT_FILE_BYTES) {
      throw new Error(
        `WORKSPACE_EDIT_PROTOCOL_FILE_TOO_LARGE: edits[${String(index)}] exceeds ${String(MAX_WORKSPACE_EDIT_FILE_BYTES)} bytes`,
      );
    }
    totalContentBytes += contentBytes;
    if (totalContentBytes > MAX_WORKSPACE_EDIT_TOTAL_BYTES) {
      throw new Error(
        `WORKSPACE_EDIT_PROTOCOL_TOTAL_TOO_LARGE: edit content exceeds ${String(MAX_WORKSPACE_EDIT_TOTAL_BYTES)} bytes`,
      );
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
): Promise<AppliedWorkspaceEdits> {
  const normalizedEdits = plan.edits.map((edit) => ({
    ...edit,
    path: assertSafeRelativePath(edit.path, options.workingDirectory),
  }));
  const normalizedDeletions = plan.deletions.map((path) =>
    assertSafeRelativePath(path, options.workingDirectory),
  );

  const editKeys = new Map<string, string>();
  for (const edit of normalizedEdits) {
    const key = canonicalTargetKey(edit.path, options.workingDirectory);
    if (editKeys.has(key)) {
      throw new Error(`WORKSPACE_EDIT_PROTOCOL_DUPLICATE_PATH: ${edit.path}`);
    }
    editKeys.set(key, edit.path);
  }
  const deletionKeys = new Map<string, string>();
  for (const path of normalizedDeletions) {
    const key = canonicalTargetKey(path, options.workingDirectory);
    if (editKeys.has(key)) {
      throw new Error(`WORKSPACE_EDIT_PROTOCOL_EDIT_DELETE_COLLISION: ${path}`);
    }
    if (deletionKeys.has(key)) {
      throw new Error(`WORKSPACE_EDIT_PROTOCOL_DUPLICATE_PATH: ${path}`);
    }
    deletionKeys.set(key, path);
  }
  const proposedPaths = [...editKeys.values(), ...deletionKeys.values()];

  for (const path of proposedPaths) {
    if (!pathAllowedByGovernance(path, options.allowedPaths, options.deniedPaths)) {
      throw new Error(`WORKSPACE_EDIT_GOVERNANCE_REJECTED: ${path}`);
    }
    await assertNoSymlinkTraversal(path, options.workingDirectory);
  }

  const originals = new Map<string, Buffer | undefined>();
  const createdDirectories = new Set<string>();
  const root = resolve(options.workingDirectory);
  for (const path of proposedPaths) {
    const target = resolve(root, path);
    try {
      const info = await lstat(target);
      if (!info.isFile()) {
        throw new Error(`WORKSPACE_EDIT_TARGET_NOT_FILE: ${path}`);
      }
      originals.set(path, await readFile(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      originals.set(path, undefined);
    }
  }
  for (const path of normalizedDeletions) {
    if (originals.get(path) === undefined) {
      throw new Error(`WORKSPACE_EDIT_PROTOCOL_NO_EFFECTIVE_CHANGES: deletion target does not exist: ${path}`);
    }
  }
  for (const edit of normalizedEdits) {
    const original = originals.get(edit.path);
    if (original !== undefined && original.equals(Buffer.from(edit.content, "utf8"))) {
      throw new Error(`WORKSPACE_EDIT_PROTOCOL_NO_EFFECTIVE_CHANGES: identical content for ${edit.path}`);
    }
  }

  const rollback = async (): Promise<void> => {
    for (const path of [...proposedPaths].reverse()) {
      const target = resolve(root, path);
      const original = originals.get(path);
      if (original === undefined) {
        await rm(target, { force: true });
      } else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, original);
      }
    }
    const directories = [...createdDirectories].sort((a, b) => b.length - a.length);
    for (const directory of directories) {
      try {
        await rmdir(directory);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
      }
    }
  };

  try {
    for (const edit of normalizedEdits) {
      const target = resolve(root, edit.path);
      let cursor = dirname(target);
      while (cursor !== root && cursor.startsWith(`${root}${sep}`)) {
        try {
          await lstat(cursor);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          createdDirectories.add(cursor);
        }
        cursor = dirname(cursor);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, edit.content, "utf8");
    }
    for (const path of normalizedDeletions) {
      await rm(resolve(root, path));
    }
  } catch (error) {
    await rollback();
    throw error;
  }

  return {
    changedFiles: proposedPaths,
    ...(plan.summary ? { summary: plan.summary } : {}),
    rollback,
  };
}

export async function applyWorkspaceEdits(
  options: ApplyWorkspaceEditsOptions,
): Promise<AppliedWorkspaceEdits> {
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
