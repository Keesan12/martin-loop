// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Returns an absolute path under ~/.martin/<filename>.
 * Creates no directories — callers are responsible for mkdir.
 */
export function martinFilePath(filename: string): string {
  return join(homedir(), ".martin", filename);
}

/**
 * Ensures ~/.martin exists. Safe to call multiple times (mkdir recursive).
 */
export function ensureMartinDir(): void {
  mkdirSync(join(homedir(), ".martin"), { recursive: true });
}
