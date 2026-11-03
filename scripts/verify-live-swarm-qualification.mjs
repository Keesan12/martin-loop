#!/usr/bin/env node
// SPDX-FileCopyrightText: MartinLoop contributors
// SPDX-License-Identifier: Apache-2.0

import { main } from "./lib/live-swarm-cli.mjs";

await main(process.argv.slice(2));
