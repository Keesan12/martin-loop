import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";

async function withRunsDir<T>(fn: (runsDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "martin-exit-signal-cli-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const RUN_ID = "loop_test_001";

describe("exit signal CLI commands", () => {
  it("cancel success — writes human_interrupt signal", async () => {
    await withRunsDir(async (runsDir) => {
      const result = await executeCli([
        "cancel",
        RUN_ID,
        "--runs-dir",
        runsDir
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      const signalPath = join(runsDir, RUN_ID, "signals", "human_interrupt.json");
      const raw = await readFile(signalPath, "utf8");
      const signal = JSON.parse(raw) as {
        kind: string;
        runId: string;
        schemaVersion: string;
      };

      expect(signal.kind).toBe("human_interrupt");
      expect(signal.runId).toBe(RUN_ID);
    });
  });

  it("external stop signal — writes external_event with cancelled disposition", async () => {
    await withRunsDir(async (runsDir) => {
      const result = await executeCli([
        "signal",
        RUN_ID,
        "--event",
        "ci.failed",
        "--disposition",
        "stop",
        "--runs-dir",
        runsDir
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      const signalPath = join(runsDir, RUN_ID, "signals", "external_event.json");
      const raw = await readFile(signalPath, "utf8");
      const signal = JSON.parse(raw) as {
        kind: string;
        runId: string;
        externalEvent: { event: string; disposition: string };
      };

      expect(signal.kind).toBe("external_event");
      expect(signal.runId).toBe(RUN_ID);
      expect(signal.externalEvent.event).toBe("ci.failed");
      expect(signal.externalEvent.disposition).toBe("cancelled");
    });
  });

  it("external continue signal — writes external_event with satisfied disposition", async () => {
    await withRunsDir(async (runsDir) => {
      const result = await executeCli([
        "signal",
        RUN_ID,
        "--event",
        "review.approved",
        "--disposition",
        "continue",
        "--runs-dir",
        runsDir
      ]);

      expect(result.exitCode).toBe(0);

      const signalPath = join(runsDir, RUN_ID, "signals", "external_event.json");
      const raw = await readFile(signalPath, "utf8");
      const signal = JSON.parse(raw) as {
        externalEvent: { event: string; disposition: string };
      };

      expect(signal.externalEvent.disposition).toBe("satisfied");
    });
  });

  it("duplicate signal — preserves original and returns nonzero", async () => {
    await withRunsDir(async (runsDir) => {
      const first = await executeCli([
        "cancel",
        RUN_ID,
        "--reason",
        "first interrupt",
        "--runs-dir",
        runsDir
      ]);

      expect(first.exitCode).toBe(0);

      const second = await executeCli([
        "cancel",
        RUN_ID,
        "--reason",
        "second interrupt — must not overwrite",
        "--runs-dir",
        runsDir
      ]);

      expect(second.exitCode).not.toBe(0);
      expect(second.stderr).toContain("already exists");

      // Original signal is preserved
      const signalPath = join(runsDir, RUN_ID, "signals", "human_interrupt.json");
      const raw = await readFile(signalPath, "utf8");
      const signal = JSON.parse(raw) as { reason?: string };
      expect(signal.reason).toBe("first interrupt");
    });
  });

  it("invalid run ID — rejects path traversal", async () => {
    await withRunsDir(async (runsDir) => {
      const result = await executeCli([
        "cancel",
        "../escape",
        "--runs-dir",
        runsDir
      ]);

      expect(result.exitCode).not.toBe(0);
    });
  });

  it("missing --event — returns nonzero with usage hint", async () => {
    await withRunsDir(async (runsDir) => {
      const result = await executeCli([
        "signal",
        RUN_ID,
        "--runs-dir",
        runsDir
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--event");
    });
  });

  it("invalid disposition — returns nonzero", async () => {
    await withRunsDir(async (runsDir) => {
      const result = await executeCli([
        "signal",
        RUN_ID,
        "--event",
        "ci.failed",
        "--disposition",
        "obliterate",
        "--runs-dir",
        runsDir
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("disposition");
    });
  });

  it("idempotency — duplicate write does not overwrite original content or timestamp", async () => {
    await withRunsDir(async (runsDir) => {
      await executeCli(["cancel", RUN_ID, "--reason", "original reason", "--runs-dir", runsDir]);

      const signalPath = join(runsDir, RUN_ID, "signals", "human_interrupt.json");
      const originalRaw = await readFile(signalPath, "utf8");
      const originalSignal = JSON.parse(originalRaw) as { reason?: string; requestedAt: string };

      // Second write with different reason — must be rejected
      const second = await executeCli(["cancel", RUN_ID, "--reason", "overwrite attempt", "--runs-dir", runsDir]);
      expect(second.exitCode).not.toBe(0);

      // File must be byte-for-byte identical
      const afterRaw = await readFile(signalPath, "utf8");
      expect(afterRaw).toBe(originalRaw);
      expect((JSON.parse(afterRaw) as { reason?: string }).reason).toBe("original reason");
      expect((JSON.parse(afterRaw) as { requestedAt: string }).requestedAt).toBe(originalSignal.requestedAt);
    });
  });

  it("JSON output — returns structured data with no stray stdout", async () => {
    await withRunsDir(async (runsDir) => {
      const result = await executeCli([
        "--json",
        "cancel",
        RUN_ID,
        "--runs-dir",
        runsDir
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      const payload = JSON.parse(result.stdout) as {
        command: string;
        runId: string;
        kind: string;
        outcome: string;
      };

      expect(payload.command).toBe("cancel");
      expect(payload.runId).toBe(RUN_ID);
      expect(payload.kind).toBe("human_interrupt");
      expect(payload.outcome).toBe("created");
    });
  });
});
