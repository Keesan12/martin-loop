#!/usr/bin/env node

import { chmod, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_FACADES = [
  {
    packageName: "@martin/contracts",
    sourceDir: ["packages", "contracts", "dist"],
    targetDir: ["dist", "vendor", "contracts"],
  },
  {
    packageName: "@martin/core",
    sourceDir: ["packages", "core", "dist"],
    targetDir: ["dist", "vendor", "core"],
  },
  {
    packageName: "@martin/adapters",
    sourceDir: ["packages", "adapters", "dist"],
    targetDir: ["dist", "vendor", "adapters"],
  },
  {
    packageName: "@martin/cli",
    sourceDir: ["packages", "cli", "dist"],
    targetDir: ["dist", "vendor", "cli"],
  },
];

const REWRITABLE_PACKAGES = {
  "@martin/contracts": "contracts",
  "@martin/core": "core",
  "@martin/adapters": "adapters",
  "@martin/cli": "cli",
};

export async function buildPublicFacade(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const distDir = path.join(rootDir, "dist");

  await rm(distDir, { force: true, recursive: true });
  await mkdir(path.join(distDir, "bin"), { recursive: true });

  for (const facade of PACKAGE_FACADES) {
    await copyFacadeDirectory({
      sourceDir: path.join(rootDir, ...facade.sourceDir),
      targetDir: path.join(rootDir, ...facade.targetDir),
      distDir,
    });
  }

  await writeFile(path.join(distDir, "index.js"), createRootIndexSource(), "utf8");
  await writeFile(path.join(distDir, "index.d.ts"), createRootTypesSource(), "utf8");
  await writeFile(path.join(distDir, "bin", "martin-loop.js"), createRootBinSource(), "utf8");
  await chmod(path.join(distDir, "bin", "martin-loop.js"), 0o755);

  return {
    distDir,
    binPath: path.join(distDir, "bin", "martin-loop.js"),
    vendorDir: path.join(distDir, "vendor"),
  };
}

async function copyFacadeDirectory(input) {
  await copyDirectory({
    sourceDir: input.sourceDir,
    targetDir: input.targetDir,
    distDir: input.distDir,
    relativeDir: "",
  });
}

async function copyDirectory(input) {
  await mkdir(input.targetDir, { recursive: true });

  const entries = await readdir(input.sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = input.relativeDir
      ? path.join(input.relativeDir, entry.name)
      : entry.name;

    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name, relativePath)) {
        continue;
      }

      await copyDirectory({
        sourceDir: path.join(input.sourceDir, entry.name),
        targetDir: path.join(input.targetDir, entry.name),
        distDir: input.distDir,
        relativeDir: relativePath,
      });
      continue;
    }

    if (shouldSkipFile(entry.name)) {
      continue;
    }

    const sourcePath = path.join(input.sourceDir, entry.name);
    const targetPath = path.join(input.targetDir, entry.name);

    if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) {
      const contents = await readFile(sourcePath, "utf8");
      const rewritten = rewritePackageSpecifiers(contents, {
        targetPath,
        distDir: input.distDir,
      });
      await writeFile(targetPath, rewritten, "utf8");
      continue;
    }

    await copyFile(sourcePath, targetPath);
  }
}

function shouldSkipDirectory(name, relativePath) {
  return name === "tests" || relativePath === "src";
}

function shouldSkipFile(name) {
  return name.endsWith(".map");
}

function rewritePackageSpecifiers(contents, input) {
  return contents.replace(
    /(['"])(@martin\/(?:contracts|core|adapters|cli))\1/g,
    (_match, quote, packageName) => {
      const mapped = REWRITABLE_PACKAGES[packageName];
      if (!mapped) {
        return `${quote}${packageName}${quote}`;
      }

      const specifier = toImportSpecifier(
        path.dirname(input.targetPath),
        path.join(input.distDir, "vendor", mapped, "index.js"),
      );

      return `${quote}${specifier}${quote}`;
    },
  );
}

function toImportSpecifier(fromDir, toFile) {
  const relativePath = path.relative(fromDir, toFile).split(path.sep).join("/");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function createRootIndexSource() {
  return [
    'import { runMartin } from "./vendor/core/index.js";',
    "",
    'export { runMartin, compilePromptPacket, createFileRunStore, makeLedgerEvent, resolveRunsRoot } from "./vendor/core/index.js";',
    'export { executeCli, parseCliArguments, renderCliHelp } from "./vendor/cli/index.js";',
    'export { createClaudeCliAdapter, createCodexCliAdapter, createDirectProviderAdapter, createStubDirectProviderAdapter, createStubAgentCliAdapter } from "./vendor/adapters/index.js";',
    'export { appendLoopEvent, buildPortfolioSnapshot, createGovernanceSnapshot, createLoopRecord, createTelemetryEnvelope, DEFAULT_BUDGET, EMPTY_COST, validateTelemetryBatch, validateTelemetryEnvelope } from "./vendor/contracts/index.js";',
    "",
    "export class MartinLoop {",
    "  constructor(options = {}) {",
    "    this.adapter = options.adapter;",
    "    this.defaults = options.defaults ?? {};",
    "  }",
    "",
    "  async run(input) {",
    "    const merged = {",
    "      ...this.defaults,",
    "      ...input,",
    "      metadata: {",
    "        ...(this.defaults.metadata ?? {}),",
    "        ...(input.metadata ?? {}),",
    "      },",
    "      adapter: input.adapter ?? this.adapter,",
    "    };",
    "",
    "    if (!merged.adapter) {",
    '      throw new Error("MartinLoop.run requires an adapter. Import an adapter helper from \\"martin-loop\\" or pass a MartinAdapter instance.");',
    "    }",
    "",
    "    return runMartin(merged);",
    "  }",
    "}",
    "",
  ].join("\n");
}

function createRootTypesSource() {
  return [
    'export { runMartin, compilePromptPacket, createFileRunStore, makeLedgerEvent, resolveRunsRoot } from "./vendor/core/index.js";',
    'export type { CompileResult, MartinAdapter, MartinAdapterRequest, MartinAdapterResult, PromptPacket, RunMartinInput, RunMartinResult, RunStore } from "./vendor/core/index.js";',
    'export { executeCli, parseCliArguments, renderCliHelp } from "./vendor/cli/index.js";',
    'export type { ParsedCliArguments, RunCommandRequest } from "./vendor/cli/index.js";',
    'export { createClaudeCliAdapter, createCodexCliAdapter, createDirectProviderAdapter, createStubDirectProviderAdapter, createStubAgentCliAdapter } from "./vendor/adapters/index.js";',
    'export type { AgentCliAdapterOptions, ClaudeCliAdapterOptions, CliArgsBuilder, CodexCliAdapterOptions, DirectProviderAdapterOptions, SpawnLike, StubAgentCliAdapterOptions, StubDirectProviderAdapterOptions, SubprocessResult, VerificationOutcome } from "./vendor/adapters/index.js";',
    'export { appendLoopEvent, buildPortfolioSnapshot, createGovernanceSnapshot, createLoopRecord, createTelemetryEnvelope, DEFAULT_BUDGET, EMPTY_COST, validateTelemetryBatch, validateTelemetryEnvelope } from "./vendor/contracts/index.js";',
    'export type { ApprovalPolicy, ExecutionProfile, LoopBudget, LoopRecord, LoopTask } from "./vendor/contracts/index.js";',
    "",
    "export interface MartinLoopOptions {",
    "  adapter?: MartinAdapter;",
    '  defaults?: Partial<Omit<RunMartinInput, "adapter">>;',
    "}",
    "",
    'export type MartinLoopRunInput = Omit<RunMartinInput, "adapter"> & {',
    "  adapter?: MartinAdapter;",
    "};",
    "",
    "export declare class MartinLoop {",
    "  constructor(options?: MartinLoopOptions);",
    "  run(input: MartinLoopRunInput): Promise<RunMartinResult>;",
    "}",
    "",
  ].join("\n");
}

function createRootBinSource() {
  return [
    "#!/usr/bin/env node",
    "",
    'import { executeCli } from "../vendor/cli/index.js";',
    "",
    "const args = process.argv.slice(2);",
    "",
    "executeCli(args)",
    "  .then((result) => {",
    "    if (result.stdout) {",
    '      process.stdout.write(`${result.stdout}\\n`);',
    "    }",
    "",
    "    if (result.stderr) {",
    '      process.stderr.write(`${result.stderr}\\n`);',
    "    }",
    "",
    "    process.exitCode = result.exitCode;",
    "  })",
    "  .catch((error) => {",
    '    const message = error instanceof Error ? error.message : String(error);',
    '    process.stderr.write(`${message}\\n`);',
    "    process.exitCode = 1;",
    "  });",
    "",
  ].join("\n");
}

async function main() {
  const result = await buildPublicFacade({ rootDir: process.cwd() });
  process.stdout.write(`Public facade written to ${result.distDir}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Public facade build failed: ${message}\n`);
    process.exitCode = 1;
  });
}
