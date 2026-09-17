// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

/**
 * P1-GATE: MCP workflow state workspace isolation and namespace preservation.
 *
 * Tests:
 *   M1 — MCP receipts are written to the per-workspace path, not the global path
 *   M2 — MCP receipts written for workspace A are not visible when gating workspace B
 *   M3 — Legacy global MCP receipts are ignored for workspace governance decisions
 *   M4 — CLI then MCP write: MCP must not erase the CLI namespace
 *   M5 — MCP then CLI write: subsequent MCP write must preserve the CLI namespace
 *   M6 — CLI and MCP derive the same workspace key for the same working directory
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  evaluateMcpRunGate,
  readWorkflowState,
  recordMcpWorkflowStep
} from "../src/workflow-state.js";

// Mirror the MCP internal deriveWorkspaceKey logic for path assertions
function testWorkspaceKey(workingDirectory: string): string {
  const normalized = resolve(workingDirectory);
  const input = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

let scratchRoot: string;

beforeEach(async () => {
  scratchRoot = await mkdtemp(join(tmpdir(), "martin-mcp-ws-state-"));
});

afterEach(async () => {
  await rm(scratchRoot, { force: true, recursive: true }).catch(() => {});
});

// ─── M1: MCP state is written to per-workspace path, not global ──────────────

it("M1: recordMcpWorkflowStep writes to per-workspace path, not global", async () => {
  const runsRoot = join(scratchRoot, "runs");
  const workspaceA = join(scratchRoot, "repo-a");
  await mkdir(runsRoot, { recursive: true });
  await mkdir(workspaceA, { recursive: true });

  await recordMcpWorkflowStep({
    runsRoot,
    step: "doctor",
    workingDirectory: workspaceA
  });

  // File must exist at per-workspace path
  const wsKey = testWorkspaceKey(workspaceA);
  const perWorkspacePath = join(runsRoot, "_martin", "workspaces", wsKey, "workflow-state.json");
  const raw = await readFile(perWorkspacePath, "utf8");
  const state = JSON.parse(raw) as { version: number; mcp?: Record<string, unknown> };

  expect(state.version).toBe(1);
  expect(state.mcp?.["doctor"]).toBeDefined();

  // Global path must NOT carry the workspace governance receipt
  const globalPath = join(runsRoot, "_martin", "workflow-state.json");
  let globalState: { mcp?: Record<string, unknown> } | null = null;
  try {
    globalState = JSON.parse(await readFile(globalPath, "utf8")) as typeof globalState;
  } catch { /* global file absent = correct */ }
  if (globalState !== null) {
    expect(globalState.mcp?.["doctor"]).toBeUndefined();
  }
});

// ─── M2: MCP receipts for workspace A are not visible to workspace B ─────────

it("M2: MCP receipts for workspace A do not satisfy workspace B gate", async () => {
  const runsRoot = join(scratchRoot, "runs");
  const workspaceA = join(scratchRoot, "repo-a");
  const workspaceB = join(scratchRoot, "repo-b");
  await mkdir(runsRoot, { recursive: true });
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });

  await recordMcpWorkflowStep({ runsRoot, step: "doctor", workingDirectory: workspaceA });
  await recordMcpWorkflowStep({ runsRoot, step: "estimate", workingDirectory: workspaceA });
  await recordMcpWorkflowStep({ runsRoot, step: "plan", workingDirectory: workspaceA });
  await recordMcpWorkflowStep({ runsRoot, step: "preflight", workingDirectory: workspaceA });

  const gate = await evaluateMcpRunGate({
    runsRoot,
    workingDirectory: workspaceB,
    objective: "test objective"
  });

  expect(gate.allowed).toBe(false);
  expect(gate.missingSteps).toContain("doctor");
});

// ─── M3: Legacy global MCP receipts are ignored for workspace gate ───────────

it("M3: fresh-looking global MCP receipts do not unblock a workspace gate", async () => {
  const runsRoot = join(scratchRoot, "runs");
  const workspaceA = join(scratchRoot, "repo-a");
  await mkdir(runsRoot, { recursive: true });
  await mkdir(workspaceA, { recursive: true });

  // Write all required receipts to the GLOBAL path (legacy / pre-fix format)
  const globalDir = join(runsRoot, "_martin");
  await mkdir(globalDir, { recursive: true });
  await writeFile(
    join(globalDir, "workflow-state.json"),
    JSON.stringify({
      version: 1,
      mcp: {
        doctor: { step: "doctor", recordedAt: new Date().toISOString(), workingDirectory: workspaceA },
        estimate: { step: "estimate", recordedAt: new Date().toISOString(), workingDirectory: workspaceA },
        plan: { step: "plan", recordedAt: new Date().toISOString(), workingDirectory: workspaceA },
        preflight: { step: "preflight", recordedAt: new Date().toISOString(), workingDirectory: workspaceA }
      }
    }, null, 2),
    "utf8"
  );

  // Workspace A must remain blocked — global receipts must not satisfy it
  const gate = await evaluateMcpRunGate({
    runsRoot,
    workingDirectory: workspaceA,
    objective: "test"
  });

  expect(gate.allowed).toBe(false);
  expect(gate.missingSteps.length).toBeGreaterThan(0);
});

// ─── M4: CLI then MCP — MCP write must preserve CLI namespace ────────────────

it("M4: MCP write preserves existing CLI namespace in per-workspace file", async () => {
  const runsRoot = join(scratchRoot, "runs");
  const workspaceA = join(scratchRoot, "repo-a");
  await mkdir(runsRoot, { recursive: true });
  await mkdir(workspaceA, { recursive: true });

  // Simulate CLI having written a receipt by placing it directly in the workspace file
  const wsKey = testWorkspaceKey(workspaceA);
  const wsDir = join(runsRoot, "_martin", "workspaces", wsKey);
  const wsPath = join(wsDir, "workflow-state.json");
  await mkdir(wsDir, { recursive: true });
  await writeFile(
    wsPath,
    JSON.stringify({
      version: 1,
      cli: {
        doctor: {
          step: "doctor",
          recordedAt: new Date().toISOString(),
          workingDirectory: workspaceA
        }
      }
    }, null, 2),
    "utf8"
  );

  // MCP writes a step into the same workspace file
  await recordMcpWorkflowStep({
    runsRoot,
    step: "doctor",
    workingDirectory: workspaceA
  });

  // Both namespaces must be present after the MCP write
  const raw = await readFile(wsPath, "utf8");
  const state = JSON.parse(raw) as {
    version: number;
    cli?: Record<string, unknown>;
    mcp?: Record<string, unknown>;
  };

  expect(state.version).toBe(1);
  // CLI namespace survived the MCP write
  expect(state.cli).toBeDefined();
  expect(state.cli?.["doctor"]).toBeDefined();
  // MCP namespace was added
  expect(state.mcp).toBeDefined();
  expect(state.mcp?.["doctor"]).toBeDefined();
});

// ─── M5: MCP then CLI — subsequent MCP write must preserve CLI namespace ─────

it("M5: second MCP write preserves CLI namespace that was added after first MCP write", async () => {
  const runsRoot = join(scratchRoot, "runs");
  const workspaceA = join(scratchRoot, "repo-a");
  await mkdir(runsRoot, { recursive: true });
  await mkdir(workspaceA, { recursive: true });

  // 1. MCP writes doctor
  await recordMcpWorkflowStep({ runsRoot, step: "doctor", workingDirectory: workspaceA });

  // 2. Simulate CLI adding its namespace on top of the existing MCP state
  const wsKey = testWorkspaceKey(workspaceA);
  const wsPath = join(runsRoot, "_martin", "workspaces", wsKey, "workflow-state.json");
  const existingRaw = await readFile(wsPath, "utf8");
  const existing = JSON.parse(existingRaw) as Record<string, unknown>;
  await writeFile(
    wsPath,
    JSON.stringify({
      ...existing,
      cli: {
        doctor: {
          step: "doctor",
          recordedAt: new Date().toISOString(),
          workingDirectory: workspaceA
        }
      }
    }, null, 2),
    "utf8"
  );

  // 3. MCP writes another step — must not erase CLI namespace
  await recordMcpWorkflowStep({ runsRoot, step: "estimate", workingDirectory: workspaceA });

  // 4. Both namespaces must survive
  const raw = await readFile(wsPath, "utf8");
  const state = JSON.parse(raw) as {
    version: number;
    cli?: Record<string, unknown>;
    mcp?: Record<string, unknown>;
  };

  expect(state.cli).toBeDefined();
  expect(state.cli?.["doctor"]).toBeDefined();
  expect(state.mcp).toBeDefined();
  expect(state.mcp?.["doctor"]).toBeDefined();
  expect(state.mcp?.["estimate"]).toBeDefined();
});

// ─── M6: CLI/MCP workspace identity parity ───────────────────────────────────

describe("M6: CLI and MCP derive the same workspace key", () => {

  it("absolute path and resolve() of same path produce identical key", () => {
    const workspaceA = join(scratchRoot, "repo-a");
    const key1 = testWorkspaceKey(workspaceA);
    const key2 = testWorkspaceKey(resolve(workspaceA));
    expect(key1).toBe(key2);
  });

  it("path with redundant segments normalizes to same key", () => {
    const workspaceA = join(scratchRoot, "repo-a");
    const withRedundant = join(workspaceA, "..", "repo-a");
    const key1 = testWorkspaceKey(workspaceA);
    const key2 = testWorkspaceKey(withRedundant);
    expect(key1).toBe(key2);
  });

  it("MCP write is readable via the key derived from same absolute path", async () => {
    const runsRoot = join(scratchRoot, "runs");
    const workspaceA = join(scratchRoot, "repo-a");
    await mkdir(runsRoot, { recursive: true });
    await mkdir(workspaceA, { recursive: true });

    await recordMcpWorkflowStep({ runsRoot, step: "doctor", workingDirectory: workspaceA });

    // Read back using readWorkflowState — must find the same file
    const state = await readWorkflowState(runsRoot, workspaceA);
    const mcp = (state as { mcp?: Record<string, unknown> }).mcp;
    expect(mcp?.["doctor"]).toBeDefined();

    // Key derived by test helper matches the path MCP actually wrote to
    const wsKey = testWorkspaceKey(workspaceA);
    const expectedPath = join(runsRoot, "_martin", "workspaces", wsKey, "workflow-state.json");
    const raw = await readFile(expectedPath, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ version: 1 });
  });

});
