/**
 * Directory names that hold dependency installs or build output. Git-ignored
 * content under them is tracked as a single collapsed entry and is not checked
 * file by file for protected secrets.
 */
export const DEPENDENCY_AND_BUILD_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "bower_components",
  "jspm_packages",
  ".pnpm-store",
  ".yarn",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".gradle",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "target",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor"
]);

export function isInsideDependencyOrBuildDirectory(repoPath: string): boolean {
  const segments = repoPath.replace(/\\/gu, "/").split("/").filter(Boolean);
  // A trailing collapsed entry such as `node_modules/` is itself the directory.
  return segments.some((segment) => DEPENDENCY_AND_BUILD_DIRECTORIES.has(segment));
}
