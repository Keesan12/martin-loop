#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_ONBOARDING_SURFACES = [
  "README.md",
  "packages/cli/README.md",
  "docs/reference/cli.md",
];

const SHELL_FENCE_LANGUAGES = new Set(["bash", "console", "powershell", "sh", "shell"]);
const SUPPORTED_ENGINES = new Set(["claude", "codex", "gemini", "openai"]);
const UNSAFE_GOVERNED_EXAMPLE_REASON =
  "governed run/preflight example must select a supported --engine or follow an adjacent enable --engine gate";

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

export function evaluateOnboardingDocument({ relativePath, contents }) {
  const { lines, blocks } = parseFencedBlocks(contents);
  const violations = [];

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

  for (const relativePath of PUBLIC_ONBOARDING_SURFACES) {
    const contents = await readFile(path.join(rootDir, relativePath), "utf8");
    violations.push(...evaluateOnboardingDocument({ relativePath, contents }).violations);
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
