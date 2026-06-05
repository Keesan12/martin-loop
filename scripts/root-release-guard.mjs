#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRcCommandExecution } from "./rc-validation.mjs";

const ROOT_VERSION_PATTERN = /^0\.(?:1|2)\.\d+$/;
const ALLOWED_FILES = [
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
  "CODE_OF_CONDUCT.md",
  "LICENSE",
  "README.md",
  "demo/seeded-workspace/",
  "dist/",
  "package.json",
];
const FORBIDDEN_PACKED_PATH_PATTERNS = [
  /^dist\/vendor\/cli\/bin\//u,
  /^dist\/vendor\/adapters\/stub-(agent-cli|direct-provider)\.(?:js|d\.ts)$/u,
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
  assertExactSet("workspaces", manifest.workspaces ?? [], ["packages/*"]);

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

export async function assertVendoredCliManifest(rootDir) {
  const manifestPath = path.join(rootDir, "dist", "vendor", "cli", "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

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

export function assertRootVersionPolicy(version) {
  if (!ROOT_VERSION_PATTERN.test(version)) {
    throw new Error(`Root martin-loop version must stay on the approved pre-1.0 OSS lines (0.1.x or 0.2.x). Received ${version}.`);
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
  const files = Array.isArray(packArtifacts)
    ? packArtifacts[0]?.files?.map((entry) => entry.path).filter((entry) => typeof entry === "string")
    : [];

  if (files.length === 0) {
    throw new Error("npm pack --dry-run did not report any packaged files.");
  }

  return files;
}

export function extractPackJsonPayload(stdout) {
  const trimmed = stdout.trim();
  const trailingJsonMatch = trimmed.match(/(\[\s*\{[\s\S]*\}\s*\])$/);
  const jsonPayload = trailingJsonMatch?.[1] ?? trimmed;
  return JSON.parse(jsonPayload);
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

  return new Promise((resolve, reject) => {
    const child = spawn(execution.command, execution.args, {
      cwd: options.cwd,
      env: process.env,
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

async function main() {
  const args = parseCliArgs(process.argv);
  const result = await runRootReleaseGuard({
    rootDir: process.cwd(),
    tag: args.tag,
    pack: args.pack,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
