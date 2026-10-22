import { describe, expect, it } from "vitest";

import { describeMalformedVerifier } from "../src/verifier-input.js";

describe("describeMalformedVerifier", () => {
  it.each([
    "npx martin-loop preflight --budget-usd 1",
    "pnpm exec martin run task --verify-only",
    "pnpx ./node_modules/.bin/martin-loop preflight --budget-usd 1",
    "node ./packages/cli/dist/martin.js preflight --budget-usd 1"
  ])("accepts launcher-prefixed MartinLoop invocation: %s", (command) => {
    expect(describeMalformedVerifier(command)).toBeUndefined();
  });

  it.each([
    "npx -y martin-loop preflight --budget-usd 1",
    "npx --yes martin run task --verify-only",
    "npm exec -- martin-loop preflight --budget-usd 1",
    "npm --silent exec -- martin run task --verify-only",
    "pnpm --silent exec -- martin-loop preflight --budget-usd 1"
  ])("accepts launcher options and separators before MartinLoop: %s", (command) => {
    expect(describeMalformedVerifier(command)).toBeUndefined();
  });

  it.each([
    "npx --package=@martinloop/mcp martin-loop preflight --budget-usd 1",
    "npm exec --package=@martinloop/mcp -- martin run task --verify-only"
  ])("preserves scoped inline package options while locating MartinLoop: %s", (command) => {
    expect(describeMalformedVerifier(command)).toBeUndefined();
  });

  it("still rejects folded MartinLoop flags on an ordinary verifier command", () => {
    expect(describeMalformedVerifier("pnpm test --budget-usd 1")).toMatch(/contains MartinLoop option/u);
  });

  it("still rejects an unterminated quote", () => {
    expect(describeMalformedVerifier('node -e "process.exit(0)')).toMatch(/unterminated quote/u);
  });
});
