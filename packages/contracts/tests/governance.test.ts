import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createGovernanceSnapshot,
  type GovernanceSnapshot
} from "../src/index.js";

describe("createGovernanceSnapshot", () => {
  it("creates an isolated snapshot from the seeded governance fixture", () => {
    const fixture = loadGovernanceFixture();
    const input = JSON.parse(JSON.stringify(fixture)) as GovernanceSnapshot;

    const snapshot = createGovernanceSnapshot(input);

    expect(snapshot).toEqual(input);
    expect(snapshot.allowedAdapters).not.toBe(input.allowedAdapters);
    expect(snapshot.allowedModels).not.toBe(input.allowedModels);
    expect(snapshot.verifierRules).not.toBe(input.verifierRules);
    expect(snapshot.provenance).not.toBe(input.provenance);
    expect(snapshot.provenance[0]).not.toBe(input.provenance[0]);

    input.allowedAdapters.push("agent:mutated-input");
    input.allowedModels[0] = "gpt-mutated-input";
    input.verifierRules.push("pnpm build");
    input.provenance[0]!.source = "mutated-input-source";

    expect(snapshot.allowedAdapters).toEqual(fixture.allowedAdapters);
    expect(snapshot.allowedModels).toEqual(fixture.allowedModels);
    expect(snapshot.verifierRules).toEqual(fixture.verifierRules);
    expect(snapshot.provenance[0]?.source).toBe(fixture.provenance[0]?.source);

    snapshot.allowedAdapters.push("agent:mutated-output");
    snapshot.allowedModels[0] = "gpt-mutated-output";
    snapshot.verifierRules.push("pnpm typecheck");
    snapshot.provenance[0]!.value = "999";

    expect(input.allowedAdapters).not.toContain("agent:mutated-output");
    expect(input.allowedModels).not.toContain("gpt-mutated-output");
    expect(input.verifierRules).not.toContain("pnpm typecheck");
    expect(input.provenance[0]?.value).toBe("8");
  });

  it("loads a seeded governance fixture with expected governance fields", () => {
    const fixture = loadGovernanceFixture();

    expect(fixture.policyProfile).toBe("balanced");
    expect(fixture.allowedAdapters.length).toBeGreaterThan(0);
    expect(fixture.allowedModels.length).toBeGreaterThan(0);
    expect(fixture.verifierRules.length).toBeGreaterThan(0);
    expect(fixture.provenance.length).toBeGreaterThan(0);
  });
});

function loadGovernanceFixture(): GovernanceSnapshot {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  const fixturePath = resolve(currentDir, "../../../demo/seeded-workspace/governance-policy.json");
  return JSON.parse(readFileSync(fixturePath, "utf8")) as GovernanceSnapshot;
}
