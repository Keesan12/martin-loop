/**
 * Corpus intelligence tests — Layer 5 proactive issue detection.
 * Covers readLocalCorpusRisk, computeScopeFingerprint, and preflight corpus output.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";
import { computeScopeFingerprint, readLocalCorpusRisk } from "../src/run-store.js";

async function withRunsRoot<T>(fn: (runsRoot: string) => Promise<T>): Promise<T> {
  const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
  const previousGroundingDir = process.env.MARTIN_GROUNDING_DIR;
  const root = await mkdtemp(join(tmpdir(), "martin-cli-corpus-runs-"));
  const runsRoot = join(root, "runs");
  const groundingDir = join(root, "grounding");
  await mkdir(runsRoot, { recursive: true });
  await mkdir(groundingDir, { recursive: true });
  process.env.MARTIN_RUNS_DIR = runsRoot;
  process.env.MARTIN_GROUNDING_DIR = groundingDir;

  try {
    return await fn(runsRoot);
  } finally {
    if (previousRunsRoot === undefined) {
      delete process.env.MARTIN_RUNS_DIR;
    } else {
      process.env.MARTIN_RUNS_DIR = previousRunsRoot;
    }

    if (previousGroundingDir === undefined) {
      delete process.env.MARTIN_GROUNDING_DIR;
    } else {
      process.env.MARTIN_GROUNDING_DIR = previousGroundingDir;
    }

    await rm(root, { force: true, recursive: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// computeScopeFingerprint
// ---------------------------------------------------------------------------

describe("computeScopeFingerprint", () => {
  it("returns a 16-char hex string", () => {
    const fp = computeScopeFingerprint("/workspace/my-project");
    expect(fp).toMatch(/^[a-f0-9]{16}$/);
  });

  it("is deterministic for the same path", () => {
    const a = computeScopeFingerprint("/workspace/my-project");
    const b = computeScopeFingerprint("/workspace/my-project");
    expect(a).toBe(b);
  });

  it("normalizes Windows backslashes to forward slashes", () => {
    const unix = computeScopeFingerprint("/workspace/my-project");
    const win = computeScopeFingerprint("\\workspace\\my-project");
    expect(unix).toBe(win);
  });

  it("produces different fingerprints for different paths", () => {
    const a = computeScopeFingerprint("/workspace/project-a");
    const b = computeScopeFingerprint("/workspace/project-b");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// readLocalCorpusRisk
// ---------------------------------------------------------------------------

describe("readLocalCorpusRisk", () => {
  it("returns empty hotspots and zero records when corpus file does not exist", async () => {
    const risk = await readLocalCorpusRisk({ corpusPath: "/nonexistent/corpus.jsonl" });
    expect(risk.hotspots).toEqual([]);
    expect(risk.corpusRecords).toBe(0);
  });

  it("returns empty hotspots when corpus is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corpus-test-"));
    try {
      const corpusPath = join(dir, "corpus.jsonl");
      await writeFile(corpusPath, "", "utf8");
      const risk = await readLocalCorpusRisk({ corpusPath });
      expect(risk.hotspots).toEqual([]);
      expect(risk.corpusRecords).toBe(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("returns hotspots above risk threshold from corpus records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corpus-test-"));
    try {
      const corpusPath = join(dir, "corpus.jsonl");
      const scope = "abc123def456abcd";

      // Write 5 records: 4 failures (80% failure rate → high risk)
      const records = [
        { scopeFingerprint: scope, outcome: "failed", failureClass: "verification_failure" },
        { scopeFingerprint: scope, outcome: "failed", failureClass: "verification_failure" },
        { scopeFingerprint: scope, outcome: "failed", failureClass: "budget_exceeded" },
        { scopeFingerprint: scope, outcome: "failed", failureClass: "budget_exceeded" },
        { scopeFingerprint: scope, outcome: "completed", failureClass: null }
      ];
      await writeFile(corpusPath, records.map((r) => JSON.stringify(r)).join("\n"), "utf8");

      const risk = await readLocalCorpusRisk({ corpusPath, minSampleSize: 3, minRiskScore: 0.4 });
      const hotspot = risk.hotspots[0];

      expect(risk.corpusRecords).toBe(5);
      expect(risk.hotspots).toHaveLength(1);
      expect(hotspot?.scopeFingerprint).toBe(scope);
      expect(hotspot?.failureRate).toBe(0.8);
      expect(hotspot?.sampleSize).toBe(5);
      expect(hotspot?.commonFailureClasses).toContain("verification_failure");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("excludes hotspots below sample size threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corpus-test-"));
    try {
      const corpusPath = join(dir, "corpus.jsonl");
      const scope = "abc123def456abcd";

      // Only 2 records — below minSampleSize of 3
      const records = [
        { scopeFingerprint: scope, outcome: "failed", failureClass: "verification_failure" },
        { scopeFingerprint: scope, outcome: "failed", failureClass: "verification_failure" }
      ];
      await writeFile(corpusPath, records.map((r) => JSON.stringify(r)).join("\n"), "utf8");

      const risk = await readLocalCorpusRisk({ corpusPath, minSampleSize: 3, minRiskScore: 0.0 });
      expect(risk.hotspots).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("skips malformed JSONL lines without throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corpus-test-"));
    try {
      const corpusPath = join(dir, "corpus.jsonl");
      const scope = "abc123def456abcd";
      const content = [
        "not valid json {{",
        JSON.stringify({ scopeFingerprint: scope, outcome: "completed" }),
        JSON.stringify({ scopeFingerprint: scope, outcome: "failed" }),
        JSON.stringify({ scopeFingerprint: scope, outcome: "failed" }),
        JSON.stringify({ scopeFingerprint: scope, outcome: "failed" })
      ].join("\n");
      await writeFile(corpusPath, content, "utf8");

      const risk = await readLocalCorpusRisk({ corpusPath, minSampleSize: 3, minRiskScore: 0.4 });
      // 4 valid records, 3 failures = 75% failure rate → should be a hotspot
      expect(risk.corpusRecords).toBe(4);
      expect(risk.hotspots).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// preflight corpus output
// ---------------------------------------------------------------------------

describe("preflight corpus integration", () => {
  it("shows corpus line even when no corpus data exists", async () => {
    // Override corpus path to a nonexistent file so we get the empty-corpus message
    const result = await withRunsRoot(() =>
      executeCli([
        "preflight",
        "Fix the failing test",
        "--verify", process.platform === "win32" ? "cmd /c exit 0" : "true"
      ])
    );

    expect(result.exitCode).toBe(0);
    // Should include the corpus status line regardless of whether data exists
    expect(result.stdout).toMatch(/corpus/i);
  });

  it("includes scope hotspot warning in preflight when high-risk scope data exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corpus-preflight-"));
    try {
      const corpusPath = join(dir, "corpus.jsonl");

      // Compute the fingerprint for cwd so the hotspot matches
      const cwd = process.cwd();
      const scope = computeScopeFingerprint(cwd);

      const records = Array.from({ length: 5 }, (_, i) => ({
        scopeFingerprint: scope,
        outcome: i < 4 ? "failed" : "completed",
        failureClass: "verification_failure"
      }));
      await writeFile(corpusPath, records.map((r) => JSON.stringify(r)).join("\n"), "utf8");

      const originalEnv = process.env["MARTIN_LEARNING_CORPUS_PATH"];
      process.env["MARTIN_LEARNING_CORPUS_PATH"] = corpusPath;

      try {
        const result = await withRunsRoot(() =>
          executeCli([
            "preflight",
            "Fix the failing test",
            "--verify", process.platform === "win32" ? "cmd /c exit 0" : "true"
          ])
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/corpus/i);
        // With 4/5 failures (80%), it should surface a hotspot warning
        expect(result.stdout).toMatch(/80%|0\.8|hotspot/i);
      } finally {
        if (originalEnv === undefined) {
          delete process.env["MARTIN_LEARNING_CORPUS_PATH"];
        } else {
          process.env["MARTIN_LEARNING_CORPUS_PATH"] = originalEnv;
        }
      }
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
