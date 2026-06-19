import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const vitestPackageJsonPath = require.resolve("vitest/package.json");
const vitestPackageJson = require(vitestPackageJsonPath);
const vitestEntrypoint = path.join(path.dirname(vitestPackageJsonPath), vitestPackageJson.bin.vitest);

const lane = process.argv[2] ?? "baseline";

const rollbackPattern =
  "skips rollback snapshots for adapters that cannot mutate the workspace|restores the pre-attempt repo boundary for discarded verifier regressions and preserves pre-existing dirty files|restores forbidden file changes on the filesystem safety-block path and persists rollback artifacts";

const commands =
  lane === "rollback"
    ? [
        ["exec", "vitest", "run", "tests/runtime.test.ts", "--testNamePattern", rollbackPattern]
      ]
    : [
        ["exec", "vitest", "run", "--exclude", "tests/runtime.test.ts"],
        [
          "exec",
          "vitest",
          "run",
          "tests/runtime.test.ts",
          "--testNamePattern",
          `^(?!.*(${rollbackPattern})).*$`
        ]
      ];

for (const args of commands) {
  const result = spawnSync(process.execPath, [vitestEntrypoint, ...args.slice(1)], {
    stdio: "inherit",
    shell: false
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
