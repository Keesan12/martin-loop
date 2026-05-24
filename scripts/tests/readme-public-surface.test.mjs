import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import rootPackageJson from "../../package.json" with { type: "json" };
import mcpPackageJson from "../../packages/mcp/package.json" with { type: "json" };

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC_LINK_SURFACES = [
  "README.md",
  "docs/oss",
  "docs/distribution",
  "packages/mcp/README.md",
];

const FORBIDDEN_README_PATTERNS = [
  /\b0\.1\.4\b/i,
  /\brelease candidate\b/i,
  /\bregistry publication\b/i,
  /\brepo:smoke\b/i,
  /\bpilot:prep:validate\b/i,
  /\bworkspace-only\b/i,
  /\bprivate workspace\b/i,
  /\bhosted control-plane\b/i,
  /\blocal dashboard\b/i,
  /\bapps\/control-plane\b/i,
  /\bapps\/local-dashboard\b/i,
  /\bbenchmarks\//i,
  /\bPlase\b/i,
  /\bmartin command alias\b/i,
  /^martin run\b/im,
  /^martin inspect\b/im,
  /^martin resume\b/im
];

async function readReadme() {
  return readFile(path.join(ROOT_DIR, "README.md"), "utf8");
}

async function readRepoFile(relativePath) {
  return readFile(path.join(ROOT_DIR, relativePath), "utf8");
}

async function collectMarkdownFiles(relativePath) {
  const fullPath = path.join(ROOT_DIR, relativePath);
  const entries = await readdir(fullPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryRelativePath = path.posix.join(relativePath.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(entryRelativePath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(entryRelativePath);
    }
  }

  return files;
}

async function listPublicMarkdownSurfaces() {
  const files = [];

  for (const surface of PUBLIC_LINK_SURFACES) {
    if (surface.endsWith(".md")) {
      files.push(surface);
      continue;
    }

    files.push(...(await collectMarkdownFiles(surface)));
  }

  return files.sort();
}

function stripCodeFences(contents) {
  return contents.replace(/```[\s\S]*?```/g, "");
}

function extractLocalMarkdownLinks(contents) {
  const stripped = stripCodeFences(contents);
  const matches = stripped.matchAll(/!?\[[^\]]*]\((?!https?:|mailto:|#)([^)]+)\)/g);

  return [...new Set(
    [...matches]
      .map((match) => match[1].trim())
      .map((target) => target.replace(/^<|>$/g, ""))
      .map((target) => target.split("#")[0]?.split("?")[0] ?? "")
      .filter(Boolean),
  )].sort();
}

test("root README matches the current public package versions and launch surfaces", async () => {
  const readme = await readReadme();

  assert.match(readme, new RegExp(`martin-loop@${rootPackageJson.version.replaceAll(".", "\\.")}`));
  assert.match(readme, /npm install -g martin-loop/);
  assert.match(readme, /npx martin-loop doctor/);
  assert.match(readme, /npx martin-loop demo/);
  assert.match(readme, /MARTIN_LIVE=false npx martin-loop run/);
  assert.match(readme, /npx martin-loop triage/);
  assert.match(readme, /npx martin-loop dossier --latest/);
  assert.match(readme, /npx martin-loop run/);
  assert.match(readme, /npx martin-loop inspect/);
  assert.match(readme, /npx martin-loop resume/);
  assert.match(readme, new RegExp(`@martinloop/mcp@${mcpPackageJson.version.replaceAll(".", "\\.")}`));
  assert.match(readme, /ten stdio tools plus read-only resources/i);
  assert.match(readme, /`martin_run` remains the only tool that can execute work/i);
  assert.match(readme, /martin_list_runs/);
  assert.match(readme, /martin_run_dossier/);
  assert.match(readme, /martin mcp print-config --host codex --profile minimal/);
  assert.match(readme, /martin mcp print-config --host claude --profile diagnostic/);
  assert.match(readme, /martin mcp print-config --host gemini --profile full-local/);
  assert.match(readme, /`minimal` is the default local stdio profile/i);
  assert.match(readme, /ranks persisted runs using failure categories/i);
});

test("root README stays clean client-facing public copy", async () => {
  const readme = await readReadme();

  for (const pattern of FORBIDDEN_README_PATTERNS) {
    assert.doesNotMatch(readme, pattern);
  }
});

test("public markdown links resolve inside the repo", async () => {
  const markdownFiles = await listPublicMarkdownSurfaces();

  for (const relativePath of markdownFiles) {
    const contents = await readRepoFile(relativePath);
    const targets = extractLocalMarkdownLinks(contents);

    for (const target of targets) {
      const resolvedPath = path.resolve(path.dirname(path.join(ROOT_DIR, relativePath)), target);
      await access(resolvedPath);
    }
  }
});

test("docs/posts does not contain unlinked markdown artifacts", async () => {
  const postDir = path.join(ROOT_DIR, "docs", "posts");
  let postFiles = [];

  try {
    postFiles = (await readdir(postDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  const surfaceFiles = await listPublicMarkdownSurfaces();
  const surfaceContents = await Promise.all(surfaceFiles.map((relativePath) => readRepoFile(relativePath)));
  const referenceText = surfaceContents.join("\n");

  for (const postFile of postFiles) {
    const linked =
      referenceText.includes(`docs/posts/${postFile}`) ||
      referenceText.includes(`./docs/posts/${postFile}`) ||
      referenceText.includes(postFile);

    assert.equal(linked, true, `docs/posts/${postFile} must be linked from a public markdown surface`);
  }
});
