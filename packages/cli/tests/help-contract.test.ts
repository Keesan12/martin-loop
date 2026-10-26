import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { executeCli, parseCliArguments } from "../src/index.js";

const HELP_SURFACES: Array<{ argv: string[]; subject: string }> = [
  { argv: ["run", "--help"], subject: "run" },
  { argv: ["preflight", "--help"], subject: "preflight" },
  { argv: ["bench", "--help"], subject: "bench" },
  { argv: ["audit", "--help"], subject: "audit" },
  { argv: ["sync", "--help"], subject: "sync" },
  { argv: ["sync", "status", "--help"], subject: "sync status" },
  { argv: ["sync", "flush", "--help"], subject: "sync flush" },
  { argv: ["demo", "--help"], subject: "demo" },
  { argv: ["swarm", "--help"], subject: "swarm" },
  { argv: ["swarm", "plan", "--help"], subject: "swarm plan" },
  { argv: ["swarm", "run", "--help"], subject: "swarm run" },
  { argv: ["swarm", "status", "--help"], subject: "swarm status" },
  { argv: ["swarm", "inspect", "--help"], subject: "swarm inspect" },
  { argv: ["swarm", "cancel", "--help"], subject: "swarm cancel" },
  { argv: ["swarm", "dossier", "--help"], subject: "swarm dossier" },
  { argv: ["swarm", "verify", "--help"], subject: "swarm verify" },
  { argv: ["swarm", "share", "--help"], subject: "swarm share" },
  { argv: ["inspect", "--help"], subject: "inspect" },
  { argv: ["resume", "--help"], subject: "resume" },
  { argv: ["continue", "--help"], subject: "continue" },
  { argv: ["doctor", "--help"], subject: "doctor" },
  { argv: ["gate", "--help"], subject: "gate" },
  { argv: ["mode", "--help"], subject: "mode" },
  { argv: ["mode", "auto", "--help"], subject: "mode auto" },
  { argv: ["mode", "plan", "--help"], subject: "mode plan" },
  { argv: ["mode", "edits", "--help"], subject: "mode edits" },
  { argv: ["clean", "--help"], subject: "clean" },
  { argv: ["estimate", "--help"], subject: "estimate" },
  { argv: ["start", "--help"], subject: "start" },
  { argv: ["tour", "--help"], subject: "tour" },
  { argv: ["enable", "--help"], subject: "enable" },
  { argv: ["env", "--help"], subject: "env" },
  { argv: ["review", "--help"], subject: "review" },
  { argv: ["receipts", "--help"], subject: "receipts" },
  { argv: ["receipts", "explain", "--help"], subject: "receipts explain" },
  { argv: ["outcomes", "--help"], subject: "outcomes" },
  { argv: ["outcomes", "verify", "--help"], subject: "outcomes verify" },
  { argv: ["session-start", "--help"], subject: "session-start" },
  { argv: ["phase", "--help"], subject: "phase" },
  { argv: ["phase", "session-start", "--help"], subject: "phase session-start" },
  { argv: ["phase", "status", "--help"], subject: "phase status" },
  { argv: ["phase", "contract", "--help"], subject: "phase contract" },
  { argv: ["phase", "preflight", "--help"], subject: "phase preflight" },
  { argv: ["phase", "run", "--help"], subject: "phase run" },
  { argv: ["gsd", "--help"], subject: "gsd" },
  { argv: ["gsd", "session-start", "--help"], subject: "gsd session-start" },
  { argv: ["gsd", "status", "--help"], subject: "gsd status" },
  { argv: ["gsd", "contract", "--help"], subject: "gsd contract" },
  { argv: ["gsd", "preflight", "--help"], subject: "gsd preflight" },
  { argv: ["gsd", "run", "--help"], subject: "gsd run" },
  { argv: ["triage", "--help"], subject: "triage" },
  { argv: ["dossier", "--help"], subject: "dossier" },
  { argv: ["handoff", "--help"], subject: "handoff" },
  { argv: ["runs", "--help"], subject: "runs" },
  { argv: ["runs", "list", "--help"], subject: "runs list" },
  { argv: ["runs", "get", "--help"], subject: "runs get" },
  { argv: ["runs", "attempt", "--help"], subject: "runs attempt" },
  { argv: ["runs", "verify", "--help"], subject: "runs verify" },
  { argv: ["mcp", "--help"], subject: "mcp" },
  { argv: ["mcp", "print-config", "--help"], subject: "mcp print-config" },
  { argv: ["mcp", "install", "--help"], subject: "mcp install" },
  { argv: ["mcp", "verify-install", "--help"], subject: "mcp verify-install" },
  { argv: ["mcp", "rollback", "--help"], subject: "mcp rollback" },
  { argv: ["mcp", "uninstall", "--help"], subject: "mcp uninstall" },
  { argv: ["challenge", "--help"], subject: "challenge" },
  { argv: ["share", "--help"], subject: "share" },
  { argv: ["badge", "--help"], subject: "badge" },
  { argv: ["cancel", "--help"], subject: "cancel" },
  { argv: ["signal", "--help"], subject: "signal" },
  { argv: ["telemetry", "--help"], subject: "telemetry" },
  { argv: ["telemetry", "status", "--help"], subject: "telemetry status" },
  { argv: ["telemetry", "explain", "--help"], subject: "telemetry explain" },
  { argv: ["telemetry", "on", "--help"], subject: "telemetry on" },
  { argv: ["telemetry", "off", "--help"], subject: "telemetry off" },
];

describe("unknown long-option rejection", () => {
  it.each([
    ["enable"],
    ["review"],
    ["audit"],
    ["phase", "status"],
    ["telemetry", "on"],
  ])("rejects an unsupported option before executing %s", (...command) => {
    expect(() => parseCliArguments([...command, "--functional-audit-invalid"]))
      .toThrow(/unknown option.*--functional-audit-invalid/iu);
  });
});

const INVALID_HELP_TARGETS = [
  ["not-a-command", "--help"],
  ["swarm", "nonsense", "--help"],
  ["runs", "nonsense", "--help"],
  ["mcp", "nonsense", "--help"],
  ["receipts", "nonsense", "--help"],
  ["outcomes", "nonsense", "--help"],
  ["phase", "nonsense", "--help"],
  ["gsd", "nonsense", "--help"],
  ["sync", "nonsense", "--help"],
  ["mode", "nonsense", "--help"],
  ["telemetry", "nonsense", "--help"],
];

describe("CLI-01: command-specific help is read-only and exhaustive", () => {
  it.each(HELP_SURFACES)("$subject --help exits 0 without falling back to generic help", async ({ argv, subject }) => {
    const result = await executeCli(argv);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Command: martin ${subject}`);
    expect(result.stdout).toContain("Help only: no command was executed or state changed.");
  });

  it.each(HELP_SURFACES.slice(0, 12))("$subject -h exits 0", async ({ argv, subject }) => {
    const shortArgv = [...argv.slice(0, -1), "-h"];
    const result = await executeCli(shortArgv);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Command: martin ${subject}`);
  });

  it.each(HELP_SURFACES)("$subject --help --json is directly parseable", async ({ argv, subject }) => {
    const result = await executeCli(["--json", ...argv]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "help",
      subject,
    });
  });

  it.each(INVALID_HELP_TARGETS)("rejects unknown help target %j", async (...argv) => {
    const result = await executeCli(["--json", ...argv]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ category: "invalid_input" });
  });

  it("does not mutate a disposable operator profile for mutation-prone help commands", async () => {
    const profile = await mkdtemp(join(tmpdir(), "martin-help-readonly-"));
    const previousHome = process.env["HOME"];
    const previousUserProfile = process.env["USERPROFILE"];
    const previousRunsDir = process.env["MARTIN_RUNS_DIR"];
    process.env["HOME"] = profile;
    process.env["USERPROFILE"] = profile;
    process.env["MARTIN_RUNS_DIR"] = join(profile, "runs");

    try {
      const commands = [
        ["enable", "--cwd", profile, "--force", "--help"],
        ["demo", "--dir", join(profile, "demo"), "--force", "--help"],
        ["clean", "--cwd", profile, "--all", "--help"],
        ["mode", "edits", "--cwd", profile, "--help"],
        ["sync", "flush", "--help"],
        ["mcp", "install", "--host", "codex", "--scope", "project", "--cwd", profile, "--help"],
        ["gate", "--cwd", profile, "--help"],
      ];

      for (const argv of commands) {
        const result = await executeCli(argv);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Help only: no command was executed or state changed.");
      }

      expect(await readdir(profile)).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      if (previousUserProfile === undefined) delete process.env["USERPROFILE"];
      else process.env["USERPROFILE"] = previousUserProfile;
      if (previousRunsDir === undefined) delete process.env["MARTIN_RUNS_DIR"];
      else process.env["MARTIN_RUNS_DIR"] = previousRunsDir;
      await rm(profile, { recursive: true, force: true });
    }
  });

  it("preserves parse-level help aliases for established public cases", () => {
    expect(parseCliArguments(["dossier", "--help"])).toEqual({ command: "help" });
    expect(parseCliArguments(["dossier", "-h"])).toEqual({ command: "help" });
    expect(parseCliArguments(["runs", "verify", "--help"])).toEqual({ command: "help" });
    expect(parseCliArguments(["runs", "verify", "-h"])).toEqual({ command: "help" });
    expect(parseCliArguments(["badge", "--help"])).toEqual({ command: "help" });
    expect(parseCliArguments(["badge", "-h"])).toEqual({ command: "help" });
  });
});

describe("root help machine-output contract", () => {
  it.each([
    ["--json"],
    ["help", "--json"],
    ["--help", "--json"],
  ])("%j emits directly parseable root help JSON", async (...argv) => {
    const result = await executeCli(argv);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "help",
      subject: "root",
    });
  });
});

describe("CLI-02: --version --json emits a valid JSON object", () => {
  it("--version --json exits 0 via executeCli and emits valid JSON", async () => {
    const result = await executeCli(["--version", "--json"]);
    expect(result.exitCode).toBe(0);
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(result.stdout);
    }).not.toThrow();
    expect(parsed).toEqual(expect.objectContaining({ version: expect.any(String) }));
  });

  it("--version --json version string is non-empty", async () => {
    const result = await executeCli(["--version", "--json"]);
    const parsed = JSON.parse(result.stdout) as { version: string };
    expect(parsed.version.length).toBeGreaterThan(0);
  });

  it("--version without --json returns plain text (not JSON)", async () => {
    const result = await executeCli(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).toThrow();
  });
});
