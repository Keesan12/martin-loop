#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const outputRoot = path.join(packageRoot, "dist-mcpb");
const stagingRoot = path.join(outputRoot, "martinloop");
const serverRoot = path.join(stagingRoot, "server");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? packageRoot,
      env: { ...process.env, ...options.env },
      stdio: "inherit",
      shell: false,
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} ${args.join(" ")} failed (code=${String(code)}, signal=${String(signal)})`));
    });
  });
}

function runPnpm(args, options = {}) {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) {
    throw new Error("MCPB builds must run through pnpm so npm_execpath identifies the locked pnpm CLI.");
  }
  return run(process.execPath, [pnpmCli, ...args], options);
}

async function isFile(filePath) {
  try { return (await stat(filePath)).isFile(); } catch { return false; }
}

async function isDirectory(directoryPath) {
  try { return (await stat(directoryPath)).isDirectory(); } catch { return false; }
}

function assertReleaseTreeClean() {
  const status = execFileSync(
    "git",
    ["-c", `safe.directory=${repositoryRoot}`, "status", "--porcelain", "--", "packages/mcp"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
  if (status) throw new Error(`Uncommitted changes exist under packages/mcp:\n${status}`);
}

async function verifyStaging() {
  const required = [
    path.join(stagingRoot, "manifest.json"),
    path.join(stagingRoot, "LICENSE"),
    path.join(serverRoot, "package.json"),
    path.join(serverRoot, "README.md"),
    path.join(serverRoot, "dist", "server.js"),
    path.join(serverRoot, "node_modules", "@modelcontextprotocol", "sdk")
  ];
  for (const requiredPath of required) {
    const exists = requiredPath.endsWith("sdk") ? await isDirectory(requiredPath) : await isFile(requiredPath);
    if (!exists) throw new Error(`Required staged path is missing: ${requiredPath}`);
  }
  for (const forbidden of [".env", ".env.local"]) {
    if (await isFile(path.join(stagingRoot, forbidden))) throw new Error(`Forbidden file included in staging: ${forbidden}`);
  }
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function build() {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(scriptDirectory, "manifest.json"), "utf8"));
  if (packageJson.name !== "@martinloop/mcp") throw new Error(`Unexpected package: ${packageJson.name}`);
  if (manifest.version !== packageJson.version) throw new Error(`Version mismatch: manifest=${manifest.version}, package=${packageJson.version}`);

  assertReleaseTreeClean();
  const bundleName = `martinloop-${packageJson.version}.mcpb`;
  const bundlePath = path.join(outputRoot, bundleName);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  await runPnpm(["build"], { cwd: packageRoot });
  const builtServer = path.join(packageRoot, "dist", "server.js");
  if (!(await isFile(builtServer))) throw new Error(`Build did not produce ${builtServer}`);

  await runPnpm(
    [
      "--config.inject-workspace-packages=true",
      "--config.node-linker=hoisted",
      "--filter",
      "@martinloop/mcp",
      "deploy",
      "--prod",
      serverRoot,
    ],
    { cwd: repositoryRoot },
  );

  const deployedPackagePath = path.join(serverRoot, "package.json");
  const deployedPackage = JSON.parse(await readFile(deployedPackagePath, "utf8"));
  delete deployedPackage.devDependencies;
  delete deployedPackage.optionalDependencies;
  delete deployedPackage.pnpm;
  await writeFile(deployedPackagePath, `${JSON.stringify(deployedPackage, null, 2)}\n`);

  await rm(path.join(serverRoot, "pnpm-lock.yaml"), { force: true });
  await rm(path.join(serverRoot, "node_modules", ".modules.yaml"), { force: true });
  await rm(path.join(serverRoot, "node_modules", ".pnpm-workspace-state-v1.json"), { force: true });
  await rm(path.join(serverRoot, "node_modules", ".pnpm"), { recursive: true, force: true });
  await rm(path.join(serverRoot, "node_modules", ".bin"), { recursive: true, force: true });

  await cp(path.join(repositoryRoot, "LICENSE"), path.join(stagingRoot, "LICENSE"));
  await cp(path.join(scriptDirectory, ".mcpbignore"), path.join(stagingRoot, ".mcpbignore"));
  await writeFile(path.join(stagingRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  await verifyStaging();
  await runPnpm(["exec", "mcpb", "validate", stagingRoot]);
  await runPnpm(["exec", "mcpb", "pack", stagingRoot, bundlePath]);
  if (!(await isFile(bundlePath))) throw new Error(`Bundle was not created: ${bundlePath}`);

  const digest = await sha256(bundlePath);
  await writeFile(`${bundlePath}.sha256`, `${digest}  ${bundleName}\n`);
  process.stdout.write(`Created ${bundlePath}\nSHA-256 ${digest}\n`);
}

build().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
