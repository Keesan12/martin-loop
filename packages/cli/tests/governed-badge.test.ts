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
  it("returns exact badge markdown with exit 0", async () => {
    const result = await executeCli(["badge", "--governed"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(MARTINLOOP_BADGE_MARKDOWN);
    expect(result.stderr).toBe("");
  });

  it("badge without --governed takes reliability path (not governed markdown)", async () => {
    const result = await executeCli(["badge"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toBe(MARTINLOOP_BADGE_MARKDOWN);
    // reliability badge is SVG by default
    expect(result.stdout).toContain("agent reliability");
  });
});
