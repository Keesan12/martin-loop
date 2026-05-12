#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(SCRIPT_DIR, "release-notes.config.json");

export async function loadReleaseNotesConfig(configPath = DEFAULT_CONFIG_PATH) {
  return JSON.parse(await readFile(configPath, "utf8"));
}

export function parseSemverTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(tag);
  if (!match) {
    return undefined;
  }

  return {
    raw: tag,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

export function compareSemverTags(left, right) {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

export function resolvePreviousTag(tags, currentTag) {
  const current = parseSemverTag(currentTag);
  if (!current) {
    return undefined;
  }

  return tags
    .map((tag) => parseSemverTag(tag))
    .filter((tag) => tag && compareSemverTags(tag, current) < 0)
    .sort(compareSemverTags)
    .at(-1)?.raw;
}

export async function generateReleaseNotes(options = {}) {
  const rootDir = options.rootDir ?? path.resolve(SCRIPT_DIR, "..");
  const config = options.config ?? await loadReleaseNotesConfig(options.configPath);
  const currentTag = options.currentTag ?? process.env.GITHUB_REF_NAME ?? getExactHeadTag(rootDir);
  const tags = listTags(rootDir);
  const previousTag = options.previousTag ?? resolvePreviousTag(tags, currentTag);
  const compareRange = previousTag ? `${previousTag}...${currentTag}` : undefined;
  const compareUrl = previousTag
    ? `https://github.com/${config.repo}/compare/${compareRange}`
    : `https://github.com/${config.repo}/releases/tag/${currentTag}`;
  const subjects = compareRange ? listCommitSubjects(rootDir, compareRange) : [];

  const lines = [
    `## What changed since ${previousTag ?? "the previous tag"}`,
    ...renderSummary(subjects, currentTag, previousTag),
    "",
    "## Install or quick try",
    "```sh",
    config.installCommand,
    config.quickTryCommand,
    "```",
    "",
    "## Benchmark challenge",
    `Try the public challenge: ${config.challengeUrl}`,
    "",
    "## GitHub discussions",
    ...config.discussions.map((discussion) => `- [${discussion.title}](${discussion.url})`),
    "",
    "## Verification and provenance",
    ...config.provenance.map((item) => `- ${item}`),
    "",
    `**Full Changelog**: ${compareUrl}`
  ];

  return {
    currentTag,
    previousTag,
    compareRange,
    compareUrl,
    notes: `${lines.join("\n")}\n`
  };
}

export async function writeReleaseNotesFile(options = {}) {
  const result = await generateReleaseNotes(options);
  if (!options.outputPath) {
    return result;
  }

  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, result.notes, "utf8");
  return result;
}

function renderSummary(subjects, currentTag, previousTag) {
  if (subjects.length === 0) {
    return [
      `- This release refreshes the public MartinLoop package surface for ${currentTag}.`,
      previousTag
        ? `- Compare against ${previousTag} for the exact file-level delta.`
        : "- This tag does not have an earlier semver tag to compare against in the current checkout."
    ];
  }

  return subjects.slice(0, 8).map((subject) => `- ${subject}`);
}

function listTags(rootDir) {
  const output = runGit(rootDir, ["tag", "--list"]);
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function listCommitSubjects(rootDir, compareRange) {
  const output = runGit(rootDir, ["log", "--pretty=format:%s", compareRange]);
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getExactHeadTag(rootDir) {
  const tag = runGit(rootDir, ["describe", "--tags", "--exact-match"]).trim();
  if (!tag) {
    throw new Error("Unable to determine the current release tag. Pass --current-tag explicitly.");
  }
  return tag;
}

function runGit(rootDir, args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8"
  });
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    switch (token) {
      case "--current-tag":
        parsed.currentTag = next;
        index += 1;
        break;
      case "--previous-tag":
        parsed.previousTag = next;
        index += 1;
        break;
      case "--output":
        parsed.outputPath = next;
        index += 1;
        break;
      case "--config":
        parsed.configPath = next;
        index += 1;
        break;
      default:
        break;
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await writeReleaseNotesFile({
    rootDir: path.resolve(SCRIPT_DIR, ".."),
    currentTag: args.currentTag,
    previousTag: args.previousTag,
    outputPath: args.outputPath,
    configPath: args.configPath
  });

  if (!args.outputPath) {
    process.stdout.write(result.notes);
    return;
  }

  process.stdout.write(`Release notes written to ${args.outputPath}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Release notes generation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
