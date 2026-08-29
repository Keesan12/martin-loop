#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");

const PUBLIC_LOCAL_PATH = "martin-loop_PUBLIC_OSS";
const PUBLIC_REPOS = new Set([
  "keesan12/martin-loop",
  "martin-loop/martin-loop_public_oss",
]);

const READ_ONLY_GH_COMMANDS = new Set(["view", "list", "status", "checks"]);
const READ_ONLY_GIT_COMMANDS = new Set(["fetch", "status", "log", "show", "diff", "remote"]);

function normalizeSlashes(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

function normalizeGitHubRepo(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/^ssh:\/\/git@github\.com\//, "")
    .replace(/\.git$/, "");
}

function isPublicRepo(value) {
  return PUBLIC_REPOS.has(normalizeGitHubRepo(value));
}

function normalizeGitHubUrl(value) {
  const repo = normalizeGitHubRepo(value);
  return repo ? `https://github.com/${repo}` : "";
}

function isPublicRepoUrl(value) {
  return isPublicRepo(value) || PUBLIC_REPOS.has(normalizeGitHubRepo(normalizeGitHubUrl(value)));
}

function splitShellSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }

    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      current += ch;
      quote = ch;
      continue;
    }

    if (ch === "|" || ch === ";" || (ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) i += 1;
      continue;
    }

    current += ch;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

function tokenize(segment) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function extractLeadingCd(command) {
  const match =
    command.match(/^\s*cd\s+"([^"]+)"\s*(?:&&|;)/) ||
    command.match(/^\s*cd\s+'([^']+)'\s*(?:&&|;)/) ||
    command.match(/^\s*cd\s+([^\s&;]+)\s*(?:&&|;)/);
  return match ? match[1] : undefined;
}

function resolveGitRemote(remote, cwd) {
  if (!remote || remote.includes("://") || remote.includes("@") || remote.includes("github.com")) {
    return remote;
  }

  const baseArgs = cwd ? ["-C", cwd, "remote", "get-url"] : ["remote", "get-url"];
  for (const args of [[...baseArgs, "--push", remote], [...baseArgs, remote]]) {
    const result = spawnSync("git", args, { encoding: "utf8", timeout: 5_000 });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  return remote;
}

function repoFromGhArgs(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--repo" || token === "-R") return tokens[i + 1];
    if (token.startsWith("--repo=")) return token.slice("--repo=".length);
  }
  return undefined;
}

function unwrapShellCommand(tokens) {
  const exe = tokens[0]?.toLowerCase();
  if (!exe) return undefined;

  if (exe === "bash" || exe === "sh") {
    const cIndex = tokens.findIndex((token) => token === "-c");
    return cIndex >= 0 ? tokens[cIndex + 1] : undefined;
  }

  if (exe === "cmd" || exe === "cmd.exe") {
    const cIndex = tokens.findIndex((token) => token.toLowerCase() === "/c");
    return cIndex >= 0 ? tokens.slice(cIndex + 1).join(" ") : undefined;
  }

  if (exe === "powershell" || exe === "powershell.exe" || exe === "pwsh" || exe === "pwsh.exe") {
    const cIndex = tokens.findIndex((token) => {
      const normalized = token.toLowerCase();
      return normalized === "-command" || normalized === "-c";
    });
    return cIndex >= 0 ? tokens[cIndex + 1] : undefined;
  }

  return undefined;
}

function isPublicMutation(command, depth = 0) {
  if (depth > 3) return { blocked: false };
  const cwd = extractLeadingCd(command);
  const segments = splitShellSegments(command).flatMap((segment) => {
    const tokens = tokenize(segment);
    if (tokens[0] && tokens[0].toLowerCase() === "cd") return [];
    return [tokens];
  });

  for (const tokens of segments) {
    if (tokens.length === 0) continue;
    const [exe, sub, action] = tokens.map((token) => token.toLowerCase());
    const wrappedCommand = unwrapShellCommand(tokens);
    if (wrappedCommand) {
      const wrappedMutation = isPublicMutation(wrappedCommand, depth + 1);
      if (wrappedMutation.blocked) return wrappedMutation;
      continue;
    }

    if (exe === "npm" && sub === "publish") return { blocked: true, reason: "npm publish" };

    if (exe === "git") {
      if (READ_ONLY_GIT_COMMANDS.has(sub)) continue;
      if (cwd && normalizeSlashes(cwd).includes(PUBLIC_LOCAL_PATH) && ["add", "commit", "push", "tag"].includes(sub)) {
        return { blocked: true, reason: "public repo path mutation" };
      }

      if (sub === "tag" && tokens.some((token) => /^v\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?$/i.test(token))) {
        return { blocked: true, reason: "public tag mutation" };
      }

      if (sub === "push") {
        const remote = tokens.slice(2).find((token) => !token.startsWith("-"));
        const resolved = resolveGitRemote(remote, cwd);
        if (isPublicRepoUrl(resolved)) return { blocked: true, reason: "public git push" };
      }

      if ((sub === "add" || sub === "commit") && tokens.some((token) => normalizeSlashes(token).includes(PUBLIC_LOCAL_PATH))) {
        return { blocked: true, reason: "public repo path mutation" };
      }
    }

    if (exe === "gh") {
      const repo = repoFromGhArgs(tokens);
      if (!isPublicRepo(repo)) continue;

      if (sub === "pr" && !READ_ONLY_GH_COMMANDS.has(action)) {
        return { blocked: true, reason: "public PR mutation" };
      }
      if (sub === "release" && !READ_ONLY_GH_COMMANDS.has(action)) {
        return { blocked: true, reason: "public release mutation" };
      }
    }
  }

  return { blocked: false };
}

function main() {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  process.stdin.on("end", () => {
    try {
      const tool = JSON.parse(input);
      const toolInput = tool.tool_input ?? {};
      const filePath = normalizeSlashes(toolInput.file_path ?? toolInput.path ?? "");
      const command = normalizeSlashes(toolInput.command ?? "").replace(/\s+/g, " ").trim();

      const blockedByFilePath = filePath.includes(PUBLIC_LOCAL_PATH);
      const mutation = isPublicMutation(command);

      if (blockedByFilePath || mutation.blocked) {
        const attempted = filePath || command.slice(0, 180);
        const reason = blockedByFilePath ? "public repo file write" : mutation.reason;
        process.stderr.write(`
BLOCKED: ${reason} is not allowed.

MartinLoop's mandatory sequence is:

  private feature branch
  -> private tests
  -> private PR
  -> private main merge
  -> fresh private-main health proof
  -> clean public-staging branch
  -> public promotion guard
  -> public PR
  -> explicit merge approval

Do not bypass this hook.
Attempted: ${attempted}

`);
        process.exit(2);
      }
    } catch {
      process.exit(0);
    }

    process.exit(0);
  });
}

main();
