import { setTimeout as sleep } from "node:timers/promises";

import { paint, terminalAnsi, type RenderEnvironment } from "./theme.js";
import { stripAnsi } from "./text.js";

export interface MotionEnvironment extends RenderEnvironment {
  readonly outputMode?: "human" | "json" | "quiet";
  readonly stdinIsTty?: boolean;
  readonly stdoutIsTty?: boolean;
  readonly ci?: boolean;
  readonly noMotion?: boolean;
}

function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === "1" || value === "true" || value === "yes";
}

export function canAnimate(env: MotionEnvironment = {}): boolean {
  const mode = env.outputMode ?? "human";
  if (mode !== "human") {
    return false;
  }

  const noColor =
    env.noColor ?? Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR");
  if (noColor) {
    return false;
  }

  const stdoutTty = env.stdoutIsTty ?? process.stdout.isTTY === true;
  if (!stdoutTty) {
    return false;
  }

  const ci = env.ci ?? Boolean(process.env.CI);
  if (ci) {
    return false;
  }

  const noMotion =
    env.noMotion ??
    (envFlag("MARTIN_NO_MOTION") || envFlag("MARTIN_REDUCED_MOTION"));
  if (noMotion) {
    return false;
  }

  const term = env.term ?? process.env.TERM;
  return term !== "dumb";
}

function shineCharacter(
  character: string,
  distance: number,
  env: MotionEnvironment,
): string {
  if (character === " ") {
    return character;
  }
  if (distance === 0) {
    return paint(character, "plain", { ...env, color: "always" });
  }
  if (distance === 1) {
    return paint(character, "info", { ...env, color: "always" });
  }
  return paint(character, "brand", { ...env, color: "always" });
}

export async function animateBannerShine(
  input: string,
  env: MotionEnvironment = {},
): Promise<void> {
  if (!canAnimate(env)) {
    return;
  }

  const target = [...stripAnsi(input)].slice(0, 100);
  if (target.length === 0) {
    return;
  }

  try {
    process.stdout.write(terminalAnsi.hideCursor);
    for (let center = -2; center < target.length + 4; center += 1) {
      const frame = target
        .map((character, index) =>
          shineCharacter(character, Math.abs(index - center), env),
        )
        .join("");
      process.stdout.write(
        terminalAnsi.cursorHome +
          terminalAnsi.eraseLine +
          frame +
          terminalAnsi.reset,
      );
      await sleep(18);
    }
  } finally {
    process.stdout.write(
      terminalAnsi.cursorHome +
        terminalAnsi.eraseLine +
        terminalAnsi.reset +
        terminalAnsi.showCursor,
    );
  }
}

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export async function withSpinner<T>(
  label: string,
  task: () => Promise<T>,
  env: MotionEnvironment = {},
): Promise<T> {
  if (!canAnimate(env)) {
    return task();
  }

  let frame = 0;
  process.stdout.write(terminalAnsi.hideCursor);
  const timer = setInterval(() => {
    const glyph = spinnerFrames[frame % spinnerFrames.length] ?? "•";
    frame += 1;
    process.stdout.write(
      terminalAnsi.cursorHome +
        terminalAnsi.eraseLine +
        paint(glyph, "brand", { ...env, color: "always" }) +
        " " +
        label,
    );
  }, 70);

  try {
    return await task();
  } finally {
    clearInterval(timer);
    process.stdout.write(
      terminalAnsi.cursorHome +
        terminalAnsi.eraseLine +
        terminalAnsi.reset +
        terminalAnsi.showCursor,
    );
  }
}

export async function writeHumanOutputWithShine(
  text: string,
  env: MotionEnvironment = {},
): Promise<void> {
  if (!text) {
    return;
  }
  if (!canAnimate(env)) {
    process.stdout.write(text + "\n");
    return;
  }

  const lines = text.split("\n");
  const headingIndex = lines.findIndex((line) =>
    stripAnsi(line).toUpperCase().includes("MARTINLOOP"),
  );
  if (headingIndex < 0) {
    process.stdout.write(text + "\n");
    return;
  }
  if (headingIndex > 0) {
    process.stdout.write(lines.slice(0, headingIndex).join("\n") + "\n");
  }

  const heading = lines[headingIndex] ?? "";
  await animateBannerShine(heading, env);
  process.stdout.write(heading + "\n");
  if (headingIndex < lines.length - 1) {
    process.stdout.write(lines.slice(headingIndex + 1).join("\n") + "\n");
  }
}
