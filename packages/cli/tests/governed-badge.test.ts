// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { MARTINLOOP_BADGE_MARKDOWN, MARTINLOOP_BADGE_CTA } from "../src/governed-badge.js";
import { executeCli } from "../src/index.js";

describe("governed-badge constants", () => {
  it("badge markdown is correct shields.io URL", () => {
    expect(MARTINLOOP_BADGE_MARKDOWN).toBe(
      "[![MartinLoop Governed](https://img.shields.io/badge/MartinLoop-Governed-blue)](https://martinloop.com)"
    );
  });

  it("CTA contains the badge markdown", () => {
    expect(MARTINLOOP_BADGE_CTA).toContain(MARTINLOOP_BADGE_MARKDOWN);
  });

  it("CTA starts with empty line for visual spacing", () => {
    expect(MARTINLOOP_BADGE_CTA[0]).toBe("");
  });

  it("CTA contains add-to-readme message", () => {
    expect(MARTINLOOP_BADGE_CTA).toContain("Add the badge to your README:");
  });

  it("CTA contains governed message", () => {
    expect(MARTINLOOP_BADGE_CTA).toContain("Your repo is now governed by MartinLoop.");
  });

  it("CTA has 5 lines", () => {
    expect(MARTINLOOP_BADGE_CTA.length).toBe(5);
  });

  it("badge markdown ends with martinloop.com link", () => {
    expect(MARTINLOOP_BADGE_MARKDOWN).toContain("https://martinloop.com");
  });
});

describe("badge --governed CLI command", () => {
  it("refuses to claim governance without a verified local receipt", async () => {
    const result = await executeCli(["badge", "--governed"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("requires a latest local governed run with verified receipt integrity and passing verifier evidence");
  });

  it.each([
    ["explicit format", ["badge", "--governed", "--format", "json"]],
    ["global before", ["--json", "badge", "--governed"]],
    ["global after", ["badge", "--governed", "--json"]],
  ])("fails closed without verified evidence for %s", async (_label, argv) => {
    const result = await executeCli(argv);
    expect(result.exitCode).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toContain("verified receipt integrity and passing verifier evidence");
    expect(result.stdout).not.toContain(MARTINLOOP_BADGE_MARKDOWN);
  });

  // The evidence badge remains a valid Shields endpoint even when the stronger
  // governed claim correctly fails closed without a verified local receipt.
  it("keeps the evidence badge JSON valid while governed JSON fails closed without evidence", async () => {
    const plain = JSON.parse((await executeCli(["badge", "--format", "json"])).stdout) as Record<string, unknown>;
    const governedResult = await executeCli(["badge", "--governed", "--format", "json"]);
    for (const key of ["schemaVersion", "label", "message", "color"]) {
      expect(plain).toHaveProperty(key);
    }
    expect(governedResult.exitCode).toBe(2);
    expect(governedResult.stdout).toBe("");
    expect(governedResult.stderr).toContain("verified receipt integrity and passing verifier evidence");
  });

  it("rejects governed SVG instead of labeling Markdown as SVG", async () => {
    const result = await executeCli(["badge", "--governed", "--format", "svg"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("invalid_input");
    expect(result.stdout).not.toContain(MARTINLOOP_BADGE_MARKDOWN);
  });

  it("badge without --governed takes the evidence-readiness path (not governed markdown)", async () => {
    const result = await executeCli(["badge"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toBe(MARTINLOOP_BADGE_MARKDOWN);
    expect(result.stdout).toContain("Evidence readiness:");
    expect(result.stdout).toMatch(/\d\/4 measured signals/u);
    expect(result.stdout).toContain("1 unmeasured");
    expect(result.stdout).not.toContain("agent reliability");
  });
});
