import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type {
  PatchDecision,
  RollbackBoundaryArtifact,
  RollbackFileSnapshot,
  RollbackIgnoredFileStamp,
  RollbackOutcomeArtifact
} from "@martin/contracts";

import {
  DEPENDENCY_AND_BUILD_DIRECTORIES,
  isInsideDependencyOrBuildDirectory
} from "./output-directories.js";

/** Past this many ignored files, further ignored directories stay collapsed. */
const MAX_EXPANDED_IGNORED_FILES = 20_000;
const MAX_HASHED_IGNORED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_HASHED_IGNORED_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_IGNORED_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const ignoredContentSnapshots = new WeakMap<RollbackBoundaryArtifact, Map<string, Buffer>>();
const ignoredObservations = new WeakMap<RollbackBoundaryArtifact, Map<string, IgnoredFileObservation>>();

interface IgnoredFileObservation extends RollbackIgnoredFileStamp {
  ctimeMs: number;
  sha256?: string;
}

interface IgnoredHashBudget {
  remainingBytes: number;
}

export interface IgnoredFileChanges {
  created: string[];
  modified: string[];
  deleted: string[];
}

interface RepoStateSnapshot {
  trackedDirtyFiles: string[];
  untrackedFiles: string[];
}

/** Git listings of large untracked or ignored trees exceed spawnSync's 1 MiB default. */
const GIT_LIST_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export class RollbackStateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RollbackStateUnavailableError";
  }
}

export function listAttemptChangedFilesSinceBoundary(input: {
  repoRoot?: string;
  boundary?: RollbackBoundaryArtifact;
  /** Include content changes to dirty/untracked paths that existed at the boundary. */
  includeBaselineSnapshotChanges?: boolean;
}): string[] {
  if (!input.repoRoot) {
    return [];
  }

  // Diff against the boundary commit (not the live HEAD) so that changes an
  // attempt commits are still reported as attempt changes.
  const repoState = readRepoState(input.repoRoot, input.boundary?.headRef);
  if (!input.boundary) {
    return uniqueSorted([...repoState.trackedDirtyFiles, ...repoState.untrackedFiles]);
  }

  const baselineTracked = new Set(input.boundary.trackedDirtyFiles);
  const baselineUntracked = new Set(input.boundary.untrackedFiles);

  return uniqueSorted([
    ...repoState.trackedDirtyFiles.filter((filePath) => !baselineTracked.has(filePath)),
    ...repoState.untrackedFiles.filter((filePath) => !baselineUntracked.has(filePath)),
    ...(input.includeBaselineSnapshotChanges
      ? snapshotChangedPaths(input.repoRoot, input.boundary.snapshots)
      : [])
  ]);
}

export async function captureRollbackBoundary(input: {
  repoRoot?: string;
  capturedAt: string;
}): Promise<RollbackBoundaryArtifact | undefined> {
  if (!input.repoRoot) {
    return undefined;
  }

  const repoState = readRepoState(input.repoRoot);
  // Links are recorded by path only: their targets are never read or restored.
  const snapshotPaths = uniqueSorted([
    ...repoState.trackedDirtyFiles,
    ...repoState.untrackedFiles
  ]).filter((filePath) => !isLinkPath(input.repoRoot!, filePath));
  const snapshots: RollbackFileSnapshot[] = [];

  for (const filePath of snapshotPaths) {
    snapshots.push(await readRollbackSnapshot(input.repoRoot, filePath));
  }

  const observedIgnoredFiles = readIgnoredInventory(input.repoRoot);
  const ignoredFiles: RollbackIgnoredFileStamp[] = observedIgnoredFiles.map(({ path, size, mtimeMs }) => ({
    path,
    size,
    mtimeMs
  }));
  const headRef = readGitScalar(input.repoRoot, ["rev-parse", "HEAD"]);
  const headBranch = readHeadBranch(input.repoRoot);

  const boundary: RollbackBoundaryArtifact = {
    strategy: "git_head_plus_snapshot",
    capturedAt: input.capturedAt,
    ...(headRef ? { headRef } : {}),
    ...(headBranch ? { headBranch } : {}),
    trackedDirtyFiles: repoState.trackedDirtyFiles,
    untrackedFiles: repoState.untrackedFiles,
    snapshots,
    ignoredFiles
  };
  ignoredObservations.set(boundary, new Map(observedIgnoredFiles.map((entry) => [entry.path, entry])));
  ignoredContentSnapshots.set(boundary, captureIgnoredContent(input.repoRoot, ignoredFiles));
  return boundary;
}

/**
 * Git-ignored files the attempt created or modified since the boundary.
 * Boundaries recorded before the ignored inventory existed report nothing.
 */
export function listIgnoredFileChangesSinceBoundary(input: {
  repoRoot?: string;
  boundary?: RollbackBoundaryArtifact;
}): IgnoredFileChanges {
  if (!input.repoRoot || !input.boundary?.ignoredFiles) {
    return makeIgnoredFileChanges([], [], []);
  }

  const baseline = new Map(input.boundary.ignoredFiles.map((entry) => [entry.path, entry]));
  const baselineObservations = ignoredObservations.get(input.boundary);
  const created: string[] = [];
  const modified: string[] = [];
  const currentEntries = readIgnoredInventory(input.repoRoot);
  const current = new Map(currentEntries.map((entry) => [entry.path, entry]));
  const deleted = input.boundary.ignoredFiles
    .filter((entry) => !current.has(entry.path))
    .map((entry) => entry.path);

  for (const entry of currentEntries) {
    const previous = baseline.get(entry.path);
    if (!previous) {
      created.push(entry.path);
    } else if (!entry.path.endsWith("/") && ignoredObservationChanged(previous, baselineObservations?.get(entry.path), entry)) {
      modified.push(entry.path);
    }
  }

  return makeIgnoredFileChanges(created.sort(), modified.sort(), deleted.sort());
}

function ignoredObservationChanged(
  previous: RollbackIgnoredFileStamp,
  previousObservation: IgnoredFileObservation | undefined,
  current: IgnoredFileObservation
): boolean {
  if (previousObservation?.sha256 !== undefined && current.sha256 !== undefined) {
    return previousObservation.sha256 !== current.sha256;
  }
  if (previousObservation !== undefined) {
    return previous.size !== current.size ||
      previous.mtimeMs !== current.mtimeMs ||
      previousObservation.ctimeMs !== current.ctimeMs;
  }
  return previous.size !== current.size || previous.mtimeMs !== current.mtimeMs;
}

function makeIgnoredFileChanges(
  created: string[],
  modified: string[],
  deleted: string[]
): IgnoredFileChanges {
  const changes = { created, modified } as IgnoredFileChanges;
  // Preserve the historical enumerable shape when there are no deletions while
  // still exposing deletion evidence to current callers.
  Object.defineProperty(changes, "deleted", {
    value: deleted,
    enumerable: deleted.length > 0
  });
  return changes;
}

export async function restoreRollbackBoundary(input: {
  repoRoot?: string;
  boundary?: RollbackBoundaryArtifact;
  restoredAt: string;
  decision: PatchDecision;
  /** Extra attempt-created paths (for example ignored files) to delete. */
  removePaths?: string[];
  /** Pre-existing ignored paths to restore from the in-memory boundary. */
  restoreIgnoredPaths?: string[];
}): Promise<RollbackOutcomeArtifact | undefined> {
  if (!input.repoRoot) {
    return undefined;
  }

  if (!input.boundary) {
    return {
      attempted: false,
      status: "unavailable",
      restoredAt: input.restoredAt,
      decision: input.decision,
      before: emptyRepoState(),
      after: emptyRepoState(),
      restoredFiles: [],
      deletedFiles: [],
      error: "Rollback boundary was unavailable for this attempt."
    };
  }

  const before = readRepoState(input.repoRoot, input.boundary.headRef);
  const currentHead = readGitScalar(input.repoRoot, ["rev-parse", "HEAD"]);
  const headMoved = input.boundary.headRef !== undefined && currentHead !== input.boundary.headRef;
  const removePaths = uniqueSorted(input.removePaths ?? []);
  const restoreIgnoredPaths = uniqueSorted(input.restoreIgnoredPaths ?? []);
  const snapshotsUnchanged = await rollbackSnapshotsMatch(input.repoRoot, input.boundary.snapshots);
  if (
    !headMoved &&
    removePaths.length === 0 &&
    restoreIgnoredPaths.length === 0 &&
    repoStateMatchesBoundary(before, input.boundary) &&
    snapshotsUnchanged
  ) {
    return {
      attempted: false,
      status: "not_required",
      restoredAt: input.restoredAt,
      decision: input.decision,
      before,
      after: before,
      restoredFiles: [],
      deletedFiles: []
    };
  }

  const restoredFiles = new Set<string>();
  const deletedFiles = new Set<string>();
  let rewoundHead: RollbackOutcomeArtifact["rewoundHead"];

  try {
    if (headMoved && input.boundary.headRef && currentHead) {
      rewindAttemptCommits(input.repoRoot, input.boundary, currentHead);
      rewoundHead = { from: currentHead, to: input.boundary.headRef };
    }

    const baselineTracked = new Set(input.boundary.trackedDirtyFiles);
    const baselineUntracked = new Set(input.boundary.untrackedFiles);

    for (const filePath of before.trackedDirtyFiles) {
      if (!baselineTracked.has(filePath)) {
        if (existsInHead(input.repoRoot, filePath)) {
          restoreTrackedFileFromHead(input.repoRoot, filePath);
          restoredFiles.add(filePath);
        } else {
          unstagePath(input.repoRoot, filePath);
          await removeRepoPath(input.repoRoot, filePath);
          deletedFiles.add(filePath);
        }
      }
    }

    for (const filePath of before.untrackedFiles) {
      if (!baselineUntracked.has(filePath)) {
        await removeRepoPath(input.repoRoot, filePath);
        deletedFiles.add(filePath);
      }
    }

    for (const snapshot of input.boundary.snapshots) {
      await restoreRollbackSnapshot(input.repoRoot, snapshot);
      if (snapshot.existed) {
        restoredFiles.add(snapshot.path);
      } else {
        deletedFiles.add(snapshot.path);
      }
    }

    for (const filePath of removePaths) {
      await removeRepoPath(input.repoRoot, filePath);
      deletedFiles.add(filePath);
    }

    const ignoredSnapshots = ignoredContentSnapshots.get(input.boundary);
    for (const filePath of restoreIgnoredPaths) {
      const contents = ignoredSnapshots?.get(filePath);
      if (!contents) {
        throw new Error(`Ignored-file rollback snapshot is unavailable for ${filePath}`);
      }
      const absolutePath = resolveRepoPath(input.repoRoot, filePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      resolveRepoPath(input.repoRoot, filePath);
      await writeFile(absolutePath, contents);
      restoredFiles.add(filePath);
    }

    const after = readRepoState(input.repoRoot, input.boundary.headRef);
    const restored =
      repoStateMatchesBoundary(after, input.boundary) &&
      (input.boundary.headRef === undefined ||
        readGitScalar(input.repoRoot, ["rev-parse", "HEAD"]) === input.boundary.headRef);

    return {
      attempted: true,
      status: restored ? "restored" : "failed",
      restoredAt: input.restoredAt,
      decision: input.decision,
      before,
      after,
      restoredFiles: [...restoredFiles].sort(),
      deletedFiles: [...deletedFiles].sort(),
      ...(rewoundHead ? { rewoundHead } : {}),
      ...(restored
        ? {}
        : { error: "Repo state still diverged from the recorded rollback boundary after restore." })
    };
  } catch (error) {
    const after = readRepoState(input.repoRoot, input.boundary.headRef);

    return {
      attempted: true,
      status: "failed",
      restoredAt: input.restoredAt,
      decision: input.decision,
      before,
      after,
      restoredFiles: [...restoredFiles].sort(),
      deletedFiles: [...deletedFiles].sort(),
      error: toErrorMessage(error)
    };
  }
}

function readRepoState(repoRoot: string, baseRef = "HEAD"): RepoStateSnapshot {
  return {
    trackedDirtyFiles: readGitLines(repoRoot, ["diff", "--name-only", baseRef, "--", "."]),
    // Git for Windows lists untracked files *through* junctions, so a link to a
    // directory outside the repo would otherwise surface that directory's files as
    // repo paths. Collapse every such path to the link itself.
    untrackedFiles: collapsePathsThroughLinks(
      repoRoot,
      readGitLines(repoRoot, ["ls-files", "--others", "--exclude-standard", "--", "."])
    )
  };
}

/**
 * Repo-relative links (symlinks or junctions) among `paths` whose target
 * resolves outside the repository. Paths are first collapsed to the link.
 */
export function findEscapingLinks(repoRoot: string, paths: string[]): string[] {
  const realRoot = realpathSync.native(resolve(repoRoot));
  return collapsePathsThroughLinks(repoRoot, paths).filter((filePath) => {
    if (!isLinkPath(repoRoot, filePath)) {
      return false;
    }
    try {
      const target = realpathSync.native(resolve(repoRoot, filePath));
      const fromRoot = relative(realRoot, target);
      return fromRoot === ".." || fromRoot.startsWith("../") || fromRoot.startsWith("..\\") || isAbsolute(fromRoot);
    } catch {
      // A dangling link cannot be proven to stay inside the repository.
      return true;
    }
  });
}

function collapsePathsThroughLinks(repoRoot: string, paths: string[]): string[] {
  const linkCache = new Map<string, boolean>();
  const collapsed = paths.map((filePath) => {
    const segments = normalizeRepoPath(filePath).replace(/\/$/u, "").split("/").filter(Boolean);
    for (let index = 1; index <= segments.length; index++) {
      const prefix = segments.slice(0, index).join("/");
      let isLink = linkCache.get(prefix);
      if (isLink === undefined) {
        isLink = isLinkPath(repoRoot, prefix);
        linkCache.set(prefix, isLink);
      }
      if (isLink) {
        return prefix;
      }
    }
    return filePath;
  });
  return uniqueSorted(collapsed);
}

function isLinkPath(repoRoot: string, filePath: string): boolean {
  try {
    return lstatSync(resolve(repoRoot, filePath)).isSymbolicLink();
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw new RollbackStateUnavailableError(
      `Unable to authenticate rollback path ${normalizeRepoPath(filePath)}: ${toErrorMessage(error)}`
    );
  }
}

/** Throws when any directory between the repo root and `filePath` is a link. */
function assertNoIntermediateLink(repoRoot: string, filePath: string): void {
  const segments = normalizeRepoPath(filePath).split("/").filter(Boolean);
  for (let index = 1; index < segments.length; index++) {
    const prefix = segments.slice(0, index).join("/");
    if (isLinkPath(repoRoot, prefix)) {
      throw new Error(`Refusing to access a rollback path through a link: ${filePath} (via ${prefix})`);
    }
  }
}

/**
 * Moves the boundary branch back to the boundary commit, keeping the attempt's
 * committed content in the index so the normal restore pass can undo it.
 */
function rewindAttemptCommits(
  repoRoot: string,
  boundary: RollbackBoundaryArtifact,
  currentHead: string
): void {
  const currentBranch = readHeadBranch(repoRoot);
  if (currentBranch !== boundary.headBranch) {
    throw new Error(
      `Attempt switched HEAD from ${boundary.headBranch ?? "a detached HEAD"} to ` +
        `${currentBranch ?? "a detached HEAD"} (now ${currentHead}); restore ${String(boundary.headRef)} manually.`
    );
  }

  const result = spawnSync("git", ["reset", "--soft", String(boundary.headRef)], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`git reset --soft ${String(boundary.headRef)} failed: ${gitFailureMessage(result)}`);
  }
}

function readHeadBranch(repoRoot: string): string | undefined {
  const result = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  const value = result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : "";
  return value.length > 0 ? value : undefined;
}

function existsInHead(repoRoot: string, filePath: string): boolean {
  resolveRepoPath(repoRoot, filePath, { allowLeafLink: true });
  return spawnSync("git", ["cat-file", "-e", `HEAD:${filePath}`], { cwd: repoRoot }).status === 0;
}

function unstagePath(repoRoot: string, filePath: string): void {
  resolveRepoPath(repoRoot, filePath, { allowLeafLink: true });
  const result = spawnSync(
    "git",
    ["rm", "--cached", "-r", "-q", "-f", "--ignore-unmatch", "--", filePath],
    { cwd: repoRoot, encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`git rm --cached failed for ${filePath}: ${gitFailureMessage(result)}`);
  }
}

function readIgnoredInventory(repoRoot: string): IgnoredFileObservation[] {
  const collapsed = collapsePathsThroughLinks(repoRoot, readGitLines(repoRoot, [
    "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--", "."
  ]));
  const inventory: IgnoredFileObservation[] = [];
  let expanded = 0;
  const hashBudget: IgnoredHashBudget = { remainingBytes: MAX_HASHED_IGNORED_TOTAL_BYTES };

  for (const entry of collapsed) {
    const isDirectory = entry.endsWith("/");
    const leaf = entry.replace(/\/$/u, "").split("/").at(-1) ?? entry;
    if (isDirectory && DEPENDENCY_AND_BUILD_DIRECTORIES.has(leaf)) {
      inventory.push({ path: entry, size: 0, mtimeMs: 0, ctimeMs: 0 });
      continue;
    }
    if (isDirectory && expanded >= MAX_EXPANDED_IGNORED_FILES) {
      throw new RollbackStateUnavailableError(
        `Ignored rollback inventory exceeds the ${String(MAX_EXPANDED_IGNORED_FILES)}-file observation limit at ${entry}`
      );
    }

    const files = isDirectory
      ? collapsePathsThroughLinks(
          repoRoot,
          readGitLines(repoRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "--", entry])
        )
      : [entry];
    for (const filePath of files) {
      if (expanded >= MAX_EXPANDED_IGNORED_FILES) {
        throw new RollbackStateUnavailableError(
          `Ignored rollback inventory exceeds the ${String(MAX_EXPANDED_IGNORED_FILES)}-file observation limit at ${entry}`
        );
      }
      inventory.push(stampIgnoredFile(repoRoot, filePath, hashBudget));
      expanded += 1;
    }
  }

  return inventory.sort((left, right) => left.path.localeCompare(right.path));
}

function stampIgnoredFile(
  repoRoot: string,
  filePath: string,
  hashBudget: IgnoredHashBudget
): IgnoredFileObservation {
  try {
    const absolutePath = resolveRepoPath(repoRoot, filePath, { allowLeafLink: true });
    const link = isLinkPath(repoRoot, filePath);
    const stats = link ? lstatSync(absolutePath) : statSync(absolutePath);
    const stamp: IgnoredFileObservation = {
      path: normalizeRepoPath(filePath),
      size: stats.size,
      mtimeMs: Math.trunc(stats.mtimeMs),
      ctimeMs: Math.trunc(stats.ctimeMs)
    };
    if (
      !link &&
      stats.isFile() &&
      stats.size <= MAX_HASHED_IGNORED_FILE_BYTES &&
      stats.size <= hashBudget.remainingBytes &&
      !isInsideDependencyOrBuildDirectory(filePath)
    ) {
      stamp.sha256 = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
      hashBudget.remainingBytes -= stats.size;
    }
    return stamp;
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw new RollbackStateUnavailableError(
        `Unable to authenticate ignored rollback path ${normalizeRepoPath(filePath)}: ${toErrorMessage(error)}`
      );
    }
    // Vanished between listing and stat; record presence only so later comparison fails closed.
    return { path: normalizeRepoPath(filePath), size: -1, mtimeMs: -1, ctimeMs: -1 };
  }
}

function captureIgnoredContent(
  repoRoot: string,
  ignoredFiles: RollbackIgnoredFileStamp[]
): Map<string, Buffer> {
  const snapshots = new Map<string, Buffer>();
  let capturedBytes = 0;

  for (const entry of ignoredFiles) {
    if (
      entry.path.endsWith("/") ||
      isInsideDependencyOrBuildDirectory(entry.path) ||
      isLinkPath(repoRoot, entry.path)
    ) {
      continue;
    }

    const absolutePath = resolveRepoPath(repoRoot, entry.path);
    if (entry.size < 0 || capturedBytes + entry.size > MAX_IGNORED_SNAPSHOT_BYTES) {
      continue;
    }

    try {
      const contents = readFileSync(absolutePath);
      capturedBytes += contents.byteLength;
      snapshots.set(entry.path, contents);
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw new RollbackStateUnavailableError(
          `Ignored rollback snapshot unavailable for ${entry.path}: ${toErrorMessage(error)}`
        );
      }
    }
  }

  return snapshots;
}

function snapshotChangedPaths(
  repoRoot: string,
  snapshots: RollbackFileSnapshot[]
): string[] {
  const changed: string[] = [];

  for (const snapshot of snapshots) {
    try {
      const absolutePath = resolveRepoPath(repoRoot, snapshot.path);
      if (!snapshot.existed || !snapshot.contentBase64) {
        try {
          readFileSync(absolutePath);
          changed.push(snapshot.path);
        } catch (error) {
          if (!isFileNotFoundError(error)) throw error;
        }
        continue;
      }

      const current = readFileSync(absolutePath);
      if (!current.equals(Buffer.from(snapshot.contentBase64, "base64"))) {
        changed.push(snapshot.path);
      }
    } catch (error) {
      // A missing file or link swap is still an attempt change. It must flow to
      // the leash and rollback path, which will authenticate before mutation.
      if (isFileNotFoundError(error) || error instanceof RollbackStateUnavailableError || error instanceof Error) {
        changed.push(snapshot.path);
        continue;
      }
      throw error;
    }
  }

  return uniqueSorted(changed);
}

function readGitLines(repoRoot: string, args: string[]): string[] {
  let lastFailure = "unknown Git failure";
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: GIT_LIST_MAX_BUFFER_BYTES
    });

    if (result.status === 0 && typeof result.stdout === "string") {
      return uniqueSorted(
        result.stdout
          .split(/\r?\n/u)
          .map((line) => normalizeRepoPath(line))
          .filter(Boolean)
      );
    }

    lastFailure = gitFailureMessage(result);

    // Retry once after a short delay — handles git lock-file contention
    // that occurs when another process holds .git/index.lock.
    if (attempt === 0 && result.status !== 0) {
      delaySynchronously(500);
    }
  }

  throw new RollbackStateUnavailableError(
    `Git rollback state unavailable for ${args.join(" ")}: ${lastFailure}`
  );
}

function readGitScalar(repoRoot: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8"
  });

  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new RollbackStateUnavailableError(
      `Git rollback state unavailable for ${args.join(" ")}: ${gitFailureMessage(result)}`
    );
  }

  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
}

async function readRollbackSnapshot(
  repoRoot: string,
  filePath: string
): Promise<RollbackFileSnapshot> {
  const absolutePath = resolveRepoPath(repoRoot, filePath);

  try {
    const contents = await readFile(absolutePath);
    return {
      path: normalizeRepoPath(filePath),
      existed: true,
      encoding: "base64",
      contentBase64: contents.toString("base64")
    };
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw new RollbackStateUnavailableError(
        `Rollback snapshot unavailable for ${normalizeRepoPath(filePath)}: ${toErrorMessage(error)}`
      );
    }
    return {
      path: normalizeRepoPath(filePath),
      existed: false,
      encoding: "base64"
    };
  }
}

async function rollbackSnapshotsMatch(
  repoRoot: string,
  snapshots: RollbackFileSnapshot[]
): Promise<boolean> {
  for (const snapshot of snapshots) {
    try {
      const absolutePath = resolveRepoPath(repoRoot, snapshot.path);
      if (!snapshot.existed) {
        try {
          await readFile(absolutePath);
          return false;
        } catch (error) {
          if (!isFileNotFoundError(error)) return false;
        }
        continue;
      }
      if (!snapshot.contentBase64) return false;
      const current = await readFile(absolutePath);
      if (!current.equals(Buffer.from(snapshot.contentBase64, "base64"))) return false;
    } catch {
      // A link swap, inaccessible path, or vanished baseline means the boundary
      // cannot be declared unchanged; the restore path will fail closed.
      return false;
    }
  }
  return true;
}

async function restoreRollbackSnapshot(
  repoRoot: string,
  snapshot: RollbackFileSnapshot
): Promise<void> {
  const absolutePath = resolveRepoPath(repoRoot, snapshot.path);

  if (!snapshot.existed || !snapshot.contentBase64) {
    resolveRepoPath(repoRoot, snapshot.path);
    await rm(absolutePath, { recursive: true, force: true });
    return;
  }

  await mkdir(dirname(absolutePath), { recursive: true });
  resolveRepoPath(repoRoot, snapshot.path);
  await writeFile(absolutePath, Buffer.from(snapshot.contentBase64, "base64"));
}

function restoreTrackedFileFromHead(repoRoot: string, filePath: string): void {
  // Git must never receive a path that crosses a link. A tracked symlink may
  // itself be the leaf, because Git replaces the link rather than traversing it.
  resolveRepoPath(repoRoot, filePath, { allowLeafLink: true });
  const result = spawnSync(
    "git",
    ["restore", "--staged", "--worktree", "--source=HEAD", "--", filePath],
    {
      cwd: repoRoot,
      encoding: "utf8"
    }
  );

  if (result.status === 0) {
    return;
  }

  // Retry once after a short delay (git lock-file contention)
  delaySynchronously(500);
  const retry = spawnSync(
    "git",
    ["restore", "--staged", "--worktree", "--source=HEAD", "--", filePath],
    { cwd: repoRoot, encoding: "utf8" }
  );

  if (retry.status === 0) {
    return;
  }

  // Fallback: try git checkout which works on older git versions
  const fallback = spawnSync(
    "git",
    ["checkout", "HEAD", "--", filePath],
    { cwd: repoRoot, encoding: "utf8" }
  );

  if (fallback.status === 0) {
    return;
  }

  throw new Error(
    result.stderr?.trim() ||
    `git restore failed for ${filePath} (retry and checkout fallback also failed)`
  );
}

async function removeRepoPath(repoRoot: string, filePath: string): Promise<void> {
  const absolutePath = resolveRepoPath(repoRoot, filePath, { allowLeafLink: true });
  if (isLinkPath(repoRoot, filePath)) {
    // Remove the link itself; never descend into whatever it points at.
    await rm(absolutePath, { force: true });
    return;
  }
  resolveRepoPath(repoRoot, filePath);
  await rm(absolutePath, { recursive: true, force: true });
}

function resolveRepoPath(
  repoRoot: string,
  filePath: string,
  options: { allowLeafLink?: boolean } = {}
): string {
  const resolvedRoot = resolve(repoRoot);
  const resolvedPath = resolve(resolvedRoot, filePath);
  const relativePath = relative(resolvedRoot, resolvedPath);

  if (relativePath.startsWith("..") || relativePath === "") {
    throw new Error(`Refusing to access a rollback path outside repo root: ${filePath}`);
  }
  assertNoIntermediateLink(resolvedRoot, relativePath);
  if (!options.allowLeafLink && isLinkPath(resolvedRoot, relativePath)) {
    throw new Error(`Refusing to access a rollback path that is a link: ${filePath}`);
  }

  return resolvedPath;
}

function repoStateMatchesBoundary(
  state: RepoStateSnapshot,
  boundary: RollbackBoundaryArtifact
): boolean {
  return arraysEqual(state.trackedDirtyFiles, boundary.trackedDirtyFiles) &&
    arraysEqual(state.untrackedFiles, boundary.untrackedFiles);
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => normalizeRepoPath(value)).filter(Boolean))].sort();
}

function normalizeRepoPath(value: string): string {
  return value.trim().replace(/\\/gu, "/");
}

function emptyRepoState(): RepoStateSnapshot {
  return {
    trackedDirtyFiles: [],
    untrackedFiles: []
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gitFailureMessage(result: ReturnType<typeof spawnSync>): string {
  if (result.error) {
    return result.error.message;
  }
  if (typeof result.stderr === "string" && result.stderr.trim().length > 0) {
    return result.stderr.trim();
  }
  return `git exited with status ${String(result.status)}`;
}

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function delaySynchronously(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}
