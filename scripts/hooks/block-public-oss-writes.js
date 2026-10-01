#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const PUBLIC_LOCAL_PATH = "martin-loop_PUBLIC_OSS";
const PUBLIC_REPOS = new Set([
  "keesan12/martin-loop",
  "martin-loop/martin-loop_public_oss",
]);

const READ_ONLY_GH_COMMANDS = new Set(["view", "list", "status", "checks"]);
const READ_ONLY_GIT_COMMANDS = new Set(["fetch", "status", "log", "show", "diff", "remote"]);
const GUARDED_GIT_COMMANDS = new Set(["add", "commit", "push", "tag"]);
const ALLOWED_PUBLIC_PUSH_OPTIONS = new Set(["-u", "--set-upstream"]);

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

function normalizeExecutableTokens(tokens) {
  let index = 0;
  let gitConfigInjected = false;
  const consumeAssignments = () => {
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(tokens[index])) {
      const name = tokens[index].slice(0, tokens[index].indexOf("=")).toUpperCase();
      if (name.startsWith("GIT_CONFIG")) gitConfigInjected = true;
      index += 1;
    }
  };

  consumeAssignments();
  if (tokens[index]?.toLowerCase() === "env") {
    index += 1;
    while (tokens[index]?.startsWith("-")) index += 1;
    consumeAssignments();
  }

  return { tokens: tokens.slice(index), gitConfigInjected };
}

function isPublicCheckout(cwd) {
  return Boolean(cwd && normalizeSlashes(cwd).toLowerCase().includes(PUBLIC_LOCAL_PATH.toLowerCase()));
}

function resolveCommandCwd(candidate, baseCwd) {
  if (!candidate) return baseCwd;
  return path.resolve(baseCwd || process.cwd(), candidate);
}

function parseGitInvocation(tokens, inheritedCwd) {
  let index = 1;
  let cwd = inheritedCwd;
  const configOverrides = [];

  while (index < tokens.length) {
    const token = tokens[index];
    const normalized = token.toLowerCase();

    if (token === "-C") {
      cwd = resolveCommandCwd(tokens[index + 1], cwd);
      index += 2;
      continue;
    }
    if (token === "-c") {
      if (tokens[index + 1]) configOverrides.push(tokens[index + 1]);
      index += 2;
      continue;
    }
    if (normalized.startsWith("-c") && token.length > 2) {
      configOverrides.push(token.slice(2));
      index += 1;
      continue;
    }
    if (["--no-pager", "--paginate", "--no-replace-objects", "--literal-pathspecs"].includes(normalized)) {
      index += 1;
      continue;
    }
    break;
  }

  return {
    sub: tokens[index]?.toLowerCase() ?? "",
    args: tokens.slice(index + 1),
    cwd,
    configOverrides,
  };
}

function parsePushArgs(args) {
  const options = [];
  const positional = [];
  let positionalOnly = false;

  for (const arg of args) {
    if (!positionalOnly && arg === "--") {
      positionalOnly = true;
    } else if (!positionalOnly && arg.startsWith("-")) {
      options.push(arg.toLowerCase());
    } else {
      positional.push(arg);
    }
  }

  return { options, positional };
}

function isTruthyGitBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function widensPushFollowTags(configOverrides) {
  return configOverrides.some((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 0) return false;
    const key = entry.slice(0, separator).trim().toLowerCase();
    return key === "push.followtags" && isTruthyGitBoolean(entry.slice(separator + 1));
  });
}

function configuredPushFollowTags(cwd) {
  if (!cwd) return false;
  const result = spawnSync("git", ["-C", cwd, "config", "--bool", "--get", "push.followTags"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return result.status === 0 && result.stdout.trim().toLowerCase() === "true";
}

function configWidensPushFollowTags(args) {
  const keyIndex = args.findIndex((arg) => arg.toLowerCase() === "push.followtags");
  if (keyIndex < 0) return false;
  return isTruthyGitBoolean(args[keyIndex + 1]);
}

function currentGitBranch(cwd) {
  if (!cwd) return "";
  const result = spawnSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8", timeout: 5_000 });
  return result.status === 0 ? result.stdout.trim() : "";
}

function governedPublicStagingBranch(cwd) {
  if (!cwd || !normalizeSlashes(cwd).includes(PUBLIC_LOCAL_PATH)) return "";
  const branch = currentGitBranch(cwd);
  return /^public-staging\/[A-Za-z0-9._/-]+$/.test(branch) ? branch : "";
}

function isExplicitPushOfBranch(refspecs, branch) {
  if (!branch) return false;
  if (refspecs.length !== 1) return false;
  return refspecs.every((refspec) =>
    refspec === `HEAD:refs/heads/${branch}` ||
    refspec === `refs/heads/${branch}:refs/heads/${branch}`
  );
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
  const segments = splitShellSegments(command).map(tokenize);
  let cwd;
  let cwdChangeCount = 0;
  let branchContextChanged = false;

  for (const rawTokens of segments) {
    if (rawTokens.length === 0) continue;
    const normalized = normalizeExecutableTokens(rawTokens);
    const tokens = normalized.tokens;
    if (tokens.length === 0) continue;
    const [exe, rawSub, action] = tokens.map((token) => token.toLowerCase());

    if (exe === "cd") {
      const candidate = tokens[1]?.toLowerCase() === "/d" ? tokens[2] : tokens[1];
      cwd = resolveCommandCwd(candidate, cwd);
      cwdChangeCount += 1;
      continue;
    }

    const wrappedCommand = unwrapShellCommand(tokens);
    if (wrappedCommand) {
      const wrappedMutation = isPublicMutation(wrappedCommand, depth + 1);
      if (wrappedMutation.blocked) return wrappedMutation;
      continue;
    }

    if (exe === "npm" && rawSub === "publish") return { blocked: true, reason: "npm publish" };

    if (exe === "git") {
      const git = parseGitInvocation(tokens, cwd);
      const { sub } = git;
      if (READ_ONLY_GIT_COMMANDS.has(sub)) continue;
      const publicCwd = isPublicCheckout(git.cwd);
      const stagingBranch = publicCwd ? governedPublicStagingBranch(git.cwd) : "";
      const unstableContext = cwdChangeCount > 1 || branchContextChanged;

      if (publicCwd && GUARDED_GIT_COMMANDS.has(sub) && normalized.gitConfigInjected) {
        return { blocked: true, reason: "public git configuration injection" };
      }

      if (publicCwd && GUARDED_GIT_COMMANDS.has(sub) && unstableContext) {
        return { blocked: true, reason: "public repo context changed before mutation" };
      }

      if (publicCwd && sub === "config" && configWidensPushFollowTags(git.args)) {
        return { blocked: true, reason: "public push.followTags widening" };
      }

      if (publicCwd && (sub === "add" || sub === "commit") && !stagingBranch) {
        return { blocked: true, reason: "public repo path mutation" };
      }

      if (publicCwd && sub === "tag") {
        return { blocked: true, reason: "public tag mutation" };
      }

      if (sub === "tag" && tokens.some((token) => /^v\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?$/i.test(token))) {
        return { blocked: true, reason: "public tag mutation" };
      }

      if (sub === "push") {
        const push = parsePushArgs(git.args);
        const [remote, ...refspecs] = push.positional;
        const resolved = resolveGitRemote(remote, git.cwd);

        if (publicCwd && push.positional.length < 2) {
          return { blocked: true, reason: "public git push without explicit remote" };
        }

        if (publicCwd && (push.options.includes("--tags") || push.options.includes("--follow-tags"))) {
          return { blocked: true, reason: "public git push tag widening" };
        }

        if (publicCwd && widensPushFollowTags(git.configOverrides)) {
          return { blocked: true, reason: "public push.followTags widening" };
        }

        if (isPublicRepoUrl(resolved)) {
          const optionsAreSafe = push.options.every((option) => ALLOWED_PUBLIC_PUSH_OPTIONS.has(option));
          const followTagsDisabled = !configuredPushFollowTags(git.cwd);
          if (
            publicCwd &&
            stagingBranch &&
            optionsAreSafe &&
            followTagsDisabled &&
            isExplicitPushOfBranch(refspecs, stagingBranch)
          ) {
            continue;
          }
          return { blocked: true, reason: "public git push" };
        }
      }

      if ((sub === "add" || sub === "commit") && tokens.some((token) => normalizeSlashes(token).includes(PUBLIC_LOCAL_PATH))) {
        return { blocked: true, reason: "public repo path mutation" };
      }

      if (sub === "switch" || sub === "checkout") branchContextChanged = true;
    }

    if (exe === "gh") {
      const repo = repoFromGhArgs(tokens);
      if (!isPublicRepo(repo)) continue;

      if (rawSub === "pr" && !READ_ONLY_GH_COMMANDS.has(action)) {
        return { blocked: true, reason: "public PR mutation" };
      }
      if (rawSub === "release" && !READ_ONLY_GH_COMMANDS.has(action)) {
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
