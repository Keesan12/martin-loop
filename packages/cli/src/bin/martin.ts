#!/usr/bin/env node

// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { executeCli } from "../index.js";

const args = process.argv.slice(2);

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
