import * as readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

import {
  playWhileWaiting,
  type ArcadeOptions,
} from "./space-invaders.js";

export type ArcadeMode = "never" | "ask" | "always";

export interface ArcadeOfferOptions<T> extends ArcadeOptions<T> {
  readonly outputMode: "human" | "json" | "quiet";
  readonly offerAfterMs?: number;
  readonly prompt?: string;
}

interface ArcadeQuestion {
  readonly promise: Promise<boolean>;
  readonly cancel: () => void;
}

export interface ArcadeOfferRuntime {
  readonly mode?: ArcadeMode;
  readonly stdoutIsTty?: boolean;
  readonly stdinIsTty?: boolean;
  readonly ci?: boolean;
  readonly term?: string;
  readonly columns?: number;
  readonly rows?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly ask?: (prompt: string) => ArcadeQuestion;
  readonly play?: (
    task: Promise<any>,
    options: ArcadeOptions<any>,
  ) => Promise<any>;
}

type Settled<T> =
  | { type: "resolved"; value: T }
  | { type: "rejected"; error: unknown };

function resolveArcadeMode(runtime: ArcadeOfferRuntime): ArcadeMode {
  if (runtime.mode) {
    return runtime.mode;
  }
  const raw = process.env.MARTIN_ARCADE?.trim().toLowerCase();
  if (raw === "never") {
    return "never";
  }
  if (raw === "always") {
    return "always";
  }
  return "ask";
}

export function isArcadeOfferEligible(
  outputMode: ArcadeOfferOptions<unknown>["outputMode"],
  runtime: ArcadeOfferRuntime = {},
): boolean {
  if (outputMode !== "human") {
    return false;
  }
  const stdoutIsTty = runtime.stdoutIsTty ?? process.stdout.isTTY === true;
  const stdinIsTty = runtime.stdinIsTty ?? process.stdin.isTTY === true;
  if (!stdoutIsTty || !stdinIsTty) {
    return false;
  }
  if (runtime.ci ?? Boolean(process.env.CI)) {
    return false;
  }
  if ((runtime.term ?? process.env.TERM) === "dumb") {
    return false;
  }

  const columns = runtime.columns ?? process.stdout.columns ?? 0;
  const rows = runtime.rows ?? process.stdout.rows ?? 0;
  return columns >= 50 && rows >= 18;
}

function observe<T>(task: Promise<T>): Promise<Settled<T>> {
  return task.then(
    (value) => ({ type: "resolved", value }),
    (error) => ({ type: "rejected", error }),
  );
}

function createArcadeQuestion(prompt: string): ArcadeQuestion {
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  let finished = false;

  const promise = new Promise<boolean>((resolve) => {
    terminal.question(prompt, (answer) => {
      if (finished) {
        return;
      }
      finished = true;
      terminal.close();
      const normalized = answer.trim().toLowerCase();
      resolve(
        normalized === "" || normalized === "y" || normalized === "yes",
      );
    });
  });

  return {
    promise,
    cancel: () => {
      if (finished) {
        return;
      }
      finished = true;
      terminal.close();
      if (process.stdout.isTTY) {
        process.stdout.write("\r\u001B[2K");
      }
    },
  };
}

export async function offerArcadeWhileWaiting<T>(
  task: Promise<T>,
  options: ArcadeOfferOptions<T>,
  runtime: ArcadeOfferRuntime = {},
): Promise<T> {
  const mode = resolveArcadeMode(runtime);
  if (mode === "never" || !isArcadeOfferEligible(options.outputMode, runtime)) {
    return task;
  }

  const play = runtime.play ?? playWhileWaiting;
  if (mode === "always") {
    return play(task, options) as Promise<T>;
  }

  const observed = observe(task);
  const first = await Promise.race([
    observed,
    (runtime.wait ?? sleep)(options.offerAfterMs ?? 2500).then(() => ({
      type: "offer" as const,
    })),
  ]);
  if (first.type === "resolved") {
    return first.value;
  }
  if (first.type === "rejected") {
    throw first.error;
  }

  const question = (runtime.ask ?? createArcadeQuestion)(
    options.prompt ??
      "Still working. Play MartinLoop Arcade while you wait? [Y/n] ",
  );
  const second = await Promise.race([
    observed,
    question.promise.then((choice) => ({
      type: "choice" as const,
      choice,
    })),
  ]);
  if (second.type === "resolved") {
    question.cancel();
    return second.value;
  }
  if (second.type === "rejected") {
    question.cancel();
    throw second.error;
  }
  if (!second.choice) {
    return task;
  }

  return play(task, options) as Promise<T>;
}
