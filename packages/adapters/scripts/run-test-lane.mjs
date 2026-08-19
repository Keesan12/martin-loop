import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const vitestPackageJsonPath = require.resolve("vitest/package.json");
const vitestPackageJson = require(vitestPackageJsonPath);
const vitestEntrypoint = path.join(path.dirname(vitestPackageJsonPath), vitestPackageJson.bin.vitest);

const lane = process.argv[2] ?? "baseline";

const heavyClaudeCliPattern = [
  "returns estimated cost provenance when the CLI does not emit settled usage",
  "reports verifier-created file changes instead of treating verify-only as clean"
].join("|");

// These six legacy assertions encoded one static Codex argv contract. Their
// behavior is now covered by codex-cli.test.ts using explicit negotiated
// capability profiles, including absolute-binary routing and JSONL settlement.
const legacyStaticCodexPattern = [
  "uses codex exec with an explicit writable sandbox instead of legacy full-auto",
  "preserves custom Codex model, sandbox, and extra exec flags before stdin prompt",
  "runs MartinLoop verification after successful Codex exec completion",
  "fails closed when Codex exits non-zero before emitting structured completion",
  "settles authoritative Codex usage from JSONL turn.completed output",
  "reports pre-verifier Codex launch failures without running verifier commands"
].join("|");

const baselineExclusionPattern = [heavyClaudeCliPattern, legacyStaticCodexPattern].join("|");

const commands =
  lane === "baseline"
    ? [
        ["run", "--maxWorkers=1", "--exclude", "tests/claude-cli.test.ts"],
        [
          "run",
          "--maxWorkers=1",
          "tests/claude-cli.test.ts",
          "--testNamePattern",
          `^(?!.*(${baselineExclusionPattern})).*$`
        ],
        [
          "run",
          "--maxWorkers=1",
          "tests/claude-cli.test.ts",
          "--testNamePattern",
          "returns estimated cost provenance when the CLI does not emit settled usage"
        ],
        [
          "run",
          "--maxWorkers=1",
          "tests/claude-cli.test.ts",
          "--testNamePattern",
          "reports verifier-created file changes instead of treating verify-only as clean"
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
