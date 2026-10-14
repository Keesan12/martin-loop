import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeCli, parseCliArguments } from "../src/index.js";

// From PowerShell through the npm `martin.cmd` shim:
//   martin preflight "Parser test" --engine codex --verify "`"unterminated" --budget-usd 1 --json
// cmd.exe treats the stray quote as an open quoted region, so node receives the remaining
// flags folded into the verifier value. Calling node directly instead preserves the stray quote.
const CMD_SHIM_ARGV = [
  "preflight",
  "Parser test",
  "--engine", "codex",
  "--verify", "unterminated --budget-usd 1 --json",
];
const DIRECT_NODE_ARGV = [
  "preflight",
  "Parser test",
  "--engine", "codex",
  "--verify", "\"unterminated",
  "--budget-usd", "1",
  "--json",
];

describe("malformed verifier input", () => {
  it.each(["run", "preflight"])("rejects a verifier carrying swallowed MartinLoop flags for %s", (command) => {
    expect(() => parseCliArguments([command, ...CMD_SHIM_ARGV.slice(1)])).toThrow(
      expect.objectContaining({
        category: "invalid_input",
        message: expect.stringMatching(/--verify.*--budget-usd/u),
      })
    );
  });

  it.each(["run", "preflight"])("rejects a verifier with an unterminated quote for %s", (command) => {
    expect(() => parseCliArguments([command, ...DIRECT_NODE_ARGV.slice(1)])).toThrow(
      expect.objectContaining({
        category: "invalid_input",
        message: expect.stringMatching(/--verify.*unterminated quote/iu),
      })
    );
  });

  it("returns invalid_input with a nonzero exit and no READY claim for the .cmd shim argv", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-malformed-verifier-"));
    const runsDirectory = join(directory, "runs-must-not-exist");

    try {
      const result = await executeCli([...CMD_SHIM_ARGV, "--runs-dir", runsDirectory]);

      expect(result.exitCode).toBe(2);
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/READY TO EXECUTE/u);
      expect(`${result.stdout}${result.stderr}`).toMatch(/--budget-usd/u);
      await expect(readdir(runsDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps --json output for the direct-node shape and reports invalid_input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "martin-cli-malformed-verifier-json-"));
    const runsDirectory = join(directory, "runs-must-not-exist");

    try {
      const result = await executeCli([...DIRECT_NODE_ARGV, "--runs-dir", runsDirectory]);

      expect(result.exitCode).toBe(2);
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({ ok: false, category: "invalid_input" });
      expect(payload).not.toHaveProperty("ready", true);
      await expect(readdir(runsDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects the same malformed verifier on enable before it is persisted", () => {
    expect(() => parseCliArguments(["enable", "--verify", "unterminated --budget-usd 1"])).toThrow(
      expect.objectContaining({ category: "invalid_input" })
    );
  });

  it.each([
    "npm test",
    "pnpm test -- --json",
    "npx vitest run --reporter=json",
    "node -e \"process.exit(0)\"",
    "pytest -k 'auth and not slow'",
    "npm run lint && npm test",
    "martin outcomes verify --evidence out.json",
  ])("keeps valid verifier %j", (verifier) => {
    expect(parseCliArguments(["preflight", "Valid verifier", "--verify", verifier])).toEqual(
      expect.objectContaining({
        command: "preflight",
        request: expect.objectContaining({ verificationPlan: [verifier] }),
      })
    );
  });

  it("keeps following flags parsed when the verifier is well formed", () => {
    expect(parseCliArguments([
      "preflight", "Flags stay flags",
      "--verify", "npm test",
      "--budget-usd", "1",
      "--engine", "codex",
    ])).toEqual(expect.objectContaining({
      request: expect.objectContaining({
        verificationPlan: ["npm test"],
        engine: "codex",
        budget: expect.objectContaining({ maxUsd: 1 }),
      }),
    }));
  });

  it("still rejects a missing verifier value", () => {
    expect(() => parseCliArguments(["preflight", "Missing", "--verify"])).toThrow(
      expect.objectContaining({ category: "invalid_input", message: "--verify requires a verifier command." })
    );
  });
});
