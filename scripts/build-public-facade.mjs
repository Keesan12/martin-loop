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
    packageJson: ["packages", "cli", "package.json"],
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
  const rootManifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  const rootPackageVersion =
    typeof rootManifest.version === "string" && rootManifest.version.length > 0
      ? rootManifest.version
      : null;

  await rm(distDir, { force: true, recursive: true });
  await mkdir(path.join(distDir, "bin"), { recursive: true });

  for (const facade of PACKAGE_FACADES) {
    await copyFacadeDirectory({
      packageName: facade.packageName,
      sourceDir: path.join(rootDir, ...facade.sourceDir),
      targetDir: path.join(rootDir, ...facade.targetDir),
      distDir,
      packageJsonSource: facade.packageJson ? path.join(rootDir, ...facade.packageJson) : null,
      rootPackageVersion,
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
    packageName: input.packageName,
    sourceDir: input.sourceDir,
    targetDir: input.targetDir,
    distDir: input.distDir,
    packageJsonTarget: input.packageJsonSource ? path.join(input.targetDir, "package.json") : null,
    relativeDir: "",
  });

  if (input.packageJsonSource) {
    const rawManifest = JSON.parse(await readFile(input.packageJsonSource, "utf8"));
    const sanitizedManifest = sanitizeVendoredPackageJson(
      rawManifest,
      input.packageName,
      input.rootPackageVersion,
    );
    await writeFile(
      path.join(input.targetDir, "package.json"),
      `${JSON.stringify(sanitizedManifest, null, 2)}\n`,
      "utf8",
    );
  }
}

async function copyDirectory(input) {
  await mkdir(input.targetDir, { recursive: true });

  const entries = await readdir(input.sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = input.relativeDir
      ? path.join(input.relativeDir, entry.name)
      : entry.name;

    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name, relativePath, input.packageName)) {
        continue;
      }

      await copyDirectory({
        packageName: input.packageName,
        sourceDir: path.join(input.sourceDir, entry.name),
        targetDir: path.join(input.targetDir, entry.name),
        distDir: input.distDir,
        packageJsonTarget: input.packageJsonTarget,
        relativeDir: relativePath,
      });
      continue;
    }

    if (shouldSkipFile(entry.name, relativePath, input.packageName)) {
      continue;
    }

    const sourcePath = path.join(input.sourceDir, entry.name);
    const targetPath = path.join(input.targetDir, entry.name);

    if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) {
      const contents = await readFile(sourcePath, "utf8");
      let rewritten = rewritePackageJsonSpecifier(
        rewritePackageSpecifiers(contents, {
          targetPath,
          distDir: input.distDir,
        }),
        {
          targetPath,
          packageJsonTarget: input.packageJsonTarget,
        },
      );
      if (
        input.packageName === "@martin/adapters" &&
        (relativePath === "index.js" || relativePath === "index.d.ts")
      ) {
        rewritten = sanitizeVendoredAdaptersIndex(rewritten);
      }
      await writeFile(targetPath, rewritten, "utf8");
      continue;
    }

    await copyFile(sourcePath, targetPath);
  }
}

function shouldSkipDirectory(name, relativePath, packageName) {
  return (
    name === "tests" ||
    relativePath === "src" ||
    (packageName === "@martin/cli" && relativePath === "bin")
  );
}

function shouldSkipFile(name, relativePath, packageName) {
  return (
    name.endsWith(".map") ||
    (
      packageName === "@martin/adapters" &&
      /^stub-agent-cli\.(?:js|d\.ts)$/u.test(relativePath)
    )
  );
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

function rewritePackageJsonSpecifier(contents, input) {
  if (!input.packageJsonTarget) {
    return contents;
  }

  const specifier = toImportSpecifier(path.dirname(input.targetPath), input.packageJsonTarget);
  return contents.replace(/require\((['"])\.\.\/package\.json\1\)/gu, `require("${specifier}")`);
}

function sanitizeVendoredAdaptersIndex(contents) {
  return contents.replace(
    /^export \{.*createStubAgentCliAdapter.*\} from "\.\/stub-agent-cli\.js";\r?\n?/gmu,
    "",
  );
}

function sanitizeVendoredPackageJson(manifest, packageName, rootPackageVersion) {
  const version =
    packageName === "@martin/cli" && rootPackageVersion
      ? rootPackageVersion
      : manifest.version ?? "0.0.0";
  const sanitized = {
    name: manifest.name ?? packageName,
    version,
    type: manifest.type ?? "module",
    description: manifest.description ?? `${packageName} vendored for the martin-loop root package.`,
    main: "./index.js",
    types: "./index.d.ts",
    exports: {
      ".": {
        types: "./index.d.ts",
        default: "./index.js",
      },
      "./package.json": "./package.json",
    },
  };

  return sanitized;
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
    'export { createClaudeCliAdapter, createCodexCliAdapter, createGeminiCliAdapter, createDirectProviderAdapter, createOpenAiCompatibleAdapter, createVerifierOnlyAdapter } from "./vendor/adapters/index.js";',
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
    'export { createClaudeCliAdapter, createCodexCliAdapter, createGeminiCliAdapter, createDirectProviderAdapter, createOpenAiCompatibleAdapter, createVerifierOnlyAdapter } from "./vendor/adapters/index.js";',
    'export type { AgentCliAdapterOptions, ClaudeCliAdapterOptions, CliArgsBuilder, CodexCliAdapterOptions, GeminiCliAdapterOptions, DirectProviderAdapterOptions, OpenAiCompatibleAdapterOptions, SpawnLike, SubprocessResult, VerificationOutcome, VerifierOnlyAdapterOptions } from "./vendor/adapters/index.js";',
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
