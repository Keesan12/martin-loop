#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN_SUBJECT_PATTERNS = [
  { label: "release bookkeeping subject", pattern: /^chore:\s+release\b/i },
  { label: "internal phase numbering", pattern: /\bphase\s*\d+\b/i },
  { label: "internal RC-state wording", pattern: /\brc\s+state\b/i },
  { label: "internal snapshot-for-CI wording", pattern: /\bsnapshot\b.*\bci\b/i },
  { label: "public cleanup process wording", pattern: /\bclean public repo\b/i },
  { label: "public surface cleanup wording", pattern: /\bpublic(?:-| )surface cleanup\b/i },
  { label: "planning directory reference", pattern: /\.planning\b/i },
  { label: "private workspace wording", pattern: /\bprivate workspace\b/i },
  { label: "internal repo name", pattern: /\b(?:ML_Core_OSS_Internal|ML_Main_Repo_Internal)\b/i },
  { label: "local Windows user path", pattern: /\bC:\\Users\\/i },
  { label: "local OneDrive path", pattern: /\bOneDrive\\/i },
  { label: "handoff process language", pattern: /\bhandoff\b/i },
];

export function findSubjectViolations(commits) {
  const violations = [];

  for (const commit of commits) {
    for (const rule of FORBIDDEN_SUBJECT_PATTERNS) {
      if (rule.pattern.test(commit.subject)) {
        violations.push({
          ...commit,
          rule: rule.label,
        });
      }
    }
  }

  return violations;
}

export async function readCommitSubjects(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const head = options.head ?? "HEAD";
  const base = options.base ?? null;

  if (base) {
    try {
      const log = await runGit(["log", "--format=%H%x00%s", `${base}..${head}`], { cwd: rootDir });
      const commits = parseCommitSubjectLog(log.stdout);
      if (commits.length > 0) return commits;
    } catch {
      // base SHA is inaccessible (e.g. after a force push rewrote history) — fall through to HEAD-only check
    }
  }

  const fallback = await runGit(["log", "--format=%H%x00%s", "--max-count=1", head], { cwd: rootDir });
  return parseCommitSubjectLog(fallback.stdout);
}

export function parseCommitSubjectLog(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split("\0");
      return {
        sha,
        subject: subject ?? "",
      };
    });
}

export async function runPublicGitSurfaceGuard(options = {}) {
  const commits = await readCommitSubjects(options);
  const violations = findSubjectViolations(commits);

  if (violations.length > 0) {
    const details = violations
      .map((violation) => `- ${violation.sha.slice(0, 12)} ${violation.rule}: ${violation.subject}`)
      .join("\n");
    throw new Error(`Public git surface contains internal-process commit language:\n${details}`);
  }

  return {
    checkedCommits: commits.length,
    head: options.head ?? "HEAD",
    base: options.base ?? null,
  };
}

function parseCliArgs(argv) {
  const base = readFlag(argv, "--base") ?? process.env.PUBLIC_GIT_SURFACE_BASE ?? defaultBaseFromGithubEnv();
  const head = readFlag(argv, "--head") ?? process.env.PUBLIC_GIT_SURFACE_HEAD ?? "HEAD";

  return {
    base: base && base !== "0000000000000000000000000000000000000000" ? base : null,
    head,
  };
}

function readFlag(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] ?? null;
}

function defaultBaseFromGithubEnv() {
  if (process.env.GITHUB_BASE_REF) {
    return `origin/${process.env.GITHUB_BASE_REF}`;
  }

  return null;
}

function runGit(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: process.env,
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
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} failed with ${code ?? "unknown"}\n${stderr}`));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

async function main() {
  const args = parseCliArgs(process.argv);
  const result = await runPublicGitSurfaceGuard({
    rootDir: process.cwd(),
    base: args.base,
    head: args.head,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === path.resolve(modulePath)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Public git surface guard failed: ${message}\n`);
    process.exitCode = 1;
  });
}
