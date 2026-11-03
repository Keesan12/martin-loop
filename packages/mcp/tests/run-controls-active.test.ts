import { link, mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { acquireRunExecutionLease, readExitSignal, writeExitSignal } from "@martin/core";
import { afterEach, describe, expect, it } from "vitest";

import { getStatusTool } from "../src/tools/get-status.js";
import { martinLogsTool } from "../src/tools/logs.js";
import {
  createFileRunControlSource,
  createRunControlReceipt as createRawRunControlReceipt,
  readRunControlState
} from "../src/tools/run-controls.js";

type ControlInput = Parameters<typeof createRawRunControlReceipt>[1];
type ControlHooks = Parameters<typeof createRawRunControlReceipt>[2];
const createRunControlReceipt = (
  action: Parameters<typeof createRawRunControlReceipt>[0],
  input: ControlInput,
  hooks?: ControlHooks
) => createRawRunControlReceipt(
  action,
  { ...input, authority: { transport: "local_stdio" } },
  hooks
);

const roots: string[] = [];
const executionLeases: Array<Awaited<ReturnType<typeof acquireRunExecutionLease>>> = [];
const originalRunsDir = process.env.MARTIN_RUNS_DIR;

afterEach(async () => {
  if (originalRunsDir === undefined) delete process.env.MARTIN_RUNS_DIR;
  else process.env.MARTIN_RUNS_DIR = originalRunsDir;
  await Promise.all(executionLeases.splice(0).map((lease) => lease.release()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeLoopRecord(
  overrides: Partial<{ loopId: string; status: string; lifecycleState: string }> = {},
  options: { withLease?: boolean } = {}
): Promise<{ runsRoot: string; loopId: string }> {
  const runsRoot = await mkdtemp(path.join(os.tmpdir(), "martin-mcp-active-controls-"));
  roots.push(runsRoot);
  const loopId = overrides.loopId ?? "loop_active_control";
  const runDirectory = path.join(runsRoot, loopId);
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    path.join(runDirectory, "loop-record.json"),
    `${JSON.stringify({
      loopId,
      status: overrides.status ?? "running",
      lifecycleState: overrides.lifecycleState ?? "running",
      createdAt: "2026-10-29T12:00:00.000Z",
      updatedAt: "2026-10-29T12:00:00.000Z",
      budget: { maxUsd: 1, softLimitUsd: 0.8, maxIterations: 2 },
      cost: { actualUsd: 0, avoidedUsd: 0, tokensIn: 0, tokensOut: 0 },
      attempts: [],
      events: []
    })}\n`,
    "utf8"
  );
  if (options.withLease !== false) {
    executionLeases.push(await acquireRunExecutionLease({
      runsRoot,
      runId: loopId,
      owner: "runMartin",
      runControlCapable: true
    }));
  }
  return { runsRoot, loopId };
}

describe("active MCP run controls", () => {
  it("rejects controls from an untrusted remote transport", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_remote_rejected" });
    process.env.MARTIN_RUNS_DIR = runsRoot;

    await expect(
      createRawRunControlReceipt("pause", {
        loopId,
        authority: { transport: "untrusted_remote" }
      })
    ).rejects.toThrow(/local stdio/iu);
  });

  it("rejects controls when no live capable executor lease exists", async () => {
    const { runsRoot, loopId } = await writeLoopRecord(
      { loopId: "loop_without_executor" },
      { withLease: false }
    );
    process.env.MARTIN_RUNS_DIR = runsRoot;

    await expect(
      createRunControlReceipt("pause", {
        loopId,
        authority: { transport: "local_stdio" }
      })
    ).rejects.toThrow(/control-capable executor lease/iu);
  });

  it("rejects a live runMartin lease that did not install a run-control poller", async () => {
    const { runsRoot, loopId } = await writeLoopRecord(
      { loopId: "loop_executor_without_control_poller" },
      { withLease: false }
    );
    executionLeases.push(await acquireRunExecutionLease({
      runsRoot,
      runId: loopId,
      owner: "runMartin"
    }));
    process.env.MARTIN_RUNS_DIR = runsRoot;

    await expect(createRunControlReceipt("pause", { loopId })).rejects.toThrow(
      /control-capable executor lease/iu
    );
  });

  it("reloads lifecycle under the control lock so terminal state wins", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_terminal_race" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    const recordPath = path.join(runsRoot, loopId, "loop-record.json");

    await expect(
      createRunControlReceipt(
        "pause",
        { loopId, authority: { transport: "local_stdio" } },
        {
          beforeLockedReload: async () => {
            const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
            await writeFile(
              recordPath,
              `${JSON.stringify({ ...record, status: "completed", lifecycleState: "completed" })}\n`,
              "utf8"
            );
          }
        }
      )
    ).rejects.toThrow(/already terminal/iu);
    await expect(readFile(path.join(runsRoot, loopId, "controls.jsonl"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes terminal intent with control admission before loop persistence", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_terminal_intent" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    const source = createFileRunControlSource(runsRoot);

    await source.recordTerminalIntent?.(loopId);
    await expect(createRunControlReceipt("pause", { loopId })).rejects.toThrow(/entering terminal/iu);
    const state = await readRunControlState({ loopId });
    expect(state.requestedState).toBe("terminal");
    expect(state.appliedState).toBe("terminal");
    await expect(readFile(path.join(runsRoot, loopId, "controls.jsonl"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("orders an in-flight control append before terminal intent without permitting a later append", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_terminal_append_race" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    const source = createFileRunControlSource(runsRoot);
    let releaseAppend!: () => void;
    let markAppendOpen!: () => void;
    const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
    const appendOpen = new Promise<void>((resolve) => { markAppendOpen = resolve; });
    const pausePromise = createRunControlReceipt("pause", { loopId }, {
      afterJournalOpen: async (journalPath) => {
        if (path.basename(journalPath) !== "controls.jsonl") return;
        markAppendOpen();
        await appendGate;
      }
    });

    await appendOpen;
    const terminalPromise = source.recordTerminalIntent?.(loopId);
    releaseAppend();
    const pause = await pausePromise;
    await terminalPromise;

    await expect(createRunControlReceipt("continue", { loopId }))
      .rejects.toThrow(/entering terminal/iu);
    const state = await readRunControlState({ loopId });
    expect(state.requestedState).toBe("terminal");
    expect(state.receipts).toEqual([expect.objectContaining({ controlId: pause.controlId })]);
  });

  it("rejects a junction or symlink in place of the run directory", async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), "martin-mcp-linked-parent-"));
    const target = await mkdtemp(path.join(os.tmpdir(), "martin-mcp-linked-target-"));
    roots.push(runsRoot, target);
    const loopId = "loop_linked_parent";
    await symlink(target, path.join(runsRoot, loopId), process.platform === "win32" ? "junction" : "dir");

    await expect(createFileRunControlSource(runsRoot).poll(loopId)).rejects.toThrow(
      "Run control receipt integrity check failed."
    );
  });

  it("allows a canonical run leaf beneath a platform-canonicalized ancestor", async () => {
    const container = await mkdtemp(path.join(os.tmpdir(), "martin-mcp-canonical-ancestor-"));
    roots.push(container);
    const target = path.join(container, "target");
    const alias = path.join(container, "alias");
    const runsRoot = path.join(alias, "runs");
    const loopId = "loop_canonical_ancestor";
    await mkdir(path.join(target, "runs", loopId), { recursive: true });
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");

    await expect(createFileRunControlSource(runsRoot).poll(loopId)).resolves.toEqual({});
  });

  it("rejects hard-linked journal leaves", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_hardlink_journal" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    await createRunControlReceipt("pause", { loopId });
    const controlsPath = path.join(runsRoot, loopId, "controls.jsonl");
    await link(controlsPath, path.join(runsRoot, loopId, "controls-alias.jsonl"));

    await expect(readRunControlState({ loopId })).rejects.toThrow(/integrity|Unable to read Martin runs store/iu);
  });

  it("rejects writes through a hard-linked application journal", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_hardlink_application" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    const source = createFileRunControlSource(runsRoot);
    const pause = await createRunControlReceipt("pause", { loopId });
    await source.recordApplication({
      loopId,
      controlId: pause.controlId,
      action: "pause_applied",
      appliedAt: new Date(Date.parse(pause.requestedAt) + 1_000).toISOString(),
      receiptHash: pause.receiptHash
    });
    const continued = await createRunControlReceipt("continue", { loopId });
    const applicationPath = path.join(runsRoot, loopId, "control-applications.jsonl");
    await link(applicationPath, path.join(runsRoot, loopId, "applications-alias.jsonl"));

    await expect(source.recordApplication({
      loopId,
      controlId: continued.controlId,
      action: "continue_applied",
      relatedControlId: pause.controlId,
      appliedAt: new Date(Date.parse(continued.requestedAt) + 1_000).toISOString(),
      receiptHash: continued.receiptHash
    })).rejects.toThrow(/integrity|Unable to read Martin runs store/iu);
  });

  it("detects journal replacement after the no-follow handle is opened", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_replace_race" });
    process.env.MARTIN_RUNS_DIR = runsRoot;

    await expect(
      createRunControlReceipt("pause", { loopId }, {
        afterJournalOpen: async (journalPath) => {
          if (path.basename(journalPath) !== "controls.jsonl") return;
          await rename(journalPath, `${journalPath}.moved`);
          await writeFile(journalPath, "", "utf8");
        }
      })
    ).rejects.toThrow("Run control receipt integrity check failed.");
  });

  it("never steals a lock held by a live owner solely because it is old", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_live_lock" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    const old = "2020-01-01T00:00:00.000Z";
    await writeFile(
      path.join(runsRoot, loopId, ".run-control.lock"),
      `${JSON.stringify({
        schemaVersion: "martin.run-control-lock.v1",
        token: "live-owner-token",
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: old,
        heartbeatAt: old
      })}\n`,
      "utf8"
    );

    await expect(
      createRunControlReceipt("pause", { loopId }, { lockMaxRetries: 2 })
    ).rejects.toThrow(/busy/iu);
  });

  it("atomically elects one reclaimer for a dead stale lock", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_dead_lock_race" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    const old = "2020-01-01T00:00:00.000Z";
    await writeFile(path.join(runsRoot, loopId, ".run-control.lock"), `${JSON.stringify({
      schemaVersion: "martin.run-control-lock.v1",
      token: "dead-owner-token",
      pid: 2_147_483_647,
      hostname: os.hostname(),
      acquiredAt: old,
      heartbeatAt: old
    })}\n`, "utf8");

    const outcomes = await Promise.allSettled([
      createRunControlReceipt("pause", { loopId }),
      createRunControlReceipt("pause", { loopId })
    ]);
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
    const state = await readRunControlState({ loopId });
    expect(state.receipts).toHaveLength(1);
    expect(state.requestedState).toBe("paused");
  });

  it("heartbeats the nonce-owned lock while a control transaction is active", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_lock_heartbeat" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    let releaseGate!: () => void;
    let markEntered!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const pending = createRunControlReceipt("pause", { loopId }, {
      beforeLockedReload: async () => {
        markEntered();
        await gate;
      }
    });
    const lockPath = path.join(runsRoot, loopId, ".run-control.lock");

    try {
      await entered;
      const initial = JSON.parse(await readFile(lockPath, "utf8")) as { token: string; heartbeatAt: string };
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      let refreshed: { token: string; heartbeatAt: string } | undefined;
      for (let attempt = 0; attempt < 10 && !refreshed; attempt += 1) {
        try {
          const raw = await readFile(lockPath, "utf8");
          if (raw.trim()) refreshed = JSON.parse(raw) as { token: string; heartbeatAt: string };
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(refreshed?.token).toBe(initial.token);
      expect(Date.parse(refreshed?.heartbeatAt ?? "")).toBeGreaterThan(Date.parse(initial.heartbeatAt));
    } finally {
      releaseGate();
      await pending;
    }
  });

  it("reports a live cancellation signal as audit-pending and repairs it on retry", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_cancel_recovery" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    const first = await createRunControlReceipt("cancel", { loopId }, {
      afterJournalOpen: async (journalPath) => {
        if (path.basename(journalPath) === "control-publications.jsonl") {
          throw new Error("simulated audit write failure");
        }
      }
    });
    expect(first.publicationState).toBe("published_audit_pending");
    expect(await readExitSignal(runsRoot, loopId, "human_interrupt")).toBeDefined();

    const repaired = await createRunControlReceipt("cancel", { loopId });
    expect(repaired.controlId).toBe(first.controlId);
    expect(repaired.publicationState).toBe("already_requested");
    expect(repaired.state.publications).toHaveLength(1);
  });

  it("repairs a missing canonical signal from its bound cancellation publication", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_cancel_signal_repair" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    const first = await createRunControlReceipt("cancel", { loopId, reason: "stop now" });
    await unlink(path.join(runsRoot, loopId, "signals", "human_interrupt.json"));

    const repaired = await createRunControlReceipt("cancel", { loopId });
    expect(repaired.controlId).toBe(first.controlId);
    expect(repaired.publicationState).toBe("already_requested");
    expect(await readExitSignal(runsRoot, loopId, "human_interrupt")).toMatchObject({
      requestedAt: first.requestedAt,
      reason: "stop now"
    });
  });

  it("fails closed when an existing cancellation publication conflicts with canonical signal truth", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_cancel_signal_conflict" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    const first = await createRunControlReceipt("cancel", { loopId, reason: "first" });
    await unlink(path.join(runsRoot, loopId, "signals", "human_interrupt.json"));
    await writeExitSignal(runsRoot, {
      schemaVersion: "exit-signal/1",
      kind: "human_interrupt",
      runId: loopId,
      requestedAt: new Date(Date.parse(first.requestedAt) + 1_000).toISOString(),
      requestedBy: "external",
      reason: "conflict"
    });

    await expect(createRunControlReceipt("cancel", { loopId }))
      .rejects.toThrow(/integrity/iu);
  });

  it("rejects a cancellation publication that is not hash-bound to its receipt", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_cancel_publication_binding" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    await createRunControlReceipt("cancel", { loopId });
    const publicationPath = path.join(runsRoot, loopId, "control-publications.jsonl");
    const publication = JSON.parse(await readFile(publicationPath, "utf8")) as Record<string, unknown>;
    publication.receiptHash = "0".repeat(64);
    await writeFile(publicationPath, `${JSON.stringify(publication)}\n`, "utf8");

    await expect(readRunControlState({ loopId })).rejects.toThrow(/integrity/iu);
  });

  it("publishes a canonical human interrupt when cancellation is requested", async () => {
    const { runsRoot, loopId } = await writeLoopRecord();
    process.env.MARTIN_RUNS_DIR = runsRoot;

    const result = await createRunControlReceipt("cancel", {
      loopId,
      reason: "operator requested stop"
    });

    const signal = await readExitSignal(runsRoot, loopId, "human_interrupt");
    expect(signal).toMatchObject({
      schemaVersion: "exit-signal/1",
      kind: "human_interrupt",
      runId: loopId,
      reason: "operator requested stop",
      requestedBy: "local_mcp_client"
    });
    expect(result.publicationState).toBe("published");
    expect(result.applicationState).toBe("pending_observation");

    const stored = JSON.parse(
      await readFile(path.join(runsRoot, loopId, "signals", "human_interrupt.json"), "utf8")
    ) as { runId: string };
    expect(stored.runId).toBe(loopId);
  });

  it("reconciles a pending cancellation to terminal when run evidence becomes terminal", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_cancel_terminal_reconcile" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    await createRunControlReceipt("cancel", { loopId });
    const recordPath = path.join(runsRoot, loopId, "loop-record.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      recordPath,
      `${JSON.stringify({
        ...record,
        status: "cancelled",
        lifecycleState: "cancelled",
        updatedAt: "2026-10-29T12:00:02.000Z"
      })}\n`,
      "utf8"
    );

    const state = await readRunControlState({ loopId });
    expect(state.requestedState).toBe("terminal");
    expect(state.appliedState).toBe("terminal");
    expect(state.receipts).toHaveLength(1);
    expect(state.publications).toHaveLength(1);
  });

  it("rejects cancellation for an already terminal run without publishing a signal", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({
      loopId: "loop_terminal_control",
      status: "completed",
      lifecycleState: "completed"
    });
    process.env.MARTIN_RUNS_DIR = runsRoot;

    await expect(
      createRunControlReceipt("cancel", {
        loopId,
        reason: "too late"
      })
    ).rejects.toThrow(/already terminal/iu);

    expect(await readExitSignal(runsRoot, loopId, "human_interrupt")).toBeUndefined();
  });

  it("treats repeated cancellation as idempotent and preserves the first signal", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_duplicate_cancel" });
    process.env.MARTIN_RUNS_DIR = runsRoot;

    const first = await createRunControlReceipt("cancel", {
      loopId,
      reason: "first request"
    });
    const second = await createRunControlReceipt("cancel", {
      loopId,
      reason: "second request"
    });

    expect(first.publicationState).toBe("published");
    expect(second.publicationState).toBe("already_requested");
    expect(second.controlId).toBe(first.controlId);
    expect(second.state.receipts).toHaveLength(1);
    expect(await readExitSignal(runsRoot, loopId, "human_interrupt")).toMatchObject({
      reason: "first request",
      requestedBy: "local_mcp_client"
    });
  });

  it("binds continue to the exact pause it releases", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_pause_cas" });
    process.env.MARTIN_RUNS_DIR = runsRoot;

    const paused = await createRunControlReceipt("pause", {
      loopId,
      reason: "review requested"
    });
    const continued = await createRunControlReceipt("continue", {
      loopId,
      reason: "review complete"
    });

    expect(continued.state.latestReceipt).toMatchObject({
      action: "continue",
      expectedPreviousControlId: paused.controlId
    });

    await expect(
      createRunControlReceipt("continue", { loopId })
    ).rejects.toThrow(/pending pause/iu);
  });

  it("serializes concurrent pause requests so only one receipt is accepted", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_concurrent_pause" });
    process.env.MARTIN_RUNS_DIR = runsRoot;

    const outcomes = await Promise.allSettled([
      createRunControlReceipt("pause", { loopId }),
      createRunControlReceipt("pause", { loopId })
    ]);
    const state = await readRunControlState({ loopId });

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { message: expect.stringMatching(/pending pause/iu) }
    });
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]?.action).toBe("pause");
  });

  it("serializes concurrent continue requests against the same pause predecessor", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_concurrent_continue" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    const pause = await createRunControlReceipt("pause", { loopId });

    const outcomes = await Promise.allSettled([
      createRunControlReceipt("continue", { loopId }),
      createRunControlReceipt("continue", { loopId })
    ]);
    const state = await readRunControlState({ loopId });

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { message: expect.stringMatching(/pending pause/iu) }
    });
    expect(state.receipts).toHaveLength(2);
    expect(state.latestReceipt).toMatchObject({
      action: "continue",
      expectedPreviousControlId: pause.controlId
    });
  });

  it("distinguishes a requested pause from a pause applied by the executor", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_applied_pause" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    const pause = await createRunControlReceipt("pause", { loopId });

    expect(pause.state.requestedState).toBe("paused");
    expect(pause.state.appliedState).toBe("active");

    const source = createFileRunControlSource(runsRoot);
    await source.recordApplication({
      loopId,
      controlId: pause.controlId,
      action: "pause_applied",
      appliedAt: new Date(Date.parse(pause.requestedAt) + 1_000).toISOString(),
      receiptHash: pause.receiptHash
    });

    await expect(readRunControlState({ loopId })).resolves.toMatchObject({
      requestedState: "paused",
      appliedState: "paused"
    });
    await expect(martinLogsTool({ loopId })).resolves.toMatchObject({
      live: {
        requestedControlState: "paused",
        appliedControlState: "paused",
        pauseState: "paused"
      },
      entries: expect.arrayContaining([
        expect.objectContaining({
          source: "control",
          kind: "run.pause_applied",
          payload: { controlId: pause.controlId }
        })
      ])
    });
  });

  it("reports requested and applied control state separately without claiming a pending pause is applied", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_status_pending_pause" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    await createRunControlReceipt("pause", { loopId });

    const status = await getStatusTool({ loopId });
    const logs = await martinLogsTool({ loopId });

    expect(status.live).toMatchObject({
      requestedControlState: "paused",
      appliedControlState: "active"
    });
    expect(status.live).not.toHaveProperty("pauseState", "paused");
    expect(logs.live).toMatchObject({
      requestedControlState: "paused",
      appliedControlState: "active",
      pauseState: "active"
    });
  });

  it("fails closed when an application claims a control receipt that does not exist", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_forged_application" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    const pause = await createRunControlReceipt("pause", { loopId });
    await writeFile(
      path.join(runsRoot, loopId, "control-applications.jsonl"),
      `${JSON.stringify({
        loopId,
        controlId: "ctl_forged",
        action: "pause_applied",
        appliedAt: new Date(Date.parse(pause.requestedAt) + 1_000).toISOString()
      })}\n`,
      "utf8"
    );

    await expect(readRunControlState({ loopId })).rejects.toThrow(
      "Run control receipt integrity check failed."
    );
  });

  it("does not mutate the control journal when existing application history is corrupt", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_corrupt_history_no_write" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    const pause = await createRunControlReceipt("pause", { loopId });
    const controlsPath = path.join(runsRoot, loopId, "controls.jsonl");
    await writeFile(
      path.join(runsRoot, loopId, "control-applications.jsonl"),
      `${JSON.stringify({
        loopId,
        controlId: "ctl_forged",
        action: "pause_applied",
        appliedAt: new Date(Date.parse(pause.requestedAt) + 1_000).toISOString()
      })}\n`,
      "utf8"
    );
    const before = await readFile(controlsPath, "utf8");

    await expect(
      createRunControlReceipt("continue", { loopId })
    ).rejects.toThrow("Run control receipt integrity check failed.");

    expect(await readFile(controlsPath, "utf8")).toBe(before);
  });

  it("fails closed when continue application evidence is not bound to its applied pause", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_mismatched_application" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    const pause = await createRunControlReceipt("pause", { loopId });
    const continued = await createRunControlReceipt("continue", { loopId });
    const pauseAppliedAt = new Date(Date.parse(continued.requestedAt) + 1_000).toISOString();
    const continueAppliedAt = new Date(Date.parse(continued.requestedAt) + 2_000).toISOString();
    await writeFile(
      path.join(runsRoot, loopId, "control-applications.jsonl"),
      [
        JSON.stringify({
          loopId,
          controlId: pause.controlId,
          action: "pause_applied",
          appliedAt: pauseAppliedAt
        }),
        JSON.stringify({
          loopId,
          controlId: continued.controlId,
          action: "continue_applied",
          relatedControlId: "ctl_other_pause",
          appliedAt: continueAppliedAt
        })
      ].join("\n") + "\n",
      "utf8"
    );

    await expect(readRunControlState({ loopId })).rejects.toThrow(
      "Run control receipt integrity check failed."
    );
  });

  it("fails closed when a pause is claimed applied after its matching continue was requested", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_stale_pause_application" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    const pause = await createRunControlReceipt("pause", { loopId });
    const continued = await createRunControlReceipt("continue", { loopId });
    await writeFile(
      path.join(runsRoot, loopId, "control-applications.jsonl"),
      `${JSON.stringify({
        loopId,
        controlId: pause.controlId,
        action: "pause_applied",
        appliedAt: new Date(Date.parse(continued.requestedAt) + 1_000).toISOString()
      })}\n`,
      "utf8"
    );

    await expect(readRunControlState({ loopId })).rejects.toThrow(
      "Run control receipt integrity check failed."
    );
  });

  it("does not replace an applied pause until its matching continue is applied", async () => {
    const { runsRoot, loopId } = await writeLoopRecord({ loopId: "loop_pause_release_cas" });
    process.env.MARTIN_RUNS_DIR = runsRoot;
    const source = createFileRunControlSource(runsRoot);
    const pause = await createRunControlReceipt("pause", { loopId });
    const pauseAppliedAt = new Date(Date.parse(pause.requestedAt) + 1_000).toISOString();
    await source.recordApplication({
      loopId,
      controlId: pause.controlId,
      action: "pause_applied",
      appliedAt: pauseAppliedAt,
      receiptHash: pause.receiptHash
    });
    const continued = await createRunControlReceipt("continue", { loopId });

    await expect(
      createRunControlReceipt("pause", { loopId })
    ).rejects.toThrow(/still applied/iu);

    await source.recordApplication({
      loopId,
      controlId: continued.controlId,
      action: "continue_applied",
      relatedControlId: pause.controlId,
      appliedAt: new Date(Date.parse(continued.requestedAt) + 2_000).toISOString(),
      receiptHash: continued.receiptHash
    });
    await expect(
      createRunControlReceipt("pause", { loopId })
    ).resolves.toMatchObject({ requestedAction: "pause" });
  });
});
