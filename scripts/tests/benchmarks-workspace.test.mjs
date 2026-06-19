import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

test("benchmark commands do not rebuild shared workspace artifacts implicitly", async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT_DIR, "benchmarks", "package.json"), "utf8"));
  const scripts = manifest.scripts ?? {};

  assert.equal(typeof scripts.build, "string");
  assert.equal(scripts.preeval, undefined);
  assert.equal(scripts["prereport:ralphy"], undefined);
  assert.match(scripts.eval, /^tsx src\/eval\.ts --suite under-3-challenge$/u);
  assert.match(scripts["report:ralphy"], /^tsx src\/eval\.ts --suite ralphy-engineering-50$/u);
});

test("benchmark eval and report commands run through public workspace commands", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "martin-benchmark-output-"));

  try {
    const env = { MARTIN_BENCHMARK_OUTPUT_DIR: outputDir };
    const evalResult = await run("pnpm", ["--filter", "@martin/benchmarks", "eval"], { env });
    const reportResult = await run("pnpm", ["--filter", "@martin/benchmarks", "report:ralphy"], { env });

    assert.match(evalResult.stdout, /Under-\$3 Challenge/u);
    assert.match(reportResult.stdout, /Ralph Loop Stress Report/u);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("benchmark artifacts are append-only when rerunning the same suite", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "martin-benchmark-output-"));

  try {
    const env = { MARTIN_BENCHMARK_OUTPUT_DIR: outputDir };
    await run("pnpm", ["--filter", "@martin/benchmarks", "eval"], { env });
    await run("pnpm", ["--filter", "@martin/benchmarks", "eval"], { env });

    const files = await readdir(outputDir);
    const jsonFiles = files.filter((entry) => entry.endsWith(".json")).sort();
    const markdownFiles = files.filter((entry) => entry.endsWith(".md")).sort();

    assert.deepEqual(jsonFiles, [
      "under-3-challenge-report.json",
      "under-3-challenge-report.rev-0001.json",
    ]);
    assert.deepEqual(markdownFiles, [
      "under-3-challenge-report.md",
      "under-3-challenge-report.rev-0001.md",
    ]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
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
