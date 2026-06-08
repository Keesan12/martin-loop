import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cloneChangeObservationReconciliation,
  cloneVerifierSnapshot,
  createAdapterCapabilityDescriptor,
  getBuiltInEngineCapabilityDescriptor,
  createGovernanceSnapshot,
  type ChangeObservationReconciliation,
  type GovernanceSnapshot,
  type VerifierSnapshot
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

describe("shared runtime contracts", () => {
  it("creates adapter capability descriptors with stable defaults and overrides", () => {
    const descriptor = createAdapterCapabilityDescriptor({
      usageSettlement: "actual",
      diffVisibility: "git",
      structuredErrors: true
    });

    expect(descriptor.preflight).toBe(true);
    expect(descriptor.usageSettlement).toBe("actual");
    expect(descriptor.diffVisibility).toBe("git");
    expect(descriptor.verifierCompatibility).toBe("full");
  });

  it("returns built-in engine capability truth for claude and codex", () => {
    expect(getBuiltInEngineCapabilityDescriptor("claude").usageSettlement).toBe("actual");
    expect(getBuiltInEngineCapabilityDescriptor("codex").usageSettlement).toBe("estimated");
  });

  it("clones verifier snapshots without aliasing nested step data", () => {
    const source: VerifierSnapshot = {
      passed: true,
      summary: "All checks passed.",
      startedAt: "2026-06-07T00:00:00.000Z",
      completedAt: "2026-06-07T00:00:02.000Z",
      durationMs: 2000,
      stepCount: 1,
      failedStepCount: 0,
      commands: ["pnpm test"],
      steps: [
        {
          command: "pnpm test",
          type: "test_full",
          fastFail: true,
          passed: true,
          exitCode: 0,
          exitReason: "passed",
          startedAt: "2026-06-07T00:00:00.000Z",
          completedAt: "2026-06-07T00:00:02.000Z",
          durationMs: 2000,
          stdout: "ok"
        }
      ]
    };
    const snapshot = cloneVerifierSnapshot(source);

    snapshot.commands.push("pnpm lint");
    snapshot.steps[0]!.command = "mutated";

    expect(source.commands).toEqual(["pnpm test"]);
    expect(source.steps[0]?.command).toBe("pnpm test");
  });

  it("clones change observation reconciliation without aliasing nested evidence", () => {
    const source: ChangeObservationReconciliation = {
      status: "mismatch",
      summary: "Adapter-reported changes differed from repo observation.",
      adapterReported: {
        available: true,
        changedFiles: ["src/a.ts"],
        diffStats: {
          filesChanged: 1,
          addedLines: 4,
          deletedLines: 1
        }
      },
      repoObserved: {
        available: true,
        changedFiles: ["src/a.ts", "src/b.ts"],
        diffStats: {
          filesChanged: 2,
          addedLines: 7,
          deletedLines: 1
        }
      },
      effectiveChangedFiles: ["src/a.ts", "src/b.ts"],
      matchedFiles: ["src/a.ts"],
      adapterOnlyFiles: [],
      repoOnlyFiles: ["src/b.ts"]
    };

    const snapshot = cloneChangeObservationReconciliation(source);

    snapshot.adapterReported.changedFiles.push("src/c.ts");
    snapshot.repoObserved.diffStats!.filesChanged = 3;
    snapshot.effectiveChangedFiles[0] = "src/mutated.ts";

    expect(source.adapterReported.changedFiles).toEqual(["src/a.ts"]);
    expect(source.repoObserved.diffStats?.filesChanged).toBe(2);
    expect(source.effectiveChangedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

function loadGovernanceFixture(): GovernanceSnapshot {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  const fixturePath = resolve(currentDir, "./fixtures/governance-policy.json");
  return JSON.parse(readFileSync(fixturePath, "utf8")) as GovernanceSnapshot;
}
