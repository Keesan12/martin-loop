// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { PUBLISHER_EQUIVALENT_COMMANDS } from "./publisher-equivalent-commands.mjs";

const CANDIDATE_BUILD = ["node", ["scripts/generate-candidate-build-manifest.mjs"]];

export const INTERNAL_HEALTH_COMMANDS = Object.freeze([
  ...PUBLISHER_EQUIVALENT_COMMANDS.flatMap((command) => (
    command[0] === "pnpm" && command[1]?.length === 1 && command[1][0] === "build"
      ? [command, CANDIDATE_BUILD]
      : [command]
  )),
  ["node", ["scripts/verify-release-consumer.mjs"]],
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
