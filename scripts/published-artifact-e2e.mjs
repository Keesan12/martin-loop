#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { packRootRelease } from "./pack-root-release.mjs";

const ACCEPTANCE_FILE = "src/packaged-artifact-e2e.ts";
const ACCEPTANCE_CONTENT = "export const packagedArtifactE2e = true;\n";
const LEDGER_FILENAME = "ledger.jsonl";

function parseArgs(argv) {
  const specArg = argv.find((arg) => arg.startsWith("--package-spec="));
  const specIndex = argv.indexOf("--package-spec");
  const packageSpec = specArg
    ? specArg.slice("--package-spec=".length)
    : specIndex === -1
      ? undefined
      : argv[specIndex + 1];

  if (!packageSpec) {
    throw new Error("Missing --package-spec. Use --package-spec=pack or --package-spec martin-loop@x.y.z.");
  }

  return { packageSpec };
}

async function resolvePackageSpec(packageSpec, rootDir, tempRoot) {
  if (packageSpec !== "pack") {
    return packageSpec;
  }

  const result = await packRootRelease({
    rootDir,
    outputDir: path.join(tempRoot, "pack"),
  });
  return result.tarballPath;
}

async function runCommand(command, options) {
  const execution = resolvePublishedArtifactCommandExecution(command, process.platform);

  return new Promise((resolve, reject) => {
    const child = spawn(execution.command, execution.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: execution.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (options.echo) process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (options.echo) process.stderr.write(text);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed (${code ?? "unknown"}): ${command.join(" ")}\n${stdout}${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export function resolvePublishedArtifactCommandExecution(command, platform = process.platform, comSpec = process.env.ComSpec ?? "cmd.exe") {
  if (platform !== "win32") {
    return {
      command: command[0],
      args: command.slice(1),
      shell: false,
    };
  }

  const executable = resolveWindowsExecutable(command[0]);
  if (requiresWindowsCommandShim(executable)) {
    return {
      command: comSpec,
      args: ["/d", "/c", executable, ...command.slice(1)],
      shell: false,
    };
  }

  return {
    command: executable,
    args: command.slice(1),
    shell: false,
  };
}

function resolveWindowsExecutable(command) {
  if (path.extname(command).length > 0) {
    return command;
  }

  if (command === "npm" || command === "pnpm" || command === "npx") {
    return `${command}.cmd`;
  }

  return command;
}

function requiresWindowsCommandShim(command) {
  const extension = path.extname(command).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

async function writeConsumerRunner(consumerDir, workspaceDir, runsRoot) {
  const runnerPath = path.join(consumerDir, "packaged-artifact-e2e-runner.mjs");
  const source = `
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFileRunStore, runMartin } from "martin-loop";
import { verifyReceiptIntegrityFromFiles } from "martin-loop/core";

const workspaceDir = ${JSON.stringify(workspaceDir)};
const runsRoot = ${JSON.stringify(runsRoot)};
const acceptanceFile = ${JSON.stringify(ACCEPTANCE_FILE)};
const acceptanceContent = ${JSON.stringify(ACCEPTANCE_CONTENT)};

const store = createFileRunStore({ runsRoot });
const adapter = {
  adapterId: "direct:packaged-artifact-e2e",
  kind: "direct-provider",
  label: "Packaged artifact E2E adapter",
  metadata: {
    providerId: "packaged-artifact-e2e",
    model: "deterministic"
  },
  async execute(request) {
    await mkdir(join(workspaceDir, "src"), { recursive: true });
    await writeFile(join(workspaceDir, acceptanceFile), acceptanceContent, "utf8");
    return {
      status: "completed",
      summary: "Created the packaged artifact E2E source file.",
      usage: {
        actualUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        provenance: "actual"
      },
      verification: {
        passed: true,
        summary: "Packaged artifact E2E verifier passed.",
        binding: {
          runId: request.loopId,
          workspaceId: request.workspaceId,
          cwd: request.context.repoRoot ?? workspaceDir,
          commands: request.context.verificationPlan
        },
        steps: request.context.verificationPlan.map((command) => ({
          command,
          launched: true,
          completed: true,
          crashed: false,
          exitCode: 0,
          timedOut: false
        }))
      },
      execution: {
        changedFiles: [acceptanceFile],
        diffStats: {
          filesChanged: 1,
          addedLines: 1,
          deletedLines: 0
        }
      }
    };
  }
};

const result = await runMartin({
  workspaceId: "ws_packaged_artifact_e2e",
  projectId: "proj_packaged_artifact_e2e",
  task: {
    title: "Packaged artifact E2E",
    objective: "Create a new allowed source file from an installed package artifact.",
    verificationPlan: ["node -e \\"process.exit(0)\\""],
    repoRoot: workspaceDir,
    allowedPaths: [acceptanceFile]
  },
  budget: {
    maxUsd: 1,
    softLimitUsd: 1,
    maxIterations: 1
  },
  adapter,
  store
});

const loopId = result.loop.loopId;
const loopRoot = join(runsRoot, loopId);
const persistedContent = await readFile(join(workspaceDir, acceptanceFile), "utf8");
const ledger = await readFile(join(loopRoot, ${JSON.stringify(LEDGER_FILENAME)}), "utf8");
const patchDecision = JSON.parse(await readFile(join(loopRoot, "artifacts", "attempt-001", "patch-decision.json"), "utf8"));
const receipt = await verifyReceiptIntegrityFromFiles({
  runId: loopId,
  runsRoot,
  loopRecordPath: join(loopRoot, "loop-record.json"),
  ledgerPath: join(loopRoot, ${JSON.stringify(LEDGER_FILENAME)})
});

if (result.decision.lifecycleState !== "completed") {
  throw new Error("Expected completed lifecycle, received " + result.decision.lifecycleState);
}
if (persistedContent !== acceptanceContent) {
  throw new Error("Accepted file content mismatch.");
}
if (patchDecision.decision !== "KEEP") {
  throw new Error("Expected KEEP patch decision, received " + patchDecision.decision);
}
if (patchDecision.reasonCodes.includes("grounding_failure")) {
  throw new Error("Unexpected grounding_failure in KEEP patch decision.");
}
if (ledger.includes("attempt.discarded") || ledger.includes("repo_grounding_failure")) {
  throw new Error("Unexpected discard or grounding failure in ledger.");
}
if (receipt.state !== "verified") {
  throw new Error("Expected verified receipt integrity, received " + receipt.state);
}

process.stdout.write(JSON.stringify({
  ok: true,
  packageVersion: (await import("martin-loop/package.json", { with: { type: "json" } })).default.version,
  loopId,
  lifecycleState: result.decision.lifecycleState,
  patchDecision: patchDecision.decision,
  receiptState: receipt.state,
  keyId: receipt.keyId,
  loopRecordSha256: receipt.loopRecordSha256,
  ledgerSha256: receipt.ledgerSha256,
  changedFiles: result.loop.events.find((event) => event.type === "verification.completed")?.payload?.changedFiles ?? []
}, null, 2) + "\\n");
`;

  await writeFile(runnerPath, source, "utf8");
  return runnerPath;
}

export async function runPublishedArtifactE2e(options) {
  const rootDir = options.rootDir ?? process.cwd();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "martin published artifact e2e "));
  const consumerDir = path.join(tempRoot, "consumer");
  const workspaceDir = path.join(tempRoot, "workspace");
  const runsRoot = path.join(tempRoot, "runs");
  const keysRoot = path.join(tempRoot, "keys");
  const queueRoot = path.join(tempRoot, "queue");
  const stateRoot = path.join(tempRoot, "state");
  const groundingRoot = path.join(tempRoot, "grounding");

  await Promise.all([
    mkdir(consumerDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    mkdir(runsRoot, { recursive: true }),
    mkdir(keysRoot, { recursive: true }),
    mkdir(queueRoot, { recursive: true }),
    mkdir(stateRoot, { recursive: true }),
    mkdir(groundingRoot, { recursive: true }),
  ]);

  const resolvedPackageSpec = await resolvePackageSpec(options.packageSpec, rootDir, tempRoot);

  await writeFile(path.join(consumerDir, "package.json"), `${JSON.stringify({
    name: "martin-published-artifact-e2e-consumer",
    version: "1.0.0",
    private: true,
    type: "module",
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(workspaceDir, "README.md"), "# Packaged artifact E2E fixture\n", "utf8");
  await runCommand(["git", "init"], { cwd: workspaceDir });
  await runCommand(["git", "config", "user.email", "packaged-artifact-e2e@example.invalid"], { cwd: workspaceDir });
  await runCommand(["git", "config", "user.name", "Packaged Artifact E2E"], { cwd: workspaceDir });
  await runCommand(["git", "add", "README.md"], { cwd: workspaceDir });
  await runCommand(["git", "commit", "-m", "Add packaged artifact E2E fixture"], { cwd: workspaceDir });
  await runCommand(["npm", "install", "--save-exact", resolvedPackageSpec], { cwd: consumerDir, echo: true });

  const runnerPath = await writeConsumerRunner(consumerDir, workspaceDir, runsRoot);
  const env = {
    ...process.env,
    MARTIN_RUNS_DIR: runsRoot,
    MARTIN_INTEGRITY_KEY_DIR: keysRoot,
    MARTIN_SYNC_QUEUE_DIR: queueRoot,
    MARTIN_STATE_DIR: stateRoot,
    MARTIN_GROUNDING_DIR: groundingRoot,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: workspaceDir,
  };
  const result = await runCommand(["node", runnerPath], { cwd: consumerDir, env, echo: true });

  return {
    tempRoot,
    packageSpec: options.packageSpec,
    resolvedPackageSpec,
    output: JSON.parse(result.stdout),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runPublishedArtifactE2e({
    packageSpec: options.packageSpec,
    rootDir: process.cwd(),
  });

  process.stdout.write(`\nPUBLISHED_ARTIFACT_E2E=${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Published artifact E2E failed: ${message}\n`);
    process.exitCode = 1;
  });
}
