#!/usr/bin/env node

import {
  canAnimate,
  withSpinner,
  writeHumanOutputWithShine,
} from "@martin/presentation";

import { executeCli } from "../index.js";

const args = process.argv.slice(2);

type OutputMode = "human" | "json" | "quiet";

function outputModeFromArgs(argv: readonly string[]): OutputMode {
  if (argv.includes("--json")) {
    return "json";
  }
  if (argv.includes("--quiet")) {
    return "quiet";
  }
  return "human";
}

function primaryCommand(argv: readonly string[]): string {
  return argv.find((argument) => !argument.startsWith("-")) ?? "help";
}

function spinnerLabelFor(argv: readonly string[]): string | null {
  const command = primaryCommand(argv);
  if (command === "preflight") {
    return "Checking governed run contract";
  }
  if (command === "dossier") {
    return "Building run dossier";
  }
  if (command === "review") {
    return "Loading trusted run evidence";
  }
  if (command === "share") {
    return "Building share bundle";
  }
  if (command === "receipts") {
    return "Checking receipt integrity";
  }
  if (command === "runs") {
    const subcommand = argv[argv.indexOf("runs") + 1];
    if (subcommand === "verify") {
      return "Verifying persisted run evidence";
    }
    if (subcommand === "list") {
      return "Loading governed run ledger";
    }
  }
  return null;
}

async function main(): Promise<void> {
  if (args[0] === "stats") {
    const { readMilestoneState } = await import("../cli-milestone-state.js");
    const { renderLoopCard } = await import("../ux.js");
    renderLoopCard(await readMilestoneState());
    return;
  }

  const outputMode = outputModeFromArgs(args);
  const motionEnvironment = {
    outputMode,
    stdoutIsTty: process.stdout.isTTY === true,
    stdinIsTty: process.stdin.isTTY === true,
    ci: Boolean(process.env.CI),
    term: process.env.TERM,
  } as const;
  const spinnerLabel = spinnerLabelFor(args);
  const result =
    spinnerLabel && canAnimate(motionEnvironment)
      ? await withSpinner(
          spinnerLabel,
          () => executeCli(args),
          motionEnvironment,
        )
      : await executeCli(args);

  if (result.stdout) {
    if (outputMode === "human") {
      await writeHumanOutputWithShine(result.stdout, motionEnvironment);
    } else {
      process.stdout.write(result.stdout + "\n");
    }
  }
  if (result.stderr) {
    process.stderr.write(result.stderr + "\n");
  }
  process.exitCode = result.exitCode;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message + "\n");
  process.exitCode = 1;
});
