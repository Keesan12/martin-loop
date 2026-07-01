import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC_SURFACE_PATHS = [
  ".github",
  "CHANGELOG.md",
  "README.md",
  "docs",
  "dist",
  "package.json",
  "packages/adapters/package.json",
  "packages/cli/package.json",
  "packages/contracts/package.json",
  "packages/core/package.json",
  "packages/mcp/package.json"
];
const FORBIDDEN_PATTERNS = [
  /\bMIT Licensed\b/iu,
  /\bMIT license\b/iu,
  /\bLicense:\s*MIT\b/iu,
  /"license"\s*:\s*"MIT"/u,
  /license-MIT/iu
];
const ALLOWED_EXTENSIONS = new Set([".json", ".md", ".mjs", ".txt", ".ts", ".tsx", ".js", ".yml", ".yaml"]);

test("public release surface does not contain stale MIT licensing copy", async () => {
  const violations = [];

  for (const relativePath of PUBLIC_SURFACE_PATHS) {
    const absolutePath = path.join(ROOT_DIR, relativePath);
    const entryStat = await stat(absolutePath).catch(() => null);
    if (!entryStat) {
      continue;
    }

    if (entryStat.isDirectory()) {
      const files = await walkFiles(absolutePath);
      for (const filePath of files) {
        const contents = await readFile(filePath, "utf8");
        const matches = FORBIDDEN_PATTERNS.filter((pattern) => pattern.test(contents));
        if (matches.length > 0) {
          violations.push(path.relative(ROOT_DIR, filePath));
        }
      }
      continue;
    }

    const contents = await readFile(absolutePath, "utf8");
    const matches = FORBIDDEN_PATTERNS.filter((pattern) => pattern.test(contents));
    if (matches.length > 0) {
      violations.push(relativePath);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Found stale MIT copy in public release surfaces:\n${violations.map((entry) => `- ${entry}`).join("\n")}`
  );
});

async function walkFiles(directory) {
  const results = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkFiles(absolutePath)));
      continue;
    }

    if (ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.push(absolutePath);
    }
  }

  return results;
}
