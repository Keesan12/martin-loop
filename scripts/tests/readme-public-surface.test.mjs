import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const PUBLIC_LINK_SURFACES = [
  "README.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/getting-started",
  "docs/concepts",
  "docs/reference",
  "docs/security",
  "docs/release",
  "packages/cli/README.md",
  "packages/mcp/README.md",
];

const FORBIDDEN_PUBLIC_COPY_PATTERNS = [
  /\bremediation\b/i,
  /\bstable cockpit line\b/i,
  /\brelease-proof\b/i,
  /\bpublic feature contract\b/i,
  /\bworkspace chatter\b/i,
  /\bprivate roadmap\b/i,
  /\blocal machine\b/i,
  /\bKeesan explicitly\b/i,
  /\bpending directory\b/i,
  /\bprivate beta\b/i,
];

async function readRepoFile(relativePath) {
  return readFile(path.join(ROOT_DIR, relativePath), "utf8");
}

async function readRootManifest() {
  return JSON.parse(await readRepoFile("package.json"));
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

test("root README is a public product entry point", async () => {
  const readme = await readRepoFile("README.md");
  const manifest = await readRootManifest();

  const expectedOrder = [
    "## Why MartinLoop",
    "## Quick Start",
    "## What It Does",
    "## How It Works",
    "## CLI",
    "## Benchmarks",
    "## MCP",
    "## SDK",
    "## Examples",
    "## Development",
    "## Contributing",
    "## License",
  ];

  let previousIndex = -1;
  for (const heading of expectedOrder) {
    const index = readme.indexOf(heading);
    assert.notEqual(index, -1, `README must include ${heading}`);
    assert.ok(index > previousIndex, `${heading} must appear after the previous public README section`);
    previousIndex = index;
  }

  assert.match(readme, /MartinLoop gives AI coding agents budgets, stop conditions, rollback rules, and receipts\./i);
  assert.match(readme, /Built from thousands of agent runs where the problem was not intelligence -- it was uncontrolled execution\./i);
  assert.match(readme, /## Why Star This\?/);
  assert.match(readme, /## 2-Minute Install Path/);
  assert.match(readme, /## Visual Proof/);
  assert.match(readme, /MartinLoop turns an AI coding run into an inspectable execution record/i);
  assert.match(readme, /Ungoverned agents can retry until cost and scope drift/i);
  assert.match(readme, /<img src="\.\/docs\/assets\/cli-animated\.svg" alt="MartinLoop CLI showing a governed agent run"/);
  assert.match(readme, /<img src="\.\/docs\/assets\/side-by-side\.svg" alt="MartinLoop governed run compared with an unbounded retry loop"/);
  assert.match(readme, /<img src="\.\/docs\/assets\/cli-static\.svg" alt="MartinLoop CLI terminal output"/);
  assert.doesNotMatch(readme, /martinloop-demo\.gif/);
  assert.match(readme, /\*\*Star this repo:\*\* \[GitHub stars]\(https:\/\/github\.com\/Keesan12\/martin-loop\)/);
  assert.match(readme, /\*\*Try it now:\*\* `npx -y martin-loop@latest start`/);
  assert.match(readme, /\[!\[npm version]\(https:\/\/img\.shields\.io\/npm\/v\/martin-loop/);
  assert.match(readme, /If this flow saved you time, please star the repo to help other builders find it\./);
  assert.match(readme, /\*\*Star the repo\*\* if you think AI coding needs budgets, brakes, and receipts\./);
  assert.match(readme, /\[support@martinloop\.com]\(mailto:support@martinloop\.com\)/);
  assert.match(readme, /npx(?: -y)? martin-loop(?:@latest)? demo/);
  assert.match(readme, /npx(?: -y)? martin-loop(?:@latest)? run .* --proof --verify "npm test"/);
  assert.match(readme, /npx(?: -y)? martin-loop(?:@latest)? dossier --latest/);
  assert.match(readme, /npx martin-loop bench --suite under-3-challenge/);
  assert.match(readme, /pnpm --filter @martin\/benchmarks build/);
  assert.match(readme, /pnpm --filter @martin\/benchmarks eval/);
  assert.match(readme, /npx -y @martinloop\/mcp/);
  assert.match(readme, /import \{ MartinLoop, createClaudeCliAdapter \} from "martin-loop"/);
  assert.match(readme, new RegExp(`docs/release/OSS-${manifest.version.replace(/\./g, "\\.")}-RELEASE-NOTES\\.md`));
  assert.doesNotMatch(readme, /What's New In/i);
});

test("public markdown copy avoids non-public process language", async () => {
  const markdownFiles = await listPublicMarkdownSurfaces();

  for (const relativePath of markdownFiles) {
    const contents = await readRepoFile(relativePath);
    for (const pattern of FORBIDDEN_PUBLIC_COPY_PATTERNS) {
      assert.doesNotMatch(contents, pattern, `${relativePath} contains ${pattern}`);
    }
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

test("obsolete public distribution folder is absent", async () => {
  const removedPaths = [
    path.join(ROOT_DIR, "docs", "distribution"),
  ];

  for (const removedPath of removedPaths) {
    await assert.rejects(access(removedPath), /ENOENT/);
  }
});
