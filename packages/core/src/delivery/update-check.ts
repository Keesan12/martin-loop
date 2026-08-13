import { createRequire } from "node:module";

// CLI and MCP version checks are intentionally independent — they use different
// package names and must never share a constant or resolve function.

/**
 * Returns the installed version of the CLI package (`martin-loop`).
 * Call site: CLI only. Never call from MCP.
 */
export function getCliInstalledVersion(): string | null {
  return resolvePackageVersion("martin-loop");
}

/**
 * Returns the installed version of the MCP package (`@martinloop/mcp`).
 * Call site: MCP only. Never call from CLI.
 */
export function getMcpInstalledVersion(): string | null {
  return resolvePackageVersion("@martinloop/mcp");
}

/**
 * Compare two semver strings. Returns true when `available` is strictly
 * newer than `current`.
 *
 * Prereleases are never surfaced as updates unless the user's current
 * version is itself a prerelease (semver prerelease protection).
 * Build metadata (+build) does not affect precedence.
 */
export function isNewerVersion(current: string, available: string): boolean {
  const currentVersion = parseSemver(current);
  const availableVersion = parseSemver(available);

  if (!currentVersion || !availableVersion) return false;

  // Stable users must never be offered a prerelease.
  if (
    currentVersion.prerelease.length === 0 &&
    availableVersion.prerelease.length > 0
  ) {
    return false;
  }

  return compareSemver(availableVersion, currentVersion) > 0;
}

function resolvePackageVersion(name: string): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require(`${name}/package.json`) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

// ─── SemVer parser and comparator ────────────────────────────────────────────

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
}

function parseSemver(version: string): ParsedSemver | null {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version
    );

  if (!match) return null;

  const prerelease: Array<number | string> = [];

  for (const identifier of match[4]?.split(".") ?? []) {
    if (/^\d+$/.test(identifier)) {
      // Leading zeros on numeric identifiers are invalid per SemVer spec.
      if (identifier.length > 1 && identifier.startsWith("0")) return null;
      prerelease.push(Number(identifier));
    } else {
      prerelease.push(identifier);
    }
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

/**
 * Returns a positive number if left > right, negative if left < right, 0 if equal.
 * Implements SemVer 2.0.0 precedence rules exactly.
 */
function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }

  // When base versions are equal: stable (no prerelease) > prerelease.
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  // Both have prereleases — compare identifier by identifier.
  const length = Math.max(left.prerelease.length, right.prerelease.length);

  for (let index = 0; index < length; index++) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];

    if (a === undefined) return -1; // fewer identifiers = lower precedence
    if (b === undefined) return 1;
    if (a === b) continue;

    if (typeof a === "number" && typeof b === "number") return a > b ? 1 : -1;
    if (typeof a === "number") return -1; // numeric < alphanumeric
    if (typeof b === "number") return 1;
    return a > b ? 1 : -1; // both alphanumeric: lexicographic
  }

  return 0;
}
