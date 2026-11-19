import type { MartinOutputMode } from "@martin/contracts";

import { CliCommandError, renderCliSuccess } from "./ux.js";

export type MemoryLifecycleState = "candidate" | "active" | "revoked" | "expired" | "corrupt" | "unreadable";
export type MemorySelector = { memoryId: string } | { latest: true };

export interface MemoryCommandRequest {
  selector?: MemorySelector;
  runsDir?: string;
  state?: MemoryLifecycleState;
  reason?: string;
  hostApprovalPath?: string;
}

export type ParsedMemoryCommand = {
  command: "memory_inspect" | "memory_verify" | "memory_candidates" | "memory_revoke";
  request: MemoryCommandRequest;
};

export interface MemoryRecordView {
  memoryId: string;
  state: MemoryLifecycleState;
  [key: string]: unknown;
}

export interface MemoryAuthorityView {
  schemaVersion: string;
  authority: { kind: "persisted"; revision: number; headHash?: string | null };
}

export interface MemoryInspectView extends MemoryAuthorityView {
  memory: MemoryRecordView;
}

export interface MemoryVerifyView extends MemoryAuthorityView {
  memoryId: string;
  state: MemoryLifecycleState;
  verification: { status: "valid" | "corrupt" | "unreadable"; [key: string]: unknown };
}

export interface MemoryCandidatesView extends MemoryAuthorityView {
  candidates: MemoryRecordView[];
}

export interface MemoryRevokeView extends MemoryAuthorityView {
  memoryId: string;
  state: "revoked";
  outcome: "revoked" | "already_revoked";
  approval: { status: "verified"; [key: string]: unknown };
}

export interface MemoryOperatorPort {
  inspect(request: MemoryCommandRequest & { selector: MemorySelector }): Promise<MemoryInspectView>;
  verify(request: MemoryCommandRequest & { selector: MemorySelector }): Promise<MemoryVerifyView>;
  candidates(request: MemoryCommandRequest): Promise<MemoryCandidatesView>;
  revoke(request: MemoryCommandRequest & {
    selector: MemorySelector;
    reason: string;
    hostApprovalPath: string;
  }): Promise<MemoryRevokeView>;
}

const ACTIONS = new Set(["inspect", "verify", "candidates", "revoke"]);
const STATES = new Set<MemoryLifecycleState>(["candidate", "active", "revoked", "expired", "corrupt", "unreadable"]);

function optionValue(args: string[], option: string): string | undefined {
  const indexes = args.flatMap((token, index) => token === option ? [index] : []);
  if (indexes.length > 1) throw new CliCommandError("invalid_input", `${option} may only be provided once.`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new CliCommandError("invalid_input", `${option} requires a value.`);
  return value;
}

export function parseMemoryCommandArguments(args: string[]): ParsedMemoryCommand {
  const [action, ...rest] = args;
  if (!action || !ACTIONS.has(action)) {
    throw new CliCommandError("invalid_input", `Unknown memory subcommand: ${action ?? ""}.`, {
      suggestion: "Use `martin memory inspect|verify|candidates|revoke`.",
    });
  }

  const memoryId = optionValue(rest, "--memory-id");
  const runsDir = optionValue(rest, "--runs-dir");
  const reason = optionValue(rest, "--reason");
  const hostApprovalPath = optionValue(rest, "--host-approval");
  const stateValue = optionValue(rest, "--state");
  const latestCount = rest.filter((token) => token === "--latest").length;
  if (latestCount > 1) throw new CliCommandError("invalid_input", "--latest may only be provided once.");

  const selectorCount = (memoryId ? 1 : 0) + (latestCount ? 1 : 0);
  if (action === "candidates" && selectorCount > 0) {
    throw new CliCommandError("invalid_input", "memory candidates does not accept a single-memory selector.");
  }
  if (action !== "candidates" && selectorCount !== 1) {
    throw new CliCommandError("invalid_input", "Choose exactly one memory selector: --memory-id <id> or --latest.");
  }

  if (stateValue && !STATES.has(stateValue as MemoryLifecycleState)) {
    throw new CliCommandError("invalid_input", `Unknown memory state: ${stateValue}.`, {
      suggestion: "Use candidate, active, revoked, expired, corrupt, or unreadable.",
    });
  }
  if (stateValue && action !== "candidates") {
    throw new CliCommandError("invalid_input", `memory ${action} does not accept --state.`);
  }
  if (action === "revoke") {
    if (!reason) throw new CliCommandError("invalid_input", "memory revoke requires --reason <text>.");
    if (!hostApprovalPath) {
      throw new CliCommandError(
        "auth",
        "memory revoke requires an explicit current signed host approval input.",
        { suggestion: "Pass --host-approval <path> containing the current signed host approval." },
      );
    }
  } else if (reason || hostApprovalPath) {
    throw new CliCommandError("invalid_input", `memory ${action} does not accept revoke authorization options.`);
  }

  const allowed = new Set(["--memory-id", "--runs-dir", "--reason", "--host-approval", "--state"]);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === "--latest") continue;
    if (allowed.has(token)) { index += 1; continue; }
    throw new CliCommandError("invalid_input", `Unsupported memory ${action} argument: ${token}.`);
  }

  return {
    command: `memory_${action}` as ParsedMemoryCommand["command"],
    request: {
      ...(memoryId ? { selector: { memoryId } } : latestCount ? { selector: { latest: true } } : {}),
      ...(runsDir ? { runsDir } : {}),
      ...(stateValue ? { state: stateValue as MemoryLifecycleState } : {}),
      ...(reason ? { reason } : {}),
      ...(hostApprovalPath ? { hostApprovalPath } : {}),
    },
  };
}

function memoryHuman(command: string, view: MemoryInspectView | MemoryVerifyView | MemoryCandidatesView | MemoryRevokeView): string[] {
  const lines = [`Command: ${command}`, `Authority revision: ${view.authority.revision}`];
  if ("candidates" in view) {
    lines.push(`Records: ${view.candidates.length}`);
    lines.push(...view.candidates.map((record) => `- ${record.memoryId}: ${record.state}`));
  } else if ("memory" in view) {
    lines.push(`Memory: ${view.memory.memoryId}`, `State: ${view.memory.state}`);
  } else {
    lines.push(`Memory: ${view.memoryId}`, `State: ${view.state}`);
    if ("verification" in view) lines.push(`Verification: ${view.verification.status}`);
    if ("outcome" in view) lines.push(`Outcome: ${view.outcome}`, `Approval: ${view.approval.status}`);
  }
  return lines;
}

export async function executeMemoryCommand(
  parsed: ParsedMemoryCommand,
  outputMode: MartinOutputMode,
  port: MemoryOperatorPort,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const action = parsed.command.slice("memory_".length) as "inspect" | "verify" | "candidates" | "revoke";
  let view: MemoryInspectView | MemoryVerifyView | MemoryCandidatesView | MemoryRevokeView;
  if (action === "candidates") {
    view = await port.candidates(parsed.request);
  } else if (action === "revoke") {
    view = await port.revoke(parsed.request as MemoryCommandRequest & {
      selector: MemorySelector;
      reason: string;
      hostApprovalPath: string;
    });
  } else {
    view = await port[action](parsed.request as MemoryCommandRequest & { selector: MemorySelector });
  }

  const command = `memory ${action}`;
  const exitCode = action === "verify" && "verification" in view
    ? view.verification.status === "valid" ? 0 : view.verification.status === "unreadable" ? 6 : 7
    : 0;
  const quiet = "memoryId" in view ? view.memoryId : action === "inspect" && "memory" in view ? view.memory.memoryId : action;
  return renderCliSuccess(outputMode, {
    data: { command, ...view },
    human: memoryHuman(command, view),
    quiet,
    exitCode,
  });
}
