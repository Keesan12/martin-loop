import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import type {
  PatchDecision,
  RollbackBoundaryArtifact,
  RollbackFileSnapshot,
  RollbackOutcomeArtifact
} from "@martin/contracts";

interface RepoStateSnapshot {
  trackedDirtyFiles: string[];
  untrackedFiles: string[];
}

export async function captureRollbackBoundary(input: {
  repoRoot?: string;
  capturedAt: string;
}): Promise<RollbackBoundaryArtifact | undefined> {
  if (!input.repoRoot) {
    return undefined;
  }

  const repoState = readRepoState(input.repoRoot);
  const snapshotPaths = uniqueSorted([
    ...repoState.trackedDirtyFiles,
    ...repoState.untrackedFiles
  ]);
  const snapshots: RollbackFileSnapshot[] = [];

  for (const filePath of snapshotPaths) {
    snapshots.push(await readRollbackSnapshot(input.repoRoot, filePath));
  }

  return {
    strategy: "git_head_plus_snapshot",
    capturedAt: input.capturedAt,
    ...(readGitScalar(input.repoRoot, ["rev-parse", "HEAD"])
      ? { headRef: readGitScalar(input.repoRoot, ["rev-parse", "HEAD"]) }
      : {}),
    trackedDirtyFiles: repoState.trackedDirtyFiles,
    untrackedFiles: repoState.untrackedFiles,
    snapshots
  };
}

export async function restoreRollbackBoundary(input: {
  repoRoot?: string;
  boundary?: RollbackBoundaryArtifact;
  restoredAt: string;
  decision: PatchDecision;
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

  const before = readRepoState(input.repoRoot);
  if (repoStateMatchesBoundary(before, input.boundary)) {
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

  try {
    const baselineTracked = new Set(input.boundary.trackedDirtyFiles);
    const baselineUntracked = new Set(input.boundary.untrackedFiles);

    for (const filePath of before.trackedDirtyFiles) {
      if (!baselineTracked.has(filePath)) {
        restoreTrackedFileFromHead(input.repoRoot, filePath);
        restoredFiles.add(filePath);
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

    const after = readRepoState(input.repoRoot);
    const restored = repoStateMatchesBoundary(after, input.boundary);

    return {
      attempted: true,
      status: restored ? "restored" : "failed",
      restoredAt: input.restoredAt,
      decision: input.decision,
      before,
      after,
      restoredFiles: [...restoredFiles].sort(),
      deletedFiles: [...deletedFiles].sort(),
      ...(restored
        ? {}
        : { error: "Repo state still diverged from the recorded rollback boundary after restore." })
    };
  } catch (error) {
    const after = readRepoState(input.repoRoot);

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

function readRepoState(repoRoot: string): RepoStateSnapshot {
  return {
    trackedDirtyFiles: readGitLines(repoRoot, ["diff", "--name-only", "HEAD"]),
    untrackedFiles: readGitLines(repoRoot, ["ls-files", "--others", "--exclude-standard"])
  };
}

function readGitLines(repoRoot: string, args: string[]): string[] {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8"
  });

  if (result.status !== 0 || typeof result.stdout !== "string") {
    return [];
  }

  return uniqueSorted(
    result.stdout
      .split(/\r?\n/u)
      .map((line) => normalizeRepoPath(line))
      .filter(Boolean)
  );
}

function readGitScalar(repoRoot: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8"
  });

  if (result.status !== 0 || typeof result.stdout !== "string") {
    return undefined;
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
  } catch {
    return {
      path: normalizeRepoPath(filePath),
      existed: false,
      encoding: "base64"
    };
  }
}

async function restoreRollbackSnapshot(
  repoRoot: string,
  snapshot: RollbackFileSnapshot
): Promise<void> {
  const absolutePath = resolveRepoPath(repoRoot, snapshot.path);

  if (!snapshot.existed || !snapshot.contentBase64) {
    await rm(absolutePath, { recursive: true, force: true });
    return;
  }

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, Buffer.from(snapshot.contentBase64, "base64"));
}

function restoreTrackedFileFromHead(repoRoot: string, filePath: string): void {
  const result = spawnSync(
    "git",
    ["restore", "--staged", "--worktree", "--source=HEAD", "--", filePath],
    {
      cwd: repoRoot,
      encoding: "utf8"
    }
  );

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `git restore failed for ${filePath}`);
  }
}

async function removeRepoPath(repoRoot: string, filePath: string): Promise<void> {
  await rm(resolveRepoPath(repoRoot, filePath), { recursive: true, force: true });
}

function resolveRepoPath(repoRoot: string, filePath: string): string {
  const resolvedRoot = resolve(repoRoot);
  const resolvedPath = resolve(resolvedRoot, filePath);
  const relativePath = relative(resolvedRoot, resolvedPath);

  if (relativePath.startsWith("..") || relativePath === "") {
    throw new Error(`Refusing to access a rollback path outside repo root: ${filePath}`);
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
