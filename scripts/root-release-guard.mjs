#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRcCommandExecution } from "./rc-validation.mjs";

const ROOT_VERSION_PATTERN = /^0\.(?:2|3|4)\.\d+$/;
const ALLOWED_FILES = [
  "benchmarks/fixtures",
  "CODE_OF_CONDUCT.md",
  "README.md",
  "demo/seeded-workspace",
  "dist",
];
const REQUIRED_DIST_FILES = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/bin/martin-loop.js",
];
const ALLOWED_PACKED_PREFIXES = [
  "benchmarks/README.md",
  "benchmarks/fixtures/",
  "CODE_OF_CONDUCT.md",
  "LICENSE",
  "README.md",
  "demo/README.md",
  "demo/seeded-workspace/",
  "dist/",
  "package.json",
];
const FORBIDDEN_PACKED_PATH_PATTERNS = [
  /^dist\/vendor\/cli\/bin\//u,
  /^dist\/vendor\/adapters\/stub-agent-cli\.(?:js|d\.ts)$/u,
];

export async function runRootReleaseGuard(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const tag = options.tag ?? null;
  const pack = options.pack ?? false;
  const manifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));

  assertRootVersionPolicy(manifest.version);

  if (tag !== null && tag !== `v${manifest.version}`) {
    throw new Error(`Release tag ${tag} does not match package version v${manifest.version}.`);
  }

  assertExactSet("files", manifest.files ?? [], ALLOWED_FILES);
  assertExactSet("workspaces", manifest.workspaces ?? [], ["benchmarks", "packages/*"]);

  const result = {
    name: manifest.name,
    version: manifest.version,
    tag,
    packChecked: false,
  };

  if (!pack) {
    return result;
  }

  await assertDistArtifactsPresent(rootDir);
  await assertVendoredCliManifest(rootDir);
  const packedFiles = await inspectPackedFiles({ rootDir });
  assertPackedSurface(packedFiles);

  return {
    ...result,
    packChecked: true,
    packedFiles,
  };
}

export function assertRootVersionPolicy(version) {
  if (!ROOT_VERSION_PATTERN.test(version)) {
    throw new Error(`Root martin-loop version must stay on the 0.2.x, 0.3.x, or 0.4.x line. Received ${version}.`);
  }
}

export function assertPackedSurface(packedFiles) {
  const uniqueFiles = [...new Set(packedFiles)].sort();

  for (const requiredFile of ["package.json", ...REQUIRED_DIST_FILES]) {
    if (!uniqueFiles.includes(requiredFile)) {
      throw new Error(`Packed tarball is missing required file ${requiredFile}.`);
    }
  }

  for (const packedFile of uniqueFiles) {
    if (!ALLOWED_PACKED_PREFIXES.some((prefix) => packedFile === prefix || packedFile.startsWith(prefix))) {
      throw new Error(`Packed tarball includes unexpected path ${packedFile}.`);
    }

    if (FORBIDDEN_PACKED_PATH_PATTERNS.some((pattern) => pattern.test(packedFile))) {
      throw new Error(`Packed tarball includes forbidden vendored implementation path ${packedFile}.`);
    }
  }
}

export async function inspectPackedFiles(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const ignoreScripts = options.ignoreScripts ?? true;
  const command = ["npm", "pack", "--dry-run", "--json"];
  if (ignoreScripts) {
    command.push("--ignore-scripts");
  }
  const packRun = await runCommand(
    command,
    { cwd: rootDir },
  );
  const packArtifacts = extractPackJsonPayload(packRun.stdout);
  return extractPackedFilePaths(packArtifacts);
}

export function extractPackedFilePaths(packArtifacts) {
  const artifact = normalizePackArtifact(packArtifacts);
  const artifactFiles = Array.isArray(artifact?.files) ? artifact.files : [];
  const files = artifactFiles.map((entry) => entry.path).filter((entry) => typeof entry === "string");

  if (files.length === 0) {
    const artifactKeys = artifact === null ? "none" : Object.keys(artifact).sort().join(", ");
    throw new Error(`npm pack --dry-run did not report any packaged files. Artifact keys: ${artifactKeys}.`);
  }

  return files;
}

function normalizePackArtifact(packArtifacts) {
  if (Array.isArray(packArtifacts)) {
    return packArtifacts[0] ?? null;
  }

  if (packArtifacts !== null && typeof packArtifacts === "object") {
    if (Array.isArray(packArtifacts.files)) {
      return packArtifacts;
    }

    const keyedArtifacts = Object.values(packArtifacts).filter(
      (artifact) => artifact !== null && typeof artifact === "object",
    );
    return keyedArtifacts[0] ?? null;
  }

  return null;
}

export function extractPackJsonPayload(stdout) {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error("npm pack --json produced no stdout.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // npm versions may print notices around --json output. Extract the first
    // balanced JSON value so release validation stays tied to npm's payload.
  }

  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== "[" && trimmed[index] !== "{") {
      continue;
    }

    const candidate = extractBalancedJsonValue(trimmed, index);
    if (candidate === null) {
      continue;
    }

    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }

  throw new Error("Unable to parse npm pack --json output.");
}

function extractBalancedJsonValue(text, startIndex) {
  const stack = [];
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }

    if (character === "[") {
      stack.push("]");
      continue;
    }

    if (character === "{") {
      stack.push("}");
      continue;
    }

    if (character === "]" || character === "}") {
      if (stack.pop() !== character) {
        return null;
      }

      if (stack.length === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

export async function assertVendoredCliManifest(rootDir) {
  const manifestPath = path.join(rootDir, "dist", "vendor", "cli", "package.json");
  const rootManifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  if (manifest.version !== rootManifest.version) {
    throw new Error(
      `Vendored CLI manifest version must match root package version ${rootManifest.version}. Received ${String(manifest.version)}.`,
    );
  }

  if (manifest.main !== "./index.js") {
    throw new Error(`Vendored CLI manifest must point main at ./index.js. Received ${String(manifest.main)}.`);
  }

  if (manifest.types !== "./index.d.ts") {
    throw new Error(`Vendored CLI manifest must point types at ./index.d.ts. Received ${String(manifest.types)}.`);
  }

  if (manifest.bin !== undefined) {
    throw new Error("Vendored CLI manifest must not publish its internal bin surface inside the root package facade.");
  }

  const manifestText = JSON.stringify(manifest);
  if (/workspace:\*/u.test(manifestText)) {
    throw new Error("Vendored CLI manifest must not leak workspace:* dependencies into the public root package.");
  }
}

async function assertDistArtifactsPresent(rootDir) {
  await Promise.all(
    REQUIRED_DIST_FILES.map(async (relativePath) => {
      await access(path.join(rootDir, relativePath));
    }),
  );
}

function assertExactSet(fieldName, actualValues, expectedValues) {
  const actual = [...new Set(actualValues)].sort();
  const expected = [...new Set(expectedValues)].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${fieldName} must exactly match the OSS-safe allowlist. Expected ${expected.join(", ")}; received ${actual.join(", ")}.`,
    );
  }
}

function parseCliArgs(argv) {
  const tagIndex = argv.indexOf("--tag");
  const pack = argv.includes("--pack");

  return {
    tag: tagIndex === -1 ? null : argv[tagIndex + 1] ?? null,
    pack,
  };
}

function runCommand(command, options) {
  const execution = resolveRcCommandExecution(command, process.platform);
  const env = buildLifecycleSafeEnv();

  return new Promise((resolve, reject) => {
    const child = spawn(execution.command, execution.args, {
      cwd: options.cwd,
      env,
      shell: execution.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`Command failed (${code ?? "unknown"}): ${command.join(" ")}\n${stdout}${stderr}`),
        );
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function buildLifecycleSafeEnv(sourceEnv = process.env) {
  const env = { ...sourceEnv };

  for (const key of Object.keys(env)) {
    if (
      key === "INIT_CWD" ||
      key === "npm_command" ||
      key === "npm_execpath" ||
      key === "npm_node_execpath" ||
      key.startsWith("npm_config_") ||
      key.startsWith("npm_lifecycle_") ||
      key.startsWith("npm_package_") ||
      key.startsWith("PNPM_") ||
      key.startsWith("pnpm_")
    ) {
      delete env[key];
    }
  }

  return env;
}

async function main() {
  const args = parseCliArgs(process.argv);
  const result = await runRootReleaseGuard({
    rootDir: process.cwd(),
    tag: args.tag,
    pack: args.pack,
  });

  process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Root release guard failed: ${message}\n`);
    process.exitCode = 1;
  });
}
