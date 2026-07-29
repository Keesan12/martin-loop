// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MARTIN_HOME = join(homedir(), ".martin");

export function martinFilePath(...segments: string[]): string {
  return join(MARTIN_HOME, ...segments);
}

export function ensureMartinDir(): void {
  mkdirSync(MARTIN_HOME, { recursive: true });
}
