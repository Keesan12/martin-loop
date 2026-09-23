// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { PUBLISHER_EQUIVALENT_COMMANDS } from "./publisher-equivalent-commands.mjs";

export const INTERNAL_HEALTH_COMMANDS = Object.freeze([
  ...PUBLISHER_EQUIVALENT_COMMANDS,
  ["pnpm", ["release:matrix:local"]],
  ["pnpm", ["release:clean-check"]],
]);

export function renderHealthCommand([command, args]) {
  return [command, ...args].join(" ");
}

export function internalHealthCommandSetSha256() {
  return createHash("sha256")
    .update(JSON.stringify(INTERNAL_HEALTH_COMMANDS))
    .digest("hex");
}
