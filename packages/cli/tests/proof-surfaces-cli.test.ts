import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";

describe("CLI V2 proof-surface wiring", () => {
  let runsRoot: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), "martin-proof-surfaces-"));
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it("renders the Governed Run Plan for human preflight output", async () => {
    const result = await executeCli([
      "preflight",
      "--objective",
      "Verify the additive proof surfaces",
      "--proof",
      "--verify",
      "node --version",
      "--runs-dir",
      runsRoot
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("MARTINLOOP");
    expect(result.stdout).toContain("GOVERNED RUN PLAN");
    expect(result.stdout).toContain("Verify the additive proof surfaces");
  });

  it("preserves the preflight JSON contract without ANSI presentation", async () => {
    const result = await executeCli([
      "--json",
      "preflight",
      "--objective",
      "Verify the additive proof surfaces",
      "--proof",
      "--verify",
      "node --version",
      "--runs-dir",
      runsRoot
    ]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.command).toBe("preflight");
    expect(typeof payload.ready).toBe("boolean");
    expect(result.stdout).not.toContain("\u001b[");
    expect(result.stdout).not.toContain("GOVERNED RUN PLAN");
  });

  it("renders the canonical Verified Handoff and preserves the governed exit code", async () => {
    const result = await executeCli([
      "run",
      "--objective",
      "Exercise the proof handoff",
      "--proof",
      "--verify",
      "node --version",
      "--max-iterations",
      "1",
      "--budget-usd",
      "5",
      "--runs-dir",
      runsRoot
    ]);

    expect(result.exitCode).toBe(7);
    expect(result.stdout).toContain("MARTINLOOP VERIFIED HANDOFF");
    expect(result.stdout).toContain("NEEDS REVIEW");
    expect(result.stdout).toContain("Receipt Integrity");
  });

  it("keeps quiet governed output presentation-free", async () => {
    const result = await executeCli([
      "--quiet",
      "run",
      "--objective",
      "Exercise the quiet proof handoff",
      "--proof",
      "--verify",
      "node --version",
      "--max-iterations",
      "1",
      "--budget-usd",
      "5",
      "--runs-dir",
      runsRoot
    ]);

    expect(result.exitCode).toBe(7);
    expect(result.stdout).toMatch(/^loop_/u);
    expect(result.stdout).not.toContain("VERIFIED HANDOFF");
    expect(result.stdout).not.toContain("\u001b[");
  });
});
