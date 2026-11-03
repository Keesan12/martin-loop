import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const laneSource = readFileSync(
  fileURLToPath(new URL("../scripts/run-test-lane.mjs", import.meta.url)),
  "utf8"
);
const claudeCliTestSource = readFileSync(
  fileURLToPath(new URL("./claude-cli.test.ts", import.meta.url)),
  "utf8"
);

function extractTopLevelDescribeNames(source: string): string[] {
  return [...source.matchAll(/^describe\("([^"]+)",/gm)].map((match) => match[1] ?? "");
}

function extractConfiguredClaudeCliSuites(source: string): string[] {
  const suiteBlock = source.match(/const claudeCliSuites = \[([\s\S]*?)\n\];/);
  expect(suiteBlock, "claudeCliSuites must remain an explicit reviewable array").not.toBeNull();
  return [...(suiteBlock?.[1] ?? "").matchAll(/^\s+"([^"]+)",?$/gm)].map(
    (match) => match[1] ?? ""
  );
}

describe("adapter baseline lane policy", () => {
  it("runs each claude-cli top-level suite in a fresh Vitest process", () => {
    const actualSuites = extractTopLevelDescribeNames(claudeCliTestSource);
    const configuredSuites = extractConfiguredClaudeCliSuites(laneSource);

    expect(actualSuites.length).toBeGreaterThan(0);
    expect(new Set(actualSuites).size, "top-level describe names must be unique").toBe(
      actualSuites.length
    );
    expect(new Set(configuredSuites).size, "configured suite partitions must be unique").toBe(
      configuredSuites.length
    );
    expect(configuredSuites).toEqual(actualSuites);
    expect(laneSource).toMatch(/claudeCliSuites\.map/);
    expect(laneSource).toMatch(/--maxWorkers=1/);
    expect(laneSource).not.toContain("^(?!.*(${baselineExclusionPattern})).*$");
  });
});
