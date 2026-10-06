import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { SWARM_SCHEMA_VERSION } from "@martin/contracts";
import type {
  SwarmCleanupRecord,
  SwarmWorkspaceKind,
  SwarmWorkspaceRecord
} from "@martin/contracts";

const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const FILENAME_SAFE_ID = /^[a-z0-9](?:[a-z0-9_-]|\.(?=[a-z0-9_-])){0,127}$/iu;

export interface SwarmGitCommand {
  readonly cwd: string;
  readonly args: readonly string[];
}

export interface SwarmGitResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type SwarmGitRunner = (command: SwarmGitCommand) => Promise<SwarmGitResult>;

export interface SwarmWorkspaceFs {
  mkdir(path: string): Promise<void>;
  realpath(path: string): Promise<string>;
  pathExists(path: string): Promise<boolean>;
  rm?(path: string): Promise<void>;
}

export type SwarmWorkspaceSpec =
  | {
      readonly kind: "child";
      readonly workspaceId: string;
      readonly childRunId: string;
      readonly agentId: string;
      readonly taskIds: readonly string[];
    }
  | {
      readonly kind: "integration";
      readonly workspaceId: string;
    }
  | {
      readonly kind: "verifier";
      readonly workspaceId: string;
    };

/** Runtime-only capability. Its absolute path must never be copied into shareable evidence. */
export interface SwarmWorkspaceRuntimeHandle {
  readonly path: string;
  readonly record: SwarmWorkspaceRecord;
  readonly isolationMode?: "worktree" | "independent_clone";
}

export interface SwarmWorkspaceCleanupGate {
  readonly evidencePersisted: boolean;
  readonly processTreeClosed: boolean;
  readonly force?: boolean;
  readonly ownedProcessId?: number;
}

export interface SwarmWorkspaceManager {
  readonly baselineCommit: string;
  readonly canonicalRoot: string;
  readonly ownedRoot: string;
  createWorkspace(spec: SwarmWorkspaceSpec): Promise<SwarmWorkspaceRuntimeHandle>;
  removeWorkspace(
    handle: SwarmWorkspaceRuntimeHandle,
    gate: SwarmWorkspaceCleanupGate
  ): Promise<SwarmCleanupRecord>;
}

export interface CreateSwarmWorkspaceManagerInput {
  readonly canonicalRoot: string;
  readonly ownedRoot: string;
  readonly swarmId: string;
  readonly isolationMode?: "worktree" | "independent_clone";
  readonly gitRunner?: SwarmGitRunner;
  readonly fs?: SwarmWorkspaceFs;
  readonly now?: () => string;
  readonly createCleanupId?: () => string;
}

export class SwarmWorkspaceError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SwarmWorkspaceError";
    this.code = code;
  }
}

export class SwarmWorkspaceCreationError extends SwarmWorkspaceError {
  readonly originalCode: string;
  readonly cleanup: SwarmCleanupRecord;
  readonly recoveryHandle: SwarmWorkspaceRuntimeHandle;

  constructor(input: {
    original: SwarmWorkspaceError;
    cleanup: SwarmCleanupRecord;
    recoveryHandle: SwarmWorkspaceRuntimeHandle;
  }) {
    super(
      "WORKTREE_VALIDATION_CLEANUP_PENDING",
      `Workspace validation failed (${input.original.code}) and exact-path rollback is pending.`,
      { cause: input.original }
    );
    this.name = "SwarmWorkspaceCreationError";
    this.originalCode = input.original.code;
    this.cleanup = input.cleanup;
    this.recoveryHandle = input.recoveryHandle;
  }
}

interface RegisteredWorkspace {
  readonly handle: SwarmWorkspaceRuntimeHandle;
  readonly path: string;
  readonly realPath: string;
  readonly record: SwarmWorkspaceRecord;
  readonly validated: boolean;
  readonly isolationMode: "worktree" | "independent_clone";
}

interface ListedWorktree {
  path: string;
  head?: string;
}

export async function createSwarmWorkspaceManager(
  input: CreateSwarmWorkspaceManagerInput
): Promise<SwarmWorkspaceManager> {
  assertSwarmPathIdentifier(input.swarmId, "swarm ID");
  const gitRunner = input.gitRunner ?? runGit;
  const fs = input.fs ?? defaultFs;
  const now = input.now ?? (() => new Date().toISOString());
  const createCleanupId = input.createCleanupId ?? (() => `cleanup-${randomUUID()}`);
  const isolationMode = input.isolationMode ?? "worktree";

  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(resolve(input.canonicalRoot));
  } catch (error) {
    throw new SwarmWorkspaceError(
      "CANONICAL_ROOT_UNAVAILABLE",
      "Canonical root is unavailable or is not a Git repository.",
      { cause: error }
    );
  }

  const topLevel = await gitScalarOrThrow(
    gitRunner,
    canonicalRoot,
    ["rev-parse", "--show-toplevel"],
    "NOT_A_GIT_REPOSITORY",
    "Canonical root must be a Git repository."
  );
  const realTopLevel = await fs.realpath(resolve(topLevel));
  if (!pathsEqual(canonicalRoot, realTopLevel)) {
    throw new SwarmWorkspaceError(
      "CANONICAL_ROOT_NOT_TOP_LEVEL",
      "Canonical root must be the real Git repository top level."
    );
  }

  await assertCanonicalClean(gitRunner, canonicalRoot);
  const baselineCommit = await gitScalarOrThrow(
    gitRunner,
    canonicalRoot,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "BASELINE_UNAVAILABLE",
    "Unable to resolve one immutable canonical baseline commit."
  );

  await fs.mkdir(resolve(input.ownedRoot));
  const ownedRoot = await fs.realpath(resolve(input.ownedRoot));
  if (pathsEqual(ownedRoot, canonicalRoot) || isPathContained(ownedRoot, canonicalRoot)) {
    throw new SwarmWorkspaceError(
      "UNSAFE_OWNED_ROOT",
      "Swarm-owned root must not be the canonical checkout or one of its ancestors."
    );
  }
  // Creating an in-repository owned root is safe only when repository ignore
  // policy keeps that runtime state out of the canonical worktree.
  await assertCanonicalClean(gitRunner, canonicalRoot);

  const registered = new Map<SwarmWorkspaceRuntimeHandle, RegisteredWorkspace>();
  const registeredIds = new Set<string>();
  let operationTail: Promise<void> = Promise.resolve();

  const runExclusively = async <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = operationTail.then(operation, operation);
    operationTail = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const createWorkspace = async (
    spec: SwarmWorkspaceSpec
  ): Promise<SwarmWorkspaceRuntimeHandle> => runExclusively(async () => {
    assertSwarmPathIdentifier(spec.workspaceId, "workspace ID");
    if (registeredIds.has(spec.workspaceId)) {
      throw new SwarmWorkspaceError(
        "DUPLICATE_WORKSPACE_ID",
        `Workspace ID is already registered: ${spec.workspaceId}`
      );
    }
    validateSpec(spec);
    await assertCanonicalClean(gitRunner, canonicalRoot);
    const currentHead = await gitScalarOrThrow(
      gitRunner,
      canonicalRoot,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      "BASELINE_UNAVAILABLE",
      "Unable to verify the canonical baseline commit."
    );
    if (currentHead !== baselineCommit) {
      throw new SwarmWorkspaceError(
        "CANONICAL_BASELINE_CHANGED",
        "Canonical HEAD no longer matches the captured swarm baseline."
      );
    }

    const workspacePath = resolve(join(ownedRoot, spec.workspaceId));
    if (!isStrictlyContained(ownedRoot, workspacePath)) {
      throw new SwarmWorkspaceError(
        "WORKSPACE_PATH_ESCAPE",
        "Workspace path escapes the real swarm-owned root."
      );
    }
    if (await fs.pathExists(workspacePath)) {
      throw new SwarmWorkspaceError(
        "WORKSPACE_PATH_EXISTS",
        `Workspace path already exists for ID: ${spec.workspaceId}`
      );
    }

    if (isolationMode === "independent_clone") {
      await runGitOrThrow(
        gitRunner,
        canonicalRoot,
        ["clone", "--no-hardlinks", "--no-checkout", canonicalRoot, workspacePath],
        "CLONE_CREATE_FAILED",
        `Git could not create isolated clone ${spec.workspaceId}.`
      );
      await runGitOrThrow(
        gitRunner,
        workspacePath,
        ["-c", "core.autocrlf=false", "checkout", "--detach", baselineCommit],
        "CLONE_CHECKOUT_FAILED",
        `Git could not checkout the immutable baseline for ${spec.workspaceId}.`
      );
    } else {
      await runGitOrThrow(
        gitRunner,
        canonicalRoot,
        ["-c", "core.autocrlf=false", "worktree", "add", "--detach", workspacePath, baselineCommit],
        "WORKTREE_CREATE_FAILED",
        `Git could not create detached workspace ${spec.workspaceId}.`
      );
    }

    let workspaceRealPath = workspacePath;
    try {
      workspaceRealPath = await fs.realpath(workspacePath);
      if (!isStrictlyContained(ownedRoot, workspaceRealPath)) {
        throw new SwarmWorkspaceError(
          "WORKSPACE_REALPATH_ESCAPE",
          "Created workspace resolves outside the real swarm-owned root."
        );
      }
      if (pathsEqual(workspaceRealPath, canonicalRoot)) {
        throw new SwarmWorkspaceError(
          "CANONICAL_WORKSPACE_FORBIDDEN",
          "A mutating swarm workspace cannot be the canonical checkout."
        );
      }

      if (isolationMode === "independent_clone") {
        await assertIndependentCloneIdentity({
          gitRunner,
          fs,
          workspaceRealPath,
          baselineCommit
        });
      } else {
        await assertWorktreeIdentity({
          gitRunner,
          fs,
          canonicalRoot,
          workspaceRealPath,
          baselineCommit
        });
      }
    } catch (validationFailure) {
      const original = asWorkspaceError(validationFailure);
      const attemptedAt = now();
      try {
        if (isolationMode === "independent_clone") {
          await removeOwnedDirectory(fs, workspacePath);
        } else {
          await gitRunner({
            cwd: canonicalRoot,
            args: ["worktree", "remove", "--force", workspacePath]
          });
        }
      } catch (rollbackFailure) {
        const errorCode = safeErrorCode(rollbackFailure);
        const cleanupPending = errorCode === "EPERM" || errorCode === "EBUSY";
        const record = freezeWorkspaceRecord(makeWorkspaceRecord({
          spec,
          swarmId: input.swarmId,
          baselineCommit,
          createdAt: attemptedAt,
          state: "cleanup_pending"
        }));
        const recoveryHandle = Object.freeze({
          path: workspaceRealPath,
          record,
          isolationMode
        }) satisfies SwarmWorkspaceRuntimeHandle;
        registered.set(recoveryHandle, {
          handle: recoveryHandle,
          path: workspacePath,
          realPath: workspaceRealPath,
          record,
          validated: false,
          isolationMode
        });
        registeredIds.add(spec.workspaceId);
        const cleanup = freezeCleanupRecord({
          schemaVersion: SWARM_SCHEMA_VERSION,
          cleanupId: createCleanupId(),
          swarmId: input.swarmId,
          workspaceId: spec.workspaceId,
          workspaceKind: spec.kind,
          evidencePersisted: false,
          processCloseState: "not_required",
          removalState: "failed",
          state: cleanupPending ? "cleanup_pending" : "failed",
          attemptedAt,
          errorCode
        });
        throw new SwarmWorkspaceCreationError({ original, cleanup, recoveryHandle });
      }
      throw original;
    }

    const record = freezeWorkspaceRecord(makeWorkspaceRecord({
      spec,
      swarmId: input.swarmId,
      baselineCommit,
      createdAt: now()
    }));
    const handle = Object.freeze({
      path: workspaceRealPath,
      record,
      isolationMode
    }) satisfies SwarmWorkspaceRuntimeHandle;
    registered.set(handle, {
      handle,
      path: workspacePath,
      realPath: workspaceRealPath,
      record,
      validated: true,
      isolationMode
    });
    registeredIds.add(spec.workspaceId);
    return handle;
  });

  const removeWorkspace = async (
    handle: SwarmWorkspaceRuntimeHandle,
    gate: SwarmWorkspaceCleanupGate
  ): Promise<SwarmCleanupRecord> => runExclusively(async () => {
    const entry = registered.get(handle);
    if (entry === undefined || entry.handle !== handle) {
      throw new SwarmWorkspaceError(
        "UNREGISTERED_WORKSPACE_HANDLE",
        "Cleanup requires the exact manager-issued registered workspace handle."
      );
    }
    if (!gate.evidencePersisted) {
      throw new SwarmWorkspaceError(
        "EVIDENCE_NOT_PERSISTED",
        "Workspace cleanup cannot begin before evidence is persisted."
      );
    }
    if (!gate.processTreeClosed) {
      throw new SwarmWorkspaceError(
        "PROCESS_TREE_ACTIVE",
        "Workspace cleanup cannot begin before its process tree is closed."
      );
    }
    if (pathsEqual(entry.realPath, canonicalRoot)) {
      throw new SwarmWorkspaceError(
        "CANONICAL_REMOVE_FORBIDDEN",
        "Refusing to remove the canonical checkout."
      );
    }

    const currentRealPath = await fs.realpath(entry.path);
    if (!pathsEqual(currentRealPath, entry.realPath) || !isStrictlyContained(ownedRoot, currentRealPath)) {
      throw new SwarmWorkspaceError(
        "WORKSPACE_IDENTITY_CHANGED",
        "Registered workspace path no longer resolves to the owned workspace."
      );
    }
    if (entry.isolationMode === "independent_clone") {
      if (entry.validated) {
        await assertIndependentCloneIdentity({
          gitRunner,
          fs,
          workspaceRealPath: entry.realPath,
          baselineCommit
        });
      }
    } else {
      await assertListedWorktree(
        gitRunner,
        canonicalRoot,
        entry.realPath,
        entry.validated ? baselineCommit : undefined
      );
    }

    const attemptedAt = now();
    try {
      if (entry.isolationMode === "independent_clone") {
        await removeOwnedDirectory(fs, entry.path);
      } else {
        const args = [
          "worktree",
          "remove",
          ...(gate.force === true ? ["--force"] : []),
          entry.path
        ];
        await gitRunner({ cwd: canonicalRoot, args });
      }
      registered.delete(handle);
      registeredIds.delete(entry.record.workspaceId);
      return freezeCleanupRecord({
        schemaVersion: SWARM_SCHEMA_VERSION,
        cleanupId: createCleanupId(),
        swarmId: input.swarmId,
        workspaceId: entry.record.workspaceId,
        workspaceKind: entry.record.kind,
        ...(gate.ownedProcessId === undefined ? {} : { ownedProcessId: gate.ownedProcessId }),
        evidencePersisted: true,
        processCloseState: "closed",
        removalState: "removed",
        state: "completed",
        attemptedAt,
        completedAt: now()
      });
    } catch (error) {
      const errorCode = safeErrorCode(error);
      const cleanupPending = errorCode === "EPERM" || errorCode === "EBUSY";
      return freezeCleanupRecord({
        schemaVersion: SWARM_SCHEMA_VERSION,
        cleanupId: createCleanupId(),
        swarmId: input.swarmId,
        workspaceId: entry.record.workspaceId,
        workspaceKind: entry.record.kind,
        ...(gate.ownedProcessId === undefined ? {} : { ownedProcessId: gate.ownedProcessId }),
        evidencePersisted: true,
        processCloseState: "closed",
        removalState: "failed",
        state: cleanupPending ? "cleanup_pending" : "failed",
        attemptedAt,
        errorCode
      });
    }
  });

  return Object.freeze({
    baselineCommit,
    canonicalRoot,
    ownedRoot,
    createWorkspace,
    removeWorkspace
  });
}

async function removeOwnedDirectory(fs: SwarmWorkspaceFs, path: string): Promise<void> {
  if (fs.rm) {
    await fs.rm(path);
    return;
  }
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

const defaultFs: SwarmWorkspaceFs = {
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  realpath,
  async pathExists(path) {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  },
  async rm(path) {
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
};

function runGit(command: SwarmGitCommand): Promise<SwarmGitResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      [...command.args],
      {
        cwd: command.cwd,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: MAX_GIT_OUTPUT_BYTES
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

async function assertCanonicalClean(gitRunner: SwarmGitRunner, canonicalRoot: string): Promise<void> {
  const result = await runGitOrThrow(
    gitRunner,
    canonicalRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    "CANONICAL_STATUS_FAILED",
    "Unable to inspect canonical checkout status."
  );
  if (result.stdout.length > 0) {
    throw new SwarmWorkspaceError(
      "CANONICAL_CHECKOUT_DIRTY",
      "Swarm isolation requires a clean canonical checkout."
    );
  }
}

async function assertIndependentCloneIdentity(input: {
  gitRunner: SwarmGitRunner;
  fs: SwarmWorkspaceFs;
  workspaceRealPath: string;
  baselineCommit: string;
}): Promise<void> {
  const topLevel = await gitScalarOrThrow(
    input.gitRunner,
    input.workspaceRealPath,
    ["rev-parse", "--show-toplevel"],
    "CLONE_TOP_LEVEL_FAILED",
    "Created isolated clone is not a valid Git repository."
  );
  const realTopLevel = await input.fs.realpath(resolve(topLevel));
  if (!pathsEqual(realTopLevel, input.workspaceRealPath)) {
    throw new SwarmWorkspaceError(
      "CLONE_TOP_LEVEL_MISMATCH",
      "Created isolated clone top level does not match its registered real path."
    );
  }
  const head = await gitScalarOrThrow(
    input.gitRunner,
    input.workspaceRealPath,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "CLONE_HEAD_FAILED",
    "Unable to verify isolated clone HEAD."
  );
  if (head !== input.baselineCommit) {
    throw new SwarmWorkspaceError(
      "CLONE_BASELINE_MISMATCH",
      "Created isolated clone HEAD does not match the captured baseline."
    );
  }
  const gitDir = await gitScalarOrThrow(
    input.gitRunner,
    input.workspaceRealPath,
    ["rev-parse", "--git-dir"],
    "CLONE_GIT_DIR_FAILED",
    "Unable to resolve isolated clone Git metadata."
  );
  const gitDirRealPath = await input.fs.realpath(resolve(input.workspaceRealPath, gitDir));
  if (!isStrictlyContained(input.workspaceRealPath, gitDirRealPath)) {
    throw new SwarmWorkspaceError(
      "CLONE_GIT_DIR_ESCAPE",
      "Isolated clone Git metadata must remain inside the clone workspace."
    );
  }
}

async function assertWorktreeIdentity(input: {
  gitRunner: SwarmGitRunner;
  fs: SwarmWorkspaceFs;
  canonicalRoot: string;
  workspaceRealPath: string;
  baselineCommit: string;
}): Promise<void> {
  const topLevel = await gitScalarOrThrow(
    input.gitRunner,
    input.workspaceRealPath,
    ["rev-parse", "--show-toplevel"],
    "WORKTREE_TOP_LEVEL_FAILED",
    "Created workspace is not a valid Git worktree."
  );
  const realTopLevel = await input.fs.realpath(resolve(topLevel));
  if (!pathsEqual(realTopLevel, input.workspaceRealPath)) {
    throw new SwarmWorkspaceError(
      "WORKTREE_TOP_LEVEL_MISMATCH",
      "Created workspace top level does not match its registered real path."
    );
  }
  const head = await gitScalarOrThrow(
    input.gitRunner,
    input.workspaceRealPath,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "WORKTREE_HEAD_FAILED",
    "Unable to verify created workspace HEAD."
  );
  if (head !== input.baselineCommit) {
    throw new SwarmWorkspaceError(
      "WORKTREE_BASELINE_MISMATCH",
      "Created workspace HEAD does not match the captured baseline."
    );
  }
  await assertListedWorktree(
    input.gitRunner,
    input.canonicalRoot,
    input.workspaceRealPath,
    input.baselineCommit
  );
}

async function assertListedWorktree(
  gitRunner: SwarmGitRunner,
  canonicalRoot: string,
  expectedRealPath: string,
  baselineCommit?: string
): Promise<void> {
  const result = await runGitOrThrow(
    gitRunner,
    canonicalRoot,
    ["worktree", "list", "--porcelain", "-z"],
    "WORKTREE_LIST_FAILED",
    "Unable to verify registered Git worktrees."
  );
  const listed = parseWorktreeList(result.stdout).find(({ path }) => pathsEqual(path, expectedRealPath));
  if (listed === undefined) {
    throw new SwarmWorkspaceError(
      "WORKTREE_NOT_REGISTERED",
      "Workspace is absent from Git worktree registration."
    );
  }
  if (baselineCommit !== undefined && listed.head !== baselineCommit) {
    throw new SwarmWorkspaceError(
      "WORKTREE_LIST_BASELINE_MISMATCH",
      "Registered worktree HEAD does not match the captured baseline."
    );
  }
}

function parseWorktreeList(stdout: string): ListedWorktree[] {
  const records: ListedWorktree[] = [];
  let current: ListedWorktree | undefined;
  for (const field of stdout.split("\0")) {
    if (field.length === 0) {
      if (current !== undefined) records.push(current);
      current = undefined;
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (current !== undefined) records.push(current);
      current = { path: field.slice("worktree ".length) };
      continue;
    }
    if (field.startsWith("HEAD ") && current !== undefined) {
      current.head = field.slice("HEAD ".length);
    }
  }
  if (current !== undefined) records.push(current);
  return records;
}

function makeWorkspaceRecord(input: {
  spec: SwarmWorkspaceSpec;
  swarmId: string;
  baselineCommit: string;
  createdAt: string;
  state?: "active" | "cleanup_pending";
}): SwarmWorkspaceRecord {
  const base = {
    schemaVersion: SWARM_SCHEMA_VERSION,
    workspaceId: input.spec.workspaceId,
    swarmId: input.swarmId,
    baselineCommit: input.baselineCommit,
    state: input.state ?? "active",
    createdAt: input.createdAt
  };
  if (input.spec.kind === "child") {
    return {
      ...base,
      kind: "child",
      childRunId: input.spec.childRunId,
      agentId: input.spec.agentId,
      taskIds: Object.freeze([...input.spec.taskIds])
    };
  }
  return { ...base, kind: input.spec.kind };
}

function freezeWorkspaceRecord(record: SwarmWorkspaceRecord): SwarmWorkspaceRecord {
  return Object.freeze(record);
}

function freezeCleanupRecord(record: SwarmCleanupRecord): SwarmCleanupRecord {
  return Object.freeze(record);
}

function validateSpec(spec: SwarmWorkspaceSpec): void {
  if (spec.kind !== "child") return;
  if (!spec.childRunId.trim() || !spec.agentId.trim() || spec.taskIds.length === 0) {
    throw new SwarmWorkspaceError(
      "INVALID_CHILD_WORKSPACE_IDENTITY",
      "Child workspaces require child run, agent, and task identities."
    );
  }
  if (spec.taskIds.some((taskId) => !taskId.trim())) {
    throw new SwarmWorkspaceError(
      "INVALID_CHILD_TASK_ID",
      "Child workspace task identities must be non-empty."
    );
  }
}

/** Non-authority path guard shared by production composition callers before any ID-derived join. */
export function assertSwarmPathIdentifier(value: string, label = "swarm path identifier"): void {
  const windowsBaseName = value.split(".", 1)[0]?.toUpperCase() ?? "";
  const windowsReserved = windowsBaseName === "CON"
    || windowsBaseName === "PRN"
    || windowsBaseName === "AUX"
    || windowsBaseName === "NUL"
    || /^COM[1-9]$/u.test(windowsBaseName)
    || /^LPT[1-9]$/u.test(windowsBaseName);
  if (!FILENAME_SAFE_ID.test(value) || value.endsWith(".") || windowsReserved) {
    throw new SwarmWorkspaceError(
      "UNSAFE_FILENAME_ID",
      `${label} must be a filename-safe workspace ID.`
    );
  }
}

async function gitScalarOrThrow(
  gitRunner: SwarmGitRunner,
  cwd: string,
  args: readonly string[],
  code: string,
  message: string
): Promise<string> {
  const result = await runGitOrThrow(gitRunner, cwd, args, code, message);
  const value = result.stdout.trim();
  if (!value) throw new SwarmWorkspaceError(code, message);
  return value;
}

async function runGitOrThrow(
  gitRunner: SwarmGitRunner,
  cwd: string,
  args: readonly string[],
  code: string,
  message: string
): Promise<SwarmGitResult> {
  try {
    return await gitRunner({ cwd, args: [...args] });
  } catch (error) {
    throw new SwarmWorkspaceError(code, message, { cause: error });
  }
}

function pathsEqual(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function pathKey(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isStrictlyContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

function isPathContained(root: string, candidate: string): boolean {
  return pathsEqual(root, candidate) || isStrictlyContained(root, candidate);
}

function safeErrorCode(error: unknown): string {
  if (isNodeError(error) && typeof error.code === "string" && /^[A-Z0-9_]+$/u.test(error.code)) {
    return error.code;
  }
  if (typeof (error as { code?: unknown })?.code === "number") {
    return `GIT_EXIT_${String((error as { code: number }).code)}`;
  }
  return "GIT_WORKTREE_REMOVE_FAILED";
}

function asWorkspaceError(error: unknown): SwarmWorkspaceError {
  if (error instanceof SwarmWorkspaceError) return error;
  return new SwarmWorkspaceError(
    "WORKTREE_POST_CREATE_VALIDATION_FAILED",
    "Created worktree failed post-add validation.",
    { cause: error }
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
