import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnPlan =
      process.platform === "win32"
        ? {
            command: process.env.ComSpec ?? "cmd.exe",
            args: ["/d", "/s", "/c", [command, ...args].map(quoteForCmd).join(" ")],
          }
        : {
            command,
            args,
          };

    const child = spawn(spawnPlan.command, spawnPlan.args, {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: {
        ...process.env,
        CI: "true",
        ...(options.env ?? {}),
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${String(code)}\nstdout:\n${stdout}\nstderr:\n${stderr}`
        )
      );
    });
  });
}

function quoteForCmd(value) {
  if (!/[\s"]/u.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}

test("benchmark workspace cold-builds from a fresh dependency state", async () => {
  const pathsToReset = [
    path.join(ROOT_DIR, "packages", "contracts", "dist"),
    path.join(ROOT_DIR, "packages", "core", "dist"),
    path.join(ROOT_DIR, "benchmarks", "dist"),
  ];

  for (const target of pathsToReset) {
    await rm(target, { recursive: true, force: true });
  }

  await run("pnpm", ["--filter", "@martin/benchmarks", "build"]);

  await access(path.join(ROOT_DIR, "packages", "contracts", "dist", "index.d.ts"));
  await access(path.join(ROOT_DIR, "packages", "core", "dist", "index.d.ts"));
  await access(path.join(ROOT_DIR, "benchmarks", "dist", "index.js"));
});

test("public benchmark docs align to the shipped benchmark commands", async () => {
  const readme = await readFile(path.join(ROOT_DIR, "README.md"), "utf8");
  const cliReference = await readFile(path.join(ROOT_DIR, "docs", "reference", "cli.md"), "utf8");
  const cliReadme = await readFile(path.join(ROOT_DIR, "packages", "cli", "README.md"), "utf8");
  const challengeDoc = await readFile(path.join(ROOT_DIR, "docs", "concepts", "under-3-challenge.md"), "utf8");

  for (const contents of [readme, cliReference, cliReadme, challengeDoc]) {
    assert.match(contents, /under-3-challenge/);
  }

  assert.match(readme, /npx martin-loop bench --suite under-3-challenge/);
  assert.match(readme, /pnpm install --frozen-lockfile/);
  assert.match(readme, /pnpm --filter @martin\/benchmarks build/);
  assert.match(cliReference, /martin-loop bench --suite <suiteId>/);
  assert.match(cliReference, /pnpm install --frozen-lockfile/);
  assert.match(cliReadme, /npx martin-loop bench --suite ralphy-engineering-50/);
  assert.match(cliReadme, /pnpm install --frozen-lockfile/);
  assert.match(challengeDoc, /pnpm install --frozen-lockfile/);
  assert.match(challengeDoc, /benchmarks\/fixtures\/under-3-challenge\.json/);
});
