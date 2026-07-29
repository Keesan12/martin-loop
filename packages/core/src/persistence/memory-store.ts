// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

/**
 * MartinLoop Memory Store
 *
 * Append-only, never-overwriting persistent memory. Records user consent
 * signals, preferences, behavioral patterns, and learning outcomes so
 * MartinLoop gets smarter with every session.
 *
 * Design principles:
 * - Append-only JSONL — entries are never deleted or overwritten
 * - Structured by kind — each memory entry has a type and a key
 * - Source-aware — distinguishes explicit user input from inferred patterns
 * - Confidence-scored — inferred memories degrade gracefully
 *
 * Storage: <runsRoot>/_martin/memory.jsonl
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type MemoryKind =
  | "consent"      // User approved or denied a governance action
  | "preference"   // User expressed a preference (budget, model, IDE)
  | "pattern"      // Observed behavioral pattern (e.g. always skips gate)
  | "feedback"     // Explicit user feedback on a run outcome
  | "budget"       // Budget preference for a task category
  | "model";       // Model preference for a task type or engine

export interface MemoryEntry {
  /** ISO-8601 timestamp */
  timestamp: string;
  /** What kind of memory this is */
  kind: MemoryKind;
  /** Dot-notated key, e.g. "model.direct.claude", "budget.auth.usd", "gate.bypassed" */
  key: string;
  /** The memory payload */
  value: unknown;
  /** Did the user say it explicitly, or did Martin observe it? */
  source: "explicit" | "inferred";
  /** Confidence score 0-1 — inferred memories should be < 0.8 */
  confidence: number;
}

export interface MemorySummary {
  totalEntries: number;
  byKind: Partial<Record<MemoryKind, MemoryEntry[]>>;
  recentPreferences: MemoryEntry[];
  recentConsents: MemoryEntry[];
  recentFeedback: MemoryEntry[];
}

const MEMORY_DIRECTORY = "_martin";
const MEMORY_FILENAME = "memory.jsonl";

function resolveMemoryPath(runsRoot: string): string {
  return join(resolve(runsRoot), MEMORY_DIRECTORY, MEMORY_FILENAME);
}

/**
 * Append a memory entry. Never overwrites — always appends.
 */
export async function appendMemory(runsRoot: string, entry: MemoryEntry): Promise<void> {
  const memPath = resolveMemoryPath(runsRoot);
  await mkdir(join(resolve(runsRoot), MEMORY_DIRECTORY), { recursive: true });
  await appendFile(memPath, JSON.stringify(entry) + "\n", "utf8");
}

/**
 * Read all memory entries in order (oldest first).
 */
export async function readMemoryEntries(runsRoot: string): Promise<MemoryEntry[]> {
  const memPath = resolveMemoryPath(runsRoot);
  try {
    const raw = await readFile(memPath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as MemoryEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is MemoryEntry => e !== null);
  } catch {
    return [];
  }
}

/**
 * Get the most recent memory entry for a specific key.
 * Returns undefined if no entry exists for that key.
 */
export async function getPreference(runsRoot: string, key: string): Promise<MemoryEntry | undefined> {
  const entries = await readMemoryEntries(runsRoot);
  // Return the most recent entry for this key (last in file)
  const matches = entries.filter((e) => e.key === key);
  return matches[matches.length - 1];
}

/**
 * Build a summary of memory entries for MCP resource and MartinLoop context injection.
 * Returns the top 20 most recent entries per kind.
 */
export function buildMemorySummary(entries: MemoryEntry[]): MemorySummary {
  const byKind: Partial<Record<MemoryKind, MemoryEntry[]>> = {};

  for (const entry of entries) {
    if (!byKind[entry.kind]) {
      byKind[entry.kind] = [];
    }
    byKind[entry.kind]!.push(entry);
  }

  // Keep only the 20 most recent per kind
  for (const kind of Object.keys(byKind) as MemoryKind[]) {
    byKind[kind] = byKind[kind]!.slice(-20);
  }

  const recent = entries.slice(-50);

  return {
    totalEntries: entries.length,
    byKind,
    recentPreferences: recent.filter((e) => e.kind === "preference"),
    recentConsents: recent.filter((e) => e.kind === "consent"),
    recentFeedback: recent.filter((e) => e.kind === "feedback")
  };
}

/**
 * Record a preference from user input.
 */
export async function recordPreference(
  runsRoot: string,
  key: string,
  value: unknown,
  source: "explicit" | "inferred" = "explicit"
): Promise<void> {
  await appendMemory(runsRoot, {
    timestamp: new Date().toISOString(),
    kind: "preference",
    key,
    value,
    source,
    confidence: source === "explicit" ? 1.0 : 0.6
  });
}

/**
 * Record a consent signal (user approved or denied a governance action).
 */
export async function recordConsent(
  runsRoot: string,
  action: string,
  approved: boolean,
  context?: Record<string, unknown>
): Promise<void> {
  await appendMemory(runsRoot, {
    timestamp: new Date().toISOString(),
    kind: "consent",
    key: `consent.${action}`,
    value: { approved, context },
    source: "explicit",
    confidence: 1.0
  });
}
