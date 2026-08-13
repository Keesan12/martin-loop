// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import type { PostRunExperience } from "./types.js";
import type { RemoteExperienceV1 } from "../remote-experience.js";

export interface PostRunExperienceRenderDependencies {
  renderRequiredNotice(message: Extract<PostRunExperience, { kind: "required-notice" }>["message"]): Promise<void>;
  renderTelemetryNotice(): Promise<void>;
  renderRunFiveFeedback(): Promise<void>;
  renderStarPrompt(): Promise<void>;
  renderBadge(): Promise<void>;
  renderRemoteExperience(message: Extract<PostRunExperience, { kind: "remote-experience" }>["message"]): Promise<void>;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled post-run experience: ${JSON.stringify(value)}`);
}

export async function renderPostRunExperience(
  experience: PostRunExperience,
  dependencies: PostRunExperienceRenderDependencies
): Promise<void> {
  switch (experience.kind) {
    case "required-notice":
      await dependencies.renderRequiredNotice(experience.message);
      return;
    case "telemetry-notice":
      await dependencies.renderTelemetryNotice();
      return;
    case "feedback":
      await dependencies.renderRunFiveFeedback();
      return;
    case "star":
      await dependencies.renderStarPrompt();
      return;
    case "badge":
      await dependencies.renderBadge();
      return;
    case "remote-experience":
      await dependencies.renderRemoteExperience(experience.message);
      return;
    case "none":
      return;
    default:
      assertNever(experience);
  }
}

export async function renderRemoteExperienceMessage(message: RemoteExperienceV1): Promise<void> {
  process.stdout.write("\n");
  process.stdout.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  process.stdout.write(`  ${message.title}\n\n`);
  for (const line of message.body.split("\n")) {
    process.stdout.write(`  ${line}\n`);
  }
  if (message.action) {
    process.stdout.write(`\n  ${message.action.label}: ${message.action.url}\n`);
  }
  process.stdout.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`);
}

// ─── Dashboard invite interactive prompt ──────────────────────────────────────

type DashboardInviteKey = "y" | "l" | "n";

async function readDashboardInviteKey(): Promise<DashboardInviteKey> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) { resolve("l"); return; }
    const prev = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");
    const timeout = setTimeout(() => { cleanup(); resolve("l"); }, 30_000);
    const onData = (key: string) => {
      // Ctrl+C, Enter, and newline all mean Later — never terminate the process.
      if (key === "\u0003" || key === "\r" || key === "\n") {
        cleanup();
        resolve("l");
        return;
      }
      const normalized = key.toLowerCase();
      cleanup();
      if (normalized === "y") resolve("y");
      else if (normalized === "n") resolve("n");
      else resolve("l");
    };
    const cleanup = () => {
      clearTimeout(timeout);
      stdin.removeListener("data", onData);
      try { stdin.setRawMode(prev ?? false); } catch { /* ignore */ }
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}

async function openUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const safe = parsed.toString();

    const [command, args]: [string, string[]] =
      process.platform === "win32"
        ? ["rundll32.exe", ["url.dll,FileProtocolHandler", safe]]
        : process.platform === "darwin"
          ? ["open", [safe]]
          : ["xdg-open", [safe]];

    return await new Promise((resolve) => {
      const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false });
      child.once("spawn", () => { child.unref(); resolve(true); });
      child.once("error", () => resolve(false));
    });
  } catch {
    return false;
  }
}

export interface DashboardInviteDeps {
  /** Emit remote_experience_clicked event. No-op when telemetry is inactive. */
  emitClicked(experienceId: string, experienceType: string): Promise<void>;
  recordDelivered(cooldownKey: string): Promise<void>;
  recordDismissed(dismissKey: string): Promise<void>;
}

/**
 * Renders an interactive [Y] Open / [L] Later / [N] Don't ask again prompt for
 * dashboard_invite experiences. Does not collect email in the terminal.
 * The secure website handles all account creation and email collection.
 */
export async function renderDashboardInviteInteractive(
  message: RemoteExperienceV1,
  deps: DashboardInviteDeps
): Promise<void> {
  process.stdout.write("\n");
  process.stdout.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  process.stdout.write(`  ${message.title}\n\n`);
  for (const line of message.body.split("\n")) {
    process.stdout.write(`  ${line}\n`);
  }
  process.stdout.write("\n");
  process.stdout.write("  [Y] Open secure signup   [L] Later   [N] Don't ask again\n\n");
  process.stdout.write("  > ");

  // Record delivery before awaiting keypress so an interrupted process doesn't repeat.
  await deps.recordDelivered(message.cooldownKey);

  const key = await readDashboardInviteKey();
  process.stdout.write(`${key.toUpperCase()}\n\n`);

  if (key === "y" && message.action?.url) {
    const opened = await openUrl(message.action.url);
    if (opened) await deps.emitClicked(message.id, message.type);
  } else if (key === "n") {
    // Permanently suppress dashboard invites; does not affect required notices.
    await deps.recordDismissed("dashboard_invite");
  }
  // L/timeout: delivery already recorded above.

  process.stdout.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`);
}
