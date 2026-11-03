#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_ONBOARDING_SURFACES = [
  "README.md",
  "packages/cli/README.md",
  "docs/reference/cli.md",
  "docs/getting-started/mcp.md",
  "docs/getting-started/quickstart.md",
  "docs/oss/QUICKSTART.md",
  "docs/oss/MCP-FOR-AI-AGENTS.md",
  "docs/reference/mcp-compatibility.md",
  "docs/release/MCP-PUBLISHING.md",
];

const SHELL_FENCE_LANGUAGES = new Set(["bash", "console", "powershell", "sh", "shell"]);
const SUPPORTED_ENGINES = new Set(["claude", "codex", "gemini", "openai"]);
const UNSAFE_GOVERNED_EXAMPLE_REASON =
  "governed run/preflight example must select a supported --engine or follow an adjacent enable --engine gate";
const LIVE_STANDALONE_MCP_BASELINE_PATTERN =
  /^\s*`@martinloop\/mcp@(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`\s+is the live public standalone MCP baseline\b/iu;

function parseStandaloneMcpLiveBaseline(versionLedger) {
  const section = versionLedger.match(
    /## Standalone package: `@martinloop\/mcp`(?<body>[\s\S]*?)(?=\n## |$)/u,
  )?.groups?.body;
  const matches = [...(section ?? "").matchAll(
    /^\s*-\s*standalone MCP public baseline:\s*`(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`\s*$/gimu,
  )];

  if (matches.length !== 1 || !matches[0]?.groups?.version) {
    throw new Error(
      "VERSION-LEDGER.md must declare exactly one standalone MCP public baseline in the standalone package section",
    );
  }

  return matches[0].groups.version;
}

function parseFencedBlocks(contents) {
  const lines = contents.split(/\r?\n/u);
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const opening = lines[index].match(/^\s*```([^`]*)\s*$/u);
    if (!opening) {
      continue;
    }

    const language = opening[1].trim().toLowerCase().split(/\s+/u)[0] ?? "";
    const body = [];
    const startIndex = index;
    index += 1;

    while (index < lines.length && !/^\s*```\s*$/u.test(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }

    blocks.push({
      language,
      body: body.join("\n"),
      startIndex,
      endIndex: index,
      line: startIndex + 1,
    });
  }

  return { lines, blocks };
}

function extractEngine(command) {
  const match = command.match(/(?:^|\s)--engine(?:\s+|=)([^\s\\]+)/u);
  return match?.[1]?.replace(/^['"]|['"]$/gu, "").toLowerCase();
}

function classifyCommands(block) {
  const commands = block.body.split(/\r?\n/u);
  const governed = [];
  const gates = [];

  for (const [index, command] of commands.entries()) {
    const executable = String.raw`(?:martin(?:-loop)?|npx(?:\s+-y)?\s+martin-loop(?:@[^\s]+)?)`;
    const governedMatch = command.match(new RegExp(String.raw`(?:^|\s)${executable}\s+(run|preflight)\b`, "u"));
    if (governedMatch && !/(?:^|\s)--proof(?:\s|$)/u.test(command)) {
      governed.push({ command, engine: extractEngine(command), index });
    }

    const gateMatch = command.match(new RegExp(String.raw`(?:^|\s)${executable}\s+enable\b`, "u"));
    if (gateMatch) {
      gates.push({ command, engine: extractEngine(command), index });
    }
  }

  return { governed, gates };
}

function findAdjacentGate({ blockIndex, blocks, lines }) {
  const current = blocks[blockIndex];
  const previous = blocks[blockIndex - 1];
  if (!previous || !SHELL_FENCE_LANGUAGES.has(previous.language)) {
    return undefined;
  }

  const between = lines.slice(previous.endIndex + 1, current.startIndex);
  if (between.some((line) => /^\s{0,3}#{1,6}\s+/u.test(line))) {
    return undefined;
  }

  const gates = classifyCommands(previous).gates;
  return gates.at(-1);
}

function engineViolation(engine) {
  if (!engine) {
    return UNSAFE_GOVERNED_EXAMPLE_REASON;
  }
  if (!SUPPORTED_ENGINES.has(engine)) {
    return `unsupported engine "${engine}"; expected one of: claude, codex, gemini, openai`;
  }
  return undefined;
}

export function evaluateOnboardingDocument({
  relativePath,
  contents,
  currentRootVersion,
  currentMcpVersion,
  liveMcpVersion,
}) {
  const { lines, blocks } = parseFencedBlocks(contents);
  const violations = [];

  if (currentRootVersion && currentMcpVersion) {
    for (const [index, line] of lines.entries()) {
      const packagePattern = /(?<package>martin-loop|@martinloop\/mcp)@(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/gu;
      const liveMcpDeclaration = line.match(LIVE_STANDALONE_MCP_BASELINE_PATTERN);
      const liveMcpDeclarationIndex = liveMcpDeclaration
        ? line.indexOf("@martinloop/mcp@", liveMcpDeclaration.index)
        : -1;
      for (const match of line.matchAll(packagePattern)) {
        const packageName = match.groups?.package;
        const version = match.groups?.version;
        const currentVersion = packageName === "@martinloop/mcp" ? currentMcpVersion : currentRootVersion;
        const isDeclaredLiveMcpBaseline = packageName === "@martinloop/mcp"
          && match.index === liveMcpDeclarationIndex
          && version === liveMcpDeclaration?.groups?.version
          && Boolean(liveMcpVersion);
        if (isDeclaredLiveMcpBaseline && version !== liveMcpVersion) {
          violations.push({
            relativePath,
            line: index + 1,
            reason: `stale live MCP baseline ${version}; version ledger live baseline is ${liveMcpVersion}`,
          });
        } else if (!isDeclaredLiveMcpBaseline && version && version !== currentVersion) {
          violations.push({
            relativePath,
            line: index + 1,
            reason: `stale package version "${packageName}@${version}"; current package version is ${currentVersion}`,
          });
        }
      }

      const proseMatch = line.match(/\b(?<version>\d+\.\d+\.\d+)\b.*\bcurrent public (?:standalone )?MCP package line\b/iu)
        ?? line.match(/\bcurrent public (?:standalone )?MCP package line\b.*\b(?<version>\d+\.\d+\.\d+)\b/iu);
      const proseVersion = proseMatch?.groups?.version;
      if (proseVersion && proseVersion !== currentMcpVersion) {
        violations.push({
          relativePath,
          line: index + 1,
          reason: `stale MCP package line ${proseVersion}; current package version is ${currentMcpVersion}`,
        });
      }
    }
  }

  for (const [blockIndex, block] of blocks.entries()) {
    if (!SHELL_FENCE_LANGUAGES.has(block.language)) {
      continue;
    }

    const { governed, gates } = classifyCommands(block);
    if (governed.length === 0) {
      continue;
    }

    const adjacentGate = findAdjacentGate({ blockIndex, blocks, lines });

    for (const command of governed) {
      let reason = engineViolation(command.engine);
      if (reason === UNSAFE_GOVERNED_EXAMPLE_REASON) {
        const sameBlockGate = gates.filter((gate) => gate.index < command.index).at(-1);
        const gate = sameBlockGate ?? adjacentGate;
        reason = gate ? engineViolation(gate.engine) : reason;
      }

      if (reason) {
        violations.push({ relativePath, line: block.line, reason });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

export async function evaluatePublicOnboardingSurfaces(rootDir = process.cwd()) {
  const violations = [];
  const rootPackage = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  const mcpPackage = JSON.parse(await readFile(path.join(rootDir, "packages/mcp/package.json"), "utf8"));
  const versionLedger = await readFile(path.join(rootDir, "docs/release/VERSION-LEDGER.md"), "utf8");
  const liveMcpVersion = parseStandaloneMcpLiveBaseline(versionLedger);

  for (const relativePath of PUBLIC_ONBOARDING_SURFACES) {
    const contents = await readFile(path.join(rootDir, relativePath), "utf8");
    violations.push(...evaluateOnboardingDocument({
      relativePath,
      contents,
      currentRootVersion: rootPackage.version,
      currentMcpVersion: mcpPackage.version,
      liveMcpVersion,
    }).violations);
  }

  return {
    ok: violations.length === 0,
    checkedFiles: [...PUBLIC_ONBOARDING_SURFACES],
    violations,
  };
}

async function main() {
  const result = await evaluatePublicOnboardingSurfaces(process.cwd());
  if (result.ok) {
    process.stdout.write(`Public onboarding guard passed (${result.checkedFiles.length} files).\n`);
    return;
  }

  process.stderr.write("Public onboarding guard failed.\n");
  for (const violation of result.violations) {
    process.stderr.write(`- ${violation.relativePath}:${violation.line}: ${violation.reason}\n`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Public onboarding guard failed: ${message}\n`);
    process.exitCode = 1;
  });
}
