#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distModuleUrl = pathToFileURL(path.resolve(cliRoot, "dist", "mcp-config.js")).href;
const { buildMcpInstallPlan, installMcpConfig } = await import(distModuleUrl);

async function main() {
  const summary = {
    ok: true,
    verified: []
  };

  await verifyGeneratedPlatformSnippets(summary.verified);
  await verifyCodexRemote(summary.verified);
  await verifyClaudeProjectRemote(summary.verified);
  await verifyClaudeLocalRemote(summary.verified);
  await verifyGeminiRemote(summary.verified);

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function verifyGeneratedPlatformSnippets(verified) {
  const codexWindows = buildMcpInstallPlan({
    host: "codex",
    scope: "project",
    cwd: "C:\\repo",
    runsRoot: "C:\\runs",
    transport: "stdio",
    platform: "windows"
  });
  const codexLinux = buildMcpInstallPlan({
    host: "codex",
    scope: "project",
    cwd: "/repo",
    runsRoot: "/runs",
    transport: "stdio",
    platform: "linux"
  });
  const geminiMac = buildMcpInstallPlan({
    host: "gemini",
    scope: "project",
    cwd: "/repo",
    runsRoot: "/runs",
    transport: "remote",
    profile: "starter",
    platform: "macos"
  });
  const genericRemote = buildMcpInstallPlan({
    host: "generic",
    scope: "project",
    cwd: "/repo",
    runsRoot: "/runs",
    transport: "remote",
    profile: "full",
    platform: "linux"
  });

  assert.match(codexWindows.content, /command = "cmd"/u);
  assert.match(codexLinux.content, /command = "npx"/u);
  assert.match(geminiMac.content, /"includeTools"/u);
  assert.match(genericRemote.content, /"bearerTokenEnvVar"/u);

  verified.push("generated cross-platform snippets");
}

async function verifyCodexRemote(verified) {
  const base = await mkdtemp(path.join(os.tmpdir(), "martin-codex-host-"));
  const previousCodexHome = process.env.CODEX_HOME;

  try {
    process.env.CODEX_HOME = base;
    const plan = buildMcpInstallPlan({
      host: "codex",
      scope: "user",
      cwd: base,
      runsRoot: path.join(base, ".runs"),
      transport: "remote",
      profile: "starter"
    });

    await writeFile(plan.targetPath, plan.content, "utf8");

    const result = await run(
      "codex",
      ["mcp", "list"],
      {
        HOME: base,
        USERPROFILE: base,
        CODEX_HOME: base
      },
      base
    );

    assert.equal(result.code, 0);
    assert.match(readCombinedOutput(result), /martin-loop-remote/u);
    verified.push("codex remote config load");
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    await safeRm(base);
  }
}

async function verifyClaudeProjectRemote(verified) {
  const base = await mkdtemp(path.join(os.tmpdir(), "martin-claude-project-"));

  try {
    const plan = buildMcpInstallPlan({
      host: "claude",
      scope: "project",
      cwd: base,
      runsRoot: path.join(base, ".runs"),
      transport: "remote",
      profile: "starter"
    });

    await writeFile(plan.targetPath, plan.content, "utf8");

    const result = await run("claude", ["mcp", "list"], undefined, base);

    assert.equal(result.code, 0);
    assert.match(readCombinedOutput(result), /martin-loop-remote/u);
    verified.push("claude project remote config load");
  } finally {
    await safeRm(base);
  }
}

async function verifyClaudeLocalRemote(verified) {
  const base = await mkdtemp(path.join(os.tmpdir(), "martin-claude-local-"));

  try {
    const plan = await installMcpConfig({
      host: "claude",
      scope: "local",
      cwd: base,
      runsRoot: path.join(base, ".runs"),
      transport: "remote",
      profile: "starter"
    });

    assert.equal(plan.installMethod, "command");
    const result = await run("claude", ["mcp", "get", "martin-loop-remote"], undefined, base);

    assert.equal(result.code, 0);
    assert.match(readCombinedOutput(result), /martin-loop-remote/u);
    verified.push("claude local remote install");
  } finally {
    await run("claude", ["mcp", "remove", "--scope", "local", "martin-loop-remote"], undefined, base).catch(
      () => {}
    );
    await safeRm(base);
  }
}

async function verifyGeminiRemote(verified) {
  const base = await mkdtemp(path.join(os.tmpdir(), "martin-gemini-host-"));

  try {
    const plan = buildMcpInstallPlan({
      host: "gemini",
      scope: "project",
      cwd: base,
      runsRoot: path.join(base, ".runs"),
      transport: "remote",
      profile: "starter"
    });

    await mkdir(path.dirname(plan.targetPath), { recursive: true });
    await writeFile(plan.targetPath, plan.content, "utf8");

    const result = await run("gemini", ["mcp", "list"], undefined, base);

    assert.equal(result.code, 0);
    assert.match(readCombinedOutput(result), /martin-loop-remote/u);
    verified.push("gemini remote config load");
  } finally {
    await safeRm(base);
  }
}

async function run(command, args, extraEnv, cwd) {
  const spawnSpec =
    process.platform === "win32"
      ? {
          command: "powershell.exe",
          args: [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            buildPowerShellCommand(command, args)
          ]
        }
      : { command, args };

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd,
      env: {
        ...process.env,
        ...(extraEnv ?? {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function buildPowerShellCommand(command, args) {
  const quoted = [command, ...args].map((value) => `'${String(value).replace(/'/g, "''")}'`);
  return `& ${quoted.join(" ")}`;
}

function readCombinedOutput(result) {
  return `${result.stdout}\n${result.stderr}`.trim();
}

async function safeRm(targetPath) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryableWindowsCleanupError(error) || attempt === 4) {
        throw error;
      }
      await sleep(250 * (attempt + 1));
    }
  }
}

function isRetryableWindowsCleanupError(error) {
  return (
    process.platform === "win32" &&
    error &&
    typeof error === "object" &&
    ("code" in error) &&
    (error.code === "EBUSY" || error.code === "EPERM")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
