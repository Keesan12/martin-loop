import type { MartinOutputMode } from "@martin/contracts";

import { CliCommandError, renderCliSuccess } from "./ux.js";

export type MissionSelector = { missionId: string } | { latest: true };

export interface MissionCommandRequest {
  selector: MissionSelector;
  runsDir?: string;
  reason?: string;
  hostApprovalPath?: string;
}

export type ParsedMissionCommand = {
  command: "mission_status" | "mission_inspect" | "mission_resume" | "mission_pause" | "mission_cancel";
  request: MissionCommandRequest;
};

export interface MissionAuthorityView {
  schemaVersion: string;
  missionId: string;
  authority: { kind: "persisted"; revision: number; headHash?: string | null };
  lifecycle: string;
  completed: { count: number; taskIds: string[] };
  active: { count: number; taskIds: string[] };
  interrupted: { count: number; taskIds: string[] };
  candidates: { count: number; candidateIds: string[] };
  rollback: { status: string; [key: string]: unknown };
  budget: { status: string; [key: string]: unknown };
  verification: { status: string; [key: string]: unknown };
  controlIntent?: {
    action: "pause" | "cancel";
    status: "requested" | "applied";
    approvalId: string;
    requestedAt: string;
    verifiedBy: string;
  };
  resume?: { status: "read_only" | "advanced"; reason?: string };
  updatedAt: string;
}

export interface MissionControlView {
  schemaVersion: string;
  missionId: string;
  authority: { kind: "persisted"; revision: number };
  intent: {
    action: "pause" | "cancel";
    status: "requested" | "already_requested";
    reason: string;
  };
}

export interface MissionOperatorPort {
  status(request: MissionCommandRequest): Promise<MissionAuthorityView>;
  inspect(request: MissionCommandRequest): Promise<MissionAuthorityView>;
  resume(request: MissionCommandRequest): Promise<MissionAuthorityView>;
  requestControl(
    action: "pause" | "cancel",
    request: MissionCommandRequest & { reason: string; hostApprovalPath: string },
  ): Promise<MissionControlView>;
}

const ACTIONS = new Set(["status", "inspect", "resume", "pause", "cancel"]);

function optionValue(args: string[], option: string): string | undefined {
  const indexes = args.flatMap((token, index) => token === option ? [index] : []);
  if (indexes.length > 1) throw new CliCommandError("invalid_input", `${option} may only be provided once.`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new CliCommandError("invalid_input", `${option} requires a value.`);
  return value;
}

export function parseMissionCommandArguments(args: string[]): ParsedMissionCommand {
  const [action, ...rest] = args;
  if (!action || !ACTIONS.has(action)) {
    throw new CliCommandError("invalid_input", `Unknown mission subcommand: ${action ?? ""}.`, {
      suggestion: "Use `martin mission status|inspect|resume|pause|cancel`.",
    });
  }

  const missionId = optionValue(rest, "--mission-id");
  const runsDir = optionValue(rest, "--runs-dir");
  const reason = optionValue(rest, "--reason");
  const hostApprovalPath = optionValue(rest, "--host-approval");
  const latestCount = rest.filter((token) => token === "--latest").length;
  if (latestCount > 1) throw new CliCommandError("invalid_input", "--latest may only be provided once.");
  if ((missionId ? 1 : 0) + (latestCount ? 1 : 0) !== 1) {
    throw new CliCommandError("invalid_input", "Choose exactly one mission selector: --mission-id <id> or --latest.");
  }
  const allowed = new Set(["--mission-id", "--runs-dir", "--reason", "--host-approval"]);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === "--latest") continue;
    if (allowed.has(token)) { index += 1; continue; }
    throw new CliCommandError("invalid_input", `Unsupported mission ${action} argument: ${token}.`);
  }
  if ((action === "pause" || action === "cancel") && !reason) {
    throw new CliCommandError("invalid_input", `mission ${action} requires --reason <text>.`);
  }
  if ((action === "pause" || action === "cancel") && !hostApprovalPath) {
    throw new CliCommandError(
      "auth",
      `mission ${action} requires an explicit current signed host approval input.`,
      { suggestion: "Pass --host-approval <path> containing the current signed host approval." },
    );
  }
  if ((reason || hostApprovalPath) && action !== "pause" && action !== "cancel") {
    throw new CliCommandError("invalid_input", `mission ${action} does not accept control-intent authorization options.`);
  }

  return {
    command: `mission_${action}` as ParsedMissionCommand["command"],
    request: {
      selector: missionId ? { missionId } : { latest: true },
      ...(runsDir ? { runsDir } : {}),
      ...(reason ? { reason } : {}),
      ...(hostApprovalPath ? { hostApprovalPath } : {}),
    },
  };
}

function renderMissionHuman(command: string, view: MissionAuthorityView | MissionControlView): string[] {
  const lines = [`Mission ${view.missionId}`, `Command: ${command}`, `Authority revision: ${view.authority.revision}`];
  if ("intent" in view) {
    lines.push(`Control intent: ${view.intent.action} (${view.intent.status})`, `Reason: ${view.intent.reason}`);
    return lines;
  }
  lines.push(
    `Lifecycle: ${view.lifecycle}`,
    `Completed: ${view.completed.count}`,
    `Active: ${view.active.count}`,
    `Interrupted: ${view.interrupted.count}`,
    `Candidates: ${view.candidates.count}`,
    `Rollback: ${view.rollback.status}`,
    `Budget: ${view.budget.status}`,
    `Verification: ${view.verification.status}`,
  );
  if (view.controlIntent) lines.push(`Control intent: ${view.controlIntent.action} (${view.controlIntent.status})`);
  if (view.resume) lines.push(`Resume: ${view.resume.status}${view.resume.reason ? ` (${view.resume.reason})` : ""}`);
  return lines;
}

export async function executeMissionCommand(
  parsed: ParsedMissionCommand,
  outputMode: MartinOutputMode,
  port: MissionOperatorPort,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const action = parsed.command.slice("mission_".length) as "status" | "inspect" | "resume" | "pause" | "cancel";
  const view = action === "pause" || action === "cancel"
    ? await port.requestControl(action, parsed.request as MissionCommandRequest & { reason: string; hostApprovalPath: string })
    : await port[action](parsed.request);
  const command = `mission ${action}`;
  return renderCliSuccess(outputMode, {
    data: { command, ...view },
    human: renderMissionHuman(command, view),
    quiet: view.missionId,
  });
}
