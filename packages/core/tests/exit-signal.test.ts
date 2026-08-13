/**
 * Durable exit signal tests — filesystem I/O, concurrency, containment.
 *
 * Covers atomic publication, first-signal-wins per kind, real-path
 * containment, symlink/junction rejection, diagnostics propagation, and
 * monitor behaviour.
 */

import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExitSignalV1 } from "@martin/contracts";
import {
  SignalDiagnosticError,
  createFileExitSignalSource,
  exitSignalPath,
  readAllExitSignals,
  readExitSignal,
  startExitSignalMonitor,
  writeExitSignal
} from "../src/exit-signal";

// ─── Test fixtures ───────────────────────────────────────────────────────────

let runsRoot: string;

beforeEach(async () => {
  runsRoot = await mkdtemp(join(tmpdir(), "martin-signal-test-"));
});

afterEach(async () => {
  await rm(runsRoot, { recursive: true, force: true });
});

function humanSignal(runId: string): ExitSignalV1 {
  return {
    schemaVersion: "exit-signal/1",
    runId,
    kind: "human_interrupt",
    requestedBy: "operator",
    requestedAt: "2025-01-01T00:00:00.000Z",
    reason: "Stop now"
  };
}

function externalSignal(runId: string): ExitSignalV1 {
  return {
    schemaVersion: "exit-signal/1",
    runId,
    kind: "external_event",
    requestedBy: "ci-watcher",
    requestedAt: "2025-01-01T00:00:00.000Z",
    externalEvent: {
      source: "github-ci",
      event: "build_failed",
      disposition: "cancelled",
      observedAt: "2025-01-01T00:00:00.000Z"
    }
  };
}

// ─── exitSignalPath ──────────────────────────────────────────────────────────

describe("exitSignalPath", () => {
  it("returns the expected per-kind path under <runsRoot>/<runId>/signals/", () => {
    const p = exitSignalPath(runsRoot, "run-abc", "human_interrupt");
    expect(p).toMatch(/human_interrupt\.json$/);
    expect(p).toContain("run-abc");
    expect(p).toContain("signals");
  });

  it("rejects runId containing path separators", () => {
    expect(() => exitSignalPath(runsRoot, "run/../escape", "human_interrupt")).toThrow();
  });

  it("rejects the runId '.'", () => {
    expect(() => exitSignalPath(runsRoot, ".", "human_interrupt")).toThrow();
  });

  it("rejects the runId '..'", () => {
    expect(() => exitSignalPath(runsRoot, "..", "human_interrupt")).toThrow();
  });

  it("rejects a runId that resolves outside the runs root", () => {
    // On most platforms resolve("root", "/escape") = "/escape", outside root
    // assertRunId fires first (/ is not in the allowed character set)
    expect(() => exitSignalPath(runsRoot, "/etc/passwd", "human_interrupt")).toThrow();
  });
});

// ─── writeExitSignal — basic publication ─────────────────────────────────────

describe("writeExitSignal — basic write and read", () => {
  it("creates the signal file and returns 'created'", async () => {
    const result = await writeExitSignal(runsRoot, humanSignal("run-001"));
    expect(result).toBe("created");
  });

  it("written signal is readable via readExitSignal", async () => {
    await writeExitSignal(runsRoot, humanSignal("run-001"));
    const sig = await readExitSignal(runsRoot, "run-001", "human_interrupt");
    expect(sig).toBeDefined();
    expect(sig!.kind).toBe("human_interrupt");
    expect(sig!.requestedBy).toBe("operator");
  });

  it("written external_event is readable with its evidence fields intact", async () => {
    await writeExitSignal(runsRoot, externalSignal("run-002"));
    const sig = await readExitSignal(runsRoot, "run-002", "external_event");
    expect(sig!.externalEvent?.source).toBe("github-ci");
    expect(sig!.externalEvent?.disposition).toBe("cancelled");
  });
});

// ─── First-signal-wins per kind ──────────────────────────────────────────────

describe("writeExitSignal — first-signal-wins per kind", () => {
  it("returns 'already_exists' on a second write of the SAME kind", async () => {
    const first = await writeExitSignal(runsRoot, humanSignal("run-003"));
    const second = await writeExitSignal(runsRoot, humanSignal("run-003"));
    expect(first).toBe("created");
    expect(second).toBe("already_exists");
  });

  it("the original signal is preserved — second writer does not replace it", async () => {
    const original: ExitSignalV1 = { ...humanSignal("run-004"), reason: "First reason" };
    const replacement: ExitSignalV1 = { ...humanSignal("run-004"), reason: "Second reason" };
    await writeExitSignal(runsRoot, original);
    await writeExitSignal(runsRoot, replacement);
    const sig = await readExitSignal(runsRoot, "run-004", "human_interrupt");
    expect(sig!.reason).toBe("First reason");
  });
});

// ─── Per-kind coexistence ─────────────────────────────────────────────────────

describe("writeExitSignal — different kinds coexist independently", () => {
  it("human_interrupt written AFTER external_event succeeds (different kind slot)", async () => {
    const extResult = await writeExitSignal(runsRoot, externalSignal("run-005"));
    const humResult = await writeExitSignal(runsRoot, humanSignal("run-005"));
    expect(extResult).toBe("created");
    expect(humResult).toBe("created");
  });

  it("readAllExitSignals returns both signals when both kinds are present", async () => {
    await writeExitSignal(runsRoot, humanSignal("run-006"));
    await writeExitSignal(runsRoot, externalSignal("run-006"));
    const { signals, diagnostics } = await readAllExitSignals(runsRoot, "run-006");
    expect(signals).toHaveLength(2);
    expect(diagnostics).toHaveLength(0);
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain("human_interrupt");
    expect(kinds).toContain("external_event");
  });
});

// ─── Absent signal ───────────────────────────────────────────────────────────

describe("readExitSignal / readAllExitSignals — absent signals", () => {
  it("returns undefined when no signal has been written for a run", async () => {
    const sig = await readExitSignal(runsRoot, "no-run", "human_interrupt");
    expect(sig).toBeUndefined();
  });

  it("returns empty signals and diagnostics when signals dir does not exist", async () => {
    const result = await readAllExitSignals(runsRoot, "no-run");
    expect(result.signals).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
  });
});

// ─── Oversized signal ────────────────────────────────────────────────────────

describe("writeExitSignal — oversized signals are rejected before touching disk", () => {
  it("throws when payload exceeds 64 KiB", async () => {
    const bigReason = "x".repeat(65 * 1024);
    const signal: ExitSignalV1 = { ...humanSignal("run-big"), reason: bigReason };
    await expect(writeExitSignal(runsRoot, signal)).rejects.toThrow(/64 KiB/);
  });
});

// ─── Malformed and unsupported signals ───────────────────────────────────────

describe("readAllExitSignals — malformed signal files produce diagnostics", () => {
  it("reports a diagnostic for a signal file containing invalid JSON", async () => {
    // Place a malformed file directly in the signals directory
    const sigDir = join(runsRoot, "run-bad", "signals");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sigDir, { recursive: true });
    await writeFile(join(sigDir, "human_interrupt.json"), "not-json", "utf8");
    const { signals, diagnostics } = await readAllExitSignals(runsRoot, "run-bad");
    expect(signals).toHaveLength(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.kind).toBe("human_interrupt");
    expect(diagnostics[0]!.error).toMatch(/JSON/);
  });

  it("reports a diagnostic for a signal with an unsupported schemaVersion", async () => {
    const sigDir = join(runsRoot, "run-schema", "signals");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sigDir, { recursive: true });
    const badSignal = {
      schemaVersion: "exit-signal/99",
      runId: "run-schema",
      kind: "human_interrupt",
      requestedBy: "test",
      requestedAt: "2025-01-01T00:00:00.000Z"
    };
    await writeFile(
      join(sigDir, "human_interrupt.json"),
      JSON.stringify(badSignal) + "\n",
      "utf8"
    );
    const { signals, diagnostics } = await readAllExitSignals(runsRoot, "run-schema");
    expect(signals).toHaveLength(0);
    expect(diagnostics[0]!.error).toMatch(/schema/i);
  });
});

// ─── Path traversal ──────────────────────────────────────────────────────────

describe("writeExitSignal — path traversal is rejected", () => {
  it("rejects a signal with runId containing double-dot sequences", async () => {
    const signal: ExitSignalV1 = {
      ...humanSignal("run-001"),
      runId: "../escape"
    };
    await expect(writeExitSignal(runsRoot, signal)).rejects.toThrow();
  });

  it("rejects a signal with a runId that is only dots", async () => {
    const signal: ExitSignalV1 = {
      ...humanSignal("run-001"),
      runId: ".."
    };
    await expect(writeExitSignal(runsRoot, signal)).rejects.toThrow();
  });
});

// ─── Symlink/junction escape (platform-conditional) ──────────────────────────

describe("readAllExitSignals — symbolic link rejection", () => {
  let canSymlink = false;

  beforeEach(async () => {
    // Probe whether symlinks are allowed on this platform/user
    const probe = join(runsRoot, "probe-link");
    const probe_target = join(runsRoot, "probe-target");
    try {
      await writeFile(probe_target, "", "utf8");
      await symlink(probe_target, probe);
      canSymlink = true;
    } catch {
      canSymlink = false;
    }
  });

  it("returns a diagnostic when the signal file itself is a symbolic link", async () => {
    if (!canSymlink) return; // skip — symlinks not permitted on this system

    const { mkdir } = await import("node:fs/promises");
    const sigDir = join(runsRoot, "run-sym", "signals");
    await mkdir(sigDir, { recursive: true });

    const realFile = join(runsRoot, "legit-signal.json");
    const signal = humanSignal("run-sym");
    await writeFile(realFile, JSON.stringify(signal) + "\n", "utf8");

    // Place a symlink at the expected signal path
    await symlink(realFile, join(sigDir, "human_interrupt.json"));

    const { signals, diagnostics } = await readAllExitSignals(runsRoot, "run-sym");
    expect(signals).toHaveLength(0);
    expect(diagnostics[0]!.error).toMatch(/symbolic link/);
  });

  it("returns a diagnostic when the signals directory itself points outside the run store", async () => {
    if (!canSymlink) return;

    const outsideDir = await mkdtemp(join(tmpdir(), "outside-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      const runDir = join(runsRoot, "run-escape");
      await mkdir(runDir, { recursive: true });

      // Create a valid signal in the outside directory
      const signal = humanSignal("run-escape");
      await writeFile(join(outsideDir, "human_interrupt.json"), JSON.stringify(signal) + "\n", "utf8");

      // Symlink <runDir>/signals → outside dir (escapes the run store)
      await symlink(outsideDir, join(runDir, "signals"));

      const { signals, diagnostics } = await readAllExitSignals(runsRoot, "run-escape");
      // Either rejected signals OR a containment diagnostic
      const hasContainmentDiag = diagnostics.some((d) =>
        d.error.includes("escapes") || d.error.includes("containment")
      );
      // The signals should not be read from outside the run store
      expect(signals.length === 0 || hasContainmentDiag).toBe(true);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

// ─── Concurrent same-kind writers ────────────────────────────────────────────

describe("writeExitSignal — concurrent same-kind writers: first wins", () => {
  it("exactly one of two concurrent writers gets 'created'; the other gets 'already_exists'", async () => {
    const sig = humanSignal("run-conc");
    const [r1, r2] = await Promise.all([
      writeExitSignal(runsRoot, sig),
      writeExitSignal(runsRoot, sig)
    ]);
    const outcomes = [r1, r2].sort();
    expect(outcomes).toEqual(["already_exists", "created"]);
  });
});

// ─── createFileExitSignalSource ──────────────────────────────────────────────

describe("createFileExitSignalSource", () => {
  it("poll returns SignalReadResult including both signals and diagnostics", async () => {
    const source = createFileExitSignalSource(runsRoot);
    await writeExitSignal(runsRoot, humanSignal("run-src"));
    const result = await source.poll("run-src");
    expect(result.signals).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("poll returns empty result when no signals have been written", async () => {
    const source = createFileExitSignalSource(runsRoot);
    const result = await source.poll("no-run");
    expect(result.signals).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
  });
});

// ─── startExitSignalMonitor ──────────────────────────────────────────────────

describe("startExitSignalMonitor", () => {
  it("returns a no-op dispose when source is undefined", () => {
    const controller = new AbortController();
    const dispose = startExitSignalMonitor({
      source: undefined,
      runId: "run-noop",
      controller,
      onSignal: () => undefined,
      onError: () => undefined
    });
    expect(() => dispose()).not.toThrow();
  });

  it("calls onSignal when a new signal appears and aborts the controller", async () => {
    // Real timers: fake timers don't flush real filesystem I/O in Node.js
    const source = createFileExitSignalSource(runsRoot);
    const controller = new AbortController();
    const received: ExitSignalV1[][] = [];
    const errors: Error[] = [];

    const dispose = startExitSignalMonitor({
      source,
      runId: "run-monitor",
      controller,
      pollIntervalMs: 10,
      onSignal: (sigs) => { received.push([...sigs]); },
      onError: (e) => { errors.push(e); }
    });

    await writeExitSignal(runsRoot, humanSignal("run-monitor"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    dispose();

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]![0]!.kind).toBe("human_interrupt");
    expect(controller.signal.aborted).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it("routes diagnostics to onDiagnostic when provided", async () => {
    const { mkdir } = await import("node:fs/promises");
    const sigDir = join(runsRoot, "run-diag", "signals");
    await mkdir(sigDir, { recursive: true });
    await writeFile(join(sigDir, "human_interrupt.json"), "bad-json", "utf8");

    const source = createFileExitSignalSource(runsRoot);
    const controller = new AbortController();
    const diagReceived: unknown[] = [];
    const errors: Error[] = [];

    const dispose = startExitSignalMonitor({
      source,
      runId: "run-diag",
      controller,
      pollIntervalMs: 10,
      onSignal: () => undefined,
      onDiagnostic: (d) => { diagReceived.push(...d); },
      onError: (e) => { errors.push(e); }
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    dispose();

    expect(diagReceived.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(0);
  });

  it("routes diagnostics to onError as SignalDiagnosticError when no onDiagnostic is provided", async () => {
    const { mkdir } = await import("node:fs/promises");
    const sigDir = join(runsRoot, "run-diag2", "signals");
    await mkdir(sigDir, { recursive: true });
    await writeFile(join(sigDir, "human_interrupt.json"), "bad-json", "utf8");

    const source = createFileExitSignalSource(runsRoot);
    const controller = new AbortController();
    const errors: Error[] = [];

    const dispose = startExitSignalMonitor({
      source,
      runId: "run-diag2",
      controller,
      pollIntervalMs: 10,
      onSignal: () => undefined,
      onError: (e) => { errors.push(e); }
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    dispose();

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toBeInstanceOf(SignalDiagnosticError);
    const diagErr = errors[0] as SignalDiagnosticError;
    expect(diagErr.diagnostics.length).toBeGreaterThan(0);
  });

  it("dispose stops polling after it is called", async () => {
    const source = createFileExitSignalSource(runsRoot);
    const controller = new AbortController();
    let callCount = 0;

    const countingSource = {
      poll: async (runId: string) => {
        callCount++;
        return source.poll(runId);
      }
    };

    const dispose = startExitSignalMonitor({
      source: countingSource,
      runId: "run-stop",
      controller,
      pollIntervalMs: 10,
      onSignal: () => undefined,
      onError: () => undefined
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    const countAfterSome = callCount;
    expect(countAfterSome).toBeGreaterThan(0);
    dispose();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(callCount).toBe(countAfterSome);
  });
});

// ─── Signal validation ───────────────────────────────────────────────────────

describe("writeExitSignal — validates signal schema before writing", () => {
  it("rejects a signal with an unknown schemaVersion", async () => {
    const bad = { ...humanSignal("run-val"), schemaVersion: "exit-signal/99" } as unknown as ExitSignalV1;
    await expect(writeExitSignal(runsRoot, bad)).rejects.toThrow(/schema/i);
  });

  it("rejects an external_event signal missing externalEvent evidence", async () => {
    const bad: ExitSignalV1 = {
      schemaVersion: "exit-signal/1",
      runId: "run-val",
      kind: "external_event",
      requestedBy: "test",
      requestedAt: "2025-01-01T00:00:00.000Z"
      // missing externalEvent
    };
    await expect(writeExitSignal(runsRoot, bad)).rejects.toThrow(/externalEvent/);
  });

  it("rejects an external_event with an unknown disposition", async () => {
    const bad: ExitSignalV1 = {
      ...externalSignal("run-val"),
      externalEvent: {
        source: "ci",
        event: "failed",
        disposition: "unknown" as never,
        observedAt: "2025-01-01T00:00:00.000Z"
      }
    };
    await expect(writeExitSignal(runsRoot, bad)).rejects.toThrow(/disposition/i);
  });
});
