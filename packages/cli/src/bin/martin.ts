#!/usr/bin/env node

import { executeCli } from "../index.js";

const args = process.argv.slice(2);

if (args[0] === "stats") {
  const { readMilestoneState } = await import("../cli-milestone-state.js");
  const { renderLoopCard } = await import("../ux.js");
  renderLoopCard(await readMilestoneState());
  process.exit(0);
}

executeCli(args)
  .then((result) => {
    if (result.stdout) {
      process.stdout.write(`${result.stdout}\n`);
    }

    if (result.stderr) {
      process.stderr.write(`${result.stderr}\n`);
    }

    process.exitCode = result.exitCode;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
