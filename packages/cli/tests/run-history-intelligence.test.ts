import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createLoopRecord } from "../../contracts/src/index.js";
import { executeCli } from "../src/index.js";
import {
  computeScopeFingerprint,
  readLocalCorpusRisk,
  readLocalRunHistoryRisk
} from "../src/run-store.js";

describe("computeScopeFingerprint", () => {
  it("returns a 16-char hex string", () => {
    const fp = computeScopeFingerprint("/workspace/my-project");
    expect(fp).toMatch(/^[a-f0-9]{16}$/);
  });

  it("is deterministic for the same path", () => {
    expect(computeScopeFingerprint("/workspace/my-project")).toBe(
      computeScopeFingerprint("/workspace/my-project")
    );
  });

  it("normalizes path separators", () => {
    expect(computeScopeFingerprint("/workspace/my-project")).toBe(
      computeScopeFingerprint("\\workspace\\my-project")
    );
  });

  it("produces different fingerprints for different paths", () => {
    expect(computeScopeFingerprint("/workspace/project-a")).not.toBe(
      computeScopeFingerprint("/workspace/project-b")
    );
  });
});

describe("readLocalRunHistoryRisk", () => {
  it("returns empty hotspots when the runs root does not exist", async () => {
    const missingRuns = join(await mkdtemp(join(tmpdir(), "martin-missing-runs-")), "missing");
    const risk = await readLocalRunHistoryRisk({ runsDir: missingRuns });

    expect(risk.hotspots).toEqual([]);
    expect(risk.runRecords).toBe(0);
    expect(risk.runsRoot).toBe(missingRuns);
  });

  it("groups risk by repoRoot fingerprint and counts failed verification as risky", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-run-history-"));
    const repoRoot = join(runsRoot, "repo");

    try {
      const loops = [
        createPersistedLoop({
          loopId: "loop_risk_1",
          repoRoot,
          status: "completed",
          lifecycleState: "completed",
          verificationPassed: false,
          failureClass: "verification_failure"
        }),
        createPersistedLoop({
          loopId: "loop_risk_2",
          repoRoot,
          status: "failed",
          lifecycleState: "human_escalation",
          failureClass: "logic_error"
        }),
        createPersistedLoop({
          loopId: "loop_risk_3",
          repoRoot,
          status: "completed",
          lifecycleState: "completed",
          verificationPassed: true
        }),
        createPersistedLoop({
          loopId: "loop_no_repo",
          status: "failed",
          lifecycleState: "budget_exit"
        })
      ];

      for (const loop of loops) {
        const loopDir = join(runsRoot, loop.loopId);
        await mkdir(loopDir, { recursive: true });
        await writeFile(join(loopDir, "loop-record.json"), JSON.stringify(loop, null, 2), "utf8");
      }

      const risk = await readLocalRunHistoryRisk({
        runsDir: runsRoot,
        minSampleSize: 3,
        minRiskScore: 0.4
      });

      expect(risk.runRecords).toBe(4);
      expect(risk.hotspots).toHaveLength(1);
      expect(risk.hotspots[0]).toMatchObject({
        scopeFingerprint: computeScopeFingerprint(repoRoot),
        failureRate: 0.67,
        sampleSize: 3
      });
      expect(risk.hotspots[0]?.commonFailureClasses).toEqual(
        expect.arrayContaining(["verification_failure", "logic_error"])
      );
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });
});

describe("readLocalCorpusRisk", () => {
  it("returns empty hotspots and zero records when the corpus file does not exist", async () => {
    const risk = await readLocalCorpusRisk({ corpusPath: "/nonexistent/corpus.jsonl" });

    expect(risk.hotspots).toEqual([]);
    expect(risk.corpusRecords).toBe(0);
  });

  it("returns empty hotspots when the corpus is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "martin-empty-corpus-"));

    try {
      const corpusPath = join(dir, "corpus.jsonl");
      await writeFile(corpusPath, "", "utf8");

      const risk = await readLocalCorpusRisk({ corpusPath });

      expect(risk.hotspots).toEqual([]);
      expect(risk.corpusRecords).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the legacy corpus shim available when an explicit corpus path is provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "martin-legacy-corpus-"));

    try {
      const corpusPath = join(dir, "corpus.jsonl");
      await writeFile(
        corpusPath,
        [
          JSON.stringify({
            scopeFingerprint: "abc123def456abcd",
            outcome: "failed",
            failureClass: "verification_failure"
          }),
          JSON.stringify({
            scopeFingerprint: "abc123def456abcd",
            outcome: "failed",
            failureClass: "verification_failure"
          }),
          JSON.stringify({
            scopeFingerprint: "abc123def456abcd",
            outcome: "completed",
            failureClass: null
          })
        ].join("\n"),
        "utf8"
      );

      const risk = await readLocalCorpusRisk({
        corpusPath,
        minSampleSize: 3,
        minRiskScore: 0.4
      });

      expect(risk.corpusRecords).toBe(3);
      expect(risk.hotspots).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("excludes hotspots below the sample-size threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "martin-small-corpus-"));

    try {
      const corpusPath = join(dir, "corpus.jsonl");
      await writeFile(
        corpusPath,
        [
          JSON.stringify({
            scopeFingerprint: "abc123def456abcd",
            outcome: "failed",
            failureClass: "verification_failure"
          }),
          JSON.stringify({
            scopeFingerprint: "abc123def456abcd",
            outcome: "failed",
            failureClass: "verification_failure"
          })
        ].join("\n"),
        "utf8"
      );

      const risk = await readLocalCorpusRisk({
        corpusPath,
        minSampleSize: 3,
        minRiskScore: 0
      });

      expect(risk.hotspots).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips malformed JSONL lines without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "martin-malformed-corpus-"));

    try {
      const corpusPath = join(dir, "corpus.jsonl");
      await writeFile(
        corpusPath,
        [
          "not valid json {{",
          JSON.stringify({
            scopeFingerprint: "abc123def456abcd",
            outcome: "completed",
            failureClass: null
          }),
          JSON.stringify({
            scopeFingerprint: "abc123def456abcd",
            outcome: "failed",
            failureClass: "verification_failure"
          }),
          JSON.stringify({
            scopeFingerprint: "abc123def456abcd",
            outcome: "failed",
            failureClass: "verification_failure"
          }),
          JSON.stringify({
            scopeFingerprint: "abc123def456abcd",
            outcome: "failed",
            failureClass: "verification_failure"
          })
        ].join("\n"),
        "utf8"
      );

      const risk = await readLocalCorpusRisk({
        corpusPath,
        minSampleSize: 3,
        minRiskScore: 0.4
      });

      expect(risk.corpusRecords).toBe(4);
      expect(risk.hotspots).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("preflight run-history integration", () => {
  it("shows run-history guidance even when no persisted runs exist", async () => {
    const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
    const previousLive = process.env.MARTIN_LIVE;
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-empty-runs-"));

    try {
      process.env.MARTIN_RUNS_DIR = join(runsRoot, "missing");
      process.env.MARTIN_LIVE = "false";

      const result = await executeCli(["preflight", "--objective", "Fix the failing test"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Run history:/i);
    } finally {
      if (previousRunsRoot === undefined) {
        delete process.env.MARTIN_RUNS_DIR;
      } else {
        process.env.MARTIN_RUNS_DIR = previousRunsRoot;
      }

      if (previousLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousLive;
      }

      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("surfaces a scope hotspot from the legacy corpus shim when explicitly configured", async () => {
    const previousCorpusPath = process.env.MARTIN_LEARNING_CORPUS_PATH;
    const previousLive = process.env.MARTIN_LIVE;
    const dir = await mkdtemp(join(tmpdir(), "martin-preflight-corpus-"));

    try {
      const corpusPath = join(dir, "corpus.jsonl");
      const scopeFingerprint = computeScopeFingerprint(process.cwd());
      await writeFile(
        corpusPath,
        Array.from({ length: 5 }, (_, index) =>
          JSON.stringify({
            scopeFingerprint,
            outcome: index < 4 ? "failed" : "completed",
            failureClass: "verification_failure"
          })
        ).join("\n"),
        "utf8"
      );

      process.env.MARTIN_LEARNING_CORPUS_PATH = corpusPath;
      process.env.MARTIN_LIVE = "false";

      const result = await executeCli(["preflight", "--objective", "Fix the failing test"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Run history:/i);
      expect(result.stdout).toMatch(/Run history risk:/i);
      expect(result.stdout).toMatch(/80%/i);
    } finally {
      if (previousCorpusPath === undefined) {
        delete process.env.MARTIN_LEARNING_CORPUS_PATH;
      } else {
        process.env.MARTIN_LEARNING_CORPUS_PATH = previousCorpusPath;
      }

      if (previousLive === undefined) {
        delete process.env.MARTIN_LIVE;
      } else {
        process.env.MARTIN_LIVE = previousLive;
      }

      await rm(dir, { recursive: true, force: true });
    }
  });
});

function createPersistedLoop(input: {
  loopId: string;
  repoRoot?: string;
  status: "completed" | "failed" | "exited";
  lifecycleState: "completed" | "human_escalation" | "budget_exit";
  verificationPassed?: boolean;
  failureClass?: "verification_failure" | "logic_error";
}) {
  const loop = createLoopRecord({
    workspaceId: "ws_ops",
    projectId: "proj_runtime",
    task: {
      title: input.loopId,
      objective: "Assess run-history risk.",
      ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
      verificationPlan: ["pnpm test"]
    }
  });

  return {
    ...loop,
    loopId: input.loopId,
    status: input.status,
    lifecycleState: input.lifecycleState,
    attempts: input.failureClass
      ? [
          {
            attemptId: `att_${input.loopId}`,
            index: 1,
            adapterId: "codex-cli",
            model: "gpt-5-codex",
            startedAt: "2026-06-07T00:00:00.000Z",
            summary: input.failureClass,
            failureClass: input.failureClass
          }
        ]
      : [],
    events:
      input.verificationPassed === undefined
        ? loop.events
        : [
            {
              eventId: `evt_${input.loopId}`,
              timestamp: "2026-06-07T00:00:01.000Z",
              type: "verification.completed" as const,
              lifecycleState: input.verificationPassed ? "completed" : "verifying",
              payload: {
                passed: input.verificationPassed,
                summary: input.verificationPassed
                  ? "Verification passed."
                  : "Verification failed."
              }
            }
          ]
  };
}
