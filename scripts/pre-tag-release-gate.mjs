// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PUBLISHER_EQUIVALENT_COMMANDS } from "./lib/publisher-equivalent-commands.mjs";
function arg(name) { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; }
const candidate = arg("--candidate-sha");
const output = resolve(arg("--output") || ".martin/pre-tag-attestation.json");
if (!candidate || !/^[a-f0-9]{40}$/iu.test(candidate)) { console.error("--candidate-sha must be a full Git SHA"); process.exit(2); }
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (head !== candidate) { console.error(`candidate mismatch: HEAD=${head} requested=${candidate}`); process.exit(1); }
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const commands = [
  ...PUBLISHER_EQUIVALENT_COMMANDS,
  ["node", ["./scripts/root-release-guard.mjs", "--tag", `v${version}`, "--pack"]],
  ["pnpm", ["release:clean-check"]],
];
const results = [];
for (const [command, args] of commands) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  results.push({ command: [command, ...args].join(" "), exitCode: result.status });
  if (result.status !== 0) { console.error(`[pre-tag-release-gate] BLOCKED command=${command} ${args.join(" ")} exit=${result.status}`); process.exit(result.status ?? 1); }
  const current = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (current !== candidate) { console.error("candidate SHA changed during validation"); process.exit(1); }
}
mkdirSync(resolve(output, ".."), { recursive: true });
writeFileSync(output, `${JSON.stringify({ schemaVersion: "martin.pre-tag-attestation.v1", validatedReleaseSha: candidate, publisherEquivalentValidation: "PASS", commands: results }, null, 2)}\n`);
console.log(`[pre-tag-release-gate] PASS candidate=${candidate}`);
