import type { RenderEnvironment } from "./theme.js";

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
