#!/usr/bin/env node
// SPDX-FileCopyrightText: MartinLoop contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(process.cwd());
const distRoot = join(root, "dist");
const sourceSha = git(["rev-parse", "HEAD"]).toLowerCase();
const sourceTree = git(["rev-parse", "HEAD^{tree}"]).toLowerCase();
const trackedStatus = git(["status", "--porcelain", "--untracked-files=no"]);
if (trackedStatus) throw new Error("candidate build manifest requires a clean tracked source tree");
const packagePath = join(root, "package.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const manifest = {
  schemaVersion: "martin.candidate-build.v1",
  generatedBy: "pnpm build",
  generatedAt: new Date().toISOString(),
  sourceSha,
  sourceTree,
  packageVersion: packageJson.version,
  packageJson: await binding(packagePath),
  cliEntrypoint: await binding(join(distRoot, "bin", "martin-loop.js")),
  coreEntrypoint: await binding(join(distRoot, "vendor", "core", "index.js")),
  packageFiles: await inventory(distRoot),
};
const output = join(root, ".martin", "generated", "candidate-build.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`[candidate-build] manifest ${output}\n`);

async function inventory(directory, base = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`candidate package contains a link alias: ${path}`);
    if (entry.isDirectory()) files.push(...await inventory(path, base));
    else if (entry.isFile()) files.push({ path: relative(base, path).replaceAll("\\", "/"), sha256: await sha256(path) });
    else throw new Error(`candidate package contains a non-file entry: ${path}`);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
async function binding(path) { return { path, sha256: await sha256(path) }; }
async function sha256(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
function git(args) { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
