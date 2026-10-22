import { describe, expect, it } from "vitest";

import { executeCli, parseCliArguments } from "../src/index.js";

describe("CLI-01: subcommand --help routes to help, exits 0", () => {
  it("dossier --help parses to { command: 'help' }", () => {
    expect(parseCliArguments(["dossier", "--help"])).toEqual({ command: "help" });
  });

  it("dossier -h parses to { command: 'help' }", () => {
    expect(parseCliArguments(["dossier", "-h"])).toEqual({ command: "help" });
  });

  it("runs verify --help parses to { command: 'help' }", () => {
    expect(parseCliArguments(["runs", "verify", "--help"])).toEqual({ command: "help" });
  });

  it("runs verify -h parses to { command: 'help' }", () => {
    expect(parseCliArguments(["runs", "verify", "-h"])).toEqual({ command: "help" });
  });

  it("badge --help parses to { command: 'help' }", () => {
    expect(parseCliArguments(["badge", "--help"])).toEqual({ command: "help" });
  });

  it("badge -h parses to { command: 'help' }", () => {
    expect(parseCliArguments(["badge", "-h"])).toEqual({ command: "help" });
  });

  it("dossier --help exits 0 via executeCli", async () => {
    const result = await executeCli(["dossier", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("runs verify --help exits 0 via executeCli", async () => {
    const result = await executeCli(["runs", "verify", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("badge --help exits 0 via executeCli", async () => {
    const result = await executeCli(["badge", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
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
