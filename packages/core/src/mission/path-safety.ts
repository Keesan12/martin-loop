import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const SAFE_MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function assertMissionId(missionId: string): void {
  if (!SAFE_MISSION_ID.test(missionId)) {
    throw new TypeError("missionId must be a safe path component");
  }
}

/** Reject existing aliases below the caller-provided mission storage root. */
export function assertSafeMissionPath(root: string, missionId: string): string {
  assertMissionId(missionId);
  const rootPath = resolve(root);
  const missionsPath = join(rootPath, "missions");
  const missionPath = join(missionsPath, missionId);
  assertContained(rootPath, missionPath);

  let canonicalRoot = rootPath;
  if (exists(rootPath)) {
    assertNotAlias(rootPath, "mission root");
    canonicalRoot = realpathSync.native(rootPath);
  }
  for (const [path, label] of [[missionsPath, "missions directory"], [missionPath, "mission directory"]] as const) {
    if (!exists(path)) break;
    assertNotAlias(path, label);
    assertContained(canonicalRoot, realpathSync.native(path));
  }
  return missionPath;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertNotAlias(path: string, label: string): void {
  if (lstatSync(path).isSymbolicLink()) {
    throw new TypeError(`${label} is an unsafe symbolic-link or junction ancestor`);
  }
}

function assertContained(parent: string, candidate: string): void {
  const relation = relative(parent, candidate);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new TypeError("missionId path escaped its governed root");
  }
}
