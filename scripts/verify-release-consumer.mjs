#!/usr/bin/env node
// SPDX-FileCopyrightText: MartinLoop contributors
// SPDX-License-Identifier: Apache-2.0

import { main } from "./lib/live-swarm-cli.mjs";

const receipt = process.env.MARTIN_LIVE_SWARM_RECEIPT;
const trustRoot = process.env.MARTIN_LIVE_SWARM_TRUST_ROOT;
if (!receipt || !trustRoot) {
  process.stderr.write(`${JSON.stringify({
    decision: "UNKNOWN",
    structureValid: false,
    artifactIntegrityValid: false,
    executionReconciled: false,
    liveQualified: false,
    errors: ["release qualification requires MARTIN_LIVE_SWARM_RECEIPT and MARTIN_LIVE_SWARM_TRUST_ROOT"],
  }, null, 2)}\n`);
  process.exit(1);
}
await main(["--decision", "required-live", "--trust-root", trustRoot, receipt]);
