// SPDX-FileCopyrightText: MartinLoop contributors
//
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Returns an absolute path under ~/.martin/<filename>.
 * Creates no directories — callers are responsible for mkdir.
 */
export function martinFilePath(filename: string): string {
  return join(resolveMartinHome(), ".martin", filename);
}

export function resolveMartinHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configuredHome = platform === "win32"
    ? env["USERPROFILE"]?.trim() || env["HOME"]?.trim()
    : env["HOME"]?.trim() || env["USERPROFILE"]?.trim();
  return configuredHome || homedir();
}
