import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const vitestPackageJsonPath = require.resolve("vitest/package.json");
const vitestPackageJson = require(vitestPackageJsonPath);
const vitestEntrypoint = path.join(path.dirname(vitestPackageJsonPath), vitestPackageJson.bin.vitest);

const lane = process.argv[2] ?? "baseline";

const heavyMcpToolsPattern = [
  "reports run-store visibility in proof mode without requiring live CLIs",
  "detects tampering in canonical persisted runs and surfaces receipt scope",
  "uses the injected proof-mode verifier spawn for verification-only contract tests",
  "returns a loop outcome in stub mode",
  "respects engine selection",
  "persists repoRoot and path constraints into the loop record"
].join("|");

const heavyServerValidationPattern = [
  "accepts a matching doctor-plan-preflight receipt chain for martin_run when maxUsd is below the default soft limit",
  "accepts a matching doctor-plan-preflight receipt chain when no path allow/deny filters are provided"
].join("|");

const commands =
  lane === "baseline"
    ? [
        [
          "run",
          "--maxWorkers=1",
          "--exclude",
          "tests/mcp-tools.test.ts",
          "--exclude",
          "tests/server-validation.test.ts",
          "--exclude",
          "tests/eval.test.ts"
        ],
        [
          "run",
          "--maxWorkers=1",
          "tests/mcp-tools.test.ts",
          "--testNamePattern",
          `^(?!.*(${heavyMcpToolsPattern})).*$`
        ],
        [
          "run",
          "--maxWorkers=1",
          "tests/server-validation.test.ts",
          "--testNamePattern",
          `^(?!.*(${heavyServerValidationPattern})).*$`
        ]
      ]
    : (() => {
        throw new Error(`Unsupported test lane: ${lane}`);
      })();

for (const args of commands) {
  const result = spawnSync(process.execPath, [vitestEntrypoint, ...args], {
    stdio: "inherit",
    shell: false
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
